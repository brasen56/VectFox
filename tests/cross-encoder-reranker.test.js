import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('../core/log.js', () => ({ log: { warn: vi.fn() } }));
import { rerankEventCandidates, parseCrossEncoderResults } from '../core/cross-encoder-reranker.js';
import { resolveCrossEncoderMaxDocuments, resolveCrossEncoderTimeoutMs } from '../core/cross-encoder-settings.js';
import { resolveEventBaseRetrievalTimeoutMs } from '../core/retrieval-budget.js';

const settings = { eventbase_cross_encoder_enabled: true, eventbase_cross_encoder_api_url: 'http://localhost:8000/v1/' };
const events = [0, 1, 2].map(i => ({ event_id: `e${i}`, summary: `summary ${i}`, _finalScore: 1 - i / 10 }));
beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('cross-encoder reranker', () => {
    it('is a no-op when disabled, with no query, or fewer than two renderable events', async () => {
        for (const [pool, query, config] of [[events, 'query', {}], [events, '', settings],
            [events.slice(0, 1), 'query', settings], [[{}, events[0]], 'query', settings]]) {
            expect((await rerankEventCandidates(pool, query, config)).events).toBe(pool);
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    it('normalizes the endpoint, sends auth/model and all top_n, preserves scores and inputs', async () => {
        fetch.mockResolvedValue({ ok: true, json: async () => ({ results: [
            { index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 },
        ] }) });
        const result = await rerankEventCandidates(events, ' query ', { ...settings,
            eventbase_cross_encoder_model: 'model', eventbase_cross_encoder_api_key: 'key', eventbase_cross_encoder_max_documents: 2 });
        expect(fetch.mock.calls[0][0]).toBe('http://localhost:8000/v1/rerank');
        const request = fetch.mock.calls[0][1];
        expect(request.headers.Authorization).toBe('Bearer key');
        expect(JSON.parse(request.body)).toEqual({ query: 'query', documents: ['summary 0', 'summary 1'], top_n: 2, model: 'model' });
        expect(result.events.map(e => e.event_id)).toEqual(['e1', 'e0', 'e2']);
        expect(result.events[0]).toMatchObject({ _finalScore: 0.9, _crossEncoderScore: 0.9 });
        expect(events[1]._crossEncoderScore).toBeUndefined();
        expect(result.meta).toMatchObject({ used: true, documentsSent: 2, resultsReturned: 2 });
    });

    it('preserves omitted and empty-text events with correct explicit index mapping', async () => {
        fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ document_index: 1, score: -3 }] }) });
        const pool = [events[0], { event_id: 'empty' }, events[1], events[2]];
        const result = await rerankEventCandidates(pool, 'query', settings);
        expect(result.events.map(e => e.event_id)).toEqual(['e1', 'e0', 'empty', 'e2']);
        expect(new Set(result.events.map(e => e.event_id)).size).toBe(pool.length);
    });

    it('accepts score arrays and supported object formats but rejects ambiguous or corrupt rows', () => {
        expect(parseCrossEncoderResults([0.1, 0.8], 2)).toEqual([{ index: 1, score: 0.8 }, { index: 0, score: 0.1 }]);
        expect(parseCrossEncoderResults([{ documentIndex: 1, relevanceScore: 2 }], 2)).toEqual([{ index: 1, score: 2 }]);
        for (const payload of [{}, { results: [] }, [0.8], [{ score: 1 }],
            [{ index: 2, score: 1 }], [{ index: 0, score: NaN }], [{ index: 0, score: '1' }],
            [{ index: 0, score: 1 }, { index: 0, score: 2 }]]) {
            expect(() => parseCrossEncoderResults(payload, 2)).toThrow();
        }
    });

    it('falls back for HTTP, malformed response, network and configuration errors without leaking details', async () => {
        const failures = [
            () => Promise.resolve({ ok: false, status: 401 }),
            () => Promise.resolve({ ok: true, json: async () => ({ results: [{ score: 1 }] }) }),
            () => Promise.reject(new Error('secret key and story text')),
        ];
        for (const implementation of failures) {
            fetch.mockImplementation(implementation);
            const result = await rerankEventCandidates(events, 'query', settings);
            expect(result.events).toBe(events);
            expect(result.meta.used).toBe(false);
            expect(result.meta.error).not.toContain('secret');
        }
        fetch.mockClear();
        const invalid = await rerankEventCandidates(events, 'query', { ...settings, eventbase_cross_encoder_api_url: 'file:///secret' });
        expect(invalid.events).toBe(events);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('bounds even a fetch that ignores abort and cancels the request', async () => {
        vi.useFakeTimers();
        fetch.mockImplementation(() => new Promise(() => {}));
        const promise = rerankEventCandidates(events, 'query', { ...settings, eventbase_cross_encoder_timeout_ms: 1000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;
        expect(result.events).toBe(events);
        expect(result.meta.error).toContain('timed out');
        expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('clamps settings and adds one reranker timeout to the outer budget only when enabled', () => {
        expect(resolveCrossEncoderMaxDocuments({ eventbase_cross_encoder_max_documents: 999 })).toBe(200);
        expect(resolveCrossEncoderMaxDocuments({ eventbase_cross_encoder_max_documents: 'bad' })).toBe(50);
        expect(resolveCrossEncoderTimeoutMs({ eventbase_cross_encoder_timeout_ms: 1 })).toBe(1000);
        expect(resolveCrossEncoderTimeoutMs({ eventbase_cross_encoder_timeout_ms: Infinity })).toBe(10000);
        const base = { retrieval_timeout_ms: 15000, agentic_retrieval_enabled: true, vector_backend: 'qdrant' };
        expect(resolveEventBaseRetrievalTimeoutMs({ ...base, ...settings }) - resolveEventBaseRetrievalTimeoutMs(base)).toBe(10000);
    });
});