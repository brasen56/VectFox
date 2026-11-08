/** Host metadata access is lazy so the shared identity helpers remain host-independent. */
import { getRequestHeaders } from '../../../../../script.js';
import { getCollectionMeta } from './collection-metadata.js';
import { normalizeBackendForId, resolveBackendForCollection } from './collection-id-routing.js';
import { findCollectionByIdentity, collectionStorageDescriptor, sharedCollectionDiscovery,
    DISCOVERY_MISS_RETRY_MS } from './collection-storage.js';

async function fetchDiscovery() {
    const response = await fetch('/api/plugins/similharity/collections', { method: 'GET', headers: getRequestHeaders() });
    if (!response.ok) throw new Error(`Cannot resolve collection storage: ${response.status}`);
    const data = await response.json();
    if (!data.success || !Array.isArray(data.collections)) throw new Error('Invalid collection storage metadata');
    return data.collections;
}

export async function resolveStoredCollection(key, settings = {}) {
    const matching = collections => collections.filter(item => findCollectionByIdentity([item], key, settings));
    const cached = await sharedCollectionDiscovery(fetchDiscovery);
    let matches = matching(cached.collections);
    if (!matches.length && Date.now() - cached.at > DISCOVERY_MISS_RETRY_MS) {
        matches = matching((await sharedCollectionDiscovery(fetchDiscovery, DISCOVERY_MISS_RETRY_MS)).collections);
    }
    if (matches.length !== 1) throw new Error(`Cannot uniquely resolve collection storage: ${key}`);
    const collection = matches[0];
    const resolved = resolveBackendForCollection(key);
    const backend = normalizeBackendForId(resolved.backend || settings.vector_backend || collection.backend);
    const meta = getCollectionMeta(`${backend}:${resolved.collectionId}`);
    const legacyMeta = backend === 'standard' ? getCollectionMeta(`vectra:${resolved.collectionId}`) : null;
    return collectionStorageDescriptor(collection, meta?.preferredModel ?? legacyMeta?.preferredModel);
}
