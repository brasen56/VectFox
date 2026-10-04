/** Session-local EventBase index. Stored events are never rewritten. */
import { parseEmbedText } from './eventbase-schema.js';
import { log } from './log.js';

export const CHARACTER_ROSTER_DEFAULTS = Object.freeze({
    eventbase_lead_share_threshold: 0.25,
    eventbase_lead_min_events: 20,
    eventbase_known_characters_limit: 40,
    eventbase_known_characters_max_chars: 4000,
});
const indexes = new Map();
// The current listing API scans the collection before slicing offset/limit.
const LIST_LIMIT = Number.MAX_SAFE_INTEGER;
const HONORIFICS = /^(?:(?:mr|mrs|ms|miss|dr|prof|sir|lady|lord|captain|capt|officer|judge|doctor|professor)\.?\s+)+/i;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u;

export function rosterCollectionId(id) {
    return String(id || '').replace(/^(?:qdrant|standard|vectra):/, '');
}

/** Exact stored spellings; ignoring one tag must not hide similarly named people. */
export function getIgnoredCharacterTags(collectionId, settings = {}) {
    const tags = settings.eventbase_character_ignored_tags?.[rosterCollectionId(collectionId)];
    return Array.isArray(tags)
        ? [...new Set(tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim()))]
        : [];
}

export function normalizeCharacterName(name) {
    return String(name || '').normalize('NFKC').trim().replace(HONORIFICS, '')
        .replace(/\s+/g, ' ').toLocaleLowerCase();
}

function slimEvent(item) {
    const event = { ...parseEmbedText(item.text || ''), ...item.metadata };
    if (!event.event_id) return null; // Native hashes-only fallback has no roster data.
    return {
        event_id: event.event_id,
        hash: item.hash,
        summary: String(event.summary || '').split(/\r?\n/)[0],
        DateTime: event.DateTime,
        scene_time: event.scene_time,
        importance: event.importance,
        should_persist: event.should_persist,
        event_type: event.event_type,
        source_window_end: event.source_window_end,
        characters: Array.isArray(event.characters)
            ? [...new Set(event.characters.filter(n => typeof n === 'string' && n.trim()).map(n => n.trim()))] : [],
    };
}

/** Coalesced lazy build. Invalidation detaches the entry so an old fetch cannot revive it. */
export function ensureCharacterIndex(collectionId, settings, loadBackend = null) {
    const id = rosterCollectionId(collectionId);
    if (!id) return Promise.resolve(null);
    const existing = indexes.get(id);
    if (existing) return existing.promise;
    const entry = { ready: false, events: new Map(), mutations: new Map(), revision: 0, promise: null };
    indexes.set(id, entry);
    entry.promise = (async () => {
        try {
            let backend;
            if (loadBackend) backend = await loadBackend(id, settings);
            else {
                const { getBackend, getBackendForCollection } = await import('../backends/backend-manager.js');
                const { resolveBackendForCollection } = await import('./collection-ids.js');
                const resolved = resolveBackendForCollection(collectionId);
                backend = resolved.backend ? await getBackendForCollection(resolved.backend, settings) : await getBackend(settings);
            }
            let revision = entry.revision;
            for (let offset = 0; ; ) {
                const result = await backend.listChunks(id, settings, { offset, limit: LIST_LIMIT });
                if (indexes.get(id) !== entry) return null;
                if (!Array.isArray(result?.items)) throw new Error('Invalid listChunks response');
                // A mutation can move untouched records behind an already-read offset.
                if (revision !== entry.revision) {
                    entry.events.clear();
                    offset = 0;
                    revision = entry.revision;
                    continue;
                }
                const items = result.items;
                if (items.length && items.every(item => !item.text && !Object.keys(item.metadata || {}).length)) {
                    throw new Error('Roster payload unavailable (hashes-only listing)');
                }
                for (const item of items) {
                    const event = slimEvent(item);
                    if (event) entry.events.set(event.event_id, event);
                }
                offset += items.length;
                if (Number.isFinite(result.total) && offset < result.total) {
                    if (!items.length) throw new Error('Incomplete listChunks response');
                } else break;
            }
            // Local writes/deletes take precedence over a stale backend snapshot.
            for (const [hash, event] of entry.mutations) {
                for (const [key, old] of entry.events) if (old.hash === hash) entry.events.delete(key);
                if (event) entry.events.set(event.event_id, event);
            }
            entry.mutations.clear();
            entry.ready = true;
            return entry;
        } catch (err) {
            if (indexes.get(id) === entry) indexes.delete(id); // Retry on next warm-up.
            log.warn(`[Character roster] Failed to index ${id}:`, err?.message || err);
            return null;
        }
    })();
    return entry.promise;
}

export function invalidateCharacterIndex(collectionId) {
    indexes.delete(rosterCollectionId(collectionId));
}

export function upsertCharacterEvents(collectionId, items) {
    const entry = indexes.get(rosterCollectionId(collectionId));
    if (!entry) return;
    for (const item of items) {
        const event = slimEvent(item);
        if (!event) continue;
        if (!entry.ready) {
            entry.mutations.set(item.hash, event);
            entry.revision++;
        }
        for (const [key, old] of entry.events) if (old.hash === item.hash) entry.events.delete(key);
        entry.events.set(event.event_id, event);
    }
}

export function pruneCharacterEvents(collectionId, hashes) {
    const entry = indexes.get(rosterCollectionId(collectionId));
    if (!entry) return;
    const removed = new Set(hashes);
    if (!entry.ready && removed.size) {
        for (const hash of removed) entry.mutations.set(hash, null);
        entry.revision++;
    }
    for (const [key, event] of entry.events) if (removed.has(event.hash)) entry.events.delete(key);
}

/** Overrides are explicit groups, including singleton groups to prevent auto-merging. */
export function buildCharacterRoster(events, overrides = [], settings = {}) {
    const spellings = new Map();
    for (const event of events) for (const name of event.characters || []) {
        const key = normalizeCharacterName(name);
        if (!key) continue;
        if (!spellings.has(key)) spellings.set(key, new Set());
        spellings.get(key).add(name);
    }
    const assignments = new Map();
    const automaticAssignments = new Map();
    const manualKeys = new Set();
    const groups = [];
    const addGroup = (name, aliases, manual = false, ambiguous = false) => {
        const group = { name, aliases: [], eventIds: new Set(), eventCount: 0, share: 0, isLead: false, recency: -1, manual, ambiguous };
        for (const alias of aliases) {
            if (assignments.has(alias)) continue; // First explicit choice wins on cross-collection conflicts.
            assignments.set(alias, group);
            group.aliases.push(alias);
        }
        if (group.aliases.length) groups.push(group);
        return group;
    };
    for (const override of overrides) {
        if (!Array.isArray(override?.aliases) || typeof override.name !== 'string') continue;
        const aliases = override.aliases.filter(alias => spellings.get(normalizeCharacterName(alias))?.has(alias));
        const group = addGroup(override.name.trim() || aliases[0], aliases, true);
        for (const alias of group.aliases) manualKeys.add(normalizeCharacterName(alias));
    }
    const keys = [...spellings.keys()];
    const remaining = key => [...spellings.get(key)].filter(alias => !assignments.has(alias));
    const addAutomaticGroup = (name, keys, ambiguous) => {
        const group = addGroup(name, keys.flatMap(remaining), false, ambiguous);
        for (const key of keys) automaticAssignments.set(key, group);
        return group;
    };
    const targets = new Map();
    const ambiguous = new Set();
    for (const key of keys) {
        if (!remaining(key).length || CJK.test(key)) continue;
        const tokens = key.split(' ');
        const matches = keys.filter(other => other !== key && !CJK.test(other)
            && other.split(' ').length > tokens.length && tokens.every(token => other.split(' ').includes(token)));
        if (matches.length === 1) targets.set(key, matches[0]);
        else if (matches.length > 1) ambiguous.add(key);
    }
    const root = key => targets.has(key) ? root(targets.get(key)) : key;
    for (const key of keys) {
        if (automaticAssignments.has(key) || !remaining(key).length) continue;
        const target = root(key);
        // Never extend a manually split/merged group automatically.
        const group = automaticAssignments.get(target);
        if (manualKeys.has(target)) {
            addAutomaticGroup(remaining(key)[0], [key], ambiguous.has(key));
        } else if (group) {
            automaticAssignments.set(key, group);
            for (const alias of remaining(key)) {
                assignments.set(alias, group);
                group.aliases.push(alias);
            }
        } else {
            const related = keys.filter(k => !automaticAssignments.has(k) && remaining(k).length && root(k) === target);
            addAutomaticGroup(remaining(target)[0], related, related.some(k => ambiguous.has(k)));
        }
    }
    const totalEvents = new Set(events.map(e => e.event_id)).size;
    for (const event of events) {
        const seen = new Set((event.characters || []).map(n => assignments.get(n)).filter(Boolean));
        for (const group of seen) {
            group.eventIds.add(event.event_id);
            group.recency = Math.max(group.recency, Number(event.source_window_end) || 0);
        }
    }
    const threshold = Number.isFinite(settings.eventbase_lead_share_threshold)
        ? Math.max(0, Math.min(1, settings.eventbase_lead_share_threshold)) : CHARACTER_ROSTER_DEFAULTS.eventbase_lead_share_threshold;
    const minimum = Number.isFinite(settings.eventbase_lead_min_events)
        ? Math.max(1, settings.eventbase_lead_min_events) : CHARACTER_ROSTER_DEFAULTS.eventbase_lead_min_events;
    for (const group of groups) {
        group.aliases = [...new Set(group.aliases)].sort();
        group.eventCount = group.eventIds.size;
        group.share = totalEvents ? group.eventCount / totalEvents : 0;
        group.isLead = totalEvents >= minimum && group.share > threshold;
    }
    groups.sort((a, b) => b.eventCount - a.eventCount || b.recency - a.recency || a.name.localeCompare(b.name));
    return { groups, totalEvents };
}

/** Sync read of the current lock union; never waits for an index on the turn path. */
export function getCharacterRoster(collectionIds, settings = {}) {
    const events = new Map();
    const rosterEvents = [];
    const overrides = [];
    const pendingCollections = [];
    for (const id of new Set(collectionIds.map(rosterCollectionId))) {
        const entry = indexes.get(id);
        if (!entry?.ready) { pendingCollections.push(id); continue; }
        const ignored = new Set(getIgnoredCharacterTags(id, settings));
        for (const event of entry.events.values()) {
            if (!events.has(event.event_id)) events.set(event.event_id, { ...event, _collectionIds: [] });
            events.get(event.event_id)._collectionIds.push(id);
            // Project each collection separately: a tag ignored in one lock may
            // still be valid in another, even on a duplicate event ID. Keep the
            // cached and returned event records intact so restoration is lossless.
            rosterEvents.push({ ...event, characters: event.characters.filter(name => !ignored.has(name)) });
        }
        overrides.push(...(settings.eventbase_character_alias_overrides?.[id] || []));
    }
    return { ...buildCharacterRoster(rosterEvents, overrides, settings), events: [...events.values()], pendingCollections, ready: pendingCollections.length === 0 };
}

export function renderKnownCharacters(roster, settings = {}) {
    const limit = Math.max(0, Math.floor(settings.eventbase_known_characters_limit ?? CHARACTER_ROSTER_DEFAULTS.eventbase_known_characters_limit));
    const budget = Math.max(0, Math.floor(settings.eventbase_known_characters_max_chars ?? CHARACTER_ROSTER_DEFAULTS.eventbase_known_characters_max_chars));
    const lines = [];
    let length = 0;
    for (const group of roster.groups.slice(0, limit)) {
        const aliases = group.aliases.filter(a => a !== group.name);
        const line = `${group.name}${aliases.length ? ` (also: ${aliases.join(', ')})` : ''}`.replace(/[\r\n]/g, ' ');
        if (length + line.length + (lines.length ? 1 : 0) > budget) continue;
        lines.push(line);
        length += line.length + (lines.length > 1 ? 1 : 0);
    }
    return lines.join('\n');
}
