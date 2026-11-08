/** Host metadata access is lazy so the shared identity helpers remain host-independent. */
import { getRequestHeaders } from '../../../../../script.js';
import { getCollectionMeta } from './collection-metadata.js';
import { normalizeBackendForId, resolveBackendForCollection } from './collection-id-routing.js';
import { findCollectionByIdentity, collectionStorageDescriptor } from './collection-storage.js';

export async function resolveStoredCollection(key, settings = {}) {
    const response = await fetch('/api/plugins/similharity/collections', { method: 'GET', headers: getRequestHeaders() });
    if (!response.ok) throw new Error(`Cannot resolve collection storage: ${response.status}`);
    const data = await response.json();
    if (!data.success || !Array.isArray(data.collections)) throw new Error('Invalid collection storage metadata');
    const matches = data.collections.filter(item => findCollectionByIdentity([item], key, settings));
    if (matches.length !== 1) throw new Error(`Cannot uniquely resolve collection storage: ${key}`);
    const collection = matches[0];
    const resolved = resolveBackendForCollection(key);
    const backend = normalizeBackendForId(resolved.backend || settings.vector_backend || collection.backend);
    const meta = getCollectionMeta(`${backend}:${resolved.collectionId}`);
    const legacyMeta = backend === 'standard' ? getCollectionMeta(`vectra:${resolved.collectionId}`) : null;
    return collectionStorageDescriptor(collection, meta?.preferredModel ?? legacyMeta?.preferredModel);
}