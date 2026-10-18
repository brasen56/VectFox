/** Versioned, read-only integration API. Dependencies are injected for host-free tests. */
import { buildCharacterRoster, normalizeCharacterName, getIgnoredCharacterTags } from './character-roster.js';
import { getContinuityView, isActiveDuplicate } from './continuity.js';
import { parseEmbedText } from './eventbase-schema.js';
import { canFingerprintNarrative, eventSourceReferences, resolveEventSources } from './event-sources.js';
import { selectStoryEvents, STORY_LIMITS } from './story-research.js';

const MAX_RECORDS = 10000;
const clone = value => structuredClone(value);
const failure = (code, message, details = {}) => ({ ok: false, error: { code, message, ...details } });
const boundedString = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const recordIdentity = event => JSON.stringify([event.collection_key, event.event_id]);
let sessionSequence = 0;
async function boundedRead(work, milliseconds = 30000) {
    let timer;
    try {
        return await Promise.race([work, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('History read timed out')), milliseconds);
        })]);
    } finally { clearTimeout(timer); }
}

export function createPublicEventAPI({ readState, loadBackend, querySemantic }) {
    let revision = 0, sequence = 0, previous = '', token = '';
    // Scope tokens are invalidation handles, not security credentials.
    const session = typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${++sessionSequence}-${Math.random().toString(36).slice(2)}`;
    const sourceCache = new Map();
    const backendSupport = new Map();
    function snapshot() {
        const state = readState();
        // Track all embedding model settings conservatively without importing host
        // provider modules into this host-free core. Also covers inactive models.
        const models = Object.keys(state.settings).filter(key => /^embedding_.*_model$/.test(key))
            .sort().map(key => [key, state.settings[key]]);
        // Includes content, ILS metadata, settings and locks. No MWT private fields.
        const signature = JSON.stringify([revision, state.ready, state.enabled, state.chatId,
            state.collections, state.availableCollections, state.settings.vector_backend,
            state.settings.embedding_provider, models, state.settings.collections,
            state.settings.qdrant_use_cloud, state.settings.qdrant_url,
            state.settings.qdrant_host, state.settings.qdrant_port, state.settings.qdrant_multitenancy,
            state.settings.eventbase_character_alias_overrides, state.settings.eventbase_character_ignored_tags,
            state.chat, state.chatMetadata, state.archiveRevision]);
        if (signature !== previous) {
            previous = signature;
            token = `${session}:${++sequence}`;
            sourceCache.clear();
        }
        return { ...state, token };
    }
    function getStatus() {
        const state = snapshot();
        const reason = !state.ready ? 'loading' : !state.enabled ? 'disabled' : !state.chatId ? 'no_chat' : null;
        const unsupported = state.collections.length > 0 && state.collections.every(c => backendSupport.get(c.registryKey) === false);
        return clone({ version: 1, state: reason || 'ready', ready: !reason, scope_token: state.token,
            effective_collections: state.collections,
            available_collections: state.availableCollections,
            capabilities: {
                history: { available: !reason && !unsupported, reason: reason || (unsupported ? 'metadata_listing_unavailable' : null),
                    backend_support: state.collections.map(c => ({ collection_id: c.collectionId,
                        available: backendSupport.get(c.registryKey) ?? null, reason: backendSupport.has(c.registryKey) ? null : 'not_probed' })) },
                semantic_search: { available: !reason && typeof querySemantic === 'function',
                    reason: reason || (querySemantic ? null : 'semantic_query_unavailable') },
                question_research: { available: !reason && !unsupported,
                    policy: querySemantic ? 'bounded_semantic_lexical_chronological' : 'bounded_lexical_chronological' },
                source_resolution: { available: !reason && canFingerprintNarrative(),
                    reason: reason || (canFingerprintNarrative() ? null : 'fingerprinting_unavailable') },
                cross_chat_source_resolution: { available: false, reason: 'current_chat_only_in_v1' },
            } });
    }
    const stale = state => snapshot().token !== state.token;
    function validate(request) {
        if (!request || typeof request !== 'object' || Array.isArray(request)) return 'Expected a request object';
        if (request.mode != null && !['history', 'question'].includes(request.mode)) return 'Invalid mode';
        if (request.limit != null && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 500)) return 'limit must be 1–500';
        if (request.match != null && !['all', 'any'].includes(request.match)) return 'Invalid subject match';
        if (request.question != null && (typeof request.question !== 'string' || request.question.length > 4000)) return 'Invalid question';
        if (request.types != null && (!Array.isArray(request.types) || request.types.length > 50 || !request.types.every(boundedString))) return 'Invalid types';
        if (request.subjects != null && (!Array.isArray(request.subjects) || request.subjects.length > 20
            || request.subjects.some(s => !s || !boundedString(s.name) || (s.aliases != null
                && (!Array.isArray(s.aliases) || s.aliases.length > 20 || !s.aliases.every(boundedString)))))) return 'Invalid subjects';
        const scope = request.scope;
        if (scope != null && (!scope || !['current_chat', 'selected_collections'].includes(scope.kind))) return 'Invalid scope';
        if (scope?.kind === 'selected_collections' && (!Array.isArray(scope.collections) || !scope.collections.length
            || scope.collections.length > 20 || !scope.collections.every(boundedString))) return 'Select 1–20 collections';
        return null;
    }
    async function findEvents(input = {}) {
        const invalid = validate(input);
        if (invalid) return failure('invalid_request', invalid);
        const request = clone(input);
        const state = clone(snapshot());
        const status = getStatus();
        if (!status.ready) return failure(status.state, `VectFox is ${status.state}`);
        if (request.scope_token != null && request.scope_token !== state.token) return failure('stale_scope', 'Scope changed');
        if (request.mode === 'question' && !request.question?.trim()) return failure('invalid_request', 'Question research requires a question');
        let collections = state.collections;
        if (request.scope?.kind === 'selected_collections') {
            const selected = request.scope.collections;
            if (selected.some(id => !state.availableCollections.some(c => c.collectionId === id || c.registryKey === id))) {
                return failure('invalid_scope', 'Unknown or unavailable event collection');
            }
            collections = state.availableCollections.filter(c => selected.includes(c.collectionId) || selected.includes(c.registryKey));
        }
        if (collections.length > 20) return failure('limit_exceeded', 'Select at most 20 collections');
        const records = [], unavailable = [], searched = [], truncatedCollections = [];
        let scanned = 0;
        for (const collection of collections) {
            try {
                const backend = await boundedRead(loadBackend(collection, state.settings));
                if (backend.pluginAvailable === false) throw Object.assign(new Error('Metadata listing unavailable'), { code: 'unsupported' });
                searched.push(collection.collectionId);
                let offset = 0;
                while (scanned < MAX_RECORDS) {
                    const result = await boundedRead(backend.listChunks(collection.collectionId, state.settings, { offset, limit: Math.min(500, MAX_RECORDS - scanned) }));
                    if (stale(state)) return failure('stale_scope', 'Scope changed during retrieval');
                    if (!Array.isArray(result?.items)) throw new Error('Invalid metadata listing');
                    if (result.capabilities?.metadata === false
                        || result.items.some(item => !item.text && !Object.keys(item.metadata || {}).length)) {
                        throw Object.assign(new Error('Hashes-only listing cannot provide events'), { code: 'unsupported' });
                    }
                    backendSupport.set(collection.registryKey, true);
                    for (const item of result.items) {
                        const parsed = parseEmbedText(item.text || '');
                        const event = { ...parsed, ...item.metadata, summary: item.metadata?.summary || parsed.summary || '' };
                        if (event.event_id) records.push({ ...event, collection_id: collection.collectionId, collection_key: collection.registryKey });
                    }
                    offset += result.items.length;
                    scanned += result.items.length;
                    if (!Number.isFinite(result.total)) {
                        truncatedCollections.push(collection.collectionId);
                        break;
                    }
                    if (offset >= result.total) break;
                    if (!result.items.length) throw new Error('Incomplete metadata listing');
                    if (scanned >= MAX_RECORDS) truncatedCollections.push(collection.collectionId);
                }
                if (scanned >= MAX_RECORDS && offset === 0) truncatedCollections.push(collection.collectionId);
            } catch (error) {
                if (error.code === 'unsupported') backendSupport.set(collection.registryKey, false);
                unavailable.push({ collection_id: collection.collectionId, collection_key: collection.registryKey,
                    code: error.code || 'backend_error', reason: error.message });
                // Never publish a partly read collection as complete.
                for (let i = records.length - 1; i >= 0; i--) if (records[i].collection_key === collection.registryKey) records.splice(i, 1);
            }
        }
        if (stale(state)) return failure('stale_scope', 'Scope changed during retrieval');
        if (collections.length && unavailable.length === collections.length) {
            return failure(unavailable.every(c => c.code === 'unsupported') ? 'unsupported' : 'unavailable', 'No selected collection could be read', { unavailable });
        }
        const semantic = { attempted: false, candidate_count: 0, unavailable: [], truncated: false };
        const semanticRanks = new Map();
        if (request.mode === 'question') {
            if (!querySemantic) semantic.unavailable.push({ code: 'unsupported', reason: 'Semantic query unavailable' });
            else {
                // Bound the total vector candidates independently of injection Top-K.
                const perCollection = Math.floor(STORY_LIMITS.candidates / Math.max(1, collections.length));
                const identities = new Set(records.map(recordIdentity));
                for (const collection of collections) {
                    if (unavailable.some(item => item.collection_key === collection.registryKey)) continue;
                    semantic.attempted = true;
                    try {
                        const result = await boundedRead(querySemantic(collection, request.question, perCollection, state.settings));
                        if (stale(state)) return failure('stale_scope', 'Scope changed during semantic retrieval');
                        if (!Array.isArray(result?.metadata)) throw new Error('Invalid semantic results');
                        semantic.truncated ||= result.metadata.length >= perCollection;
                        for (const [rank, metadata] of result.metadata.slice(0, perCollection).entries()) {
                            const parsed = parseEmbedText(metadata.text || '');
                            const event = { ...parsed, ...metadata, collection_id: collection.collectionId, collection_key: collection.registryKey };
                            if (!event.event_id) continue;
                            const key = recordIdentity(event);
                            semanticRanks.set(key, Math.min(semanticRanks.get(key) ?? Infinity, rank));
                            if (!identities.has(key)) { records.push(event); identities.add(key); }
                        }
                    } catch (error) {
                        semantic.unavailable.push({ collection_id: collection.collectionId, code: 'semantic_error', reason: error.message });
                    }
                }
            }
        }
        if (stale(state)) return failure('stale_scope', 'Scope changed during retrieval');
        // Continuity uses the full collection union, not the filtered return set.
        // Duplicate exclusions and digest/link validation retain roster semantics.
        const continuityEvents = records.filter(event => !isActiveDuplicate(event));
        const eventById = new Map(continuityEvents.map(event => [recordIdentity(event), event]));
        const targetsById = new Map(), resolvedBy = new Map();
        for (const event of continuityEvents) {
            if (!targetsById.has(event.event_id)) targetsById.set(event.event_id, []);
            targetsById.get(event.event_id).push(event);
        }
        for (const resolver of continuityEvents) {
            if (resolver.continuity?.v !== 1) continue;
            for (const link of resolver.continuity.resolves || []) {
                const targets = targetsById.get(link?.event_id) || [];
                const local = targets.filter(target => target.collection_key === resolver.collection_key);
                const candidates = local.length ? local : targets;
                // Prefer the resolver's own collection. Cross-collection links are
                // safe only when there is exactly one possible target.
                if (candidates.length !== 1) continue;
                const key = recordIdentity(candidates[0]);
                if (!resolvedBy.has(key)) resolvedBy.set(key, []);
                resolvedBy.get(key).push({ resolver, link });
            }
        }
        const continuityIndex = { events: continuityEvents, eventById, resolvedBy, eventKey: recordIdentity };
        const eligible = continuityEvents.filter(event => request.scope?.kind === 'selected_collections'
            || event.source_chat_id === state.chatId);
        const unknownSources = records.filter(e => !e.source_chat_id).length;
        // Qualify subject identities without changing the public/stored event IDs.
        const rosterEvents = eligible.map(event => ({ ...event, event_id: recordIdentity(event), characters: (event.characters || [])
            .filter(name => !getIgnoredCharacterTags(event.collection_id, state.settings).includes(name)) }));
        const overrides = collections.flatMap(c => state.settings.eventbase_character_alias_overrides?.[c.collectionId] || []);
        const roster = buildCharacterRoster(rosterEvents, overrides, state.settings);
        if (request.mode === 'question' && !request.subjects?.length) {
            const question = normalizeCharacterName(request.question);
            const occurrences = [];
            for (const group of roster.groups) for (const name of new Set([group.name, ...group.aliases].map(normalizeCharacterName))) {
                if (!name) continue;
                for (let start = question.indexOf(name); start >= 0; start = question.indexOf(name, start + 1)) {
                    const end = start + name.length;
                    if (!/[\p{L}\p{N}]/u.test(question[start - 1] || '')
                        && !/[\p{L}\p{N}]/u.test(question[end] || '')) occurrences.push({ group, start, end });
                }
            }
            // A full name masks only the shorter mention at the same position,
            // not a separate unqualified mention elsewhere in the question.
            const mentions = [...new Set(occurrences.filter(mention => !occurrences.some(other =>
                other.end - other.start > mention.end - mention.start
                && other.start < mention.end && mention.start < other.end)).map(mention => mention.group))];
            if (mentions.some(group => group.ambiguous)) return failure('ambiguous_subject', 'Please clarify the character name',
                { candidates: mentions.map(group => ({ name: group.name, aliases: group.aliases })) });
            request.subjects = mentions.map(group => ({ name: group.name, aliases: group.aliases }));
            request.match = 'any';
        }
        const subjects = [], resolvedSubjects = [];
        for (const subject of request.subjects || []) {
            const names = [subject.name, ...(subject.aliases || [])].map(normalizeCharacterName);
            const matches = roster.groups.filter(group => [group.name, ...group.aliases].some(name => names.includes(normalizeCharacterName(name))));
            if (matches.length > 1 || matches.some(group => group.ambiguous)) {
                return failure('ambiguous_subject', `Ambiguous subject: ${subject.name}`, { candidates: matches.map(g => ({ name: g.name, aliases: g.aliases })) });
            }
            subjects.push(matches[0]?.eventIds || new Set());
            if (matches[0]) resolvedSubjects.push({ name: matches[0].name, aliases: matches[0].aliases });
        }
        const history = eligible.filter(event => !request.types?.length || request.types.includes(event.event_type));
        // Group by source, then source order; unrelated indices never form one timeline.
        history.sort((a, b) => String(a.source_chat_id || a.collection_id).localeCompare(String(b.source_chat_id || b.collection_id))
            || (a.source_window_start ?? Infinity) - (b.source_window_start ?? Infinity)
            || (a.window_event_order ?? 0) - (b.window_event_order ?? 0));
        const matchesSubject = event => !subjects.length || (request.match === 'any'
            ? subjects.some(ids => ids.has(recordIdentity(event))) : subjects.every(ids => ids.has(recordIdentity(event))));
        const matched = history.filter(matchesSubject);
        semantic.candidate_count = matched.filter(event => semanticRanks.has(recordIdentity(event))).length;
        const anchorIndices = history.flatMap((event, index) => matchesSubject(event) ? [index] : []);
        const subjectNames = resolvedSubjects.flatMap(subject => [subject.name, ...subject.aliases]);
        const selection = request.mode === 'question' ? selectStoryEvents(history.map(event => ({ ...event,
            retrieval: semanticRanks.has(recordIdentity(event)) && matchesSubject(event)
                ? { semantic_rank: semanticRanks.get(recordIdentity(event)) } : undefined,
            continuity_view: getContinuityView(event, continuityIndex) })), request.question, request.limit ?? 200, subjectNames, anchorIndices)
            : { events: matched.slice(0, request.limit ?? 100), sampled: false, truncated: matched.length > (request.limit ?? 100) };
        const events = selection.events.map(event => {
            const eventRef = `vf1:${encodeURIComponent(event.collection_key)}:${encodeURIComponent(event.event_id)}`;
            const sourceRefs = eventSourceReferences(event, event.collection_id, eventRef, state.token);
            sourceRefs.forEach(ref => sourceCache.set(ref.ref, ref));
            return { ...event, event_ref: eventRef, source_refs: sourceRefs, source_status: 'unresolved',
                continuity_view: getContinuityView(event, continuityIndex) };
        });
        // Bound retained references across repeated requests as well as per request.
        while (sourceCache.size > 20000) sourceCache.delete(sourceCache.keys().next().value);
        return clone({ ok: true, scope_token: state.token, events, resolved_subjects: resolvedSubjects,
            coverage: { collections_searched: searched, matched_count: matched.length, returned_count: events.length,
                counts_exact: !truncatedCollections.length && !unavailable.length,
                ...(request.mode === 'question' ? { semantic } : {}),
                truncated: selection.truncated || truncatedCollections.length > 0 || semantic.truncated,
                sampled: selection.sampled, truncated_collections: truncatedCollections, unavailable,
                unknown_source_chat_count: unknownSources, partial: !!unavailable.length || !!truncatedCollections.length || unknownSources > 0 || !!semantic.unavailable.length,
                ordering: 'grouped_by_source_chat_then_source_order' } });
    }
    async function resolveSources(request) {
        if (!request || !Array.isArray(request.sources) || request.sources.length > 500) return failure('invalid_request', 'sources must contain at most 500 references');
        const state = clone(snapshot());
        const status = getStatus();
        if (!status.ready) return failure(status.state, `VectFox is ${status.state}`);
        if (request.scope_token !== state.token) return failure('stale_scope', 'Scope changed');
        const refs = request.sources.map(ref => sourceCache.get(typeof ref === 'string' ? ref : ref?.ref));
        if (refs.some(ref => !ref)) return failure('invalid_reference', 'Use source references returned by findEvents in this scope');
        try {
            const sources = await resolveEventSources(clone(refs), state);
            if (stale(state)) return failure('stale_scope', 'Scope changed during source resolution');
            return clone({ ok: true, scope_token: state.token, sources });
        } catch (error) {
            return failure('source_error', error.message);
        }
    }
    return Object.freeze({ version: 1, getStatus, findEvents, resolveSources,
        invalidate() { revision++; sourceCache.clear(); } });
}