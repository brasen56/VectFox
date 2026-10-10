import { beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the real workflow, marker, fingerprint and tip code together; only
// SillyTavern, the LLM and persistence are replaced with deterministic fixtures.
const fixture = vi.hoisted(() => ({ messages: [], items: [] }));
vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, chat_metadata: {},
    getCurrentChatId: () => 'restart-chat', saveSettingsDebounced: vi.fn(),
    substituteParams: text => text, getRequestHeaders: vi.fn(),
}));
vi.mock('../../../../extensions.js', () => ({
    extension_settings: {}, getContext: () => ({ chat: fixture.messages }),
}));
vi.mock('../core/collection-ids.js', () => ({
    getChatUUID: () => 'restart-uuid', buildEventBaseCollectionId: () => 'vf_eventbase_restart',
    buildRegistryKey: id => `vectra:${id}`, parseRegistryKey: key => ({ collectionId: key }),
    getRegistryBackend: () => 'vectra', getBackendFromCollectionId: () => 'vectra',
    buildChatSearchPatterns: () => [], matchesPatterns: () => false,
    COLLECTION_PREFIXES: { VECTFOX_EVENTBASE: 'vf_eventbase_', VECTFOX_ARCHIVE_EVENT: 'vf_archiveevent_' },
}));
vi.mock('../core/collection-loader.js', () => ({
    registerCollection: vi.fn(), getCollectionRegistry: () => [], getCollectionListing: vi.fn(),
}));
vi.mock('../core/core-vector-api.js', () => ({
    insertVectorItems: vi.fn(), queryCollection: vi.fn(), deleteVectorItems: vi.fn(),
    getAdditionalArgs: vi.fn(), getSavedHashes: async () => [123],
}));
vi.mock('../core/collection-metadata.js', () => ({
    isCollectionEnabled: () => true, isCollectionActiveForContextAnyKey: () => false,
    getChatLockedCollections: () => [], setCollectionLock: vi.fn(), setCollectionMeta: vi.fn(),
}));
vi.mock('../backends/backend-manager.js', () => ({
    getBackend: async () => ({ listChunks }),
}));
vi.mock('../core/eventbase-store.js', async importOriginal => ({
    ...await importOriginal(),
    resolveActiveEventBaseCollection: () => ({ collectionId: 'vf_eventbase_restart', registryKey: 'vectra:vf_eventbase_restart' }),
    insertEvents: vi.fn(async events => {
        fixture.items.push(...events.map(metadata => ({ metadata })));
    }),
}));
vi.mock('../core/eventbase-extractor.js', () => ({ extractEvents: vi.fn() }));
vi.mock('../core/generation-rate-limiter.js', () => ({
    generationRateLimiter: { execute: fn => fn() }, generationRateLimitSettings: () => ({}),
}));
vi.mock('../core/character-roster.js', () => ({
    ensureCharacterIndex: vi.fn(), getCharacterRoster: vi.fn(), upsertCharacterEvents: vi.fn(),
    pruneCharacterEvents: vi.fn(), invalidateCharacterIndex: vi.fn(),
}));
vi.mock('../core/eventbase-token-budget.js', () => ({ formatBudgetedEventBase: vi.fn() }));
vi.mock('../core/npc-cards.js', () => ({ getNpcCards: vi.fn() }));
vi.mock('../core/npc-card-llm.js', () => ({ completeNpcCard: vi.fn() }));
vi.mock('../core/scene-cast.js', () => ({ detectSceneCast: vi.fn() }));
vi.mock('../core/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn() }));
vi.mock('../core/agentic-retrieval.js', () => ({ retrieveEventsWithAgent: vi.fn() }));
vi.mock('../ui/progress-tracker.js', () => ({
    progressTracker: {
        show: vi.fn(), updateProgress: vi.fn(), updateChunks: vi.fn(),
        updateEmbeddingProgress: vi.fn(), complete: vi.fn(),
    },
}));
vi.mock('../core/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), warn: vi.fn(), trace: vi.fn(), enabled: () => false },
}));

import { extension_settings } from '../../../../extensions.js';
import {
    clearExtractionCachesForChat, setAutoSyncStartPoint, getAutoSyncMarker,
    hasPendingAutoSyncRecheck, markWindowExtracted, isWindowAlreadyExtracted, getVectorizationTip,
} from '../core/eventbase-store.js';
import { extractEvents } from '../core/eventbase-extractor.js';
import { getAutoSyncWindowSize, getChatAutoSyncStatus, runEventBaseIngestion } from '../core/eventbase-workflow.js';
import { progressTracker } from '../ui/progress-tracker.js';

const UUID = 'restart-uuid';
const listChunks = vi.fn();
const sourceHashes = (start, size = 40) => fixture.messages.slice(start, start + size).map(m => m.hash);
const eventFor = (start, size = 40) => ({
    importance: 5, summary: `Window ${start}`, source_window_start: start,
    source_window_end: start + size - 1, source_message_hashes: sourceHashes(start, size),
});
const run = (overrides = {}) => runEventBaseIngestion({
    messages: fixture.messages, chatUUID: UUID, settings: extension_settings.vectfox,
    isAutoSync: true, windowSizeOverride: getAutoSyncWindowSize(extension_settings.vectfox),
    windowOverlapOverride: 0, ...overrides,
});
const extractedStarts = () => extractEvents.mock.calls.map(([args]) => args.windowStart);

beforeEach(() => {
    clearExtractionCachesForChat(UUID);
    vi.clearAllMocks();
    fixture.messages = Array.from({ length: 624 }, (_, index) => ({
        mes: `Message ${index}`, name: index % 2 ? 'AI' : 'User', hash: index + 1000,
    }));
    // Old coordinates claim coverage through 560, but only pre-restart history
    // is actually stored. This is the drift a manual start point must repair.
    fixture.items = [{ metadata: { source_window_end: 559, source_message_hashes: [-1, -2] } }];
    extension_settings.vectfox = {
        vector_backend: 'vectra', eventbase_autosync_window_turns: 20,
        eventbase_autosync_popup: false, autosync_show_progress_modal: true,
        eventbase_autosync_start_marker: { [UUID]: 560 },
        eventbase_vectorization_tip: { [UUID]: 560 },
    };
    listChunks.mockImplementation(async () => ({ items: fixture.items }));
    extractEvents.mockImplementation(async ({ windowStart, messages }) => [eventFor(windowStart, messages.length)]);
});

describe('manual auto-sync restart', () => {
    it.each([
        [20, true, [400, 440, 480, 520]],
        [20, false, [400, 440, 480, 520, 560]],
        [10, true, [400, 420, 440, 460, 480, 500, 520, 540, 560, 580]],
    ])('walks 400-of-624 with %i turns and settle lag %s', async (turns, settle, starts) => {
        Object.assign(extension_settings.vectfox, {
            eventbase_autosync_window_turns: turns, eventbase_autosync_settle_lag: settle,
        });
        setAutoSyncStartPoint(UUID, 400, extension_settings.vectfox);
        const result = await run();
        expect(extractedStarts()).toEqual(starts);
        expect(result.windowsProcessed).toBe(starts.length);
        expect(hasPendingAutoSyncRecheck(UUID)).toBe(false);
    });

    it('repairs earlier gaps even when the last complete window is genuinely extracted', async () => {
        fixture.items.push({ metadata: eventFor(520) });
        markWindowExtracted(sourceHashes(520), UUID);
        setAutoSyncStartPoint(UUID, 400, extension_settings.vectfox);
        expect((await getChatAutoSyncStatus(extension_settings.vectfox)).state).toBe('partial');
        const result = await run();
        expect(extractedStarts()).toEqual([400, 440, 480]);
        expect(result).toMatchObject({ windowsProcessed: 3, windowsSkipped: 1 });
        expect(hasPendingAutoSyncRecheck(UUID)).toBe(false);
        expect(progressTracker.complete).toHaveBeenLastCalledWith(true, expect.stringContaining('1 already-covered window(s) skipped'));
    });

    it('does not mistake old tip-derived fingerprints for actual extraction', async () => {
        // Old tip fallback cached these contents without sending them to the LLM.
        // Previously the run claimed success after extracting only window 520.
        for (const start of [400, 440, 480]) markWindowExtracted(sourceHashes(start), UUID);
        setAutoSyncStartPoint(UUID, 400, extension_settings.vectfox);
        // The old synchronizeChat caller already passed this opt-out; its
        // fingerprint and last-window shortcuts still ignored the restart.
        expect((await run({ skipTipFallback: true })).windowsProcessed).toBe(4);
        expect(extractedStarts()).toEqual([400, 440, 480, 520]);
    });

    it('uses stored source hashes to skip real duplicates even without a local cache', async () => {
        fixture.items.push({ metadata: eventFor(400) }, { metadata: eventFor(480) });
        setAutoSyncStartPoint(UUID, 400, extension_settings.vectfox);
        expect(await run()).toMatchObject({ windowsProcessed: 2, windowsSkipped: 2 });
        expect(extractedStarts()).toEqual([440, 520]);
        expect(getVectorizationTip(UUID)).toBe(560);
        expect((await getChatAutoSyncStatus(extension_settings.vectfox)).state).toBe('fully-vectorized');
    });

    it('retries a failed historical window even after the tail succeeds', async () => {
        setAutoSyncStartPoint(UUID, 400, extension_settings.vectfox);
        extractEvents.mockRejectedValueOnce(new Error('Extraction unavailable'));
        expect(await run()).toMatchObject({ windowsProcessed: 3, windowsFailed: 1 });
        expect(hasPendingAutoSyncRecheck(UUID)).toBe(true);
        extractEvents.mockClear();
        expect(await run()).toMatchObject({ windowsProcessed: 1, windowsSkipped: 3, windowsFailed: 0 });
        expect(extractedStarts()).toEqual([400]);
        expect(hasPendingAutoSyncRecheck(UUID)).toBe(false);
    });

    it('keeps the restart pending when nothing is eligible yet', async () => {
        setAutoSyncStartPoint(UUID, 624, extension_settings.vectfox);
        await run();
        expect(extractEvents).not.toHaveBeenCalled();
        expect(listChunks).not.toHaveBeenCalled();
        expect(hasPendingAutoSyncRecheck(UUID)).toBe(true);
    });

    it('keeps the restart pending if stored-window verification fails', async () => {
        setAutoSyncStartPoint(UUID, 400, extension_settings.vectfox);
        listChunks.mockRejectedValueOnce(new Error('Backend unavailable'));
        await expect(run()).rejects.toThrow('Backend unavailable');
        expect(extractEvents).not.toHaveBeenCalled();
        expect(hasPendingAutoSyncRecheck(UUID)).toBe(true);
    });

    it('keeps a new start point selected during extraction', async () => {
        setAutoSyncStartPoint(UUID, 400, extension_settings.vectfox);
        extractEvents.mockImplementationOnce(async () => {
            setAutoSyncStartPoint(UUID, 200, extension_settings.vectfox);
            return [eventFor(400)];
        });
        await run();
        expect(getAutoSyncMarker(UUID)).toBe(200);
        expect(hasPendingAutoSyncRecheck(UUID)).toBe(true);
    });

    it('keeps a cancelled restart pending', async () => {
        setAutoSyncStartPoint(UUID, 400, extension_settings.vectfox);
        const controller = new AbortController();
        controller.abort();
        await run({ abortSignal: controller.signal });
        expect(hasPendingAutoSyncRecheck(UUID)).toBe(true);
        expect(extractEvents).not.toHaveBeenCalled();
    });

    it('never turns an ordinary positional skip into a content fingerprint', async () => {
        extension_settings.vectfox.eventbase_autosync_start_marker[UUID] = 400;
        expect(await run()).toMatchObject({ windowsProcessed: 0, windowsSkipped: 4 });
        expect(extractEvents).not.toHaveBeenCalled();
        expect(await isWindowAlreadyExtracted(sourceHashes(400), null, {}, UUID)).toBe(false);
        expect(extension_settings.vectfox.eventbase_extracted_windows?.[UUID]).toBeUndefined();
    });
});
