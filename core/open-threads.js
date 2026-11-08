/** Read-only archive projection. Collection-local indexes prevent cross-archive closures. */
import { buildCharacterRoster, rosterCollectionId } from './character-roster.js';
import { getContinuityView, isActiveDuplicate } from './continuity.js';
import { continuityIndex, openThreadIndices, repairScope } from './continuity-repair.js';
import { plausibleStoryTimeRange, storyTimeMs, ingestedAtMs, compareChronology } from './event-chronology.js';

export const OPEN_THREAD_LIMITS = Object.freeze({ records: 10000, collections: 20, pageSize: 40 });

export async function loadOpenThreads(collections, settings, ensureIndex, signal) {
    if (!collections.length) throw new Error('Select at least one event collection.');
    if (collections.length > OPEN_THREAD_LIMITS.collections) throw new Error('Select at most 20 collections.');
    const archives = [];
    let remaining = OPEN_THREAD_LIMITS.records;
    for (const collection of collections) {
        signal?.throwIfAborted();
        const index = await ensureIndex(collection, settings, null, { signal, maxRecords: remaining, pageSize: 500 });
        signal?.throwIfAborted();
        if (!index?.ready) throw new Error(`Metadata unavailable or scan ceiling exceeded: ${collection}. No complete snapshot loaded.`);
        remaining -= index.scannedRecords ?? index.events.size;
        if (remaining < 0) throw new Error('Metadata ceiling exceeded (10,000 records). Narrow the collection scope.');
        archives.push({ collection, events: [...index.events.values()] });
    }
    return buildOpenThreadSnapshot(archives, settings);
}

export function buildOpenThreadSnapshot(archives, settings = {}) {
    const rows = [], groups = [];
    for (const { collection, events } of archives) {
        const index = continuityIndex(events), range = plausibleStoryTimeRange(events);
        const remainingEvents = new Set(repairScope(events, { scope: 'all' }, [], index));
        const roster = buildCharacterRoster(events.filter(e => !isActiveDuplicate(e)),
            settings.eventbase_character_alias_overrides?.[rosterCollectionId(collection)] || [], settings);
        groups.push(...roster.groups.map(group => ({ ...group, collection, key: JSON.stringify([collection, group.name]) })));
        const latestStory = Math.max(...events.map(e => storyTimeMs(e, range) ?? -Infinity));
        const latestPosition = Math.max(...events.map(e => Number(e.source_window_end) || 0));
        for (const event of events) {
            if (isActiveDuplicate(event) || !event.open_threads?.length) continue;
            const view = getContinuityView(event, index);
            const indices = remainingEvents.has(event) ? openThreadIndices(event, index) : [];
            const time = storyTimeMs(event, range);
            const position = event.source_window_end;
            const ingested = ingestedAtMs(event);
            const age = time != null ? `Story time ${event.DateTime} · ${Math.max(0, Math.floor((latestStory - time) / 86400000))} story days old`
                : position != null ? `Approximate message position ${position} · about ${Math.max(0, latestPosition - Number(position))} positions behind archive head`
                    : ingested ? `Ingested ${new Date(ingested).toISOString()} (fallback)` : 'Undated; age unknown';
            rows.push({ collection, event, view, indices, age, range, index });
        }
    }
    // compareChronology includes deterministic position/id tie-breaks; equal age gets importance first.
    rows.sort((a, b) => {
        const ta = storyTimeMs(a.event, a.range), tb = storyTimeMs(b.event, b.range);
        const pa = a.event.source_window_end ?? (ingestedAtMs(a.event) || undefined);
        const pb = b.event.source_window_end ?? (ingestedAtMs(b.event) || undefined);
        const tied = ta === tb && (ta != null || pa === pb);
        return (tied ? Number(b.event.importance || 0) - Number(a.event.importance || 0) : 0)
            || compareChronology({ ...a.event, DateTime: ta == null ? null : a.event.DateTime,
                source_window_end: pa },
                { ...b.event, DateTime: tb == null ? null : b.event.DateTime,
                    source_window_end: pb })
            || a.collection.localeCompare(b.collection);
    });
    return { rows, groups };
}

export function filterOpenThreads(snapshot, { audit = false, importance = 0, group = '' } = {}) {
    const cast = snapshot.groups.find(item => item.key === group);
    return snapshot.rows.filter(row => (audit || row.indices.length) && Number(row.event.importance || 0) >= importance
        && (!cast || (row.collection === cast.collection && row.event.characters?.some(name => cast.aliases.includes(name)))));
}