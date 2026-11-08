/** Host-independent collection backend routing, shared by APIs and session caches. */
/**
 * Backend labels that legitimately appear in collection IDs.
 * `vectra` is recognized for backwards compatibility — it's the internal
 * storage name. New IDs always use `standard` instead.
 * Exported so other helpers (parsers, remappers) share one truth.
 */
export const KNOWN_BACKEND_LABELS = Object.freeze(['standard', 'qdrant', 'vectra']);

/**
 * Normalize backend names used in IDs.
 * Keeps old alias "vectra" mapped to "standard" to avoid split IDs.
 * Exported (was private) so collection-export.js and any other caller stops
 * rolling its own version. See Doc/collection_helper.md (single-source-of-truth rule).
 *
 * @param {string} backend
 * @returns {string} normalized backend label suitable for use in a collection ID
 */
export function normalizeBackendForId(backend) {
    const b = String(backend || '').toLowerCase();
    if (!b) return '';
    return b === 'vectra' ? 'standard' : b;
}

/**
 * Parse the backend segment out of a VectFox collection ID.
 *
 * Collection IDs follow the shape:
 *   vf_{contentType}_{backend}_{handle}_{name}_{timestamp}
 *
 * Strips any registry-key prefix (`qdrant:`, `vectra:`, `standard:`) before
 * parsing so callers can pass either form.
 *
 * Returns null when the ID doesn't match any known VectFox shape — caller
 * should fall back to global settings in that case rather than guessing.
 *
 * @param {string} collectionId - bare or registry-keyed ID
 * @returns {string|null} backend label (`'qdrant'` | `'standard'`) or null
 */
export function getBackendFromCollectionId(collectionId) {
    if (!collectionId || typeof collectionId !== 'string') return null;
    // Strip the registry-key prefix if present (e.g. `qdrant:vf_lorebook_...`).
    const colonIdx = collectionId.indexOf(':');
    const bare = colonIdx > 0 ? collectionId.slice(colonIdx + 1) : collectionId;
    const match = bare.match(/^vf_[^_]+_([^_]+)_/);
    const backend = match?.[1];
    if (!backend) return null;
    return KNOWN_BACKEND_LABELS.includes(backend) ? normalizeBackendForId(backend) : null;
}

/**
 * Canonical resolver: given either a registry-key ("backend:collectionId")
 * or a bare collection ID, return the backend label + the bare collection ID.
 *
 * Use this anywhere routing must pick the right backend for a collection.
 * Replaces three previously-scattered patterns:
 *   1. `parseRegistryKey(id).backend ?? settings.vector_backend`  (silent wrong
 *       backend for mixed-backend users; root cause of the 2026-05-23 EventBase
 *       cross-backend retrieval bug)
 *   2. `getBackendFromCollectionId(bareId)` alone (works for bare, but doesn't
 *       handle the case where the caller already has a registry-key form)
 *   3. Hand-rolled `id.includes('qdrant') ? 'qdrant' : 'standard'` (drift bait)
 *
 * Resolution order:
 *   1. If the input has a known backend prefix (`qdrant:` / `vectra:` /
 *      `standard:`), use that. This is the canonical post-2026-05-23 form.
 *   2. Otherwise, try to detect the backend from the ID's structure
 *      (`vf_<kind>_<backend>_…`). Handles legacy bare entries from before
 *      the registry-key convention.
 *   3. If both fail, return `{ backend: null }`. Caller decides whether to
 *      throw, warn, or fall through to a settings-level default.
 *
 * The returned `collectionId` is always the BARE form — backend methods
 * (e.g. StandardBackend.queryCollection, plugin REST calls) expect bare IDs
 * and route by the `backend` field returned here.
 *
 * @param {string} input - registry key or bare collection ID
 * @returns {{ backend: string|null, collectionId: string }}
 *   `backend` is one of {@link KNOWN_BACKEND_LABELS} or `null` if unresolvable.
 *   `collectionId` is always the bare form.
 */
export function resolveBackendForCollection(input) {
    const parsed = parseRegistryKey(input);
    if (parsed.backend) {
        return { backend: parsed.backend, collectionId: parsed.collectionId };
    }
    const detected = getBackendFromCollectionId(parsed.collectionId);
    return { backend: detected, collectionId: parsed.collectionId };
}

/**
 * Extracts backend and source from a registry key
 * Registry keys can be:
 * - "backend:source:collectionId" (new format)
 * - "source:collectionId" (migration format)
 * - "collectionId" (legacy format)
 *
 * @param {string} registryKey Registry key to parse
 * @returns {{backend: string|null, source: string|null, collectionId: string}} Parsed key
 */
export function parseRegistryKey(registryKey) {
    if (!registryKey || typeof registryKey !== 'string') {
        return { backend: null, source: null, collectionId: '' };
    }

    // Known storage backends
    const knownBackends = ['standard', 'vectra', 'qdrant'];

    const parts = registryKey.split(':');

    // Current format: backend:collectionId (starts with a known backend)
    if (parts.length >= 2 && knownBackends.includes(parts[0])) {
        return {
            backend: parts[0],
            source: null,
            collectionId: parts.slice(1).join(':'),
        };
    }

    // Legacy format: just collectionId (no recognized prefix)
    return { backend: null, source: null, collectionId: registryKey };
}
