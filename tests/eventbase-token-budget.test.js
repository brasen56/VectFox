import { describe, it, expect } from 'vitest';
import { formatBudgetedEventBase } from '../core/eventbase-token-budget.js';
import { estimateCastTokens, formatEventsForInjectionDetailed } from '../core/eventbase-injection.js';

const events = Array.from({ length: 10 }, (_, i) => ({ event_id: `e${i}`, summary: `Fact ${i}`,
    text: `[event] Fact ${i}`, cause: 'detail '.repeat(100), source_window_end: i,
    characters: ['Brennan'], DateTime: '2026-06-03' }));
const group = { name: 'Brennan', aliases: ['Brennan'], eventIds: new Set(events.map(e => e.event_id)) };
const roster = { ready: true, events, groups: [group] };
const cast = [{ group, lastMention: 10, signals: ['text'] }];

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
    it('uses atomic cards and falls back to the spine when they do not fit', () => {
        const cards = new Map([['Brennan', { text: '- Filed the LLC.', sourceEventIds: ['e0'] }]]);
        const options = { roster, cast, cards, settings: { eventbase_token_budget: 300 } };
        expect(formatBudgetedEventBase(options).cast.cardCharacters).toEqual(['Brennan']);
        cards.get('Brennan').text = 'x'.repeat(5000);
        const result = formatBudgetedEventBase(options);
        expect(result.cast.cardCharacters).toEqual([]);
        expect(result.text).toContain('Fact');
    });
    it('lists events the card has not absorbed after it, under the same exclusions', () => {
        const cards = new Map([['Brennan', { text: '- Filed the LLC.', sourceEventIds: ['e0'], pendingEventIds: ['e8', 'e9'] }]]);
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
        const cards = new Map([['Brennan', { text: '- Filed LLC.', sourceEventIds: ['e0'] }]]);
        const result = formatBudgetedEventBase({ roster: { ...roster, events: visibleEvents }, cast, cards,
            settings: { deduplication_depth: 10 }, chatLength: 100, currentCollectionIds: ['live'] });
        expect(result.text).toBe('');
        expect(result.cast.cardCharacters).toEqual([]);
    });
});