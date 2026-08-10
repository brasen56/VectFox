/**
 * ============================================================================
 * STORY-TIME RECENCY
 * ============================================================================
 * Narrative-clock replacement for message-index recency decay.
 *
 * Index-based recency (`source_window_end` vs live chat length) breaks under
 * Inline Summary: events are stamped in ILS-EXPANDED coordinates while
 * retrieval measures the COLLAPSED live chat (each summary = 1 message), so
 * every event beyond the collapsed length clamps to age 0. Flattening ILS
 * summaries then destroys the coordinate mapping permanently and lets newly
 * extracted events collide with the oldest events' index range. Story time
 * survives all of that — narrative dates don't care how messages are packed.
 *
 * Selected via `eventbase_recency_source: 'story_time'`. Sources, in order:
 *   now  = max( first parseable timestamp in the newest chat messages,
 *               max DateTime across the candidate set )
 *          The max() is the safety net: a mid-text date reference ("back in
 *          June 1998...") can lowball the message parse, but candidates were
 *          extracted from this same story so their max floors "now" at the
 *          latest known story moment. Overshoot is only possible if extraction
 *          hallucinated future dates.
 *   span = now − min DateTime across candidates. Half-life = 20% of span
 *          (floor 1 story-day) — same auto-scaling philosophy as the index
 *          path's `max(40, chatLength × 0.20)`, on the narrative clock.
 *          Span over the CANDIDATE set (not the collection) is deliberate:
 *          only candidates are ever scored, so the decay self-normalizes to
 *          the temporal spread of what is actually being ranked.
 *
 * Degradation (feedback memory: optional enhancements must degrade): an event
 * with a missing/unparseable DateTime scores the neutral 0.5 the index path
 * already uses for unknown state; if NO usable "now" exists the whole context
 * is invalid and every event scores 0.5 — recency becomes a constant and the
 * other re-rank weights carry the ranking.
 *
 * PURE MODULE — no SillyTavern imports, no logging, fully unit-testable.
 * Callers that want diagnostics log the returned ctx themselves.
 * ============================================================================
 */

/** Half-life floor: one story-day. Same-scene events shouldn't decay to
 *  irrelevance just because the whole candidate set spans a single day. */
export const STORY_HALF_LIFE_FLOOR_MS = 24 * 60 * 60 * 1000;

/** Fraction of the candidate time span used as the half-life. */
export const STORY_HALF_LIFE_SPAN_FRACTION = 0.20;

const MONTH_INDEX = (() => {
    const names = ['january', 'february', 'march', 'april', 'may', 'june',
        'july', 'august', 'september', 'october', 'november', 'december'];
    /** @type {Record<string, number>} */
    const map = {};
    names.forEach((n, i) => {
        map[n] = i;
        map[n.slice(0, 3)] = i;   // jan, feb, ... (sept handled below)
    });
    map['sept'] = 8;
    return map;
})();

// Month-name alternation for the patterns below. Longest-first so "june"
// doesn't stop a "jun" prefix match early (regex alternation is eager).
const MONTH_RE = '(january|february|march|april|may|june|july|august|september|october|november|december|sept|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)';

// ---------------------------------------------------------------------------
// Timestamp patterns
// ---------------------------------------------------------------------------
// Each pattern yields { index, ms, hasTime } via its `build` function
// (null ms → invalid capture, skip). Scanned with /g; the EARLIEST match in
// the text wins because RP timestamps are conventionally message headers —
// tie on index goes to the more specific (time-bearing) match.

/** 12 AM → 0, 12 PM → 12, no marker → as-given (24h clock). */
function _hour24(hStr, ampm) {
    let h = parseInt(hStr, 10);
    if (Number.isNaN(h) || h > 23) return null;
    if (ampm) {
        if (h < 1 || h > 12) return null;
        const isPM = ampm.toLowerCase() === 'pm';
        if (h === 12) h = isPM ? 12 : 0;
        else if (isPM) h += 12;
    }
    return h;
}

function _utc(year, monthIdx, day, hour = 0, minute = 0, second = 0) {
    if (monthIdx == null || monthIdx < 0 || monthIdx > 11) return null;
    if (day < 1 || day > 31) return null;
    if (year < 1000 || year > 9999) return null;  // RP-wide but sane; 2-digit years are too ambiguous
    if (hour == null || minute == null || minute > 59 || second > 59) return null;
    return Date.UTC(year, monthIdx, day, hour, minute, second);
}

const PATTERNS = [
    // ISO-8601: 2026-06-12, 2026-06-12T15:45[:30], 2026-06-12 15:45.
    // Hand-parsed as UTC: Date.parse treats "T15:45" without a zone as LOCAL
    // time, which would shift the story clock by the host timezone (same
    // reason eventbase-injection.js's _formatStoryTime uses UTC getters).
    {
        re: /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/g,
        build: (m) => ({
            ms: _utc(+m[1], +m[2] - 1, +m[3], m[4] != null ? _hour24(m[4], null) : 0, m[5] != null ? +m[5] : 0, m[6] != null ? +m[6] : 0),
            hasTime: m[4] != null,
        }),
    },
    // Injection convention (what _formatStoryTime renders and models mirror):
    // "3:45 PM, June 12, 2026" — time first, then month-name date.
    {
        re: new RegExp(String.raw`(?<!\d)(\d{1,2}):(\d{2})\s*([ap]m)?\s*[,–—-]?\s+${MONTH_RE}\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)`, 'gi'),
        build: (m) => ({
            ms: _utc(+m[6], MONTH_INDEX[m[4].toLowerCase()], +m[5], _hour24(m[1], m[3]), +m[2]),
            hasTime: true,
        }),
    },
    // "June 12, 2026" with optional trailing time: ", 3:45 PM" / "- 15:45" / "at 3:45 PM".
    {
        re: new RegExp(String.raw`${MONTH_RE}\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)(?:\s*(?:[,–—-]|at)\s*(\d{1,2}):(\d{2})\s*([ap]m)?)?`, 'gi'),
        build: (m) => ({
            ms: _utc(+m[3], MONTH_INDEX[m[1].toLowerCase()], +m[2], m[4] != null ? _hour24(m[4], m[6]) : 0, m[5] != null ? +m[5] : 0),
            hasTime: m[4] != null,
        }),
    },
    // Day-first: "12 June 2026" / "12th of June, 2026", optional trailing time.
    {
        re: new RegExp(String.raw`(?<!\d)(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_RE}\.?,?\s+(\d{4})(?!\d)(?:\s*(?:[,–—-]|at)\s*(\d{1,2}):(\d{2})\s*([ap]m)?)?`, 'gi'),
        build: (m) => ({
            ms: _utc(+m[3], MONTH_INDEX[m[2].toLowerCase()], +m[1], m[4] != null ? _hour24(m[4], m[6]) : 0, m[5] != null ? +m[5] : 0),
            hasTime: m[4] != null,
        }),
    },
];

/**
 * Parse the first in-story timestamp found in a text.
 *
 * "First" = earliest position in the string (RP timestamps are headers);
 * position ties go to the match that carries a clock time. Returns UTC epoch
 * ms, or null when nothing parseable is present (e.g. fantasy calendars —
 * "3rd of Mirtul, 1492 DR" — deliberately fall through to the caller's
 * fallback chain rather than guessing).
 *
 * @param {string|null|undefined} text
 * @returns {number|null} UTC epoch ms
 */
export function parseStoryTimestamp(text) {
    if (!text || typeof text !== 'string') return null;

    let best = null; // { index, ms, hasTime }
    for (const { re, build } of PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            const { ms, hasTime } = build(m);
            if (ms == null) continue;
            if (!best
                || m.index < best.index
                || (m.index === best.index && hasTime && !best.hasTime)) {
                best = { index: m.index, ms, hasTime };
            }
            // Only the earliest match per pattern can win — later /g matches
            // in the same pattern have strictly larger indexes.
            break;
        }
    }
    return best ? best.ms : null;
}

/**
 * Parse an event's stored DateTime. Stored values are normalized UTC ISO at
 * extraction, so the ISO pattern handles the common case; the tolerant parser
 * covers legacy/hand-edited values.
 * @param {object} meta Event metadata (reads meta.DateTime)
 * @returns {number|null} UTC epoch ms
 */
export function eventStoryMs(meta) {
    return parseStoryTimestamp(meta?.DateTime);
}

/**
 * Build the recency context for one retrieval call.
 *
 * @param {object[]} candidates Candidate event metadata (post importance filter)
 * @param {string[]} [recentMessageTexts] Newest-first raw chat message texts;
 *        the first one containing a parseable timestamp anchors "now".
 * @returns {{ valid: boolean, nowMs: number|null, halfLifeMs: number,
 *             nowSource: 'message'|'candidates'|'both'|null,
 *             datedCandidates: number, spanMs: number }}
 */
export function buildStoryRecencyCtx(candidates, recentMessageTexts) {
    let minCandidate = null;
    let maxCandidate = null;
    let dated = 0;
    for (const meta of candidates || []) {
        const t = eventStoryMs(meta);
        if (t == null) continue;
        dated++;
        if (minCandidate == null || t < minCandidate) minCandidate = t;
        if (maxCandidate == null || t > maxCandidate) maxCandidate = t;
    }

    let messageNow = null;
    for (const text of recentMessageTexts || []) {
        messageNow = parseStoryTimestamp(text);
        if (messageNow != null) break;
    }

    let nowMs = null;
    let nowSource = null;
    if (messageNow != null && maxCandidate != null) {
        nowMs = Math.max(messageNow, maxCandidate);
        nowSource = 'both';
    } else if (messageNow != null) {
        nowMs = messageNow;
        nowSource = 'message';
    } else if (maxCandidate != null) {
        nowMs = maxCandidate;
        nowSource = 'candidates';
    }

    const spanMs = (nowMs != null && minCandidate != null) ? Math.max(0, nowMs - minCandidate) : 0;
    const halfLifeMs = Math.max(STORY_HALF_LIFE_FLOOR_MS, spanMs * STORY_HALF_LIFE_SPAN_FRACTION);

    return {
        valid: nowMs != null,
        nowMs,
        halfLifeMs,
        nowSource,
        datedCandidates: dated,
        spanMs,
    };
}

/**
 * Story-time recency bonus: exponential decay over narrative distance from
 * "now". Mirrors the index path's contract — 0..1, future/unknown clamps:
 *   - event dated at/after now → 1.0 (age clamps to 0, same as index path)
 *   - missing/unparseable DateTime, or invalid ctx → neutral 0.5
 *
 * @param {object} meta Event metadata
 * @param {object} ctx  From buildStoryRecencyCtx
 * @returns {number} 0..1
 */
export function storyRecencyBonus(meta, ctx) {
    if (!ctx?.valid) return 0.5;
    const t = eventStoryMs(meta);
    if (t == null) return 0.5;
    const age = Math.max(0, ctx.nowMs - t);
    return Math.pow(0.5, age / ctx.halfLifeMs);
}
