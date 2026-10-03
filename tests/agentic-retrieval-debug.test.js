import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../extensions.js', () => ({ getContext: () => ({ chat: [] }) }));
vi.mock('../core/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn() }));
vi.mock('../core/core-vector-api.js', () => ({ queryCollection: vi.fn() }));
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

import { retrieveEventsWithAgent } from '../core/agentic-retrieval.js';
import { retrieveEvents } from '../core/eventbase-retrieval.js';
import { queryCollection } from '../core/core-vector-api.js';
import { postChatCompletion } from '../core/llm-provider-call.js';

beforeEach(() => vi.clearAllMocks());

describe('Agent Mode recall diagnostics', () => {
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