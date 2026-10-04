/**
 * EventBase Interop Surface Tests — getEventsSince (VISION.md "Deliverable zero")
 *
 * getEventsSince() is the one blessed read path other extensions (OpenVault's
 * Stage 3 adapter) should use instead of reaching into backend-manager.js /
 * eventbase-schema.js internals directly. These tests guard its contract:
 *   - marker is INCLUSIVE (source_window_end >= marker comes back) — paired
 *     with tip = max + 1, an exclusive bound would permanently skip a window
 *     ending exactly at a persisted tip
 *   - tip reflects the WHOLE collection's high-water mark, not just the
 *     filtered slice, so a caller can persist it even on a zero-event call
 *   - schemaVersion is always EVENTBASE_SCHEMA_VERSION so a caller can
 *     negotiate/reject on version mismatch
 *   - missing chatUUID / no matching Qdrant collection / backend failure all
 *     degrade to an empty result rather than throwing (callers poll this on
 *     every VectFox sync event; a throw would break that loop)
 *
 * Isolation strategy: every DIRECT import of core/eventbase-store.js is
 * mocked below, same approach as tests/eventbase-retrieval.test.js — this
 * keeps script.js/extensions.js (the real SillyTavern host modules) out of
 * the resolution graph entirely. autosync-coordinates.js is pure (no host
 * imports) and loads for real, same precedent as story-time.js in the
 * retrieval tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/core-vector-api.js', () => ({
    insertVectorItems: vi.fn(),
    queryCollection: vi.fn(),
    deleteVectorItems: vi.fn(),
    getAdditionalArgs: vi.fn(),
    getSavedHashes: vi.fn(),
}));

vi.mock('../../../../../script.js', () => ({
    saveSettingsDebounced: vi.fn(),
    getRequestHeaders: vi.fn(),
    getCurrentChatId: vi.fn(),
    chat_metadata: {},
}));

vi.mock('../../../../extensions.js', () => ({
    extension_settings: {},
    getContext: vi.fn(() => ({})),
}));

const getCollectionRegistryMock = vi.fn(() => []);
vi.mock('../core/collection-loader.js', () => ({
    registerCollection: vi.fn(),
    getCollectionRegistry: (...a) => getCollectionRegistryMock(...a),
    getCollectionListing: vi.fn(),
}));

vi.mock('../core/collection-metadata.js', () => ({
    getChatLockedCollections: vi.fn(() => []),
    isCollectionActiveForContextAnyKey: vi.fn(() => false),
}));

vi.mock('../core/collection-ids.js', () => ({
    getChatUUID: vi.fn(),
    buildEventBaseCollectionId: vi.fn(),
    getRegistryBackend: vi.fn((b) => b || 'vectra'),
    // Real implementation parses the `vf_<kind>_<backend>_` segment out of the
    // ID; the mock just needs to agree with the fixture IDs used below.
    getBackendFromCollectionId: vi.fn((id) => (String(id).includes('_qdrant_') ? 'qdrant' : 'vectra')),
    COLLECTION_PREFIXES: { VECTFOX_EVENTBASE: 'vf_eventbase_' },
    parseRegistryKey: vi.fn((key) => {
        const idx = String(key).indexOf(':');
        return idx > 0
            ? { backend: key.slice(0, idx), collectionId: key.slice(idx + 1) }
            : { backend: null, collectionId: key };
    }),
    buildChatSearchPatterns: vi.fn(() => []),
    matchesPatterns: vi.fn(() => false),
}));

vi.mock('../core/eventbase-schema.js', () => ({
    buildEmbedText: vi.fn(),
    parseEmbedText: vi.fn((text) => ({ summary: text || '' })),
    EVENTBASE_SCHEMA_VERSION: 1,
}));

vi.mock('../core/ils-expander.js', () => ({
    prepareMessagesForEventBase: vi.fn((messages) => ({ messages: messages || [] })),
}));

vi.mock('../core/log.js', () => ({
    log: {
        enabled: () => false,
        warn: () => {},
        lifecycle: () => {},
        verbose: () => {},
        trace: () => {},
        error: () => {},
    },
}));

const listChunksMock = vi.fn();
vi.mock('../backends/backend-manager.js', () => ({
    getBackend: vi.fn(async () => ({ listChunks: (...a) => listChunksMock(...a) })),
}));

import {
    getEventsSince, setAutoSyncStartPoint, getAutoSyncMarker, getVectorizationTip, clearVectorizationTip,
    ensureVectorizationTip, repairAutoSyncCoordinatesAfterShrink, stampAutoSyncMarker,
    hasPendingAutoSyncRecheck, clearAutoSyncRecheck, clearAutoSyncMarker,
} from '../core/eventbase-store.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { getChatUUID } from '../core/collection-ids.js';
import { getCurrentChatId, saveSettingsDebounced } from '../../../../../script.js';
import { prepareMessagesForEventBase } from '../core/ils-expander.js';

const CHAT_UUID = 'test-uuid-1234';
const COLLECTION_ID = `vf_eventbase_qdrant_${CHAT_UUID}`;

describe('setAutoSyncStartPoint', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearVectorizationTip(CHAT_UUID);
        extension_settings.vectfox = {
            eventbase_autosync_start_marker: { [CHAT_UUID]: 100, other: 8 },
            eventbase_vectorization_tip: { [CHAT_UUID]: 100 },
            eventbase_window_cache: { [CHAT_UUID]: ['preserved-fingerprint'] },
        };
        getChatUUID.mockReturnValue(CHAT_UUID);
        getCurrentChatId.mockReturnValue('chat');
        getContext.mockReturnValue({ chat: Array.from({ length: 30 }, () => ({ mes: 'message' })) });
        prepareMessagesForEventBase.mockImplementation(messages => ({ messages: messages || [] }));
    });

    it('persists a window-aligned restart without touching recorded coverage', () => {
        expect(getVectorizationTip(CHAT_UUID)).toBe(100);
        expect(setAutoSyncStartPoint(CHAT_UUID, '15', { eventbase_autosync_window_turns: 3 })).toBe(12);
        expect(getAutoSyncMarker(CHAT_UUID)).toBe(12);
        // Moving the restart point does not change what is vectorized.
        expect(getVectorizationTip(CHAT_UUID)).toBe(100);
        expect(extension_settings.vectfox.eventbase_vectorization_tip[CHAT_UUID]).toBe(100);
        expect(hasPendingAutoSyncRecheck(CHAT_UUID)).toBe(true);
        expect(extension_settings.vectfox.eventbase_autosync_start_marker.other).toBe(8);
        expect(extension_settings.vectfox.eventbase_window_cache[CHAT_UUID]).toEqual(['preserved-fingerprint']);
        expect(saveSettingsDebounced).toHaveBeenCalled();
        expect(listChunksMock).not.toHaveBeenCalled();
    });

    it('retires the pending re-check once the marker moves elsewhere', () => {
        setAutoSyncStartPoint(CHAT_UUID, 10, {});
        expect(hasPendingAutoSyncRecheck(CHAT_UUID)).toBe(true);
        extension_settings.vectfox.eventbase_autosync_start_marker[CHAT_UUID] = 24;
        expect(hasPendingAutoSyncRecheck(CHAT_UUID)).toBe(false);
    });

    it('clears the pending re-check with the marker and on completion', () => {
        setAutoSyncStartPoint(CHAT_UUID, 10, {});
        clearAutoSyncRecheck(CHAT_UUID);
        expect(hasPendingAutoSyncRecheck(CHAT_UUID)).toBe(false);
        expect(getAutoSyncMarker(CHAT_UUID)).toBe(10);

        setAutoSyncStartPoint(CHAT_UUID, 10, {});
        clearAutoSyncMarker(CHAT_UUID);
        expect(hasPendingAutoSyncRecheck(CHAT_UUID)).toBe(false);
        expect(extension_settings.vectfox.eventbase_autosync_recheck_from[CHAT_UUID]).toBeUndefined();
    });

    it('validates against expanded originals, not visible message count', () => {
        getContext.mockReturnValue({ chat: [{ mes: 'summary' }] });
        prepareMessagesForEventBase.mockReturnValueOnce({ messages: Array(30).fill({ mes: 'original' }) });
        expect(setAutoSyncStartPoint(CHAT_UUID, 30, {})).toBe(30);
    });

    it('rejects invalid positions without mutating the saved marker', () => {
        expect(() => setAutoSyncStartPoint(CHAT_UUID, 31, {})).toThrow(RangeError);
        expect(getAutoSyncMarker(CHAT_UUID)).toBe(100);
    });

    it('rejects a chat switch without changing either chat', () => {
        getChatUUID.mockReturnValue('other');
        expect(() => setAutoSyncStartPoint(CHAT_UUID, 10, {})).toThrow('Load the chat');
        expect(getAutoSyncMarker(CHAT_UUID)).toBe(100);
        expect(getAutoSyncMarker('other')).toBe(8);
    });

    it('keeps an earlier coverage tip rather than inventing extracted history', () => {
        clearVectorizationTip(CHAT_UUID);
        extension_settings.vectfox.eventbase_vectorization_tip[CHAT_UUID] = 4;
        expect(setAutoSyncStartPoint(CHAT_UUID, 20, {})).toBe(20);
        expect(getVectorizationTip(CHAT_UUID)).toBe(4);
    });
});

describe('ensureVectorizationTip — recorded tip is verified, not trusted', () => {
    const TURNS_20 = { eventbase_autosync_window_turns: 20 };

    beforeEach(() => {
        vi.clearAllMocks();
        clearVectorizationTip(CHAT_UUID);
        // The reported state: a stale recorded tip far below the backend's.
        extension_settings.vectfox = {
            eventbase_autosync_start_marker: { [CHAT_UUID]: 3480 },
            eventbase_vectorization_tip: { [CHAT_UUID]: 658 },
        };
        getCurrentChatId.mockReturnValue('Newish (1)');
        listChunksMock.mockResolvedValue({ items: [makeItem(12), makeItem(9329), makeItem(400)] });
    });

    it('replaces a stale recorded tip with the backend high-water mark', async () => {
        expect(getVectorizationTip(CHAT_UUID)).toBe(658);
        expect(await ensureVectorizationTip(CHAT_UUID, COLLECTION_ID, {})).toBe(9330);
        expect(getVectorizationTip(CHAT_UUID)).toBe(9330);
        expect(extension_settings.vectfox.eventbase_vectorization_tip[CHAT_UUID]).toBe(9330);
        expect(listChunksMock).toHaveBeenCalledTimes(1);
    });

    it('probes again only when the open chat file changes', async () => {
        await ensureVectorizationTip(CHAT_UUID, COLLECTION_ID, {});
        await ensureVectorizationTip(CHAT_UUID, COLLECTION_ID, {});
        expect(listChunksMock).toHaveBeenCalledTimes(1);

        // A branch / checkpoint sharing the UUID is a different file → re-verify.
        getCurrentChatId.mockReturnValue('Newish (1) - Branch #2');
        await ensureVectorizationTip(CHAT_UUID, COLLECTION_ID, {});
        expect(listChunksMock).toHaveBeenCalledTimes(2);

        getCurrentChatId.mockReturnValue('Newish (1)');
        await ensureVectorizationTip(CHAT_UUID, COLLECTION_ID, {});
        expect(listChunksMock).toHaveBeenCalledTimes(3);
    });

    it('falls back to the recorded tip when the backend reports no positions', async () => {
        listChunksMock.mockResolvedValue({ items: [{ text: 'no metadata', metadata: {} }] });
        expect(await ensureVectorizationTip(CHAT_UUID, COLLECTION_ID, {})).toBe(658);
        expect(extension_settings.vectfox.eventbase_vectorization_tip[CHAT_UUID]).toBe(658);
    });

    it('falls back to the recorded tip and retries later when the probe fails', async () => {
        listChunksMock.mockRejectedValueOnce(new Error('Qdrant unreachable'));
        expect(await ensureVectorizationTip(CHAT_UUID, COLLECTION_ID, {})).toBe(658);
        expect(await ensureVectorizationTip(CHAT_UUID, COLLECTION_ID, {})).toBe(9330);
        expect(listChunksMock).toHaveBeenCalledTimes(2);
    });

    it('rebases a beyond-chat tip for this session only, keeping recorded coverage', async () => {
        await ensureVectorizationTip(CHAT_UUID, COLLECTION_ID, {});
        expect(repairAutoSyncCoordinatesAfterShrink(CHAT_UUID, 3615, TURNS_20)).toBe(3480);
        expect(getAutoSyncMarker(CHAT_UUID)).toBe(3480);
        expect(getVectorizationTip(CHAT_UUID)).toBe(3480);
        expect(extension_settings.vectfox.eventbase_vectorization_tip[CHAT_UUID]).toBe(9330);
        // Same file, same session: the rebase sticks without another probe.
        expect(await ensureVectorizationTip(CHAT_UUID, COLLECTION_ID, {})).toBe(3480);
        expect(listChunksMock).toHaveBeenCalledTimes(1);
    });

    it("a short sibling's rebase cannot become the long chat's coverage", async () => {
        await ensureVectorizationTip(CHAT_UUID, COLLECTION_ID, {});
        repairAutoSyncCoordinatesAfterShrink(CHAT_UUID, 3615, TURNS_20);

        getCurrentChatId.mockReturnValue('Newish (1) - Branch #2');
        await ensureVectorizationTip(CHAT_UUID, COLLECTION_ID, {});
        repairAutoSyncCoordinatesAfterShrink(CHAT_UUID, 276, TURNS_20);
        expect(getVectorizationTip(CHAT_UUID)).toBe(120);
        expect(extension_settings.vectfox.eventbase_vectorization_tip[CHAT_UUID]).toBe(9330);

        // Back on the long chat: re-derived from the backend, not the branch's 120.
        getCurrentChatId.mockReturnValue('Newish (1)');
        expect(await ensureVectorizationTip(CHAT_UUID, COLLECTION_ID, {})).toBe(9330);
        expect(repairAutoSyncCoordinatesAfterShrink(CHAT_UUID, 3615, TURNS_20)).toBe(3480);
        expect(getVectorizationTip(CHAT_UUID)).toBe(3480);
    });

    it('a pending manual start point survives the shrink repair', async () => {
        getChatUUID.mockReturnValue(CHAT_UUID);
        getContext.mockReturnValue({ chat: Array.from({ length: 3615 }, () => ({ mes: 'message' })) });
        prepareMessagesForEventBase.mockImplementation(messages => ({ messages: messages || [] }));

        expect(setAutoSyncStartPoint(CHAT_UUID, 0, TURNS_20)).toBe(0);
        await ensureVectorizationTip(CHAT_UUID, COLLECTION_ID, {});
        expect(repairAutoSyncCoordinatesAfterShrink(CHAT_UUID, 3615, TURNS_20)).toBe(0);
        expect(getAutoSyncMarker(CHAT_UUID)).toBe(0);
        expect(hasPendingAutoSyncRecheck(CHAT_UUID)).toBe(true);
        // Coverage is still reported separately from the restart point.
        expect(getVectorizationTip(CHAT_UUID)).toBe(3480);
    });
});

describe('stampAutoSyncMarker — manual start point', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearVectorizationTip(CHAT_UUID);
        extension_settings.vectfox = {
            eventbase_autosync_start_marker: { [CHAT_UUID]: 100 },
            eventbase_vectorization_tip: { [CHAT_UUID]: 100 },
        };
        getChatUUID.mockReturnValue(CHAT_UUID);
        getCurrentChatId.mockReturnValue('chat');
        getContext.mockReturnValue({ chat: Array.from({ length: 30 }, () => ({ mes: 'message' })) });
        prepareMessagesForEventBase.mockImplementation(messages => ({ messages: messages || [] }));
    });

    it('keeps a pending start point, re-aligned to the current window size', async () => {
        setAutoSyncStartPoint(CHAT_UUID, 14, {}); // 1 turn → marker 14
        expect(await stampAutoSyncMarker(CHAT_UUID, { eventbase_autosync_window_turns: 3 })).toBe(12);
        expect(getAutoSyncMarker(CHAT_UUID)).toBe(12);
        expect(hasPendingAutoSyncRecheck(CHAT_UUID)).toBe(true);
        expect(listChunksMock).not.toHaveBeenCalled();
    });

    it('"Just keep up from here" overrides the start point and retires the re-check', async () => {
        setAutoSyncStartPoint(CHAT_UUID, 14, {});
        expect(await stampAutoSyncMarker(CHAT_UUID, {}, { floor: 'chatLength' })).toBe(30);
        expect(hasPendingAutoSyncRecheck(CHAT_UUID)).toBe(false);
    });
});

function makeItem(sourceWindowEnd, overrides = {}) {
    return {
        text: `[dialogue_significant] event at ${sourceWindowEnd}`,
        metadata: { source_window_end: sourceWindowEnd, event_id: `evt_${sourceWindowEnd}`, ...overrides },
    };
}

describe('getEventsSince', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getCollectionRegistryMock.mockReturnValue([`qdrant:${COLLECTION_ID}`]);
    });

    it('returns an empty result with no chatUUID', async () => {
        const result = await getEventsSince(null, -1, {});
        expect(result).toEqual({ schemaVersion: 1, events: [], tip: -1 });
        expect(listChunksMock).not.toHaveBeenCalled();
    });

    it('returns an empty result when no Qdrant EventBase collection matches the chat', async () => {
        getCollectionRegistryMock.mockReturnValue([]);
        const result = await getEventsSince(CHAT_UUID, -1, {});
        expect(result).toEqual({ schemaVersion: 1, events: [], tip: -1 });
    });

    it('returns events with source_window_end at or above the marker (inclusive)', async () => {
        listChunksMock.mockResolvedValue({
            items: [makeItem(5), makeItem(10), makeItem(15)],
        });

        const result = await getEventsSince(CHAT_UUID, 10, {});

        expect(result.schemaVersion).toBe(1);
        expect(result.events.map((e) => e.event_id)).toEqual(['evt_10', 'evt_15']);
        // tip reflects the collection's overall high-water mark (15+1), not
        // just the filtered slice, so callers can persist it unconditionally.
        expect(result.tip).toBe(16);
    });

    it('a window ending exactly at a persisted tip is not skipped (off-by-one regression)', async () => {
        // First read: collection tops out at window end 15 → caller persists tip 16.
        listChunksMock.mockResolvedValue({ items: [makeItem(15)] });
        const first = await getEventsSince(CHAT_UUID, -1, {});
        expect(first.tip).toBe(16);

        // Next ingestion produces a window ending EXACTLY at that tip. With an
        // exclusive bound (end > 16) evt_16 would never be returned by any
        // future call — the tip only moves further past it.
        listChunksMock.mockResolvedValue({ items: [makeItem(15), makeItem(16)] });
        const second = await getEventsSince(CHAT_UUID, first.tip, {});

        expect(second.events.map((e) => e.event_id)).toEqual(['evt_16']);
        expect(second.tip).toBe(17);
    });

    it('tip is derived from the whole collection even when the filtered slice is empty', async () => {
        listChunksMock.mockResolvedValue({ items: [makeItem(3), makeItem(7)] });

        const result = await getEventsSince(CHAT_UUID, 100, {});

        expect(result.events).toHaveLength(0);
        expect(result.tip).toBe(8);
    });

    it('a negative marker returns every event in the collection', async () => {
        listChunksMock.mockResolvedValue({ items: [makeItem(0), makeItem(1)] });

        const result = await getEventsSince(CHAT_UUID, -1, {});

        expect(result.events).toHaveLength(2);
    });

    it('degrades to an empty result (not a throw) when the backend read fails', async () => {
        listChunksMock.mockRejectedValue(new Error('Qdrant unreachable'));

        const result = await getEventsSince(CHAT_UUID, 5, {});

        expect(result).toEqual({ schemaVersion: 1, events: [], tip: 5 });
    });
});
