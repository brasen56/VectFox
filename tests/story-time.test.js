/**
 * Story-Time Recency Tests (core/story-time.js)
 *
 * Pure module — no mocks needed (story-time.js has zero imports by design;
 * see its header). Covers:
 *   - parseStoryTimestamp: the injection convention ("3:45 PM, June 12, 2026"),
 *     ISO forms (hand-parsed as UTC — Date.parse would read bare "T15:45" as
 *     LOCAL time), day-first forms, earliest-match-wins, AM/PM edge cases,
 *     digit-run guards, and fantasy-calendar rejection.
 *   - buildStoryRecencyCtx: "now" resolution order (message parse floored by
 *     max candidate DateTime), half-life = 20% of candidate span with a
 *     1-story-day floor, invalid-when-no-anchor.
 *   - storyRecencyBonus: exponential decay contract incl. neutral-0.5
 *     degradation and future-date clamp.
 */

import { describe, it, expect } from 'vitest';
import {
    parseStoryTimestamp,
    buildStoryRecencyCtx,
    storyRecencyBonus,
    eventStoryMs,
    STORY_HALF_LIFE_FLOOR_MS,
} from '../core/story-time.js';

const DAY = 24 * 60 * 60 * 1000;

describe('parseStoryTimestamp', () => {
    it('parses ISO date-only as UTC midnight', () => {
        expect(parseStoryTimestamp('2026-06-12')).toBe(Date.UTC(2026, 5, 12));
    });

    it('parses ISO date-time as UTC (not host-local)', () => {
        expect(parseStoryTimestamp('2026-06-12T15:45')).toBe(Date.UTC(2026, 5, 12, 15, 45));
        expect(parseStoryTimestamp('2026-06-12 15:45:30')).toBe(Date.UTC(2026, 5, 12, 15, 45, 30));
    });

    it('parses the injection convention: "3:45 PM, June 12, 2026"', () => {
        expect(parseStoryTimestamp('3:45 PM, June 12, 2026')).toBe(Date.UTC(2026, 5, 12, 15, 45));
    });

    it('handles 12 AM / 12 PM correctly', () => {
        expect(parseStoryTimestamp('12:05 AM, January 1, 2026')).toBe(Date.UTC(2026, 0, 1, 0, 5));
        expect(parseStoryTimestamp('12:00 PM, June 1, 2026')).toBe(Date.UTC(2026, 5, 1, 12, 0));
    });

    it('parses date-only month-name forms', () => {
        expect(parseStoryTimestamp('June 12, 2026')).toBe(Date.UTC(2026, 5, 12));
        expect(parseStoryTimestamp('June 12th, 2026')).toBe(Date.UTC(2026, 5, 12));
        expect(parseStoryTimestamp('Sept 3, 2026')).toBe(Date.UTC(2026, 8, 3));
    });

    it('parses month-name date with trailing time', () => {
        expect(parseStoryTimestamp('June 12, 2026 at 3:45 pm')).toBe(Date.UTC(2026, 5, 12, 15, 45));
        expect(parseStoryTimestamp('June 12, 2026 - 15:45')).toBe(Date.UTC(2026, 5, 12, 15, 45));
    });

    it('parses day-first forms', () => {
        expect(parseStoryTimestamp('12 June 2026')).toBe(Date.UTC(2026, 5, 12));
        expect(parseStoryTimestamp('12th of June, 2026')).toBe(Date.UTC(2026, 5, 12));
    });

    it('parses bracketed RP headers', () => {
        expect(parseStoryTimestamp('[June 12, 2026 - 3:45 PM] The plaza was crowded.'))
            .toBe(Date.UTC(2026, 5, 12, 15, 45));
    });

    it('takes the earliest match in the text (timestamps are headers)', () => {
        const text = '2026-06-12 — She thought back to June 1, 1998, when it all started.';
        expect(parseStoryTimestamp(text)).toBe(Date.UTC(2026, 5, 12));
    });

    it('rejects digit-run ambiguity instead of misparsing', () => {
        // "112" must not yield day=12 or day=2 (lookbehind guard).
        expect(parseStoryTimestamp('chapter 112 June 2026')).toBeNull();
    });

    it('returns null for fantasy calendars, empty and non-string input', () => {
        expect(parseStoryTimestamp('3rd of Mirtul, 1492 DR')).toBeNull();
        expect(parseStoryTimestamp('')).toBeNull();
        expect(parseStoryTimestamp(null)).toBeNull();
        expect(parseStoryTimestamp(undefined)).toBeNull();
        expect(parseStoryTimestamp(42)).toBeNull();
    });

    it('rejects out-of-range clock values but salvages a valid date in the same text', () => {
        // The malformed "25:99 PM" must not produce a bogus clock time, but the
        // genuine "June 12, 2026" in the text still anchors as date-only.
        expect(parseStoryTimestamp('25:99 PM, June 12, 2026')).toBe(Date.UTC(2026, 5, 12));
        // Pure garbage clock with no salvageable date → null.
        expect(parseStoryTimestamp('25:99')).toBeNull();
    });
});

describe('eventStoryMs', () => {
    it('reads meta.DateTime and tolerates absence', () => {
        expect(eventStoryMs({ DateTime: '2026-06-12' })).toBe(Date.UTC(2026, 5, 12));
        expect(eventStoryMs({})).toBeNull();
        expect(eventStoryMs(null)).toBeNull();
    });
});

describe('buildStoryRecencyCtx', () => {
    const evt = (iso) => ({ DateTime: iso });

    it('anchors "now" on the newest-first message texts', () => {
        const ctx = buildStoryRecencyCtx(
            [evt('2026-01-01')],
            ['no timestamp here', '3:45 PM, June 12, 2026 — the plaza'],
        );
        expect(ctx.valid).toBe(true);
        expect(ctx.nowMs).toBe(Date.UTC(2026, 5, 12, 15, 45));
        expect(ctx.nowSource).toBe('both');
    });

    it('floors a lowball message parse at the max candidate DateTime', () => {
        // Dialogue reference to 1998 must not drag "now" behind the story:
        // candidates were extracted from this story, so their max floors it.
        const ctx = buildStoryRecencyCtx(
            [evt('2026-01-01'), evt('2026-06-12')],
            ['She remembered June 1, 1998 like yesterday.'],
        );
        expect(ctx.nowMs).toBe(Date.UTC(2026, 5, 12));
    });

    it('falls back to candidates when no message parses', () => {
        const ctx = buildStoryRecencyCtx([evt('2026-06-12'), evt('2026-01-01')], ['hi']);
        expect(ctx.valid).toBe(true);
        expect(ctx.nowMs).toBe(Date.UTC(2026, 5, 12));
        expect(ctx.nowSource).toBe('candidates');
    });

    it('is invalid when nothing anywhere parses', () => {
        const ctx = buildStoryRecencyCtx([{}, { DateTime: 'garbage' }], ['no dates']);
        expect(ctx.valid).toBe(false);
        expect(ctx.nowMs).toBeNull();
    });

    it('half-life = 20% of candidate span, floored at one story-day', () => {
        // 100-day span → 20-day half-life.
        const wide = buildStoryRecencyCtx([evt('2026-01-01'), evt('2026-04-11')], []);
        expect(wide.halfLifeMs).toBeCloseTo(20 * DAY, -5);

        // Same-day candidates → floor.
        const tight = buildStoryRecencyCtx([evt('2026-06-12T08:00'), evt('2026-06-12T09:00')], []);
        expect(tight.halfLifeMs).toBe(STORY_HALF_LIFE_FLOOR_MS);
    });

    it('counts dated candidates', () => {
        const ctx = buildStoryRecencyCtx([evt('2026-01-01'), {}, evt('2026-02-01')], []);
        expect(ctx.datedCandidates).toBe(2);
    });
});

describe('storyRecencyBonus', () => {
    const now = Date.UTC(2026, 5, 12);
    const ctx = { valid: true, nowMs: now, halfLifeMs: 20 * DAY };

    it('scores 1.0 at "now" and 0.5 one half-life back', () => {
        expect(storyRecencyBonus({ DateTime: '2026-06-12' }, ctx)).toBeCloseTo(1.0, 10);
        expect(storyRecencyBonus({ DateTime: '2026-05-23' }, ctx)).toBeCloseTo(0.5, 10);
    });

    it('clamps future-dated events to 1.0', () => {
        expect(storyRecencyBonus({ DateTime: '2027-01-01' }, ctx)).toBe(1.0);
    });

    it('degrades to neutral 0.5 on missing DateTime or invalid ctx', () => {
        expect(storyRecencyBonus({}, ctx)).toBe(0.5);
        expect(storyRecencyBonus({ DateTime: '2026-06-01' }, { valid: false })).toBe(0.5);
        expect(storyRecencyBonus({ DateTime: '2026-06-01' }, null)).toBe(0.5);
    });

    it('decays monotonically with narrative age', () => {
        const b1 = storyRecencyBonus({ DateTime: '2026-06-01' }, ctx);
        const b2 = storyRecencyBonus({ DateTime: '2026-03-01' }, ctx);
        const b3 = storyRecencyBonus({ DateTime: '2025-06-01' }, ctx);
        expect(b1).toBeGreaterThan(b2);
        expect(b2).toBeGreaterThan(b3);
    });
});
