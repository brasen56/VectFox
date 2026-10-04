import { describe, it, expect } from 'vitest';
import { formatBudgetedEventBase } from '../core/eventbase-token-budget.js';
import { estimateCastTokens, formatEventsForInjectionDetailed, formatCastHistoryDetailed } from '../core/eventbase-injection.js';

const events = Array.from({ length: 10 }, (_, i) => ({ event_id: `e${i}`, summary: `Fact ${i}`,
    text: `[event] Fact ${i}`, cause: 'detail '.repeat(100), source_window_end: i,
    characters: ['Brennan'], DateTime: '2026-06-03' }));
const group = { name: 'Brennan', aliases: ['Brennan'], eventIds: new Set(events.map(e => e.event_id)) };
const roster = { ready: true, events, groups: [group] };
const cast = [{ group, lastMention: 10, signals: ['text'] }];
const card = (fact, source_ids, extra = {}) => ({ facts: [{ fact, source_ids }], ...extra });

describe('shared EventBase token envelope', () => {
    it('keeps full detail for the best hit and compacts lower-ranked hits', () => {
        const result = formatEventsForInjectionDetailed(events, {}, 900);
        expect(result.text).toContain('cause:');
        expect(result.compactEventIds.length).toBeGreaterThan(0);
        expect(estimateCastTokens(result.text)).toBeLessThanOrEqual(900);
        expect(result.events[0]).toBe(events[0]);
    });
    it('caps combined lanes and wrappers across formats and small budgets', () => {
        for (const format of ['json', 'densetext', 'summaryonly']) {
            for (const budget of [0, 1, 20, 100, 400, 900, 4000]) {
                const result = formatBudgetedEventBase({ events, roster, cast,
                    settings: { eventbase_token_budget: budget, eventbase_injection_format: format },
                    globalContext: 'Known facts only', xmlTag: 'memory' });
                expect(estimateCastTokens(result.text)).toBeLessThanOrEqual(budget);
                const mainIds = new Set(result.main.events?.map(e => e.event_id));
                expect(result.cast.events.every(e => !mainIds.has(e.event_id))).toBe(true);
            }
        }
    });
    it('allows cast recall without topical matches and refuses oversized wrappers', () => {
        expect(formatBudgetedEventBase({ roster, cast, settings: {} }).text).toContain('Known history');
        expect(formatBudgetedEventBase({ events, settings: { eventbase_token_budget: 50 }, globalContext: 'x'.repeat(1000) }).text).toBe('');
    });
    it('uses surviving cards and falls back to the spine when they do not fit', () => {
        const cards = new Map([['Brennan', card('Filed the LLC.', ['e0'])]]);
        const options = { roster, cast, cards, settings: { eventbase_token_budget: 300 } };
        expect(formatBudgetedEventBase(options).cast.cardCharacters).toEqual(['Brennan']);
        cards.get('Brennan').facts[0].fact = 'x'.repeat(5000);
        const result = formatBudgetedEventBase(options);
        expect(result.cast.cardCharacters).toEqual([]);
        expect(result.text).toContain('Fact');
    });
    it('lists events the card has not absorbed after it, under the same exclusions', () => {
        const cards = new Map([['Brennan', card('Filed the LLC.', ['e0'], { pendingEventIds: ['e8', 'e9'] })]]);
        const result = formatBudgetedEventBase({ roster, cast, cards, settings: { eventbase_token_budget: 400 } });
        expect(result.cast.cardCharacters).toEqual(['Brennan']);
        expect(result.text).toContain('Newer events not yet in the card');
        expect(result.text).toContain('Fact 9');
        expect(estimateCastTokens(result.text)).toBeLessThanOrEqual(400);
        const withMain = formatBudgetedEventBase({ events: [events[9]], roster, cast, cards, settings: {} });
        expect(withMain.cast.events.map(e => e.event_id)).toEqual(['e0', 'e8']);
    });
    it('does not let card facts bypass current-chat visible-context exclusions', () => {
        const visibleEvents = events.map(e => ({ ...e, _collectionIds: ['live'], source_window_end: 99 }));
        const cards = new Map([['Brennan', card('Filed LLC.', ['e0'])]]);
        const result = formatBudgetedEventBase({ roster: { ...roster, events: visibleEvents }, cast, cards,
            settings: { deduplication_depth: 10 }, chatLength: 100, currentCollectionIds: ['live'] });
        expect(result.text).toBe('');
        expect(result.cast.cardCharacters).toEqual([]);
    });
    it('keeps unrelated facts when main evidence excludes a meeting, without changing the cache', () => {
        const cached = { facts: [
            { fact: 'Attended the shared meeting.', source_ids: ['e0'] },
            { fact: 'Filed the LLC.', source_ids: ['e1'] },
            { fact: 'Synthesized both events.', source_ids: ['e0', 'e2'] },
        ] };
        const cards = new Map([['Brennan', cached]]);
        const result = formatCastHistoryDetailed({ roster, cast, cards, mainEvents: [events[0]] });
        expect(result.cardCharacters).toEqual(['Brennan']);
        expect(result.text).toContain('Filed the LLC.');
        expect(result.text).not.toContain('meeting');
        expect(result.text).not.toContain('Synthesized');
        expect(result.events.map(e => e.event_id)).toEqual(['e1']);
        expect(cached.facts).toHaveLength(3);
        expect(cached.facts[2].source_ids).toEqual(['e0', 'e2']);
    });
    it('filters visible-context facts but retains cross-chat evidence', () => {
        const local = events.map(e => ({ ...e, _collectionIds: [e.event_id === 'e0' ? 'live' : 'archive'], source_window_end: 99 }));
        const cards = new Map([['Brennan', { facts: [
            { fact: 'Visible meeting.', source_ids: ['e0'] },
            { fact: 'Archive filing.', source_ids: ['e1'] },
            { fact: 'Combined claim.', source_ids: ['e0', 'e1'] },
        ] }]]);
        const result = formatCastHistoryDetailed({ roster: { ...roster, events: local }, cast, cards,
            settings: { deduplication_depth: 10 }, chatLength: 100, currentCollectionIds: ['live'] });
        expect(result.text).toContain('Archive filing.');
        expect(result.text).not.toContain('Visible meeting.');
        expect(result.text).not.toContain('Combined claim.');
        expect(result.events.map(e => e.event_id)).toEqual(['e1']);
    });
    it('re-gates facts after earlier NPC claims and claims only surviving citations', () => {
        const earlier = { name: 'Ada', eventIds: new Set(['e0']) };
        const later = { name: 'Zoe', eventIds: new Set(['e2']) };
        const cards = new Map([
            ['Ada', card('Meeting.', ['e0'])],
            ['Brennan', { facts: [
                { fact: 'Shared meeting also attended.', source_ids: ['e0'] },
                { fact: 'Filed the LLC.', source_ids: ['e1'] },
                { fact: 'Multi-source excluded claim.', source_ids: ['e0', 'e2'] },
            ] }],
            ['Zoe', card('Independent evidence still available. ' + 'Additional grounded detail. '.repeat(10), ['e2'])],
        ]);
        const result = formatCastHistoryDetailed({ roster, cards, cast: [
            { group: earlier, lastMention: 30 }, cast[0], { group: later, lastMention: 0 },
        ] });
        expect(result.cardCharacters).toContain('Brennan');
        expect(result.cardCharacters).toEqual(['Ada', 'Brennan', 'Zoe']);
        expect(result.text).toContain('Filed the LLC.');
        expect(result.text).not.toContain('Shared meeting also attended.');
        expect(result.text).not.toContain('Multi-source excluded claim.');
        expect(result.text).toContain('Independent evidence still available.');
        expect(result.events.map(e => e.event_id).sort()).toEqual(['e0', 'e1', 'e2']);
    });
    it('falls back to the eligible spine when no facts survive', () => {
        const cards = new Map([['Brennan', card('Combined claim.', ['e0', 'e1'])]]);
        const result = formatCastHistoryDetailed({ roster, cast, cards, mainEvents: [events[0]] });
        expect(result.cardCharacters).toEqual([]);
        expect(result.text).toContain('Fact 1');
        expect(result.events.some(e => e.event_id === 'e0')).toBe(false);
    });
    it('records why each cached card was or was not injected', () => {
        const outcomes = (cards, options = {}) => formatCastHistoryDetailed({ roster, cast, cards, ...options }).cardOutcomes;
        expect(outcomes(new Map([['Brennan', { facts: [
            { fact: 'Attended the shared meeting.', source_ids: ['e0'] },
            { fact: 'Filed the LLC.', source_ids: ['e1'] },
        ] }]]), { mainEvents: [events[0]] }))
            .toEqual([{ name: 'Brennan', facts: 2, eligibleFacts: 1, injectedFacts: 1, outcome: 'injected' }]);
        expect(outcomes(new Map([['Brennan', card('Combined claim.', ['e0', 'e1'])]]), { mainEvents: [events[0]] }))
            .toEqual([{ name: 'Brennan', facts: 1, eligibleFacts: 0, injectedFacts: 0, outcome: 'gated' }]);
        expect(outcomes(new Map([['Brennan', card('x'.repeat(5000), ['e0'])]]), { settings: { eventbase_cast_token_budget: 300 } }))
            .toEqual([expect.objectContaining({ outcome: 'over_slice', sliceTokens: 300 })]);
        expect(outcomes(new Map([['Brennan', card('Filed the LLC.', ['e1'])]]), { mainEvents: events }))
            .toEqual([expect.objectContaining({ outcome: 'no_events' })]);
        const ada = { name: 'Ada', eventIds: new Set(['e0']) };
        expect(formatCastHistoryDetailed({ roster, cast: [{ group: ada, lastMention: 30 }, cast[0]],
            cards: new Map([['Ada', card('Meeting.', ['e0'])], ['Brennan', card('Shared meeting.', ['e0'])]]) }).cardOutcomes)
            .toEqual([
                { name: 'Ada', facts: 1, eligibleFacts: 1, injectedFacts: 1, outcome: 'injected' },
                { name: 'Brennan', facts: 1, eligibleFacts: 1, injectedFacts: 0, outcome: 'claimed' },
            ]);
    });
    it('budgets only surviving facts across the shared-envelope main reallocation', () => {
        const cards = new Map([['Brennan', { facts: [
            { fact: 'excluded '.repeat(1000), source_ids: ['e0'] },
            { fact: 'Filed the LLC.', source_ids: ['e1'] },
        ] }]]);
        const result = formatBudgetedEventBase({ events: [events[0]], roster, cast, cards,
            settings: { eventbase_token_budget: 300, eventbase_cast_token_budget: 100, eventbase_injection_format: 'summaryonly' } });
        expect(result.main.events.map(e => e.event_id)).toEqual(['e0']);
        expect(result.cast.cardCharacters).toEqual(['Brennan']);
        expect(result.text).toContain('Filed the LLC.');
        expect(estimateCastTokens(result.text)).toBeLessThanOrEqual(300);
    });
});