import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} } }));
vi.mock('../../../../utils.js', () => ({ uuidv4: () => 'uuid' }));
vi.mock('../core/log.js', () => ({ log: { warn: vi.fn() } }));
import { buildCharacterRoster } from '../core/character-roster.js';
import { detectSceneCast } from '../core/scene-cast.js';
import { formatCastHistoryDetailed, estimateCastTokens, selectHistorySpine } from '../core/eventbase-injection.js';
import { resolveCastSetting } from '../core/scene-cast-settings.js';
import { formatRetrievalDiagnostics } from '../core/eventbase-retrieval-debug.js';

const event = (id, characters, extra = {}) => ({ event_id: String(id), characters, summary: `Memory ${id}`,
    DateTime: `2026-06-${String(id).padStart(2, '0')}T00:00:00Z`, source_window_end: id, ...extra });
const rosterFor = events => ({ ...buildCharacterRoster(events), events, ready: true });
const names = cast => cast.map(c => c.group.name);
const messages = (...texts) => texts.map(mes => ({ mes, is_user: true }));
const detect = (roster, chat, extra = {}) => detectSceneCast({ roster, chat, dryRun: true, ...extra });

describe('scene cast detection', () => {
    const roster = rosterFor([event(1, ['Brennan']), event(2, ['Howard Brennan']), event(3, ['Ann']), event(4, ['李明'])]);
    it('matches aliases, punctuation, possessives and literal CJK names, not substrings', () => {
        expect(names(detect(roster, messages("BRENNAN's office; 李明 waits, Anna leaves.")))).toEqual(['Howard Brennan', '李明']);
        expect(names(detect(roster, messages('Annabelle')))).toEqual([]);
    });
    it('is sticky over non-system messages only and expires at the boundary', () => {
        const settings = { eventbase_cast_sticky_messages: 2 };
        expect(names(detect(roster, [...messages('Brennan'), { mes: 'system', is_system: true }, ...messages('the dispute')], { settings }))).toEqual(['Howard Brennan']);
        expect(detect(roster, messages('Brennan', 'dispute', 'payment'), { settings })).toEqual([]);
    });
    it('strips reasoning and game bookkeeping before matching', () => {
        expect(detect(roster, messages('<think>Brennan</think><UpdateVariable>Ann</UpdateVariable>The door opens.'))).toEqual([]);
    });
    it('excludes alias-group leads from both signals', () => {
        const events = Array.from({ length: 20 }, (_, i) => event(i + 1, ['Kai', 'Kai Tanaka', ...(i === 0 ? ['Brennan'] : [])]));
        expect(names(detect(rosterFor(events), messages('Kai Tanaka and Brennan'), { plannerCharacters: ['Kai', 'Kai Tanaka'] }))).toEqual(['Brennan']);
    });
    it('unions planner and text signals, ranks by recency, and caps characters', () => {
        const cast = detect(roster, messages('Ann', 'Brennan'), { plannerCharacters: ['Howard Brennan', '李明'], settings: { eventbase_cast_max_characters: 2 } });
        expect(names(cast)).toEqual(['Howard Brennan', '李明']);
        expect(cast[0].signals).toEqual(['text', 'planner']);
    });
    it('remembers planner-only detections, expires them, and isolates chats', () => {
        const chat = messages('the lawyer');
        detect(roster, chat, { chatId: 'memory', dryRun: false, plannerCharacters: ['Brennan'] });
        const settings = { eventbase_cast_sticky_messages: 2 };
        expect(names(detect(roster, [...chat, ...messages('the payment')], { chatId: 'memory', settings }))).toEqual(['Howard Brennan']);
        expect(detect(roster, [...chat, ...messages('one', 'two')], { chatId: 'memory', settings })).toEqual([]);
        expect(detect(roster, chat, { chatId: 'other' })).toEqual([]);
    });
    it('invalidates planner observations after edits, swipes and shrink', () => {
        const chat = messages('scene', 'lawyer');
        detect(roster, chat, { chatId: 'edits', dryRun: false, plannerCharacters: ['Brennan'] });
        expect(detect(roster, messages('scene', 'changed'), { chatId: 'edits' })).toEqual([]);
        expect(detect(roster, messages('changed', 'lawyer'), { chatId: 'edits' })).toEqual([]);
        expect(detect(roster, messages('scene'), { chatId: 'edits' })).toEqual([]);
    });
    it('dry-runs can use a hypothetical message but never save planner memory', () => {
        expect(names(detect(roster, [], { testMessage: 'Brennan', chatId: 'dry', plannerCharacters: ['Ann'] }))).toEqual(['Ann', 'Howard Brennan']);
        expect(detect(roster, messages('scene'), { chatId: 'dry' })).toEqual([]);
    });
    it('honors zero settings and safely resolves invalid numbers', () => {
        expect(detect(roster, messages('Brennan'), { settings: { eventbase_cast_sticky_messages: 0 } })).toEqual([]);
        expect(detect(roster, messages('Brennan'), { settings: { eventbase_cast_max_characters: 0 } })).toEqual([]);
        expect(resolveCastSetting({ eventbase_cast_token_budget: NaN }, 'eventbase_cast_token_budget')).toBe(700);
        expect(resolveCastSetting({ eventbase_cast_token_budget: -1 }, 'eventbase_cast_token_budget')).toBe(0);
    });
});

describe('cast history injection', () => {
    it('orders every mixed-date permutation consistently, including spine endpoints', () => {
        const a = event('a', ['Brennan'], { DateTime: '2026-01-01', source_window_end: 30 });
        const b = event('b', ['Brennan'], { DateTime: null, source_window_end: 20 });
        const c = event('c', ['Brennan'], { DateTime: '2026-02-01', source_window_end: 10 });
        for (const events of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
            const roster = rosterFor(events);
            expect(formatCastHistoryDetailed({ roster, cast: detect(roster, messages('Brennan')) })
                .events.map(e => e.event_id)).toEqual(['a', 'c', 'b']);
            expect(selectHistorySpine(events, 2, () => 'x').map(e => e.event_id)).toEqual(['a', 'b']);
        }
    });
    it('groups undated source frames before comparing message positions', () => {
        const events = [
            event('z', [], { DateTime: null, _collectionIds: ['archive-b'], source_window_end: 1 }),
            event('b', [], { DateTime: 'invalid', _collectionIds: ['archive-a'], source_window_end: 20 }),
            event('a', [], { DateTime: null, _collectionIds: ['archive-a'], source_window_end: 10 }),
            event('c', [], { DateTime: null, _collectionIds: ['archive-a'], source_window_end: null }),
        ];
        expect(selectHistorySpine(events, 100, () => 'x').map(e => e.event_id)).toEqual(['a', 'b', 'c', 'z']);
        expect(selectHistorySpine([...events].reverse(), 100, () => 'x').map(e => e.event_id)).toEqual(['a', 'b', 'c', 'z']);
    });
    it('redistributes unusable equal shares to a feasible smallest-history spine', () => {
        const events = [event(1, ['A'], { DateTime: '2026-01-01', summary: 'x'.repeat(100) }),
            event(2, ['A'], { DateTime: '2026-01-01', summary: 'x'.repeat(100) }),
            event(3, ['B'], { DateTime: '2026-01-01', summary: 'x'.repeat(260) })];
        const roster = rosterFor(events);
        const result = formatCastHistoryDetailed({ roster, cast: detect(roster, messages('A B')),
            settings: { eventbase_cast_token_budget: 60 } });
        expect(result.events.map(e => e.event_id)).toEqual(['1']);
        expect(estimateCastTokens(result.text)).toBeLessThanOrEqual(60);
    });
    it('renders each exhausted-pool candidate only once without repeated pool sorting', () => {
        const events = Array.from({ length: 10000 }, (_, i) => event(i + 1, [], { DateTime: null }));
        const render = vi.fn(() => 'x'.repeat(200));
        const sort = vi.spyOn(Array.prototype, 'sort');
        let selected, sortCalls;
        try {
            selected = selectHistorySpine(events, 170, render);
            sortCalls = sort.mock.calls.length;
        } finally {
            sort.mockRestore();
        }
        expect(selected.map(e => e.event_id)).toEqual(['1', '5000', '10000']);
        expect(render).toHaveBeenCalledTimes(events.length);
        expect(sortCalls).toBeLessThanOrEqual(2);
    });
    it('recalls Brennan’s routine LLC event without topical words, oldest first', () => {
        const events = [event(2, ['Howard Brennan'], { summary: 'Discussed the wire payment.' }),
            event(1, ['Brennan'], { summary: 'Drafted and filed the LLC formation and operating agreement.', importance: 1 })];
        const roster = rosterFor(events);
        const cast = detect(roster, messages('We visit Brennan about the contract dispute.'));
        const result = formatCastHistoryDetailed({ roster, cast });
        expect(result.text).toContain('Known history with Howard Brennan (oldest → newest):');
        expect(result.text).toContain('[June 1, 2026] Drafted and filed the LLC');
        expect(result.text.indexOf('Drafted')).toBeLessThan(result.text.indexOf('Discussed'));
        expect(result.includedCount).toBe(2);
        expect(result.zeroInjectionCharacters).toEqual([]);
    });
    it('excludes main events and visible current-chat history, not cross-chat history', () => {
        const events = [event(1, ['Brennan']), event(2, ['Brennan'], { source_window_end: 98, _collectionIds: ['current'] }),
            event(3, ['Brennan'], { source_window_end: 98, _collectionIds: ['archive'] })];
        const roster = rosterFor(events), cast = detect(roster, messages('Brennan'));
        const result = formatCastHistoryDetailed({ roster, cast, mainEvents: [events[0]], chatLength: 100,
            currentCollectionId: 'current', settings: { deduplication_depth: 5 } });
        expect(result.events.map(e => e.event_id)).toEqual(['3']);
    });
    it('uses story dates rather than source-window order across collections', () => {
        const events = [event(1, ['Brennan'], { DateTime: '2026-07-01', source_window_end: 1 }),
            event(2, ['Brennan'], { DateTime: '2026-06-01', source_window_end: 500 })];
        const roster = rosterFor(events);
        expect(formatCastHistoryDetailed({ roster, cast: detect(roster, messages('Brennan')) }).events.map(e => e.event_id)).toEqual(['2', '1']);
    });
    it('fits small histories first and respects the total estimated budget', () => {
        const events = [event(1, ['Ann']), ...Array.from({ length: 20 }, (_, i) => event(i + 2, ['Brennan'], { summary: 'Long history '.repeat(8) }))];
        const roster = rosterFor(events);
        // Override test fixture leads: both histories are intentionally eligible.
        roster.groups.forEach(g => { g.isLead = false; });
        const result = formatCastHistoryDetailed({ roster, cast: detect(roster, messages('Ann and Brennan')), settings: { eventbase_cast_token_budget: 180 } });
        expect(result.events.some(e => e.event_id === '1')).toBe(true);
        expect(result.events.length).toBeGreaterThan(1);
        expect(estimateCastTokens(result.text)).toBeLessThanOrEqual(180);
        expect(result.text.startsWith('Known history with Ann')).toBe(true);
    });
    it('selects foundations, latest, persistent and important events before timeline fill', () => {
        const events = Array.from({ length: 10 }, (_, i) => event(i + 1, [], { should_persist: i === 4, importance: i === 5 ? 9 : 2 }));
        const selected = selectHistorySpine(events, 4, () => 'x');
        expect(selected.map(e => e.event_id)).toEqual(['1', '5', '6', '10']);
        const spread = selectHistorySpine(events.map(e => ({ ...e, should_persist: false, importance: 2 })), 4, () => 'x');
        expect(spread.map(e => e.event_id)).toEqual(['1', '3', '5', '10']);
    });
    it('does not duplicate shared events across character blocks', () => {
        const roster = rosterFor([event(1, ['Ann', 'Brennan'])]);
        expect(formatCastHistoryDetailed({ roster, cast: detect(roster, messages('Ann Brennan')) }).includedCount).toBe(1);
    });
    it('reports zero injection with signals, including disabled or too-small budgets', () => {
        const roster = rosterFor([event(1, ['Brennan'])]), cast = detect(roster, messages('Brennan'), { plannerCharacters: ['Brennan'] });
        const result = formatCastHistoryDetailed({ roster, cast, settings: { eventbase_cast_token_budget: 0 } });
        expect(result.text).toBe('');
        expect(result.zeroInjectionCharacters).toEqual([{ name: 'Brennan', signals: ['text', 'planner'] }]);
        expect(formatRetrievalDiagnostics(result).castText).toContain('Brennan (text + planner)');
    });
});