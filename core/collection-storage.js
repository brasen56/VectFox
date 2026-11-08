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

export function collectionStorageDescriptor(collection, preferredModel) {
    const resolved = resolveBackendForCollection(collection.registryKey || collection.id || collection.collectionId);
    const backend = normalizeBackendForId(resolved.backend || collection.backend);
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

export async function resolveCollectionStorage(key, settings = {}) {
    const { resolveStoredCollection } = await import('./collection-storage-host.js');
    return resolveStoredCollection(key, settings);
}

/** Adapters honor this explicit routing descriptor, including an intentionally empty model. */
export function collectionStorageSettings(settings, storage) {
    return { ...settings, vector_backend: storage.backend, embedding_provider: storage.source,
        collection_storage: storage };
}