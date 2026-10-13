/** Derived continuity only. Never rewrite archive fields or embedding text. */
import { matchesSceneCharacter } from './scene-cast-matcher.js';
import { plausibleStoryTimeRange, storyTimeMs, compareRecencyDesc } from './event-chronology.js';

export const CONTINUITY_DEFAULTS = Object.freeze({ eventbase_resolved_downrank: 0.85, eventbase_open_issues_max: 6 });
const INTERPERSONAL = new Set(['relationship_change', 'dialogue_significant', 'betrayal', 'promise_or_oath', 'character_state_change']);
const summary = event => String(event.summary || event.text?.split('\n')[0]?.replace(/^\[[^\]]+\]\s*/, '') || '');

export function isActiveDuplicate(event, roster = null) {
    if (roster?.duplicateIds?.has(event.event_id || event.metadata?.event_id)) return true;
    const stored = roster?.eventById?.get(event.event_id || event.metadata?.event_id);
    const continuity = stored?.continuity ?? event.continuity ?? event.metadata?.continuity;
    return continuity?.v === 1 && continuity.duplicate_of?.status === 'active';
}

/** Includes the archived evidence used to judge closure; deterministic across sessions. */
export function threadsDigest(event) {
    const text = JSON.stringify([summary(event), event.open_threads || [], event.result || '']);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(36);
}

export function buildResolvedBy(events) {
    const map = new Map();
    for (const resolver of events) {
        if (resolver.continuity?.v !== 1) continue;
        for (const link of resolver.continuity.resolves || []) {
            if (!link?.event_id) continue;
            if (!map.has(link.event_id)) map.set(link.event_id, []);
            map.get(link.event_id).push({ resolver, link });
        }
    }
    return map;
}

export function getContinuityView(event, rosterIndex = null) {
    const events = rosterIndex?.events instanceof Map ? [...rosterIndex.events.values()] : rosterIndex?.events || [];
    const stored = rosterIndex?.eventById?.get(event.event_id) || events.find(e => e.event_id === event.event_id);
    const target = { ...stored, ...event };
    const threads = Array.isArray(target.open_threads) ? target.open_threads : [];
    const closed = new Set(), resolutions = [], inactiveLinks = [];
    let closesAll = false;
    const apply = (link, resolver = null) => {
        if (!link) return;
        let reason = link.status !== 'active' ? 'not_active' : null;
        if (!reason && rosterIndex && (!stored || (resolver && !(rosterIndex.eventById
            ? rosterIndex.eventById.has(resolver.event_id) : events.some(e => e.event_id === resolver.event_id))))) reason = 'ineligible_collection';
        if (!reason && link.threads_digest !== threadsDigest(target)) reason = 'digest_mismatch';
        if (!reason && resolver && link.resolver_digest && link.resolver_digest !== threadsDigest(resolver)) reason = 'resolver_digest_mismatch';
        if (!reason && link.threads !== 'all' && (!Array.isArray(link.threads) || !link.threads.length
            || link.threads.some(i => !Number.isInteger(i) || i < 0 || i >= threads.length))) reason = 'invalid_threads';
        if (reason) { inactiveLinks.push({ event_id: resolver?.event_id || target.event_id, origin: link.origin, reason }); return; }
        if (link.threads === 'all') { closesAll = true; threads.forEach((_, i) => closed.add(i)); }
        else link.threads.forEach(i => closed.add(i));
        const text = resolver ? summary(resolver).split(/(?<=[.!?。！？])\s+/u)[0].slice(0, 200) : String(link.how || '').slice(0, 200);
        resolutions.push({ event_id: resolver?.event_id || target.event_id, text: text || String(link.how || '').slice(0, 200),
            message_order: resolver?.source_window_end ?? null, origin: link.origin, threads: link.threads });
    };
    if (target.continuity?.v === 1) apply(target.continuity.closed_threads);
    const reverse = rosterIndex?.resolvedBy || buildResolvedBy(events);
    for (const { resolver, link } of reverse.get(target.event_id) || []) apply(link, resolver);
    // Outgoing links without eligible resolvers must not silently close anything.
    return { remainingThreads: threads.filter((_, i) => !closed.has(i)), closedThreads: threads.map((_, i) => i).filter(i => closed.has(i)),
        resolutions, fullyResolved: closesAll || (threads.length > 0 && closed.size === threads.length), inactiveLinks };
}

export function renderResolution(view) {
    return (view?.resolutions || []).map(r => `${r.text}${r.message_order != null ? ` (message ${r.message_order})` : ''}`).filter(Boolean).join('; ');
}

export function resolvedDownrank(settings = {}) {
    const n = Number(settings.eventbase_resolved_downrank ?? CONTINUITY_DEFAULTS.eventbase_resolved_downrank);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : CONTINUITY_DEFAULTS.eventbase_resolved_downrank;
}

export function annotateContinuity(event, roster, settings = {}, recallPastEvent = false) {
    const view = getContinuityView(event, roster);
    return { ...event, _continuityView: view, _resolvedDownrankEnabled: !recallPastEvent && resolvedDownrank(settings) < 1 };
}

const overlapsWindow = (event, start, end) => {
    const last = Number(event.source_window_end), first = Number.isFinite(Number(event.source_window_start)) ? Number(event.source_window_start) : last;
    return Number.isFinite(last) && first <= end && last >= start;
};

/** Window-local refs. Original thread indices are retained after partial closure.
 * Recency is story time (ingestion order when undated), not message position: a
 * collection can mix sibling chat files and slimmed chats with different numbering.
 * Only records from this same window are excluded; mapResolutionRefs rejects a
 * resolution that precedes its issue. */
export function selectOpenIssues({ roster, windowStart, windowEnd = windowStart, text, settings = {} }) {
    const refMap = new Map(), lines = [];
    if (!roster?.ready) return { text: '(none)', refMap, range: null };
    const range = plausibleStoryTimeRange(roster.events);
    const groups = roster.groups.filter(group => matchesSceneCharacter(group, text));
    const cap = Math.max(0, Math.floor(Number(settings.eventbase_open_issues_max ?? 6) || 0));
    const candidates = roster.events.filter(e => !overlapsWindow(e, windowStart, windowEnd)
        && groups.some(g => g.eventIds.has(e.event_id)))
        .sort((a, b) => Number(INTERPERSONAL.has(b.event_type)) - Number(INTERPERSONAL.has(a.event_type))
            || compareRecencyDesc(a, b, range));
    let cost = 0;
    for (const event of candidates) {
        if (refMap.size >= cap) break;
        const view = getContinuityView(event, roster);
        if (!view.remainingThreads.length) continue;
        const ref = `I${refMap.size + 1}`;
        const when = storyTimeMs(event, range) != null ? `story time ${event.DateTime}` : event.scene_time ? `scene time ${event.scene_time}` : `message ${event.source_window_end}`;
        const line = `${ref}: [${when}, importance ${event.importance ?? 5}] ${summary(event).slice(0, 200)} | threads: ${(event.open_threads || []).map((t, i) => view.closedThreads.includes(i) ? '' : `(${i}) ${t}`).filter(Boolean).join(' ')}`;
        // Same conservative ASCII/CJK estimate as injection; roughly 600 tokens.
        const tokens = [...line].reduce((n, c) => n + (c.codePointAt(0) > 127 ? 1 : 0.25), 1);
        if (cost + tokens > 600) continue;
        cost += tokens;
        refMap.set(ref, event);
        lines.push(line);
    }
    return { text: lines.join('\n') || '(none)', refMap, range };
}

/** A resolution cannot precede its issue: story time when both are dated, otherwise
 * the issue's position must fall before this window (one conversation). */
function precedes(issue, resolver, windowStart, range) {
    const issueTime = storyTimeMs(issue, range), resolverTime = storyTimeMs(resolver, range);
    if (issueTime != null && resolverTime != null) return issueTime <= resolverTime;
    return windowStart == null || !(Number(issue.source_window_end) >= windowStart);
}

export function mapResolutionRefs(resolves, refMap, warn = () => {}, { resolver = null, windowStart = null, range = null } = {}) {
    const links = [];
    for (const resolution of resolves || []) {
        const target = refMap.get(resolution.ref);
        if (!target) { warn(`Unknown open-issue ref ${resolution.ref} — dropped`); continue; }
        if (resolver && !precedes(target, resolver, windowStart, range)) { warn(`Open issue ${resolution.ref} is later than its resolution — dropped`); continue; }
        const threads = resolution.threads.filter(i => i < (target.open_threads || []).length);
        if (threads.length !== resolution.threads.length) warn(`Out-of-range threads for ${resolution.ref} — dropped`);
        if (!threads.length) continue;
        links.push({ event_id: target.event_id, threads, threads_digest: threadsDigest(target), how: resolution.how,
            origin: 'extraction', run: null, status: 'active' });
    }
    return links.length ? { v: 1, resolves: links } : undefined;
}