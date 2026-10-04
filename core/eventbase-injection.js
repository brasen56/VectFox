/**
 * ============================================================================
 * EVENTBASE INJECTION
 * ============================================================================
 * Formats retrieved EventRecord objects into a prompt block for injection.
 * Main events and cast history share a conservative estimated-token budget.
 * ============================================================================
 */

import { resolveCastSetting } from './scene-cast-settings.js';

// ---------------------------------------------------------------------------
// JSON format
// ---------------------------------------------------------------------------

/**
 * Extract the summary line from an event's stored embed text.
 * The text is built by buildEmbedText() and starts with "[event_type] summary"
 * on its first line. Strips the bracketed event_type prefix.
 * @param {string} text
 * @returns {string}
 */
function _summaryFromText(text) {
    if (!text) return '';
    const firstLine = String(text).split('\n')[0];
    const match = firstLine.match(/^\[[^\]]+\]\s*(.*)$/);
    return match ? match[1] : firstLine;
}

const _MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Render a stored ISO-8601 story timestamp in the readable in-story time
 * convention most RP chats already use ("3:45 PM, June 12, 2026") so the
 * LLM can line injected events up against in-chat time markers.
 *
 * Uses UTC getters throughout: DateTime values are normalized to UTC ISO at
 * extraction, and local-time getters would shift the story clock by the host
 * machine's timezone. A weekday is deliberately NOT computed — RP dates are
 * often invented, and a derived weekday can contradict what the story says.
 * Midnight-exact values are treated as date-only (a bare date parses to
 * T00:00:00Z) and rendered without the clock. Unparseable values pass
 * through unchanged.
 * @param {string|null|undefined} iso
 * @returns {string|null}
 */
function _formatStoryTime(iso) {
    if (!iso) return null;
    const ms = Date.parse(String(iso));
    if (Number.isNaN(ms)) return String(iso);
    const d = new Date(ms);
    const datePart = `${_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
    if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) {
        return datePart;
    }
    const h12 = d.getUTCHours() % 12 || 12;
    const ampm = d.getUTCHours() < 12 ? 'AM' : 'PM';
    return `${h12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${ampm}, ${datePart}`;
}

/**
 * Strip internal scoring/ingestion fields that should not be injected.
 * Returns only the canonical EventRecord fields.
 * @param {object} event
 * @returns {object}
 */
function _cleanEventForInjection(event) {
    return {
        event_type: event.event_type,
        // Relative retrieval-relevance rank within this injected batch (1 = closest
        // match to the current moment). Stamped from score order before the
        // chronological re-sort. A rank, NOT the raw score — the raw _finalScore is
        // uncalibrated and its scale shifts across backends, so it would mislead.
        context_relevance_rank: event._contextRelevanceRank != null
            ? `${event._contextRelevanceRank} of ${event._contextRelevanceTotal}`
            : null,
        importance: event.importance,
        message_order: event.source_window_end ?? null,
        summary: _summaryFromText(event.text),
        DateTime: _formatStoryTime(event.DateTime),
        scene_time: event.scene_time || '',
        cause: event.cause || '',
        result: event.result || '',
        characters: event.characters || [],
        locations: event.locations || [],
        factions: event.factions || [],
        items: event.items || [],
        concepts: event.concepts || [],
        keywords: event.keywords || [],
        open_threads: event.open_threads || [],
        should_persist: event.should_persist === true,
    };
}

/**
 * Format events as a JSON array string (canonical format).
 * @param {object[]} events
 * @returns {string}
 */
function _formatAsJson(events) {
    return JSON.stringify(events.map(_cleanEventForInjection), null, 2);
}

// ---------------------------------------------------------------------------
// Dense text format
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {string}
 */
function _stringifyList(value) {
    if (!Array.isArray(value) || value.length === 0) return '-';
    return value.map(v => String(v)).join(', ');
}

/**
 * Format events as compact dense text blocks.
 * @param {object[]} events
 * @returns {string}
 */
function _formatAsDenseText(events) {
    return events.map((rawEvent, idx) => {
        const event = _cleanEventForInjection(rawEvent);
        return [
            `# Event ${idx + 1}`,
            `context_relevance_rank: ${event.context_relevance_rank || '-'}`,
            `event_type: ${event.event_type || '-'}`,
            `importance: ${event.importance ?? '-'}`,
            `message_order: ${event.message_order ?? '-'}`,
            `summary: ${event.summary || '-'}`,
            `In-story time: ${event.DateTime || '-'}`,
            `scene_time: ${event.scene_time || '-'}`,
            `cause: ${event.cause || '-'}`,
            `result: ${event.result || '-'}`,
            `characters: ${_stringifyList(event.characters)}`,
            `locations: ${_stringifyList(event.locations)}`,
            `factions: ${_stringifyList(event.factions)}`,
            `items: ${_stringifyList(event.items)}`,
            `concepts: ${_stringifyList(event.concepts)}`,
            `keywords: ${_stringifyList(event.keywords)}`,
            `open_threads: ${_stringifyList(event.open_threads)}`,
            `should_persist: ${event.should_persist ? 'true' : 'false'}`,
        ].join('\n');
    }).join('\n\n');
}

/**
 * Format events as summary + DateTime only — minimal prompt footprint.
 * @param {object[]} events
 * @returns {string}
 */
function _formatAsSummaryOnly(events) {
    return events.map((rawEvent, idx) => {
        const event = _cleanEventForInjection(rawEvent);
        return [
            `# Event ${idx + 1}`,
            `context_relevance_rank: ${event.context_relevance_rank || '-'}`,
            `message_order: ${event.message_order ?? '-'}`,
            `summary: ${event.summary || '-'}`,
            `In-story time: ${event.DateTime || '-'}`,
            `scene_time: ${event.scene_time || '-'}`,
        ].join('\n');
    }).join('\n\n');
}

// ---------------------------------------------------------------------------
// Presentation order
// ---------------------------------------------------------------------------

/**
 * One-line instruction prepended to every injected block so the model knows the
 * events are in chronological order and which field encodes it. A silent
 * re-order only half-helps; naming the ordering makes it usable.
 */
const INJECTION_HEADER =
    'Past events, ordered oldest → newest by message_order (position in the conversation). '
    + "Use each event's in-story time (DateTime)/scene_time to place it on the story timeline. "
    + 'context_relevance_rank shows how closely each event matches the current moment '
    + '(1 = closest match) — this is retrieval relevance, NOT story importance '
    + '(see the separate importance field for how significant the event is).';

/**
 * Re-order retrieved events for presentation: chronological, oldest → newest.
 * Relevance (retrieval score) decides WHICH events are included upstream; this
 * only decides DISPLAY order — no events are added or dropped.
 *
 * Sort key is `source_window_end` (message_order): ingestion-stamped,
 * deterministic, monotonic within a conversation. NOT the LLM-extracted
 * `DateTime`, which is nullable and can mis-parse — a bad parse would teleport
 * an event across the timeline. DateTime/scene_time still print per event as
 * labels the model can read.
 *
 * Cross-frame safety: `source_window_end` is a message index within ONE
 * conversation, so it is meaningless across collections (archive chats,
 * cross-chat locks). Events are grouped by their source frame (`_sortFrame`,
 * stamped at query time) and only sorted within a frame. Frames are then ordered
 * by their most-recent `real_world_date` (wall-clock send time, comparable
 * across conversations) so the actively-played chat lands last and older
 * archives first. Frames with no real-world anchor sort first.
 *
 * Array#sort is stable, so ties (same window, or a frame with no anchor) retain
 * the incoming relevance order as a sensible tie-break.
 *
 * @param {object[]} events
 * @returns {object[]} new array, same members, presentation order
 */
function _orderEventsForPresentation(events) {
    const byWindow = (a, b) => {
        const av = typeof a.source_window_end === 'number' ? a.source_window_end : Infinity;
        const bv = typeof b.source_window_end === 'number' ? b.source_window_end : Infinity;
        return av - bv;
    };

    // Fast path: a single (or absent) frame — no cross-conversation risk.
    const frames = new Set(events.map(e => e._sortFrame ?? '__default__'));
    if (frames.size <= 1) {
        return [...events].sort(byWindow);
    }

    const groups = new Map();
    for (const e of events) {
        const key = e._sortFrame ?? '__default__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
    }

    // A frame's timeline position = the newest real-world send time it contains.
    // No anchor anywhere in the frame → -Infinity → sorts first (unknown/oldest).
    const frameAnchor = (list) => {
        let max = -Infinity;
        for (const e of list) {
            const t = e.real_world_date ? Date.parse(e.real_world_date) : NaN;
            if (!Number.isNaN(t) && t > max) max = t;
        }
        return max;
    };

    return [...groups.values()]
        .map(list => ({ list: [...list].sort(byWindow), anchor: frameAnchor(list) }))
        .sort((a, b) => a.anchor - b.anchor)
        .flatMap(g => g.list);
}

// ---------------------------------------------------------------------------
// Main formatter
// ---------------------------------------------------------------------------

/**
 * Format retrieved events into a prompt injection string.
 * A supplied token budget selects full or compact records in relevance order.
 * Events are re-ordered chronologically for presentation before formatting.
 *
 * @param {object[]} events   - Re-ranked EventRecord objects (highest score first)
 * @param {object}   settings - VectFox settings
 * @returns {string}          - Formatted string ready for injection (empty string if nothing fits)
 */
export function formatEventsForInjectionDetailed(events, _settings, tokenBudget = Infinity) {
    if (!events?.length) {
        return { text: '', includedCount: 0, requestedCount: 0 };
    }

    // Events arrive in score-descending (relevance) order. Capture that as an
    // explicit rank BEFORE the chronological re-sort scrambles position, so the
    // model can still tell which recalled memory best matches the current moment.
    const total = events.length;
    const ranked = events.map((e, i) => ({ ...e, _contextRelevanceRank: i + 1, _contextRelevanceTotal: total }));

    const format = String(_settings?.eventbase_injection_format || 'densetext').toLowerCase();
    const renderFull = list => format === 'densetext' ? _formatAsDenseText(list)
        : format === 'summaryonly' ? _formatAsSummaryOnly(list) : _formatAsJson(list);
    const selected = [], compact = [];
    const render = () => {
        const parts = [];
        if (selected.length) parts.push(renderFull(_orderEventsForPresentation(selected)));
        if (compact.length) parts.push(`Compact recalled events:\n${_orderEventsForPresentation(compact).map(e =>
            `- [${castTime(e)}] (relevance ${e._contextRelevanceRank}/${total}) ${e.summary || _summaryFromText(e.text)}`).join('\n')}`);
        return parts.length ? `${INJECTION_HEADER}\n${parts.join('\n\n')}` : '';
    };
    // Spend on full detail in score order, then try an atomic compact summary.
    // Never slice JSON or a factual line in the middle to make it fit.
    for (const event of ranked) {
        selected.push(event);
        if (estimateCastTokens(render()) <= tokenBudget) continue;
        selected.pop();
        compact.push(event);
        if (estimateCastTokens(render()) > tokenBudget) compact.pop();
    }
    const includedRanks = new Set([...selected, ...compact].map(e => e._contextRelevanceRank));

    return {
        text: render(),
        events: events.filter((e, i) => includedRanks.has(i + 1)),
        compactEventIds: compact.map(e => e.event_id),
        includedCount: selected.length + compact.length,
        requestedCount: events.length,
    };
}

/** Conservative estimate, not a model tokenizer: non-ASCII characters cost one. */
export function estimateCastTokens(text) {
    const chars = [...text];
    const nonAscii = chars.filter(c => c.codePointAt(0) > 127).length;
    return Math.ceil((chars.length - nonAscii) / 4) + nonAscii;
}

function castTime(event) {
    return _formatStoryTime(event.DateTime) || event.scene_time || 'story time unknown';
}

// Unknown story times follow all dated events. Source positions are comparable
// only within one frame, never across conversations. For coalesced events use
// the lexically first collection as their canonical frame; untagged events share
// the empty frame. This is a total ordering, not a pair-dependent date fallback.
function castOrderKey(event) {
    const time = event.DateTime ? Date.parse(event.DateTime) : NaN;
    const frame = event._sortFrame ?? (event._collectionIds || []).reduce((first, id) =>
        first === null || String(id) < first ? String(id) : first, null) ?? '';
    return { time: Number.isFinite(time) ? time : Infinity, frame: String(frame),
        position: Number.isFinite(event.source_window_end) ? event.source_window_end : Infinity,
        id: String(event.event_id) };
}

function compareCastKeys(a, b) {
    return (a.time === b.time ? 0 : a.time - b.time)
        || a.frame.localeCompare(b.frame)
        || (a.position === b.position ? 0 : a.position - b.position)
        || a.id.localeCompare(b.id);
}

/** The cast lane's total chronological order, shared with NPC card input batching. */
export function compareCastChronology(a, b) {
    return compareCastKeys(castOrderKey(a), castOrderKey(b));
}

/** Earliest, latest, persistent/important, then farthest timeline gaps. */
export function selectHistorySpine(events, budget, renderLine) {
    if (!events.length || budget <= 0) return [];
    const keys = new Map(events.map(event => [event, castOrderKey(event)]));
    const chronology = (a, b) => compareCastKeys(keys.get(a), keys.get(b));
    const ordered = [...events].sort(chronology);
    const costs = new Map(ordered.map(event => [event, estimateCastTokens(renderLine(event))]));
    const selected = new Set();
    let remaining = budget;
    const take = event => {
        if (!event || selected.has(event)) return;
        const cost = costs.get(event);
        if (cost <= remaining) { selected.add(event); remaining -= cost; }
    };
    take(ordered[0]);
    take(ordered.at(-1));
    for (const event of [...ordered].sort((a, b) => Number(b.should_persist === true) - Number(a.should_persist === true)
        || (b.importance ?? 0) - (a.importance ?? 0) || chronology(a, b))) {
        if (event.should_persist === true || (event.importance ?? 0) >= 7) take(event);
    }
    const positions = new Map(ordered.map((e, i) => [e, i]));
    let candidates = ordered.filter(e => !selected.has(e) && costs.get(e) <= remaining);
    const distances = new Map(candidates.map(e => [e, Infinity]));
    for (const event of candidates) for (const chosen of selected) {
        distances.set(event, Math.min(distances.get(event), Math.abs(positions.get(chosen) - positions.get(event))));
    }
    while (candidates.length) {
        // Candidates retain chronological order, so a linear maximum scan also
        // supplies the chronological tie-break without sorting the pool again.
        let candidate = candidates[0];
        for (const event of candidates) {
            if (distances.get(event) > distances.get(candidate)) candidate = event;
        }
        take(candidate);
        candidates = candidates.filter(e => e !== candidate && costs.get(e) <= remaining);
        for (const event of candidates) {
            distances.set(event, Math.min(distances.get(event), Math.abs(positions.get(candidate) - positions.get(event))));
        }
        if (remaining <= 0) break;
    }
    return ordered.filter(e => selected.has(e));
}

const CARD_NEWER_HEADER = 'Newer events not yet in the card (oldest → newest):\n';

/** Compact cast lane, allocated smallest history first, after main selection. */
export function formatCastHistoryDetailed({ roster, cast, diagnosticCast = cast, mainEvents = [], settings = {}, chatLength = 0, currentCollectionId = '', currentCollectionIds = [currentCollectionId], cards = new Map() }) {
    const mainIds = new Set(mainEvents.map(e => e.event_id));
    const claimed = new Set(mainIds);
    const depth = settings.deduplication_depth ?? 0;
    const lines = new Map(), costs = new Map();
    const line = e => {
        if (!lines.has(e)) {
            const text = `- [${String(castTime(e)).replace(/\s+/g, ' ')}] ${String(e.summary || _summaryFromText(e.text)).replace(/\s+/g, ' ').trim()}\n`;
            lines.set(e, text);
            costs.set(e, estimateCastTokens(text));
        }
        return lines.get(e);
    };
    const histories = cast.map(entry => {
        const events = roster.events.filter(e => entry.group.eventIds.has(e.event_id) && !mainIds.has(e.event_id)
            && !(depth > 0 && e._collectionIds?.some(id => currentCollectionIds.includes(id)) && (e.source_window_end ?? -1) >= chatLength - depth)
            && (e.summary || e.text));
        const orderLabel = events.some(e => !Number.isFinite(castOrderKey(e).time))
            ? 'dated oldest → newest; unknown times last, grouped by source' : 'oldest → newest';
        const header = `Known history with ${entry.group.name.replace(/\s+/g, ' ')} (${orderLabel}):\n`;
        events.forEach(line);
        const cachedCard = cards.get(entry.group.name);
        const eligibleIds = new Set(events.map(e => e.event_id));
        // Do not let a synthesized card bypass visible-context or main-lane
        // exclusions. If any cited evidence is excluded, use the eligible spine.
        const card = cachedCard?.sourceEventIds?.length && cachedCard.sourceEventIds.every(id => eligibleIds.has(id)) ? cachedCard : null;
        // Cards are atomic. Oversized cards fall back to the source-event spine.
        const cardText = card ? `Known history with ${entry.group.name.replace(/\s+/g, ' ')} (NPC card):\n${card.text}` : '';
        return { ...entry, events, header, card, cardText, cost: cardText ? estimateCastTokens(cardText + '\n') : estimateCastTokens(header) + events.reduce((sum, e) => sum + costs.get(e), 0) };
    }).sort((a, b) => a.cost - b.cost || b.lastMention - a.lastMention);
    let remaining = resolveCastSetting(settings, 'eventbase_cast_token_budget');
    const blocks = [], included = [], skipped = [], cardCharacters = [];
    const allocate = (history, slice) => {
        const events = history.events.filter(e => !claimed.has(e.event_id));
        if (!events.length) return true;
        const limit = Math.min(slice, remaining);
        const cardCost = history.cardText ? estimateCastTokens(history.cardText + '\n') : Infinity;
        if (cardCost <= limit && history.card.sourceEventIds.every(id => !claimed.has(id))) {
            // Events the card has not absorbed yet follow it as source lines,
            // under the same exclusions and within the same slice.
            const unread = new Set(history.card.pendingEventIds || []);
            const newer = selectHistorySpine(events.filter(e => unread.has(e.event_id)),
                limit - cardCost - estimateCastTokens(CARD_NEWER_HEADER), line);
            const block = newer.length ? `${history.cardText}\n${CARD_NEWER_HEADER}${newer.map(line).join('')}`.trimEnd() : history.cardText;
            remaining -= estimateCastTokens(block + '\n');
            blocks.push(block);
            cardCharacters.push(history.group.name);
            const sources = [...events.filter(e => history.card.sourceEventIds.includes(e.event_id)), ...newer];
            included.push(...sources);
            sources.forEach(e => claimed.add(e.event_id));
            return true;
        }
        const selected = selectHistorySpine(events, slice - estimateCastTokens(history.header) - estimateCastTokens('\n'), line);
        if (!selected.length) return false;
        const block = history.header + selected.map(line).join('');
        // Account for the separator as well as headers and event lines.
        const cost = estimateCastTokens(block + '\n');
        if (cost > remaining) return false;
        remaining -= cost;
        blocks.push(block.trimEnd());
        included.push(...selected);
        selected.forEach(e => claimed.add(e.event_id));
        return true;
    };
    for (let i = 0; i < histories.length; i++) {
        const history = histories[i];
        const events = history.events.filter(e => !claimed.has(e.event_id));
        if (!events.length) continue;
        const whole = estimateCastTokens(history.header) + events.reduce((sum, e) => sum + costs.get(e), 0);
        const slice = whole + estimateCastTokens('\n') <= remaining ? remaining : Math.floor(remaining / histories.slice(i).filter(h => h.events.some(e => !claimed.has(e.event_id))).length);
        if (!allocate(history, slice)) skipped.push(history);
    }
    // Equal shares can all be unusable. Retry in smallest-history-first order
    // against the actual remainder, rechecking shared-event claims each time.
    for (const history of skipped) allocate(history, remaining);
    const injectedIds = new Set([...mainEvents, ...included].map(e => e.event_id));
    return {
        text: blocks.join('\n\n'), events: included, includedCount: included.length, cardCharacters,
        zeroInjectionCharacters: diagnosticCast.filter(entry => ![...entry.group.eventIds].some(id => injectedIds.has(id)))
            .map(entry => ({ name: entry.group.name, signals: entry.signals })),
    };
}

