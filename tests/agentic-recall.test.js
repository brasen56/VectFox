import { describe, it, expect, vi, beforeEach } from 'vitest';

// Exercise the real retrieval and agent merge; isolate only host/network dependencies.
vi.mock('../../../../extensions.js', () => ({ getContext: () => ({ chat: [] }) }));
vi.mock('../core/core-vector-api.js', () => ({ queryCollection: vi.fn(), supportsCollectionFilters: async () => true }));
vi.mock('../backends/backend-manager.js', () => ({ getBackendForCollection: async () => null, getBackend: async () => null }));
vi.mock('../core/collection-loader.js', () => ({ checkPluginAvailable: async () => true }));
vi.mock('../core/collection-ids.js', () => ({ parseRegistryKey: id => ({ backend: null, collectionId: id }) }));
vi.mock('../core/eventbase-schema.js', () => ({ parseEmbedText: () => ({}) }));
vi.mock('../core/character-roster.js', () => ({ getCharacterRoster: () => ({ groups: [] }), normalizeCharacterName: name => name.trim().toLowerCase() }));
vi.mock('../core/prompts-i18n.js', () => ({ buildPlannerUserMessage: () => 'context', getAgenticPlannerPrompt: () => 'prompt' }));
vi.mock('../core/text-cleaning.js', () => ({ stripReasoningBlocks: text => text, stripGameSystemBlocks: text => text }));
vi.mock('../core/api-keys.js', () => ({ getOpenRouterApiKey: () => 'key', getCustomApiKey: () => 'key' }));
vi.mock('../core/llm-provider-call.js', () => ({ postChatCompletion: vi.fn(), resolveModelParameterStyle: () => ({}), LlmCallError: class extends Error {} }));
vi.mock('../core/generation-rate-limiter.js', () => ({ generationRateLimiter: { execute: fn => fn() }, generationRateLimitSettings: () => ({}) }));
vi.mock('../core/log.js', () => ({ log: {
    enabled: () => false, domainEnabled: () => false, error: vi.fn(), warn: vi.fn(),
    lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), domain: vi.fn(),
} }));

import { retrieveEvents } from '../core/eventbase-retrieval.js';
import { retrieveEventsWithAgent } from '../core/agentic-retrieval.js';
import { queryCollection } from '../core/core-vector-api.js';
import { postChatCompletion } from '../core/llm-provider-call.js';
import { threadsDigest, buildResolvedBy } from '../core/continuity.js';

function fixture() {
    const resolved = { event_id: 'resolved', summary: 'Alex threatens to leave.', event_type: 'relationship_change',
        characters: ['Alex'], open_threads: ['Will Alex stay?'], importance: 5, source_window_end: 10, score: 0.70 };
    const unresolved = { ...resolved, event_id: 'unresolved', summary: 'Alex considers leaving.', source_window_end: 12, score: 0.65 };
    const resolver = { event_id: 'resolver', summary: 'Alex stays.', source_window_end: 40,
        continuity: { v: 1, resolves: [{ event_id: resolved.event_id, threads: 'all',
            threads_digest: threadsDigest(resolved), status: 'active' }] } };
    const events = [resolved, unresolved, resolver];
    return { searchText: 'scene', chatLength: 100, liveCollectionIds: ['qdrant:one'],
        additionalCandidates: [resolved, unresolved], continuityRoster: { events, resolvedBy: buildResolvedBy(events) },
        settings: { vector_backend: 'qdrant', agentic_retrieval_enabled: true, agent_model: 'model',
            eventbase_retrieval_top_k: 8, eventbase_rerank_w_cosine: 1,
            eventbase_rerank_w_importance: 0, eventbase_rerank_w_persist: 0, eventbase_rerank_w_recency: 0 } };
}

beforeEach(() => {
    vi.clearAllMocks();
    queryCollection.mockResolvedValue({ hashes: [], metadata: [] });
});

describe('Agent historical recall before duplicate suppression', () => {
    it.each([{ queries: [] }, { queries: ['history query'] }])('restores displaced resolved events with queries $queries', async ({ queries }) => {
        const params = fixture();
        const normal = await retrieveEvents(params);
        expect(normal.events.map(e => e.event_id)).toEqual(['unresolved']);
        if (queries.length) queryCollection.mockResolvedValue({ hashes: ['fanout'], metadata: [{
            event_id: 'fanout', summary: 'A later scene.', event_type: 'other',
            importance: 5, source_window_end: 60, score: 0.60,
        }] });
        postChatCompletion.mockResolvedValue({ content: JSON.stringify({ queries, recall_past_event: true }) });
        const result = await retrieveEventsWithAgent(params);
        expect(result.events.map(e => e.event_id)).toEqual(queries.length ? ['resolved', 'fanout'] : ['resolved']);
        expect(result.events[0]._resolvedDownrankEnabled).toBe(false);
    });

    it('keeps ordinary agent merges on the post-dedup pool', async () => {
        postChatCompletion.mockResolvedValue({ content: JSON.stringify({ queries: ['history query'] }) });
        const result = await retrieveEventsWithAgent(fixture());
        expect(result.events.map(e => e.event_id)).toEqual(['unresolved']);
    });

    it('reapplies importance and context eligibility during recall', async () => {
        const params = fixture();
        params.additionalCandidates.push({ ...params.additionalCandidates[0], event_id: 'low', importance: 1, score: 0.99 },
            { ...params.additionalCandidates[0], event_id: 'visible', source_window_end: 99, score: 0.99 });
        Object.assign(params.settings, { eventbase_retrieval_min_importance: 3, deduplication_depth: 5 });
        postChatCompletion.mockResolvedValue({ content: JSON.stringify({ queries: ['history query'], recall_past_event: true }) });
        expect((await retrieveEventsWithAgent(params)).events.map(e => e.event_id)).toEqual(['resolved']);
    });
});