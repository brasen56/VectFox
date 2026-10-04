import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../core/providers.js', () => ({ getModelFromSettings: () => 'model', resolveProviderApiUrl: () => '' }));
vi.mock('../core/api-keys.js', () => ({ getQdrantApiKey: () => '' }));
vi.mock('../core/embedding-latency-warning.js', () => ({ warnIfEmbeddingSlow: vi.fn() }));
vi.mock('../core/tokenizer-lock.js', () => ({
    detectTokenizerMismatch: vi.fn(async () => null), showTokenizerMismatchModal: vi.fn(),
    applyTokenizerRevert: vi.fn(), openCjkTokenizerSetting: vi.fn(),
}));
vi.mock('../core/sparse-vector-encoder.js', () => ({ encodeSparseQuery: () => ({ indices: [1], values: [1] }) }));
vi.mock('../core/log.js', () => ({ log: { warn: vi.fn(), enabled: () => false } }));

let backend;
let denseResult;
const settings = { embedding_provider: 'transformers', qdrant_multitenancy: false };
const filters = { characters_any: ['Brennan'], importance_gte: 5 };

beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('toastr', { warning: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async url => url.endsWith('/get-embedding')
        ? { ok: true, json: async () => ({ embedding: [0.1, 0.2] }) }
        : { ok: false, status: 400, text: async () => 'not existing vector name text_sparse' }));
    const { QdrantBackend } = await import('../backends/qdrant.js');
    backend = new QdrantBackend();
    denseResult = { hashes: [7], metadata: [{ characters: ['Unrelated'], importance: 1 }] };
    vi.spyOn(backend, 'queryCollection').mockResolvedValue(denseResult);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Qdrant dense fallback filter warnings', () => {
    it.each(['hybridQuery', 'hybridQueryWithRerank'])('%s warns on first failure and only once per session', async method => {
        const query = (activeFilters) => method === 'hybridQuery'
            ? backend.hybridQuery('collection', 'history', 5, settings, {}, activeFilters)
            : backend.hybridQueryWithRerank('collection', 'history', 5, settings, {}, {}, activeFilters);
        expect(await query(filters)).toEqual(denseResult);
        expect(toastr.warning).toHaveBeenCalledTimes(1);
        expect(toastr.warning.mock.calls[0][0]).toContain('unfiltered');
        const fetchCount = fetch.mock.calls.length;
        expect(await query(filters)).toEqual(denseResult);
        expect(fetch).toHaveBeenCalledTimes(fetchCount);
        expect(toastr.warning).toHaveBeenCalledTimes(1);
    });

    it.each(['hybridQuery', 'hybridQueryWithRerank'])('%s warns when filters first appear on a cached fallback', async method => {
        await backend.hybridQuery('collection', 'history', 5, settings);
        expect(toastr.warning).not.toHaveBeenCalled();
        const fetchCount = fetch.mock.calls.length;
        const result = method === 'hybridQuery'
            ? await backend.hybridQuery('collection', 'history', 5, settings, {}, filters)
            : await backend.hybridQueryWithRerank('collection', 'history', 5, settings, {}, {}, filters);
        expect(result).toEqual(denseResult);
        expect(fetch).toHaveBeenCalledTimes(fetchCount);
        expect(toastr.warning).toHaveBeenCalledTimes(1);
        expect(backend.queryCollection).toHaveBeenLastCalledWith('collection', 'history', 5, settings);
    });
});