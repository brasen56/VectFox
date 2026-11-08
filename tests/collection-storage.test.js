import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ preferred: undefined, backends: {} }));
vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}), saveSettingsDebounced: vi.fn() }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} } }));
vi.mock('../../../../openai.js', () => ({ oai_settings: {} }));
vi.mock('../core/collection-ids.js', async () => ({ ...await import('../core/collection-id-routing.js'), INTERNAL_COLLECTION_IDS: [] }));
vi.mock('../core/collection-metadata.js', () => ({ getCollectionMeta: () => ({ preferredModel: mocks.preferred }) }));
vi.mock('../core/providers.js', () => ({ getModelFromSettings: settings => settings.embedding_ollama_model || '', resolveProviderApiUrl: vi.fn() }));
vi.mock('../core/api-keys.js', () => ({ getQdrantApiKey: vi.fn() }));
vi.mock('../core/log.js', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('../core/embedding-latency-warning.js', () => ({ warnIfEmbeddingSlow: vi.fn() }));
vi.mock('../core/collection-export.js', () => ({ fetchChunksWithVectors: vi.fn() }));
vi.mock('../core/llm-provider-call.js', () => ({ postChatCompletion: vi.fn(), parseJsonArrayFromLlm: vi.fn(), resolveModelParameterStyle: vi.fn() }));
vi.mock('../core/generation-rate-limiter.js', () => ({ generationRateLimiter: {}, generationRateLimitSettings: vi.fn() }));
vi.mock('../backends/backend-manager.js', () => ({
    getBackendForCollection: async backend => mocks.backends[backend], getBackend: vi.fn(),
}));

import { StandardBackend } from '../backends/standard.js';
import { QdrantBackend } from '../backends/qdrant.js';
import { ensureCharacterIndex, invalidateCharacterIndex } from '../core/character-roster.js';
import { markEventResolved } from '../core/continuity-repair-service.js';
import { continuityActionSnapshot } from '../core/continuity.js';
import { resolveCollectionStorage, findCollectionByIdentity, collectionStorageDescriptor, collectionStorageSettings,
    primeCollectionDiscovery, invalidateCollectionDiscovery, DISCOVERY_MAX_AGE_MS, DISCOVERY_MISS_RETRY_MS } from '../core/collection-storage.js';
import { loadOpenThreads } from '../core/open-threads.js';

let collections, requests, discoveries;
beforeEach(() => {
    mocks.preferred = undefined;
    requests = [];
    discoveries = 0;
    invalidateCollectionDiscovery();
    // Shapes match the Similharity plugin's /collections output: vectra entries carry
    // source/model/models; Qdrant entries carry neither a model nor (often) a source.
    collections = [
        { id: 'archive', backend: 'vectra', source: 'ollama', model: 'model-A',
            models: [{ path: 'model-A', chunkCount: 1 }, { path: 'preferred-A', chunkCount: 1 }] },
        { id: 'archive', backend: 'qdrant', source: 'unknown', chunkCount: 1, modelCount: 1 },
    ];
    mocks.backends = { standard: new StandardBackend(), qdrant: new QdrantBackend() };
    mocks.backends.standard.pluginAvailable = true;
    for (const backend of ['standard', 'qdrant']) invalidateCharacterIndex(`${backend}:archive`);
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
        if (url.endsWith('/collections')) { discoveries++; return { ok: true, json: async () => ({ success: true, collections: [...collections] }) }; }
        const body = JSON.parse(options.body);
        requests.push({ url, ...body });
        // The plugin's Qdrant handler ignores source/model; vectra selects a bucket by them.
        const correct = body.backend === 'qdrant' || (body.source === 'ollama' && body.model === (mocks.preferred || 'model-A'));
        return { ok: true, json: async () => options.method === 'PATCH' ? { success: true }
            : { items: correct ? [{ hash: 1, metadata: { event_id: 'e', summary: 'Debt', open_threads: ['Pay'], characters: ['Kai'] } }] : [], total: correct ? 1 : 0 } };
    }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('archive storage routing through real adapters', () => {
    it.each(['standard', 'qdrant'].flatMap(backend => [false, true].flatMap(warm => ['transformers', 'ollama'].map(provider => [backend, warm, provider]))))(
        '%s archive (warm=%s) survives switching to %s', async (backend, warm, provider) => {
            const key = `${backend}:archive`;
            if (warm) await ensureCharacterIndex(key, { embedding_provider: 'ollama', embedding_ollama_model: 'model-A' });
            const settings = { embedding_provider: provider, embedding_ollama_model: 'model-B' };
            const inventory = await loadOpenThreads([key], settings, ensureCharacterIndex);
            expect(inventory.rows).toHaveLength(1);
            const entry = await ensureCharacterIndex(key, settings);
            await markEventResolved(key, 'e', settings, [0], 'Paid', continuityActionSnapshot(entry.events.get('e')));
            expect(requests.some(request => request.url.endsWith('/metadata'))).toBe(true);
            for (const request of requests) {
                expect(request).toMatchObject(backend === 'standard'
                    ? { backend: 'vectra', collectionId: 'archive', source: 'ollama', model: 'model-A' }
                    : { backend: 'qdrant', collectionId: 'archive' });
                expect(request.includeVectors).not.toBe(true);
            }
            // Discovery opens every index server-side: Standard shares one scan across the
            // panel load, warm-ups and the write; Qdrant routing never needs it.
            expect(discoveries).toBe(backend === 'standard' ? 1 : 0);
        });

    it('honors preferred model and rejects evidence reviewed at a different storage identity', async () => {
        const old = await ensureCharacterIndex('standard:archive', {});
        const reviewed = continuityActionSnapshot(old.events.get('e'));
        mocks.preferred = 'preferred-A';
        await expect(markEventResolved('standard:archive', 'e', {}, [0], 'Paid', reviewed)).rejects.toThrow('Refresh and review');
        expect(requests.at(-1)).toMatchObject({ model: 'preferred-A' });
        expect(requests.some(request => request.url.endsWith('/metadata'))).toBe(false);
    });

    it('fails closed without discovery metadata instead of accepting a wrong-source empty scan', async () => {
        collections = [];
        await expect(resolveCollectionStorage('standard:archive', {})).rejects.toThrow('Cannot uniquely resolve');
        expect(await ensureCharacterIndex('standard:archive', { embedding_provider: 'transformers' })).toBeNull();
        expect(requests).toEqual([]);
    });

    it('rejects ambiguous source buckets', async () => {
        collections.push({ ...collections[0], source: 'transformers', model: '' });
        await expect(resolveCollectionStorage('standard:archive')).rejects.toThrow('Cannot uniquely resolve');
    });
});

describe('shared discovery scan', () => {
    const resolve = key => resolveCollectionStorage(key, {});
    const fresh = { id: 'fresh', backend: 'vectra', source: 'ollama', model: 'm', models: [{ path: 'm', chunkCount: 1 }] };

    it('shares one scan across concurrent and repeated resolutions', async () => {
        await Promise.all([resolve('standard:archive'), resolve('standard:archive'), ensureCharacterIndex('standard:archive', {})]);
        await resolve('standard:archive');
        expect(discoveries).toBe(1);
    });

    it('rescans once the shared scan is older than the max age', async () => {
        let now = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        await resolve('standard:archive');
        now += DISCOVERY_MAX_AGE_MS;
        await resolve('standard:archive');
        expect(discoveries).toBe(1);
        now += 1;
        await resolve('standard:archive');
        expect(discoveries).toBe(2);
    });

    it('finds a new collection after a miss without rescanning on every miss', async () => {
        let now = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        await resolve('standard:archive');
        collections.push(fresh);
        await expect(resolve('standard:fresh')).rejects.toThrow('Cannot uniquely resolve');
        expect(discoveries).toBe(1);
        now += DISCOVERY_MISS_RETRY_MS + 1;
        await expect(resolve('standard:fresh')).resolves.toMatchObject({ collectionId: 'fresh', model: 'm' });
        expect(discoveries).toBe(2);
    });

    it('reuses a primed scan and rescans after invalidation', async () => {
        primeCollectionDiscovery(collections);
        await resolve('standard:archive');
        expect(discoveries).toBe(0);
        invalidateCollectionDiscovery();
        await resolve('standard:archive');
        expect(discoveries).toBe(1);
    });

    it('does not cache a failed scan', async () => {
        globalThis.fetch.mockImplementationOnce(async () => ({ ok: false, status: 503 }));
        await expect(resolve('standard:archive')).rejects.toThrow('503');
        await expect(resolve('standard:archive')).resolves.toMatchObject({ source: 'ollama' });
        expect(discoveries).toBe(1);
    });
});

describe('qdrant storage identity', () => {
    it('accepts plugin Qdrant entries that report no model and an unknown source', () => {
        const storage = collectionStorageDescriptor({ id: 'vf_eventbase_qdrant_alex_x', backend: 'qdrant', source: 'unknown', chunkCount: 1, modelCount: 1 });
        expect(storage).toMatchObject({ backend: 'qdrant', collectionId: 'vf_eventbase_qdrant_alex_x', source: null, model: null });
        expect(storage.identity).toBe(JSON.stringify(['qdrant', 'vf_eventbase_qdrant_alex_x']));
    });
    it('resolves bare Qdrant EventBase IDs without discovery and keeps the caller provider', async () => {
        const storage = await resolveCollectionStorage('vf_eventbase_qdrant_alex_x', {});
        expect(storage.backend).toBe('qdrant');
        expect(discoveries).toBe(0);
        expect(collectionStorageSettings({ embedding_provider: 'ollama' }, storage).embedding_provider).toBe('ollama');
    });
});

describe('source collection lookup', () => {
    it.each([['standard', 'vectra'], ['vectra', 'standard']])('navigates %s citations to %s collections', (requested, discovered) => {
        const target = { id: 'archive', backend: discovered };
        expect(findCollectionByIdentity([{ id: 'archive', backend: 'qdrant' }, target], `${requested}:archive`)).toBe(target);
    });
    it('matches registry keys and keeps identical bare IDs on separate backends', () => {
        const qdrant = { id: 'archive', registryKey: 'qdrant:archive', backend: 'qdrant' };
        const standard = { id: 'archive', registryKey: 'vectra:archive', backend: 'vectra' };
        expect(findCollectionByIdentity([qdrant, standard], 'standard:archive')).toBe(standard);
        expect(findCollectionByIdentity([standard, qdrant], 'qdrant:archive')).toBe(qdrant);
        expect(findCollectionByIdentity([qdrant], 'standard:archive')).toBeUndefined();
    });
});