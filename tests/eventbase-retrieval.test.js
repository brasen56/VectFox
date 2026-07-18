/**
 * EventBase Retrieval Tests
 *
 * Primary purpose: REGRESSION GUARD for the "log is not defined" class of bug.
 * retrieveEvents() once referenced `log` (via log.enabled) without importing it,
 * throwing "ReferenceError: log is not defined" the moment the function ran —
 * but only at message-send time, never at import time, so npm test stayed green
 * and it shipped. This test CALLS retrieveEvents so any missing import / runtime
 * reference error inside the function body surfaces as a failure here.
 *
 * Isolation strategy (important — do NOT replace with a global vitest alias):
 * every DIRECT import of eventbase-retrieval.js is mocked below. Because all six
 * dependencies are stubbed, none of them load, so the SillyTavern host modules
 * they transitively pull in (script.js, secrets.js, extensions.js, ...) are
 * never resolved. This keeps the blast radius to this one file and needs no
 * vitest.config.js change. See [[project_vitest_host_stub]] for why the global
 * alias approach was abandoned (it collided with other tests' vi.mock calls).
 *
 * NOTE on mocking ./log.js: the `import { log }` line must still EXIST in the
 * source for the `log` binding to resolve to this mock. If someone deletes that
 * import again, `log` becomes an undefined reference and the call-time tests
 * below throw — exactly the regression we are guarding against.
 * 
 * npx vitest run --reporter=verbose 2>&1 | Tee-Object -FilePath C:\tmp\vitest-out.txt
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mock every DIRECT dependency of core/eventbase-retrieval.js ---
const queryCollectionMock = vi.fn();
vi.mock('../core/core-vector-api.js', () => ({
    queryCollection: (...a) => queryCollectionMock(...a),
}));

// Native-rerank path only (Qdrant + opt-in), not exercised here — stub to null.
vi.mock('../backends/backend-manager.js', () => ({
    getBackendForCollection: vi.fn(async () => null),
    getBackend: vi.fn(async () => null),
}));

vi.mock('../core/collection-ids.js', () => ({
    parseRegistryKey: vi.fn((id) => ({ backend: null, collectionId: id })),
}));

vi.mock('../core/eventbase-schema.js', () => ({
    parseEmbedText: vi.fn(() => ({})),
}));

const checkPluginAvailableMock = vi.fn(async () => true);
vi.mock('../core/collection-loader.js', () => ({
    checkPluginAvailable: (...a) => checkPluginAvailableMock(...a),
}));

// Permissive log stub: every level is a no-op, predicates return false so the
// debug branches stay quiet. Mocking this avoids loading log.js -> extensions.js
// while STILL requiring the `import { log }` line to exist in the source.
vi.mock('../core/log.js', () => ({
    log: {
        enabled: () => false,
        domainEnabled: () => false,
        error: () => {},
        warn: () => {},
        lifecycle: () => {},
        verbose: () => {},
        trace: () => {},
        domain: () => {},
    },
    LOG_DOMAINS: [],
}));

import { retrieveEvents } from '../core/eventbase-retrieval.js';

const baseSettings = {
    vector_backend: 'standard',
    eventbase_retrieval_top_k: 8,
    eventbase_retrieval_min_importance: 1,
};

function makeEvent(i, overrides = {}) {
    return {
        event_id: `evt_${i}`,
        event_type: `type_${i}`,
        text: `Event number ${i} happened in the story.`,
        importance: 5,
        should_persist: false,
        source_window_end: i,
        score: 0.9 - i * 0.01,
        keywords: [`kw${i}`],
        ...overrides,
    };
}

beforeEach(() => {
    queryCollectionMock.mockReset();
    checkPluginAvailableMock.mockReset();
    checkPluginAvailableMock.mockResolvedValue(true);
});

describe('retrieveEvents', () => {
    it('runs without throwing a ReferenceError (missing-import regression guard)', async () => {
        // THE guard: the original bug threw "ReferenceError: log is not defined"
        // on the first line of the function body. This call would have failed.
        queryCollectionMock.mockResolvedValue({ hashes: [], metadata: [] });

        await expect(retrieveEvents({
            searchText: 'what happened to the hero',
            keywordQuery: 'hero',
            chatLength: 50,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [],
            skipLiveQuery: false,
        })).resolves.not.toThrow();
    });

    it('returns the {events, debug} shape', async () => {
        queryCollectionMock.mockResolvedValue({ hashes: [], metadata: [] });

        const result = await retrieveEvents({
            searchText: 'recap',
            keywordQuery: 'recap',
            chatLength: 50,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [],
            skipLiveQuery: false,
        });

        expect(result).toBeTypeOf('object');
        expect(Array.isArray(result.events)).toBe(true);
        expect(result.debug).toBeTypeOf('object');
    });

    it('returns ranked events from the live query (non-empty path)', async () => {
        const metadata = [makeEvent(1), makeEvent(2), makeEvent(3)];
        queryCollectionMock.mockResolvedValue({
            hashes: metadata.map(m => m.event_id),
            metadata,
        });

        const { events, debug } = await retrieveEvents({
            searchText: 'story recap',
            keywordQuery: 'story',
            chatLength: 100,
            settings: baseSettings,
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [],
            skipLiveQuery: false,
        });

        expect(queryCollectionMock).toHaveBeenCalled();
        expect(events.length).toBeGreaterThan(0);
        expect(debug.rawCount).toBeGreaterThan(0);
    });

    it('skips the live query and folds in archive candidates without calling the backend', async () => {
        const archive = [makeEvent(10), makeEvent(11)];

        const { events, debug } = await retrieveEvents({
            searchText: 'recap',
            keywordQuery: 'recap',
            chatLength: 100,
            settings: baseSettings,
            liveCollectionIds: [],
            additionalCandidates: archive,
            skipLiveQuery: true,
        });

        expect(queryCollectionMock).not.toHaveBeenCalled();
        expect(debug.archiveCandidates).toBe(2);
        expect(Array.isArray(events)).toBe(true);
    });

    it('filters out events below minimum importance', async () => {
        const metadata = [
            makeEvent(1, { importance: 9 }),
            makeEvent(2, { importance: 1 }),
        ];
        queryCollectionMock.mockResolvedValue({
            hashes: metadata.map(m => m.event_id),
            metadata,
        });

        const { debug } = await retrieveEvents({
            searchText: 'q',
            keywordQuery: 'q',
            chatLength: 100,
            settings: { ...baseSettings, eventbase_retrieval_min_importance: 5 },
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [],
            skipLiveQuery: false,
        });

        // Only the importance-9 event survives the >=5 filter.
        expect(debug.afterImportanceFilter).toBe(1);
    });
});

describe('retrieveEvents — story-time recency (eventbase_recency_source)', () => {
    // Recency-only weights so ranking isolates the recency term. Cosine 0 also
    // sidesteps the mocked-score interference; importance/persist equal on all
    // events; distinct event_types keep the pairwise dedup out of the way.
    const storySettings = {
        ...baseSettings,
        eventbase_recency_source: 'story_time',
        eventbase_rerank_w_cosine: 0,
        eventbase_rerank_w_importance: 0,
        eventbase_rerank_w_persist: 0,
        eventbase_rerank_w_recency: 1,
        eventbase_anchor_boost: 0,
    };

    // The ILS-flatten scenario: stale expanded-coordinate index (1900) on the
    // OLD event vs fresh collapsed-coordinate index (10) on the NEW event, in
    // a chat whose live length is 400. Index recency clamps the stale event to
    // age 0 (max bonus) and decays the fresh one — inverted. Story time reads
    // the narrative clock instead.
    const oldEvent = () => makeEvent(1, {
        source_window_end: 1900, DateTime: '2025-01-01', score: 0.5,
    });
    const newEvent = () => makeEvent(2, {
        source_window_end: 10, DateTime: '2026-06-12', score: 0.5,
    });

    it('ranks by narrative clock where index mode inverts (stale ILS coordinates)', async () => {
        const metadata = [oldEvent(), newEvent()];
        queryCollectionMock.mockResolvedValue({
            hashes: metadata.map(m => m.event_id),
            metadata,
        });

        // Index mode first: the stale-coordinate event wins (the distortion).
        const indexRun = await retrieveEvents({
            searchText: 'recap', keywordQuery: 'recap', chatLength: 400,
            settings: { ...storySettings, eventbase_recency_source: 'index' },
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [], skipLiveQuery: false,
        });
        expect(indexRun.events[0].event_id).toBe('evt_1');

        // Story mode: the narratively-recent event wins.
        queryCollectionMock.mockResolvedValue({
            hashes: metadata.map(m => m.event_id),
            metadata: [oldEvent(), newEvent()],
        });
        const storyRun = await retrieveEvents({
            searchText: 'recap', keywordQuery: 'recap', chatLength: 400,
            settings: storySettings,
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [], skipLiveQuery: false,
            recentMessageTexts: ['3:45 PM, June 12, 2026 — the plaza was quiet.'],
        });
        expect(storyRun.events[0].event_id).toBe('evt_2');
        expect(storyRun.debug.recencySource).toBe('story_time');
        expect(storyRun.debug.storyRecency.valid).toBe(true);
        expect(storyRun.debug.storyRecency.nowSource).toBe('both');
        expect(storyRun.debug.storyRecency.halfLifeDays).toBeGreaterThan(0);
    });

    it('suppresses native rerank while story-time recency is active', async () => {
        queryCollectionMock.mockResolvedValue({ hashes: [], metadata: [] });

        const nativeSettings = {
            ...storySettings,
            vector_backend: 'qdrant',
            eventbase_native_rerank: true,
        };
        const storyRun = await retrieveEvents({
            searchText: 'q', keywordQuery: 'q', chatLength: 100,
            settings: nativeSettings,
            liveCollectionIds: ['qdrant:vf_eventbase_x'],
            additionalCandidates: [], skipLiveQuery: false,
        });
        expect(storyRun.debug.nativeRerank).toBe(false);

        const indexRun = await retrieveEvents({
            searchText: 'q', keywordQuery: 'q', chatLength: 100,
            settings: { ...nativeSettings, eventbase_recency_source: 'index' },
            liveCollectionIds: ['qdrant:vf_eventbase_x'],
            additionalCandidates: [], skipLiveQuery: false,
        });
        expect(indexRun.debug.nativeRerank).toBe(true);
    });

    it('degrades to neutral scoring when no DateTime exists anywhere', async () => {
        const metadata = [makeEvent(1), makeEvent(2)];   // no DateTime fields
        queryCollectionMock.mockResolvedValue({
            hashes: metadata.map(m => m.event_id),
            metadata,
        });

        const { events, debug } = await retrieveEvents({
            searchText: 'recap', keywordQuery: 'recap', chatLength: 400,
            settings: storySettings,
            liveCollectionIds: ['standard:vf_eventbase_x'],
            additionalCandidates: [], skipLiveQuery: false,
            recentMessageTexts: ['no timestamps in this message'],
        });

        // Nothing throws, events still come back, ctx reports invalid.
        expect(events.length).toBe(2);
        expect(debug.storyRecency.valid).toBe(false);
    });
});
