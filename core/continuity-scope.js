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

/** Ingestion time (ms), the only clock shared by every stored event. Positions are not. */
export function eventIngestionTime(event) {
    const value = event?.created_at ?? event?.inserted_at;
    const time = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(time) ? time : null;
}

/** A user declaration that every event already stored in a collection is one linear story
 * before now. It is frozen at the newest ingestion time seen when declared, so events
 * stored later (a rewind, a new branch) are never swept in without an explicit update.
 */
export function readStorySoFar(settings, namespace, collectionId) {
    const stored = settings.eventbase_story_so_far?.[continuityCollectionKey(namespace, collectionId)];
    return stored?.v === 1 && Number.isFinite(stored.cutoff) && Number.isInteger(stored.revision) ? stored : null;
}

export function declareStorySoFar(settings, namespace, collectionId, events, now = new Date()) {
    const times = events.map(eventIngestionTime).filter(time => time !== null);
    if (!times.length) throw new Error('No stored events with an ingestion time to declare');
    const key = continuityCollectionKey(namespace, collectionId);
    const declaration = { v: 1, cutoff: times.reduce((a, b) => Math.max(a, b)), eventCount: times.length,
        declaredAt: now.toISOString(), revision: (settings.eventbase_story_so_far?.[key]?.revision || 0) + 1 };
    settings.eventbase_story_so_far = { ...settings.eventbase_story_so_far, [key]: declaration };
    return declaration;
}

export function removeStorySoFar(settings, namespace, collectionId) {
    const key = continuityCollectionKey(namespace, collectionId);
    settings.eventbase_story_so_far = Object.fromEntries(Object.entries(settings.eventbase_story_so_far || {}).filter(([k]) => k !== key));
}

/** Settings-owned declarations, in the form resolveContinuityScope accepts. */
export function continuityDeclarations(settings, namespace, collectionId) {
    const story = readStorySoFar(settings, namespace, collectionId);
    return {
        declaredCollections: settings.eventbase_declared_continuity?.[continuityCollectionKey(namespace, collectionId)] ? [collectionId] : [],
        storySoFar: story ? [{ collection: collectionId, cutoff: story.cutoff, revision: story.revision }] : [],
    };
}

/** Identity is intentionally lossless, not a short hash. No unrelated message-count fallback. */
export function resolveContinuityScope({ continuityId, namespace, collections = [], chatId, branchId = chatId,
    frames = [], horizon = null, revision = 0, aliasRevision = 0, declaredCollections = [], storySoFar = [] }) {
    if (!continuityId || !namespace || !chatId || !branchId) throw new Error('Incomplete continuity scope');
    const locked = [...new Set(collections)].sort();
    const declared = [...new Set(declaredCollections)].filter(id => locked.includes(id)).sort();
    const mapping = frames.map(frame => ({ collection: frame.collection, chatId: frame.chatId,
        frameId: frame.frameId, horizon: frame.horizon })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const stories = storySoFar.filter(story => locked.includes(story.collection) && Number.isFinite(story.cutoff))
        .map(story => ({ collection: story.collection, cutoff: story.cutoff, revision: story.revision }))
        .sort((a, b) => a.collection.localeCompare(b.collection));
    const identity = [continuityId, namespace, locked, chatId, branchId, mapping, horizon, revision, aliasRevision, declared, stories];
    return Object.freeze({ continuityId, namespace, collections: Object.freeze(locked), chatId, branchId,
        frames: Object.freeze(mapping.map(frame => Object.freeze(frame))),
        horizon, revision, aliasRevision, declaredCollections: Object.freeze(declared),
        storySoFar: Object.freeze(stories.map(story => Object.freeze(story))), key: JSON.stringify(identity) });
}

/** Frames must be explicitly supplied by the host, including expanded-position mappings.
 * Declaring linear continuity does not authorize comparing sibling-file coordinates.
 */
export function continuityEvidenceEligibility(event, collection, scope) {
    const reject = reason => ({ eligible: false, reason });
    if (!scope.collections.includes(collection)) return reject('collection_not_locked');
    if (event.backend_namespace != null && event.backend_namespace !== scope.namespace) return reject('backend_mismatch');
    const story = scope.storySoFar?.find(s => s.collection === collection);
    const ingested = story ? eventIngestionTime(event) : null;
    // The user asserts everything stored by the cutoff precedes now, so its
    // incomparable positions and unknown source files are not consulted.
    if (story && ingested !== null && ingested <= story.cutoff) {
        return { eligible: true, label: 'user-declared continuity', basis: 'story_so_far', frame: `story-so-far:${story.revision}` };
    }
    // Events stored after the cutoff still need the per-file mapping below.
    const late = story ? reject(ingested === null ? 'unknown_ingestion_time' : 'after_declared_story_so_far') : null;
    const declared = scope.declaredCollections.includes(collection);
    const sourceChat = event.source_chat_id;
    const frame = scope.frames.find(f => f.collection === collection && f.chatId === sourceChat);
    const position = event.source_window_end;
    if (!Number.isInteger(position) || position < 0) return late || reject('unknown_source_position');
    if (frame && typeof frame.frameId === 'string' && frame.frameId
        && Number.isInteger(frame.horizon) && frame.horizon >= 0) {
        if (position > frame.horizon) return reject('beyond_horizon');
        // Non-active source files require an explicit continuity declaration as well as a mapping.
        if (sourceChat !== scope.chatId && !declared) return reject('sibling_not_declared');
        return { eligible: true, label: declared ? 'user-declared continuity' : 'verified', frame: frame.frameId };
    }
    if (late) return late;
    if (!sourceChat) return reject('ambiguous_legacy_source');
    return reject(sourceChat !== scope.chatId ? 'unmapped_sibling_source' : 'unmapped_source_frame');
}

/** Recompute at queue execution, after completion, and immediately before injection. */
export function isContinuityScopeCurrent(frozen, readScope) {
    return frozen.key === readScope()?.key;
}