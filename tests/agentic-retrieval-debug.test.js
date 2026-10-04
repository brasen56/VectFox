import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../extensions.js', () => ({ getContext: () => ({ chat: [] }) }));
vi.mock('../core/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn() }));
vi.mock('../core/core-vector-api.js', () => ({ queryCollection: vi.fn(), supportsCollectionFilters: vi.fn(async () => true) }));
vi.mock('../core/character-roster.js', () => ({
    getCharacterRoster: () => ({ groups: [] }), normalizeCharacterName: name => name.trim().toLowerCase(),
}));
vi.mock('../core/prompts-i18n.js', () => ({ buildPlannerUserMessage: () => 'context', getAgenticPlannerPrompt: () => 'prompt' }));
vi.mock('../core/text-cleaning.js', () => ({ stripReasoningBlocks: text => text, stripGameSystemBlocks: text => text }));
vi.mock('../core/api-keys.js', () => ({ getOpenRouterApiKey: () => 'key', getCustomApiKey: () => 'key' }));
vi.mock('../core/llm-provider-call.js', () => ({
    postChatCompletion: vi.fn(), resolveModelParameterStyle: () => ({}), LlmCallError: class extends Error {},
}));
vi.mock('../core/generation-rate-limiter.js', () => ({
    generationRateLimiter: { execute: fn => fn() }, generationRateLimitSettings: () => ({}),
}));
vi.mock('../core/log.js', () => ({ log: { domainEnabled: () => false, warn: vi.fn() } }));
vi.mock('../core/search-filter-support.js', () => ({ warnUnsupportedFilters: vi.fn() }));

import { retrieveEventsWithAgent, _validatePlannerFilters } from '../core/agentic-retrieval.js';
import { retrieveEvents } from '../core/eventbase-retrieval.js';
import { queryCollection, supportsCollectionFilters } from '../core/core-vector-api.js';
import { postChatCompletion } from '../core/llm-provider-call.js';
import { warnUnsupportedFilters } from '../core/search-filter-support.js';

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('Agent Mode recall diagnostics', () => {
    it.each(['never', 'late'])('bounds a %s capability lookup without blocking healthy collections', async mode => {
        vi.useFakeTimers();
        const preEvent = { event_id: 'pre' };
        const healthyEvent = { event_id: 'healthy' };
        retrieveEvents.mockResolvedValueOnce({ events: [preEvent], candidates: [preEvent], debug: {} })
            .mockResolvedValueOnce({ events: [preEvent, healthyEvent], debug: {} });
        postChatCompletion.mockResolvedValue({ content: JSON.stringify({ queries: ['history query', 'another query'],
            filters: { locations_any: ['office'] } }) });
        let resolveCapability;
        supportsCollectionFilters.mockImplementation(colId => colId === 'qdrant:slow'
            ? new Promise(resolve => { resolveCapability = resolve; }) : Promise.resolve(true));
        queryCollection.mockResolvedValue({ hashes: [42], metadata: [healthyEvent] });
        const pending = retrieveEventsWithAgent({ liveCollectionIds: ['qdrant:slow', 'qdrant:healthy'], settings: {
            agentic_retrieval_enabled: true, vector_backend: 'qdrant', agent_model: 'model',
            agentic_retrieval_query_timeout_ms: 1000 } });
        await vi.advanceTimersByTimeAsync(0);
        expect(queryCollection).toHaveBeenCalledTimes(2);
        expect(queryCollection.mock.calls.every(call => call[0] === 'qdrant:healthy')).toBe(true);
        expect(queryCollection.mock.calls[0][4]).toEqual({ locations_any: ['office'] });
        expect(supportsCollectionFilters).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1000);
        const result = await pending;
        expect(result.events).toEqual([preEvent, healthyEvent]);
        expect(retrieveEvents.mock.calls[1][0].additionalCandidates).toEqual([
            preEvent, { ...healthyEvent, _hash: 42, _sortFrame: 'qdrant:healthy' },
            { ...healthyEvent, _hash: 42, _sortFrame: 'qdrant:healthy' },
        ]);
        expect(warnUnsupportedFilters).toHaveBeenCalled();
        if (mode === 'late') {
            resolveCapability(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(queryCollection).toHaveBeenCalledTimes(2);
        }
        supportsCollectionFilters.mockResolvedValue(true);
    });

    it('strips lead groups, expands all NPC aliases, and retains unknown names', () => {
        const roster = { groups: [
            { name: 'Kai Tanaka', aliases: ['Kai', 'Kai Tanaka'], isLead: true },
            { name: 'Howard Brennan', aliases: ['Brennan', 'Howard Brennan'], isLead: false },
        ] };
        expect(_validatePlannerFilters({ characters_any: ['kai', 'Brennan', 'Unknown'], importance_gte: 5 }, {}, roster))
            .toEqual({ characters_any: ['Brennan', 'Howard Brennan', 'Unknown'] });
        expect(_validatePlannerFilters({ characters_any: ['Kai Tanaka'] }, {}, roster)).toEqual({});
        expect(_validatePlannerFilters({ importance_gte: 99 }, { agentic_importance_hard_filter: true }))
            .toEqual({ importance_gte: 10 });
        expect(_validatePlannerFilters({ characters_any: ['Brennan'] }, { agentic_filters_enabled: false }, roster)).toEqual({});
    });

    it('merges the full pre-trim pool without reintroducing excluded archive candidates', async () => {
        const pool = [{ event_id: 'top' }, { event_id: 'cut' }];
        retrieveEvents.mockResolvedValueOnce({ events: [pool[0]], candidates: pool, debug: {} })
            .mockResolvedValueOnce({ events: pool, candidates: pool, debug: {} });
        postChatCompletion.mockResolvedValue({ content: JSON.stringify({ queries: ['history query'], filters: { locations_any: ['office'] } }) });
        supportsCollectionFilters.mockResolvedValueOnce(false);
        queryCollection.mockResolvedValue({ hashes: [], metadata: [] });
        const result = await retrieveEventsWithAgent({ liveCollectionIds: ['qdrant:one'],
            additionalCandidates: [{ event_id: 'excluded' }], settings: { agentic_retrieval_enabled: true,
                vector_backend: 'qdrant', agent_model: 'model', eventbase_retrieval_overfetch: 55 } });
        expect(queryCollection.mock.calls[0][2]).toBe(55);
        expect(queryCollection.mock.calls[0][4]).toEqual({});
        expect(retrieveEvents.mock.calls[1][0].additionalCandidates).toEqual(pool);
        expect(result.candidates).toEqual(pool);
    });

    it('forwards supported entity filters but not the planner importance floor', async () => {
        retrieveEvents.mockResolvedValue({ events: [], candidates: [], debug: {} });
        postChatCompletion.mockResolvedValue({ content: JSON.stringify({ queries: ['history query'],
            filters: { characters_any: ['Brennan'], importance_gte: 5 } }) });
        queryCollection.mockResolvedValue({ hashes: [], metadata: [] });
        await retrieveEventsWithAgent({ liveCollectionIds: ['qdrant:one'], settings: {
            agentic_retrieval_enabled: true, vector_backend: 'qdrant', agent_model: 'model' } });
        expect(queryCollection.mock.calls[0][4]).toEqual({ characters_any: ['Brennan'] });
    });
    it('exposes planner cast detections even with filters disabled and no valid queries', async () => {
        retrieveEvents.mockResolvedValue({ events: [], debug: {} });
        postChatCompletion.mockResolvedValue({ content: JSON.stringify({ queries: [], filters: { characters_any: ['Brennan', 42] } }) });
        const result = await retrieveEventsWithAgent({ settings: { agentic_retrieval_enabled: true,
            vector_backend: 'qdrant', agent_model: 'model', agentic_filters_enabled: false } });
        expect(result.debug.plannerCharacters).toEqual(['Brennan']);
        expect(queryCollection).not.toHaveBeenCalled();
    });
    it('preserves pre-search cuts while counting final survivors for every planner query', async () => {
        const shared = { event_id: 'shared', text: 'shared memory' };
        const preCut = { outcome: 'cut_at_trim', summary: 'pre-search cut', stages: ['reached_pool', 'cut_at_trim'] };
        retrieveEvents.mockResolvedValueOnce({ events: [shared], debug: { candidateOutcomes: {
            preCut, shared: { outcome: 'injected' },
        } } }).mockResolvedValueOnce({ events: [shared], debug: { candidateOutcomes: {
            shared: { outcome: 'injected' }, plannerCut: { outcome: 'cut_at_trim' },
        } } });
        postChatCompletion.mockResolvedValue({ content: JSON.stringify({ queries: ['first query', 'second query', 'failed query'] }) });
        queryCollection.mockImplementation(async (col, query) => {
            if (query === 'failed query') throw new Error('unavailable');
            return { hashes: ['shared', 'plannerCut'], metadata: [shared, { event_id: 'plannerCut' }] };
        });
        const result = await retrieveEventsWithAgent({
            searchText: 'scene', keywordQuery: 'scene', liveCollectionIds: ['qdrant:one', 'qdrant:two'],
            settings: { agentic_retrieval_enabled: true, vector_backend: 'qdrant', agent_model: 'model' },
        });
        expect(result.debug.candidateOutcomes.preCut).toEqual(preCut);
        expect(result.debug.preSearchCandidateOutcomes.preCut).toEqual(preCut);
        expect(result.debug.plannerQuerySummary.map(q => [q.hitsReturned, q.uniqueHits, q.survivedCount]))
            .toEqual([[4, 2, 1], [4, 2, 1], [0, 0, 0]]);
        expect(result.debug.plannerQuerySummary[2].failedCalls).toBe(2);
        expect(retrieveEvents.mock.calls[1][0]).toMatchObject({ skipLiveQuery: true, liveCollectionIds: [] });
    });

    it('leaves pre-search diagnostics intact when Agent Mode is disabled', async () => {
        const preSearch = { events: [], debug: { candidateOutcomes: { cut: { outcome: 'failed_importance_filter' } } } };
        retrieveEvents.mockResolvedValue(preSearch);
        expect(await retrieveEventsWithAgent({ settings: {} })).toBe(preSearch);
        expect(postChatCompletion).not.toHaveBeenCalled();
    });
});