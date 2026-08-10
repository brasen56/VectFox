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

import { getEventsSince } from '../core/eventbase-store.js';

const CHAT_UUID = 'test-uuid-1234';
const COLLECTION_ID = `vf_eventbase_qdrant_${CHAT_UUID}`;

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
