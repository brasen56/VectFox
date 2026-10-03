import { describe, it, expect, vi, beforeEach } from 'vitest';

// Isolate the workflow from SillyTavern, as in eventbase-settle-lag.test.js.
vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: () => 'chat',
    substituteParams: text => text, chat_metadata: {},
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: {}, getContext: () => ({ chat: [] }) }));
vi.mock('../core/collection-ids.js', () => ({
    getChatUUID: () => 'uuid', parseRegistryKey: key => ({ collectionId: key.split(':')[1] }),
    COLLECTION_PREFIXES: { VECTFOX_EVENTBASE: 'VectFox_eventbase_', VECTFOX_ARCHIVE_EVENT: 'VectFox_archiveevent_' },
    buildRegistryKey: vi.fn(),
}));
vi.mock('../core/collection-loader.js', () => ({ getCollectionRegistry: vi.fn() }));
vi.mock('../core/core-vector-api.js', () => ({ queryCollection: vi.fn(), getSavedHashes: vi.fn() }));
vi.mock('../core/constants.js', () => ({ EXTENSION_PROMPT_TAG: '3_vectfox' }));
vi.mock('../core/eventbase-schema.js', () => ({ EventBaseFatalError: class {}, EventBaseExtractionError: class {} }));
vi.mock('../core/eventbase-extractor.js', () => ({ extractEvents: vi.fn() }));
vi.mock('../core/generation-rate-limiter.js', () => ({ generationRateLimiter: {}, generationRateLimitSettings: {} }));
vi.mock('../core/eventbase-store.js', () => ({
    insertEvents: vi.fn(), isWindowAlreadyExtracted: vi.fn(), markWindowExtracted: vi.fn(),
    clearExtractionCachesForChat: vi.fn(), buildEventBaseCollectionId: vi.fn(), isLastWindowExtracted: vi.fn(),
    setVectorizationTip: vi.fn(), getVectorizationTip: vi.fn(), ensureVectorizationTip: vi.fn(),
    shouldUseTipFallback: vi.fn(), resolveActiveEventBaseCollection: vi.fn(), repairAutoSyncCoordinatesAfterShrink: vi.fn(),
}));
vi.mock('../core/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn() }));
vi.mock('../core/agentic-retrieval.js', () => ({ retrieveEventsWithAgent: vi.fn() }));
vi.mock('../core/eventbase-injection.js', () => ({ formatEventsForInjectionDetailed: vi.fn() }));
vi.mock('../core/collection-metadata.js', () => ({
    isCollectionEnabled: () => true, isCollectionActiveForContextAnyKey: () => true,
    setCollectionLock: vi.fn(), setCollectionMeta: vi.fn(),
}));
vi.mock('../ui/progress-tracker.js', () => ({ progressTracker: {} }));
vi.mock('../core/log.js', () => ({ log: {
    lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false,
} }));
vi.mock('../core/ils-expander.js', () => ({ prepareMessagesForEventBase: messages => ({ messages }) }));

import { runEventBaseRetrieval } from '../core/eventbase-workflow.js';
import { getCollectionRegistry } from '../core/collection-loader.js';
import { retrieveEvents } from '../core/eventbase-retrieval.js';
import { retrieveEventsWithAgent } from '../core/agentic-retrieval.js';
import { formatEventsForInjectionDetailed } from '../core/eventbase-injection.js';
import { setExtensionPrompt } from '../../../../../script.js';

const params = { chat: [], searchText: 'scene', settings: {}, dryRun: true, testMessage: 'scene' };
const debug = {
    candidateOutcomes: { event: { outcome: 'injected', summary: 'memory' } },
    plannerQuerySummary: [{ queryText: 'scene', hitsReturned: 1, uniqueHits: 1, survivedCount: 1 }],
};

beforeEach(() => {
    vi.clearAllMocks();
    getCollectionRegistry.mockReturnValue(['qdrant:VectFox_eventbase_uuid']);
    retrieveEvents.mockResolvedValue({ events: [{ event_id: 'event' }], debug });
    retrieveEventsWithAgent.mockResolvedValue({ events: [{ event_id: 'event' }], debug });
    formatEventsForInjectionDetailed.mockReturnValue({ text: 'memory', includedCount: 1 });
});

describe('EventBase dry-run diagnostic contract', () => {
    it.each([false, true])('carries outcomes and query summaries (Agent Mode=%s) without injecting', async agentic => {
        const result = await runEventBaseRetrieval({ ...params, settings: { agentic_retrieval_enabled: agentic } });
        expect(result).toMatchObject({ injectionText: 'memory', eventCount: 1, debug });
        expect(setExtensionPrompt).not.toHaveBeenCalled();
    });

    it('preserves diagnostics when all candidates were cut', async () => {
        const cutDebug = { candidateOutcomes: { event: { outcome: 'failed_importance_filter' } } };
        retrieveEvents.mockResolvedValue({ events: [], debug: cutDebug });
        const result = await runEventBaseRetrieval(params);
        expect(result).toMatchObject({ injectionText: null, eventCount: 0,
            debug: { ...cutDebug, plannerQuerySummary: [] } });
        expect(setExtensionPrompt).not.toHaveBeenCalled();
    });

    it('preserves diagnostics on the empty-format return path', async () => {
        formatEventsForInjectionDetailed.mockReturnValue({ text: '', includedCount: 0 });
        expect(await runEventBaseRetrieval(params)).toMatchObject({ injectionText: null, eventCount: 0, debug });
        expect(setExtensionPrompt).not.toHaveBeenCalled();
    });

    it('provides empty diagnostics when no collections are locked', async () => {
        getCollectionRegistry.mockReturnValue([]);
        expect(await runEventBaseRetrieval(params)).toMatchObject({ injectionText: null, eventCount: 0,
            debug: { candidateOutcomes: {}, plannerQuerySummary: [] } });
        expect(retrieveEvents).not.toHaveBeenCalled();
        expect(setExtensionPrompt).not.toHaveBeenCalled();
    });
});