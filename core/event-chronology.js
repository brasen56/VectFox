/** Story chronology shared by the cast lane, NPC cards, open issues and repair.
 * Source positions are a clock only within one conversation: sibling chat files
 * and slimmed chats can share a collection with different message numbering.
 */

// Unknown story times follow all dated events. Source positions are comparable
// only within one frame, never across conversations. For coalesced events use
// the lexically first collection as their canonical frame; untagged events share
// the empty frame. This is a total ordering, not a pair-dependent date fallback.
export function castOrderKey(event) {
    const time = event.DateTime ? Date.parse(event.DateTime) : NaN;
    const frame = event._sortFrame ?? (event._collectionIds || []).reduce((first, id) =>
        first === null || String(id) < first ? String(id) : first, null) ?? '';
    return { time: Number.isFinite(time) ? time : Infinity, frame: String(frame),
        position: Number.isFinite(event.source_window_end) ? event.source_window_end : Infinity,
        id: String(event.event_id) };
}

export function compareCastKeys(a, b) {
    return (a.time === b.time ? 0 : a.time - b.time)
        || a.frame.localeCompare(b.frame)
        || (a.position === b.position ? 0 : a.position - b.position)
        || a.id.localeCompare(b.id);
}

/** The cast lane's total chronological order, shared with NPC card input batching. */
export function compareCastChronology(a, b) {
    return compareCastKeys(castOrderKey(a), castOrderKey(b));
}

const DAY_MS = 86400000;
// Repair compares thousands of pairs; parse each event's DateTime once (re-parsed if edited).
const parsedTimes = new WeakMap();

function parseStoryTime(event) {
    const value = event?.DateTime;
    if (!value) return NaN;
    const cached = parsedTimes.get(event);
    if (cached?.value === value) return cached.time;
    const time = Date.parse(value);
    parsedTimes.set(event, { value, time });
    return time;
}

/** Robust bounds for in-story dates, so a misdated outlier (a 2024 event in a
 * 2000 story) reads as undated instead of permanently "latest". Null when too
 * few events are dated to judge. */
export function plausibleStoryTimeRange(events) {
    const times = [];
    for (const event of events) {
        const time = parseStoryTime(event);
        if (Number.isFinite(time)) times.push(time);
    }
    if (times.length < 10) return null;
    times.sort((a, b) => a - b);
    const q1 = times[Math.floor(times.length * 0.25)], q3 = times[Math.floor(times.length * 0.75)];
    const margin = Math.max(3 * (q3 - q1), 365 * DAY_MS);
    return { min: q1 - margin, max: q3 + margin };
}

export function storyTimeMs(event, range = null) {
    const time = parseStoryTime(event);
    return Number.isFinite(time) && (!range || (time >= range.min && time <= range.max)) ? time : null;
}

/** Ingestion order, which follows story order for sequential auto-sync. */
export function ingestedAtMs(event) {
    return Number(event?.inserted_at) || Number(event?.created_at) || Date.parse(event?.created_at) || 0;
}

const positionOf = event => (Number.isFinite(Number(event?.source_window_end)) ? Number(event.source_window_end) : -Infinity);
const sortKeyOf = event => Number(event?.timeline_sort_key) || 0;

/** Newest first: plausible story time, then (for undated events) ingestion time, then position. */
export function compareRecencyDesc(a, b, range = null) {
    const ta = storyTimeMs(a, range), tb = storyTimeMs(b, range);
    if ((ta == null) !== (tb == null)) return ta == null ? 1 : -1;
    return (ta == null ? 0 : tb - ta)
        || ingestedAtMs(b) - ingestedAtMs(a)
        || positionOf(b) - positionOf(a)
        || sortKeyOf(b) - sortKeyOf(a)
        || String(a.event_id).localeCompare(String(b.event_id));
}

/** Oldest first: dated events by plausible story time, then undated by position. */
export function compareChronology(a, b, range = null) {
    const ta = storyTimeMs(a, range), tb = storyTimeMs(b, range);
    if ((ta == null) !== (tb == null)) return ta == null ? 1 : -1;
    return (ta == null ? 0 : ta - tb)
        || positionOf(a) - positionOf(b)
        || sortKeyOf(a) - sortKeyOf(b)
        || String(a.event_id).localeCompare(String(b.event_id));
}

/** Whether `later` follows `earlier` within the look-ahead: by story time when both
 * are plausibly dated at different moments, otherwise by source position. */
export function followsWithin(earlier, later, range, { storyMs, messages }) {
    const a = storyTimeMs(earlier, range), b = storyTimeMs(later, range);
    if (a != null && b != null && a !== b) return b > a && b - a <= storyMs;
    const gap = Number(later?.source_window_end) - Number(earlier?.source_window_end);
    if (!Number.isFinite(gap)) return false;
    return (gap > 0 || (gap === 0 && sortKeyOf(later) > sortKeyOf(earlier))) && gap <= messages;
}
