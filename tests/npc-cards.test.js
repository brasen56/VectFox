import { describe, it, expect, vi, afterEach } from 'vitest';
import { advanceNpcCard, getNpcCards, npcCardSnapshot, readNpcCard, validateNpcFacts,
    NPC_CARD_MAX_PLAN_BATCHES, NPC_CARD_REFRESH_MIN_NEW_EVENTS } from '../core/npc-cards.js';

function fixture(name = 'Brennan', count = 35, summary = i => `Fact ${i}`) {
    const events = Array.from({ length: count }, (_, i) => ({ event_id: `e${i}`, summary: summary(i), source_window_end: i, _collectionIds: ['collection'] }));
    const group = { name, aliases: [`Howard ${name}`], eventIds: new Set(events.map(e => e.event_id)) };
    return { roster: { ready: true, events }, cast: [{ group }], group,
        settings: { eventbase_npc_cards_enabled: true, chat_model: 'model', eventbase_npc_cards: {} } };
}
const evidence = prompt => JSON.parse(prompt.split('New evidence: ')[1]);
const existingCard = prompt => JSON.parse(prompt.split('Existing card: ')[1].split('\nNew evidence: ')[0]);
// A well-behaved model: keeps the card and adds one fact per batch.
const citeFirst = () => vi.fn(async prompt => [...existingCard(prompt),
    { fact: `Read ${evidence(prompt)[0].event_id}`, source_ids: [evidence(prompt)[0].event_id] }]);
const addEvent = (f, i) => {
    f.roster.events.push({ event_id: `e${i}`, summary: `Fact ${i}`, source_window_end: i, _collectionIds: ['collection'] });
    f.group.eventIds.add(`e${i}`);
};
/** Drive a card to completion the way successive turns would, storing it under its key. */
async function settle(f, complete) {
    const snapshot = npcCardSnapshot(f.roster, f.group);
    for (let card; (card = await advanceNpcCard(f.settings.eventbase_npc_cards[snapshot.key], snapshot, f.group, f.settings, complete)); ) {
        f.settings.eventbase_npc_cards = { [snapshot.key]: card };
    }
    return f.settings.eventbase_npc_cards[snapshot.key];
}
const nextSave = () => { let done; const saved = new Promise(resolve => { done = resolve; }); return { saved, done }; };

afterEach(() => vi.useRealTimers());

describe('source-grounded NPC cards', () => {
    it('rejects invented citations, uncited facts and over-budget lines', () => {
        expect(() => validateNpcFacts([{ fact: 'Invented', source_ids: ['missing'] }], new Set(['e0']), 100)).toThrow();
        expect(validateNpcFacts([{ fact: 'LLC filed', source_ids: ['e0'] }, { fact: 'x'.repeat(1000), source_ids: ['e0'] }], new Set(['e0']), 50)).toHaveLength(1);
    });
    it('keys cards by lock union and aliases; digests track only what the model sees', () => {
        const f = fixture();
        const snapshot = () => npcCardSnapshot(f.roster, f.group);
        const first = snapshot();
        f.roster.events[0].summary = 'Edited';
        expect(snapshot().digests.get('e0')).not.toBe(first.digests.get('e0'));
        Object.assign(f.roster.events[1], { hash: 'rehashed', characters: ['Someone else'] });
        f.settings.chat_model = 'new';
        expect(snapshot().digests.get('e1')).toBe(first.digests.get('e1'));
        f.group.aliases.push('Lawyer'); expect(snapshot().key).not.toBe(first.key);
        const aliased = snapshot().key;
        f.roster.events[0]._collectionIds = ['other']; expect(snapshot().key).not.toBe(aliased);
    });
    it('does not generate on dry-run, coalesces refreshes and uses the persisted card', async () => {
        const f = fixture();
        const complete = vi.fn(async () => [{ fact: 'Filed LLC', source_ids: ['e0'] }]);
        const { saved, done } = nextSave();
        const options = { ...f, complete, save: done };
        expect(getNpcCards({ ...options, dryRun: true }).size).toBe(0);
        expect(complete).not.toHaveBeenCalled();
        getNpcCards(options); getNpcCards(options);
        await saved;
        expect(complete).toHaveBeenCalledTimes(1);
        expect(getNpcCards({ ...options, dryRun: true }).get('Brennan').text).toContain('Filed LLC');
        f.roster.events[0].summary = 'Changed';
        expect(getNpcCards({ ...options, dryRun: true }).size).toBe(0);
    });
    it('never offers unrenderable events as citable evidence', () => {
        const f = fixture();
        f.roster.events[3] = { ...f.roster.events[3], summary: '' };
        const snapshot = npcCardSnapshot(f.roster, f.group);
        expect(snapshot.events.some(e => e.event_id === 'e3')).toBe(false);
        expect(snapshot.events).toHaveLength(f.group.eventIds.size - 1);
        expect(snapshot.digests.has('e3')).toBe(false);
    });
    it('reads every event of a history under the cap, one batch per call', async () => {
        const f = fixture('Batched', 35, () => 'history '.repeat(150));
        const complete = citeFirst();
        await settle(f, complete);
        expect(complete.mock.calls.length).toBeGreaterThan(1);
        expect(complete.mock.calls.length).toBeLessThanOrEqual(NPC_CARD_MAX_PLAN_BATCHES);
        const seen = complete.mock.calls.flatMap(([prompt]) => evidence(prompt).map(e => e.event_id));
        expect(new Set(seen)).toEqual(f.group.eventIds);
        expect(seen).toHaveLength(f.group.eventIds.size);
    });
    it('samples a 2000-event history within the cap, then reads only new events', async () => {
        const f = fixture('Major', 2000, i => `Fact ${i}: ${'routine detail '.repeat(8)}`);
        const complete = citeFirst();
        const card = await settle(f, complete);
        expect(complete.mock.calls.length).toBeLessThanOrEqual(NPC_CARD_MAX_PLAN_BATCHES);
        const seen = new Set(complete.mock.calls.flatMap(([prompt]) => evidence(prompt).map(e => e.event_id)));
        expect(seen.size).toBeLessThan(2000);
        expect(seen.has('e0') && seen.has('e1999')).toBe(true);
        expect(readNpcCard(card, npcCardSnapshot(f.roster, f.group), 350).uncovered).toEqual([]);

        complete.mockClear();
        addEvent(f, 2000);
        const served = getNpcCards({ ...f, complete });
        expect(served.get('Major').pendingEventIds).toEqual(['e2000']);
        await Promise.resolve();
        expect(complete).not.toHaveBeenCalled();

        for (let i = 2001; i < 2000 + NPC_CARD_REFRESH_MIN_NEW_EVENTS; i++) addEvent(f, i);
        const { saved, done } = nextSave();
        getNpcCards({ ...f, complete, save: done });
        await saved;
        expect(complete).toHaveBeenCalledTimes(1);
        expect(evidence(complete.mock.calls[0][0]).map(e => e.event_id)).toEqual(['e2000', 'e2001', 'e2002', 'e2003', 'e2004']);
        expect(getNpcCards({ ...f, dryRun: true }).get('Major').pendingEventIds).toEqual([]);
    });
    it('drops only facts whose evidence was edited, reads the edit as new, and survives model changes', async () => {
        const f = fixture('Edited');
        const card = await settle(f, vi.fn(async () => [{ fact: 'Hired Kai', source_ids: ['e0'] }, { fact: 'Filed LLC', source_ids: ['e1'] }]));
        f.roster.events[1].summary = 'Filed the LLC late';
        f.settings.chat_model = 'another-model';
        const view = readNpcCard(card, npcCardSnapshot(f.roster, f.group), 350);
        expect(view.facts.map(fact => fact.fact)).toEqual(['Hired Kai']);
        expect(view.uncovered.map(e => e.event_id)).toEqual(['e1']);
        const complete = citeFirst();
        await settle(f, complete);
        expect(complete).toHaveBeenCalledTimes(1);
        expect(evidence(complete.mock.calls[0][0]).map(e => e.event_id)).toEqual(['e1']);
    });
    it('rebuilds cards stored in the old signature format', async () => {
        const f = fixture('Legacy');
        const key = npcCardSnapshot(f.roster, f.group).key;
        f.settings.eventbase_npc_cards = { [key]: { signature: 'old', facts: [{ fact: 'Old', source_ids: ['e0'] }], text: '- Old' } };
        expect(getNpcCards({ ...f, dryRun: true }).size).toBe(0);
        const complete = citeFirst();
        const { saved, done } = nextSave();
        getNpcCards({ ...f, complete, save: done });
        await saved;
        expect(complete).toHaveBeenCalledTimes(1);
        expect(f.settings.eventbase_npc_cards[key].v).toBe(2);
    });
    it('asks for the card length in the unit the validator enforces', async () => {
        const limit = async summary => {
            const f = fixture('Script', 35, () => summary);
            const complete = vi.fn(async () => [{ fact: 'x', source_ids: ['e0'] }]);
            await advanceNpcCard(undefined, npcCardSnapshot(f.roster, f.group), f.group, f.settings, complete);
            return Number(complete.mock.calls[0][0].match(/under (\d+) characters/)[1]);
        };
        expect(await limit('Brennan filed the LLC paperwork.')).toBe(1260);
        expect(await limit('Бреннан подал документы на регистрацию ООО.')).toBeLessThan(500);
    });
    it('spends nothing on cards that cannot be injected or were disabled while queued', async () => {
        const zero = fixture('Unused');
        const complete = citeFirst();
        getNpcCards({ ...zero, settings: { ...zero.settings, eventbase_token_budget: 0 }, complete });
        getNpcCards({ ...zero, settings: { ...zero.settings, eventbase_cast_token_budget: 0 }, complete });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(complete).not.toHaveBeenCalled();

        const a = fixture('Alpha'), b = fixture('Beta');
        const settings = { eventbase_npc_cards_enabled: true, chat_model: 'model', eventbase_npc_cards: {} };
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const gated = vi.fn(async prompt => { await gate; return [{ fact: 'x', source_ids: [evidence(prompt)[0].event_id] }]; });
        getNpcCards({ roster: a.roster, cast: [...a.cast, ...b.cast], settings, complete: gated });
        await new Promise(resolve => setTimeout(resolve, 0));
        settings.eventbase_npc_cards_enabled = false;
        release();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(gated).toHaveBeenCalledTimes(1);
        expect(settings.eventbase_npc_cards).toEqual({});
    });
    it('contains background failures and keeps the source-event fallback available', async () => {
        const f = fixture('Failure test');
        const { saved: failed, done } = nextSave();
        const complete = vi.fn(async () => { throw new Error('Provider unavailable'); });
        const options = { ...f, complete, onError: done };
        expect(getNpcCards(options).size).toBe(0);
        expect((await failed).message).toBe('Provider unavailable');
        expect(Object.keys(f.settings.eventbase_npc_cards)).toHaveLength(0);
        expect(getNpcCards(options).size).toBe(0);
        expect(complete).toHaveBeenCalledTimes(1);
    });
    it('backs off exponentially between failed attempts', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(0);
        const f = fixture('Backoff');
        const complete = vi.fn(async () => { throw new Error('Bad citations'); });
        const attempt = async () => { const { saved, done } = nextSave(); getNpcCards({ ...f, complete, onError: done }); await saved; };
        await attempt();
        vi.setSystemTime(61_000);
        await attempt();
        vi.setSystemTime(61_000 + 61_000);
        getNpcCards({ ...f, complete });
        expect(complete).toHaveBeenCalledTimes(2);
        vi.setSystemTime(61_000 + 121_000);
        await attempt();
        expect(complete).toHaveBeenCalledTimes(3);
    });
});
