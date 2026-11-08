/** Metadata-only storage routing. Never infer an archive's bucket from global embedding settings. */
import { normalizeBackendForId, resolveBackendForCollection } from './collection-id-routing.js';

export function findCollectionByIdentity(collections, key, settings = {}) {
    const requested = resolveBackendForCollection(key);
    const backend = normalizeBackendForId(requested.backend || settings.vector_backend);
    return collections.find(item => {
        const candidate = resolveBackendForCollection(item.registryKey || item.id || item.collectionId);
        return candidate.collectionId === requested.collectionId
            && (!backend || normalizeBackendForId(candidate.backend || item.backend) === backend);
    });
}

/**
 * A Qdrant collection name is its whole physical location: the plugin's list,
 * metadata PATCH and vector reads ignore source/model, and its discovery never
 * reports a `model` (and often reports source 'unknown'). Requiring either would
 * reject every Qdrant archive, so its identity is the backend and name alone.
 */
function qdrantStorageDescriptor(collectionId) {
    return Object.freeze({ backend: 'qdrant', collectionId, source: null, model: null,
        identity: JSON.stringify(['qdrant', collectionId]) });
}

export function collectionStorageDescriptor(collection, preferredModel) {
    const resolved = resolveBackendForCollection(collection.registryKey || collection.id || collection.collectionId);
    const backend = normalizeBackendForId(resolved.backend || collection.backend);
    if (backend === 'qdrant') return qdrantStorageDescriptor(resolved.collectionId);
    const source = collection.source;
    const models = collection.models || [];
    const model = preferredModel !== undefined && models.some(item => item.path === preferredModel)
        ? preferredModel : collection.model;
    if (!backend || !source || source === 'unknown' || typeof model !== 'string') {
        throw new Error(`Cannot resolve collection storage source/model: ${resolved.collectionId}`);
    }
    return Object.freeze({ backend, collectionId: resolved.collectionId, source, model,
        identity: JSON.stringify([backend, resolved.collectionId, source, model]) });
}

/**
 * Plugin discovery opens every Vectra index on disk (and scrolls every Qdrant
 * collection), so one scan is shared by all resolvers instead of repeating it on
 * each roster call and continuity write. The preferred model is still read per
 * call from local metadata; only the on-disk bucket list is reused.
 */
export const DISCOVERY_MAX_AGE_MS = 5 * 60_000;
/** A key missing from a cached scan may be a new collection; rescan at most this often. */
export const DISCOVERY_MISS_RETRY_MS = 30_000;
let discovery = null;

/** Seed the shared scan from a fresh discovery made elsewhere (collection loader). */
export function primeCollectionDiscovery(collections) {
    if (Array.isArray(collections)) discovery = { at: Date.now(), promise: Promise.resolve(collections) };
}

/** Buckets were removed; the next resolver must rescan rather than reuse them. */
export function invalidateCollectionDiscovery() {
    discovery = null;
}

/** Concurrent callers share one in-flight scan; failures are never cached. */
export async function sharedCollectionDiscovery(fetchCollections, maxAgeMs = DISCOVERY_MAX_AGE_MS) {
    if (!discovery || Date.now() - discovery.at > maxAgeMs) {
        const current = { at: Date.now(), promise: Promise.resolve().then(fetchCollections) };
        current.promise.catch(() => { if (discovery === current) discovery = null; });
        discovery = current;
    }
    const { at, promise } = discovery;
    return { collections: await promise, at };
}

export async function resolveCollectionStorage(key, settings = {}) {
    const resolved = resolveBackendForCollection(key);
    // Qdrant needs no discovery lookup, which would also make the plugin scroll
    // every point of every Qdrant collection on each roster call.
    if (normalizeBackendForId(resolved.backend || settings.vector_backend) === 'qdrant') {
        return qdrantStorageDescriptor(resolved.collectionId);
    }
    const { resolveStoredCollection } = await import('./collection-storage-host.js');
    return resolveStoredCollection(key, settings);
}

/**
 * Adapters honor this explicit routing descriptor, including an intentionally
 * empty model. A null source/model (Qdrant) leaves the caller's settings alone.
 */
export function collectionStorageSettings(settings, storage) {
    return { ...settings, vector_backend: storage.backend,
        ...(storage.source != null ? { embedding_provider: storage.source } : {}),
        collection_storage: storage };
}