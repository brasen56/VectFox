/** Phase 4 scope contract. Historical retrieval deliberately does not use this gate. */
export function continuityBackendNamespace(registryKey, settings = {}) {
    const backend = /^(qdrant|standard|vectra):/.exec(registryKey)?.[1] || settings.vector_backend || 'standard';
    // A backend name alone cannot distinguish two servers or Qdrant tenants.
    return JSON.stringify([backend, backend === 'qdrant'
        ? [settings.qdrant_use_cloud === true, settings.qdrant_url || '', settings.qdrant_host || '',
            settings.qdrant_port || '', settings.qdrant_multitenancy ?? false] : []]);
}

export function continuityCollectionKey(namespace, collectionId) {
    if (!namespace || !collectionId) throw new Error('Backend namespace and collection ID are required');
    return JSON.stringify([namespace, collectionId]);
}

/** Identity is intentionally lossless, not a short hash. No unrelated message-count fallback. */
export function resolveContinuityScope({ continuityId, namespace, collections = [], chatId, branchId = chatId,
    frames = [], horizon = null, revision = 0, aliasRevision = 0, declaredCollections = [] }) {
    if (!continuityId || !namespace || !chatId || !branchId) throw new Error('Incomplete continuity scope');
    const locked = [...new Set(collections)].sort();
    const declared = [...new Set(declaredCollections)].filter(id => locked.includes(id)).sort();
    const mapping = frames.map(frame => ({ collection: frame.collection, chatId: frame.chatId,
        frameId: frame.frameId, horizon: frame.horizon })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const identity = [continuityId, namespace, locked, chatId, branchId, mapping, horizon, revision, aliasRevision, declared];
    return Object.freeze({ continuityId, namespace, collections: Object.freeze(locked), chatId, branchId,
        frames: Object.freeze(mapping.map(frame => Object.freeze(frame))),
        horizon, revision, aliasRevision, declaredCollections: Object.freeze(declared), key: JSON.stringify(identity) });
}

/** Frames must be explicitly supplied by the host, including expanded-position mappings.
 * Declaring linear continuity does not authorize comparing sibling-file coordinates.
 */
export function continuityEvidenceEligibility(event, collection, scope) {
    const reject = reason => ({ eligible: false, reason });
    if (!scope.collections.includes(collection)) return reject('collection_not_locked');
    if (event.backend_namespace != null && event.backend_namespace !== scope.namespace) return reject('backend_mismatch');
    const declared = scope.declaredCollections.includes(collection);
    const sourceChat = event.source_chat_id;
    const frame = scope.frames.find(f => f.collection === collection && f.chatId === sourceChat);
    const position = event.source_window_end;
    if (!Number.isInteger(position) || position < 0) return reject('unknown_source_position');
    if (frame && typeof frame.frameId === 'string' && frame.frameId
        && Number.isInteger(frame.horizon) && frame.horizon >= 0) {
        if (position > frame.horizon) return reject('beyond_horizon');
        // Non-active source files require an explicit continuity declaration as well as a mapping.
        if (sourceChat !== scope.chatId && !declared) return reject('sibling_not_declared');
        return { eligible: true, label: declared ? 'user-declared continuity' : 'verified', frame: frame.frameId };
    }
    if (!sourceChat) return reject('ambiguous_legacy_source');
    return reject(sourceChat !== scope.chatId ? 'unmapped_sibling_source' : 'unmapped_source_frame');
}

/** Recompute at queue execution, after completion, and immediately before injection. */
export function isContinuityScopeCurrent(frozen, readScope) {
    return frozen.key === readScope()?.key;
}