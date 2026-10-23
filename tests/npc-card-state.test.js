import { describe, it, expect, vi } from 'vitest';
import { subjectCardKey, npcFactId, upgradeNpcCard, beginNpcCardEdit, editNpcCardFact, saveNpcCardEdit,
    inspectNpcCard, mergeNpcCardRefresh, resetNpcGeneratedCards, formatNpcState, selectNpcPairEvidence,
    exportNpcCardData, importNpcCardData, resolveNpcCardBinding } from '../core/npc-card-state.js';
import { npcCardSnapshot, readNpcCard, getNpcCards } from '../core/npc-cards.js';
import { resolveContinuityScope, continuityBackendNamespace, declareStorySoFar, removeStorySoFar,
    readStorySoFar } from '../core/continuity-scope.js';
import { buildNpcStateContexts } from '../core/npc-state-context.js';
import { refreshNpcPair, npcPairReadPlan } from '../core/npc-relationship-state.js';
import { formatBudgetedEventBase } from '../core/eventbase-token-budget.js';
import { estimateCastTokens, formatCastHistoryDetailed } from '../core/eventbase-injection.js';
import { combineNpcSummarizerState } from '../core/npc-state-routes.js';
import { previewSubjectMigration, applySubjectMigration } from '../core/continuity-subjects.js';

function fixture() {
    const namespace = continuityBackendNamespace('', {}), collection = 'events';
    const registryKey = JSON.stringify([namespace, collection]);
    const settings = { eventbase_npc_state_enabled: true, eventbase_npc_cards_enabled: true,
        eventbase_npc_card_min_events: 1, eventbase_subject_registries: { [registryKey]: { v: 1, revision: 1,
            subjects: ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase(), aliases: [id] })), audit: [], references: [] } }, eventbase_npc_cards: {} };
    const events = [0, 1, 2].map(i => ({ event_id: `e${i}`, summary: `Fact ${i}`, source_chat_id: 'chat',
        source_window_end: i, _collectionIds: [collection] }));
    const roster = { ready: true, events };
    const groups = ['a', 'b', 'c'].map(name => ({ name, aliases: [name], eventIds: new Set(events.map(e => e.event_id)) }));
    const snapshot = npcCardSnapshot(roster, groups[0]);
    const binding = { key: subjectCardKey(registryKey, 'a'), subjectId: 'a', registryKey, namespace, collection };
    const scope = resolveContinuityScope({ continuityId: collection, namespace, collections: [collection], chatId: 'chat',
        frames: [{ collection, chatId: 'chat', frameId: 'frame', horizon: 2 }] });
    const generated = { v: 2, facts: [{ fact: 'The loan remains unpaid', source_ids: ['e0'] },
        { fact: 'They reconciled', source_ids: ['e1', 'e2'] }], cited: Object.fromEntries(snapshot.digests), coverage: '', planned: '' };
    settings.eventbase_npc_cards[binding.key] = upgradeNpcCard(generated, binding);
    const stateOptions = { scope, registryKey, subjectIds: ['a', 'b', 'c'], snapshots: new Map([['a', snapshot]]) };
    return { namespace, registryKey, settings, events, roster, groups, snapshot, binding, scope, generated, stateOptions };
}

describe('durable NPC cards', () => {
    it('browses without mutations, validates text, cancels by dropping the draft, and checks stale saves', () => {
        const f = fixture(), before = structuredClone(f.settings);
        const draft = beginNpcCardEdit(f.settings, f.binding, 'chat');
        expect(inspectNpcCard(draft.card, f.snapshot)).toHaveLength(2);
        expect(() => editNpcCardFact(draft, 'add', null, { text: '  ' })).toThrow('empty');
        editNpcCardFact(draft, 'add', null, { text: 'Shared loft', idFactory: () => 'canon' });
        expect(f.settings).toEqual(before);
        expect(() => saveNpcCardEdit(f.settings, draft, 'sibling')).toThrow('changed');
        f.settings.eventbase_subject_registries[f.registryKey].revision++;
        expect(() => saveNpcCardEdit(f.settings, draft, 'chat')).toThrow('changed');
    });
    it('corrections are authored, retain audit provenance, and suppression survives reset and refresh', () => {
        const f = fixture(), draft = beginNpcCardEdit(f.settings, f.binding, 'chat');
        const original = inspectNpcCard(draft.card, f.snapshot)[0];
        editNpcCardFact(draft, 'correct', original, { text: 'The loan was forgiven', idFactory: () => 'correction' });
        let card = saveNpcCardEdit(f.settings, draft, 'chat');
        expect(card.authored[0]).toMatchObject({ id: 'correction', origin: 'authored', source_refs: [] });
        expect(card.authored[0]).not.toHaveProperty('source_ids');
        expect(card.audit[0].before.fact).toBe(original.fact);
        card = mergeNpcCardRefresh(card, f.generated);
        expect(card.generated.facts).toHaveLength(1);
        f.settings.eventbase_npc_cards[f.binding.key] = card;
        resetNpcGeneratedCards(f.settings);
        card = f.settings.eventbase_npc_cards[f.binding.key];
        expect(card.authored).toHaveLength(1);
        expect(inspectNpcCard(card, f.snapshot).find(fact => fact.id === original.id).validity).toBe('suppressed');
        const restore = beginNpcCardEdit(f.settings, f.binding, 'chat');
        editNpcCardFact(restore, 'restore', original);
        expect(saveNpcCardEdit(f.settings, restore, 'chat').suppressions).toHaveLength(0);
    });
    it('pins preserve text on refresh/reset but invalid evidence withholds them', () => {
        const f = fixture(), draft = beginNpcCardEdit(f.settings, f.binding, 'chat');
        editNpcCardFact(draft, 'pin', inspectNpcCard(draft.card, f.snapshot)[0]);
        saveNpcCardEdit(f.settings, draft, 'chat');
        resetNpcGeneratedCards(f.settings);
        const card = f.settings.eventbase_npc_cards[f.binding.key];
        expect(readNpcCard(card, f.snapshot, 350).facts[0].fact).toBe('The loan remains unpaid');
        f.events[0].summary = 'Loan repaid';
        const fresh = npcCardSnapshot(f.roster, f.groups[0]);
        expect(readNpcCard(card, fresh, 350).facts).toEqual([]);
        expect(inspectNpcCard(card, fresh)[0]).toMatchObject({ pinned: true, validity: 'unverified' });
    });
    it('keeps similarly named subjects and backend identities separate', () => {
        const f = fixture();
        expect(resolveNpcCardBinding(f.settings, f.snapshot, f.groups[0])?.key).toBe(f.binding.key);
        expect(resolveNpcCardBinding(f.settings, f.snapshot, f.groups[0], 'another backend')).toBeNull();
        const draft = beginNpcCardEdit(f.settings, f.binding, 'chat');
        expect(() => editNpcCardFact(draft, 'add', null, { text: 'Loft', pairSubjectIds: ['b', 'c'] })).toThrow('owner');
        const other = { ...f.binding, key: subjectCardKey(f.registryKey, 'b'), subjectId: 'b' };
        const otherDraft = beginNpcCardEdit(f.settings, other, 'chat');
        expect(() => editNpcCardFact(otherDraft, 'add', null, { text: 'Loft', pairSubjectIds: ['b', 'a'] })).toThrow('canonical');
    });
    it('requires explicit authored deletion confirmation and rejects stale background changes', () => {
        const f = fixture(), draft = beginNpcCardEdit(f.settings, f.binding, 'chat');
        editNpcCardFact(draft, 'add', null, { text: 'Loft', idFactory: () => 'loft' });
        expect(() => editNpcCardFact(draft, 'suppress', draft.card.authored[0])).toThrow('Confirm');
        editNpcCardFact(draft, 'suppress', draft.card.authored[0], { confirmed: true });
        expect(draft.card.authored).toEqual([]);
        f.settings.eventbase_npc_cards[f.binding.key] = mergeNpcCardRefresh(f.settings.eventbase_npc_cards[f.binding.key], f.generated);
        expect(() => saveNpcCardEdit(f.settings, draft, 'chat')).toThrow('changed');
    });
    it('round-trips protected cards; conflicts and remapped imports retain recovery without overwrites', () => {
        const f = fixture(), draft = beginNpcCardEdit(f.settings, f.binding, 'chat');
        editNpcCardFact(draft, 'add', null, { text: 'Loft', idFactory: () => 'loft' });
        editNpcCardFact(draft, 'suppress', inspectNpcCard(draft.card, f.snapshot)[0]);
        saveNpcCardEdit(f.settings, draft, 'chat');
        const data = JSON.parse(JSON.stringify(exportNpcCardData(f.settings, f.namespace, 'events'))), target = {};
        expect(importNpcCardData(target, data, f.namespace, 'events').restored).toBe(1);
        expect(target.eventbase_npc_cards).toEqual(f.settings.eventbase_npc_cards);
        const before = structuredClone(target.eventbase_npc_cards);
        expect(importNpcCardData(target, data, f.namespace, 'events').restored).toBe(0);
        expect(importNpcCardData(target, data, 'new server', 'remapped').restored).toBe(0);
        expect(target.eventbase_npc_cards).toEqual(before);
        expect(Object.keys(target.eventbase_npc_card_imports)).toHaveLength(2);
    });
    it('reconciles pending historical refresh around authored edits and discards edited evidence', async () => {
        const f = fixture();
        f.settings.eventbase_npc_cards[f.binding.key].generated = { v: 2, facts: [], cited: {}, coverage: '', planned: '' };
        let release;
        const complete = vi.fn(() => new Promise(resolve => { release = resolve; })), save = vi.fn();
        getNpcCards({ ...f, cast: [{ group: f.groups[0] }], complete, save });
        await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
        const draft = beginNpcCardEdit(f.settings, f.binding, 'chat');
        editNpcCardFact(draft, 'add', null, { text: 'Canon survives', idFactory: () => 'canon' });
        saveNpcCardEdit(f.settings, draft, 'chat');
        release([{ fact: 'Refresh', source_ids: ['e1'] }]);
        await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
        expect(f.settings.eventbase_npc_cards[f.binding.key].authored[0].fact).toBe('Canon survives');
        // Force a new read with a fresh source, then edit it while the call is pending.
        f.events[0].summary = 'New source';
        f.events[1].summary = 'Changed supporting source';
        getNpcCards({ ...f, cast: [{ group: f.groups[0] }], complete, save });
        await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
        f.events[0].summary = 'Changed mid-call';
        release([{ fact: 'Stale', source_ids: ['e0'] }]);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(save).toHaveBeenCalledOnce();
    });
});

describe('relationship evidence and state budgets', () => {
    it('withholds protected authored pair facts after an identity merge without deleting them', () => {
        const f = fixture(), draft = beginNpcCardEdit(f.settings, f.binding, 'chat');
        editNpcCardFact(draft, 'add', null, { text: 'Share loft', pairSubjectIds: ['a', 'b'], idFactory: () => 'canon' });
        saveNpcCardEdit(f.settings, draft, 'chat');
        const preview = previewSubjectMigration(f.settings, f.registryKey, [{ name: 'Merged', aliases: ['a', 'b'] }, { name: 'C', aliases: ['c'] }]);
        applySubjectMigration(f.settings, preview, { confirmed: true, survivors: { 'a,b': 'a' } });
        expect(f.settings.eventbase_npc_cards[f.binding.key].authored[0]).toMatchObject({ fact: 'Share loft', validity: 'unverified' });
        expect(formatNpcState({ settings: f.settings, ...f.stateOptions, tokenBudget: 350 }).text).toBe('');
    });
    it('never schedules pair calls in dry-run or with no eligible source mapping', async () => {
        const f = fixture(), complete = vi.fn(), save = vi.fn();
        const context = { ...f.stateOptions, groups: new Map(f.groups.map((g, i) => [['a', 'b', 'c'][i], g])) };
        const options = { ...f, cast: [], stateContexts: [context], readStateContexts: () => [context], complete, save };
        getNpcCards({ ...options, dryRun: true });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(complete).not.toHaveBeenCalled();
        context.scope = resolveContinuityScope({ namespace: f.namespace, continuityId: 'events', collections: ['events'], chatId: 'chat' });
        getNpcCards(options);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(complete).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    });
    it('recency sampling does not anchor on the oldest persistent crisis', () => {
        const f = fixture();
        f.events[0].summary = 'Ancient crisis '.repeat(500); f.events[0].should_persist = true;
        f.snapshot = npcCardSnapshot(f.roster, f.groups[0]);
        const selected = selectNpcPairEvidence({ ...f, groups: f.groups.slice(0, 2), tokenBudget: 200 });
        expect(selected.events[0].event_id).toBe('e2');
        expect(selected.sampled).toBe(true);
        expect(selected.estimatedTokens).toBeLessThanOrEqual(200);
    });
    it('rejects future, sibling, ambiguous and unmapped sources', () => {
        const f = fixture();
        f.events[0].source_chat_id = 'sibling';
        f.events[1].source_window_end = 100;
        f.events[2]._collectionIds.push('other');
        f.snapshot = npcCardSnapshot(f.roster, f.groups[0]);
        const plan = selectNpcPairEvidence({ ...f, groups: f.groups.slice(0, 2) });
        expect(plan.events).toEqual([]);
        expect(plan.diagnostics.map(d => d.reason)).toEqual(['unmapped_sibling_source', 'beyond_horizon', 'ambiguous_collection']);
    });
    it('synthesizes only cited pair state, refreshes on one changed event, discards stale responses', async () => {
        const f = fixture(), card = f.settings.eventbase_npc_cards[f.binding.key];
        const complete = vi.fn(async () => [{ fact: 'Loan unpaid', source_ids: ['e0'] }]);
        const options = { ...f, card, groups: f.groups.slice(0, 2), subjectIds: ['a', 'b'],
            readScope: () => f.scope, readSnapshot: () => f.snapshot, complete };
        const result = await refreshNpcPair(options);
        expect(result.section.facts[0]).toMatchObject({ origin: 'generated', subjectIds: ['a', 'b'],
            source_refs: [{ namespace: f.namespace, collection: 'events', event_id: 'e0', digest: f.snapshot.digests.get('e0') }] });
        card.pairs[result.pairKey] = result.section;
        expect(npcPairReadPlan(options).due).toBe(false);
        f.events[1].summary = 'Reconciled but loan unpaid';
        const updated = npcCardSnapshot(f.roster, f.groups[0]);
        expect(npcPairReadPlan({ ...options, snapshot: updated }).due).toBe(true);
        expect(await refreshNpcPair({ ...options, snapshot: updated, readSnapshot: () => updated,
            readScope: () => ({ key: 'rewound' }) })).toBeNull();
        await expect(refreshNpcPair({ ...options, snapshot: updated, readSnapshot: () => updated,
            complete: async () => [{ fact: 'Invented', source_ids: ['missing'] }] })).rejects.toThrow('source-linked');
    });
    it('withholds only affected assertions, keeps authored canon and keeps pair identity separate', async () => {
        const f = fixture(), card = f.settings.eventbase_npc_cards[f.binding.key];
        const result = await refreshNpcPair({ ...f, card, groups: f.groups.slice(0, 2), subjectIds: ['a', 'b'],
            readScope: () => f.scope, readSnapshot: () => f.snapshot,
            complete: async () => [{ fact: 'Loan unpaid', source_ids: ['e0'] }, { fact: 'Reconciled', source_ids: ['e1', 'e2'] }] });
        card.pairs[result.pairKey] = result.section;
        const draft = beginNpcCardEdit(f.settings, f.binding, 'chat');
        editNpcCardFact(draft, 'add', null, { text: 'Share loft', pairSubjectIds: ['a', 'b'], idFactory: () => 'canon' });
        saveNpcCardEdit(f.settings, draft, 'chat');
        f.events[1].summary = 'Edited reconciliation';
        const snapshot = npcCardSnapshot(f.roster, f.groups[0]);
        const state = formatNpcState({ settings: f.settings, ...f.stateOptions, snapshots: new Map([['a', snapshot]]), tokenBudget: 350 });
        expect(state.text).toContain('User canon'); expect(state.text).toContain('Loan unpaid');
        expect(state.text).not.toContain('Reconciled'); expect(state.excluded).toHaveLength(1);
        expect(formatNpcState({ settings: f.settings, ...f.stateOptions, subjectIds: ['a', 'c'], tokenBudget: 350 }).text).toBe('');
    });
    it('story so far admits legacy pair evidence up to its cutoff; removal withholds what relied on it', async () => {
        const f = fixture();
        f.events.forEach((e, i) => { delete e.source_chat_id; e.created_at = 100 + i; });
        const pair = f.groups.slice(0, 2);
        const contexts = () => buildNpcStateContexts({ settings: f.settings, roster: f.roster, cast: pair.map(group => ({ group })),
            collections: [{ registryKey: 'events', collectionId: 'events' }], chatId: 'chat' });
        const select = context => selectNpcPairEvidence({ snapshot: context.snapshots.get('a'), groups: pair, scope: context.scope });
        expect(select(contexts()[0]).events).toEqual([]);
        declareStorySoFar(f.settings, f.namespace, 'events', f.events.slice(0, 2)); // e2 is stored after the cutoff.
        const [context] = contexts();
        const plan = select(context);
        expect(plan.events.map(e => e.event_id)).toEqual(['e1', 'e0']);
        expect(plan.diagnostics.find(d => d.event_id === 'e2').reason).toBe('after_declared_story_so_far');
        const card = f.settings.eventbase_npc_cards[f.binding.key];
        const result = await refreshNpcPair({ settings: f.settings, card, snapshot: context.snapshots.get('a'), groups: pair,
            subjectIds: ['a', 'b'], scope: context.scope, readScope: () => contexts()[0].scope,
            readSnapshot: () => contexts()[0].snapshots.get('a'), complete: async () => [{ fact: 'Loan unpaid', source_ids: ['e0'] }] });
        card.pairs[result.pairKey] = result.section;
        const state = c => formatNpcState({ settings: f.settings, scope: c.scope, registryKey: c.registryKey,
            subjectIds: c.subjectIds, snapshots: c.snapshots, tokenBudget: 350 });
        expect(state(contexts()[0]).text).toContain('Loan unpaid');
        removeStorySoFar(f.settings, f.namespace, 'events');
        const withdrawn = state(contexts()[0]);
        expect(withdrawn.text).not.toContain('Loan unpaid');
        expect(withdrawn.excluded).toContainEqual(expect.objectContaining({ reason: 'source_or_scope_changed' }));
    });
    it('carries the story-so-far declaration through export/import without overwriting a local one', () => {
        const f = fixture();
        declareStorySoFar(f.settings, f.namespace, 'events', [10, 11, 12].map(created_at => ({ created_at })));
        const data = JSON.parse(JSON.stringify(exportNpcCardData(f.settings, f.namespace, 'events')));
        expect(data.storySoFar.cutoff).toBe(12);
        const target = {};
        importNpcCardData(target, data, f.namespace, 'events');
        expect(readStorySoFar(target, f.namespace, 'events')).toEqual(readStorySoFar(f.settings, f.namespace, 'events'));
        const local = {};
        declareStorySoFar(local, f.namespace, 'events', [{ created_at: 1 }]);
        importNpcCardData(local, data, f.namespace, 'events');
        expect(readStorySoFar(local, f.namespace, 'events').cutoff).toBe(1);
        const remapped = {};
        importNpcCardData(remapped, data, 'new server', 'remapped');
        expect(remapped.eventbase_story_so_far).toBeUndefined();
    });
    it('rejects a card save drafted before the story-so-far declaration changed', () => {
        const f = fixture(), draft = beginNpcCardEdit(f.settings, f.binding, 'chat');
        editNpcCardFact(draft, 'add', null, { text: 'Loft', idFactory: () => 'loft' });
        declareStorySoFar(f.settings, f.namespace, 'events', [{ created_at: 1 }]);
        expect(() => saveNpcCardEdit(f.settings, draft, 'chat')).toThrow('changed');
    });
    it('honors tiny/shared budgets atomically, returns unused reserve and works with generation disabled', () => {
        const f = fixture(), draft = beginNpcCardEdit(f.settings, f.binding, 'chat');
        editNpcCardFact(draft, 'add', null, { text: 'Share loft', idFactory: () => 'canon' });
        saveNpcCardEdit(f.settings, draft, 'chat'); f.settings.eventbase_npc_cards_enabled = false;
        for (const budget of [0, 1, 20, 100, 350, 500]) {
            const result = formatBudgetedEventBase({ settings: { ...f.settings, eventbase_token_budget: budget },
                stateContexts: [f.stateOptions], globalContext: 'Global', xmlTag: 'memory' });
            expect(estimateCastTokens(result.text)).toBeLessThanOrEqual(budget);
            expect(result.text === '' || result.text.includes('Share loft')).toBe(true);
        }
        const result = formatBudgetedEventBase({ settings: f.settings, stateContexts: [f.stateOptions] });
        expect(result.state.text).toContain('Share loft');
        expect(result.state.estimatedTokens).toBeLessThan(350);
    });
    it('summarizer charges characters separately and omits whole blocks', () => {
        const f = fixture(), draft = beginNpcCardEdit(f.settings, f.binding, 'chat');
        editNpcCardFact(draft, 'add', null, { text: 'Share loft', idFactory: () => 'canon' });
        saveNpcCardEdit(f.settings, draft, 'chat');
        for (const maxChars of [0, 1, 100, 250, 1000]) {
            const result = combineNpcSummarizerState({ settings: f.settings, contexts: [f.stateOptions],
                maxChars, stateLimit: 350, text: 'history '.repeat(50), formatState: formatNpcState });
            expect(result.text.length).toBeLessThanOrEqual(maxChars);
            expect(!result.text.includes('User canon') || result.text.includes('Share loft')).toBe(true);
        }
    });
    it('uses card cost for fits-whole allocation rather than full history cost', () => {
        const f = fixture();
        f.events.forEach(e => { e.summary = 'Long history '.repeat(100); });
        const roster = { ...f.roster, events: f.events };
        const result = formatCastHistoryDetailed({ roster, cast: f.groups.slice(0, 2).map(group => ({ group })),
            settings: { eventbase_cast_token_budget: 140 }, cards: new Map([
                ['a', { facts: [{ fact: 'Compact card '.repeat(20), source_ids: ['e0'] }] }],
                ['b', { facts: [{ fact: 'Other compact card', source_ids: ['e1'] }] }],
            ]) });
        expect(result.cardCharacters).toContain('a');
        expect(estimateCastTokens(result.text)).toBeLessThanOrEqual(140);
    });
});