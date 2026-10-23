// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// The roster imports the logger, which imports SillyTavern; jsdom tests cannot resolve it.
vi.mock('../core/log.js', () => ({ log: { enabled: () => false, lifecycle: vi.fn(), verbose: vi.fn(), warn: vi.fn(), trace: vi.fn() } }));

const { mountCharacterCardsWindow } = await import('../ui/character-cards-window.js');
const { buildCharacterRoster } = await import('../core/character-roster.js');
const { npcCardSnapshot } = await import('../core/npc-cards.js');
const { continuityBackendNamespace, readStorySoFar } = await import('../core/continuity-scope.js');
const { subjectCardKey } = await import('../core/npc-card-state.js');

const COLLECTION = 'events';
const event = (id, characters, i) => ({ event_id: id, summary: `Summary ${id}`, characters, source_window_end: i, created_at: 1000 + i });

function setup({ legacyCard = false, extra = [], settings: saved = null } = {}) {
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root);
    const events = [
        ...Array.from({ length: 40 }, (_, i) => event(`a${i}`, ['Alex', 'Hiro'], i)),
        ...Array.from({ length: 35 }, (_, i) => event(`b${i}`, ['Brennan', 'Alex'], 100 + i)),
        event('d0', ['Derek'], 200), event('h0', ['Hiro-kun'], 201),
        event('x0', ['<img src=x onerror=alert(1)>'], 202),
        ...extra,
    ];
    const settings = saved || { eventbase_npc_cards_enabled: false, eventbase_npc_cards: {} };
    const context = { value: 'chat' };
    const deps = {
        ensureIndex: vi.fn(async () => ({ ready: true })),
        getRoster: (ids, s) => {
            const ignored = new Set(s.eventbase_character_ignored_tags?.[COLLECTION] || []);
            const visible = events.map(e => ({ ...e, characters: e.characters.filter(name => !ignored.has(name)) }));
            return { ...buildCharacterRoster(visible, s.eventbase_character_alias_overrides?.[COLLECTION] || [], s),
                events: events.map(e => ({ ...e, _collectionIds: [COLLECTION] })), ready: true };
        },
        ignoredTags: (id, s) => s.eventbase_character_ignored_tags?.[id] || [],
        collectionId: key => key,
        chatId: () => 'chat',
        readContext: () => context.value,
        save: vi.fn(),
        confirm: vi.fn(() => true),
        onClose: vi.fn(),
    };
    if (legacyCard) {
        const roster = deps.getRoster([COLLECTION], settings);
        const snapshot = npcCardSnapshot(roster, roster.groups.find(g => g.name === 'Brennan'));
        settings.eventbase_npc_cards[snapshot.key] = { v: 2, facts: [{ fact: 'Lent Hiro money', source_ids: ['b0'] },
            { fact: 'Is hostile toward Alex', source_ids: ['b1'] }], cited: Object.fromEntries(snapshot.digests), coverage: '', planned: '' };
    }
    const mounted = mountCharacterCardsWindow({ root, settings, collections: [{ registryKey: COLLECTION, collectionId: COLLECTION }], deps });
    const identityKey = JSON.stringify([continuityBackendNamespace(COLLECTION, settings), COLLECTION]);
    return { root, settings, deps, context, ready: mounted.ready, identityKey };
}
const findButton = label => [...document.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label);
const click = label => {
    const found = findButton(label);
    if (!found) throw new Error(`No button "${label}"`);
    found.click();
};
const text = () => document.body.textContent;
const row = content => [...document.querySelectorAll('.vf-cc-fact')].find(r => r.textContent.includes(content));
const setUpIds = () => { click('Set up 6 characters'); click('Apply IDs'); };
const addCanon = (value, pair = '') => {
    document.querySelector('[aria-label="New canon text"]').value = value;
    document.querySelector('[aria-label="Pair with character"]').value = pair;
    click('Add');
};
const subjectId = (f, name) => f.settings.eventbase_subject_registries[f.identityKey].subjects.find(s => s.name === name).id;
const card = (f, name) => f.settings.eventbase_npc_cards[subjectCardKey(f.identityKey, subjectId(f, name))];
// Typos of Brennan, plus unnamed roles beside the fixture's own Hiro-kun variant and junk tag.
const cleanupEvents = [
    event('t0', ['Brenan'], 300), event('t1', ['Brenan'], 301), event('t2', ['Brennen'], 302),
    event('n0', ['nurse', 'Alex'], 303), event('n1', ['nurse'], 304), event('v0', ['Delivery Driver'], 305),
];
const suggestion = name => [...document.querySelectorAll('.vf-cc-suggestion')].find(box => [...box.querySelectorAll('.vf-cc-name')].some(n => n.textContent === name));
const listed = parent => [...parent.querySelectorAll('.vf-cc-row')].map(r => [r.querySelector('.vf-cc-name').textContent, r.querySelector('.vf-cc-count').textContent]);
const lastConfirm = f => f.deps.confirm.mock.calls.at(-1)[0];

describe('Characters and NPC cards window', () => {
    it('opens without model calls or writes, filters the list and renders untrusted names as text', async () => {
        const f = setup(), before = structuredClone(f.settings);
        await f.ready;
        expect(text()).toContain('Set up character IDs');
        expect(findButton('Alex')).toBeTruthy();
        expect(findButton('Derek')).toBeUndefined(); // Below the 30-event default filter.
        click('All 6');
        click('<img src=x onerror=alert(1)>');
        expect(document.querySelector('img,script')).toBeNull();
        expect(text()).toContain('Read-only: set up character IDs');
        expect(f.settings).toEqual(before);
        expect(f.deps.save).not.toHaveBeenCalled();
        document.querySelector('[aria-label="Search characters"]').value = 'kun';
        document.querySelector('[aria-label="Search characters"]').dispatchEvent(new Event('input'));
        expect(findButton('Hiro-kun')).toBeTruthy();
        expect(findButton('Alex')).toBeUndefined();
    });

    it('sets up IDs in one step, then adds, cancels and saves canon', async () => {
        const f = setup();
        await f.ready;
        click('Set up 6 characters');
        expect(text()).toContain('New characters get an ID (6)');
        click('Apply IDs');
        expect(f.settings.eventbase_subject_registries[f.identityKey].subjects).toHaveLength(6);
        expect(text()).toContain('Character IDs ready');
        click('Brennan');
        addCanon('Owns the bakery LLC');
        expect(text()).toContain('1 unsaved change');
        click('Cancel');
        expect(text()).not.toContain('Owns the bakery LLC');
        addCanon('Owns the bakery LLC');
        click('Save');
        expect(card(f, 'Brennan').authored[0]).toMatchObject({ fact: 'Owns the bakery LLC', origin: 'authored', source_refs: [] });
        expect(text()).toContain('No unsaved changes');
    });

    it('keeps old generated facts through ID setup after declaring the story, then hides, restores and corrects them', async () => {
        const f = setup({ legacyCard: true });
        await f.ready;
        click('Has card');
        expect(findButton('Brennan')).toBeTruthy();
        click('Declare');
        expect(readStorySoFar(f.settings, continuityBackendNamespace(COLLECTION, f.settings), COLLECTION).eventCount).toBe(78);
        setUpIds();
        click('Brennan');
        expect(row('Lent Hiro money')).toBeTruthy();
        row('Is hostile toward Alex').querySelector('[aria-label="Hide"]').click();
        click('Save');
        expect(card(f, 'Brennan').suppressions).toHaveLength(1);
        click('Restore');
        click('Save');
        expect(card(f, 'Brennan').suppressions).toHaveLength(0);
        row('Lent Hiro money').querySelector('[aria-label="Correct"]').click();
        document.querySelector('[aria-label="Corrected fact"]').value = 'Lent Hiro $200 for the van';
        click('Save as my canon');
        click('Save');
        expect(card(f, 'Brennan').authored[0]).toMatchObject({ fact: 'Lent Hiro $200 for the van', source_refs: [] });
        expect(card(f, 'Brennan').suppressions[0].reason).toBe('corrected');
    });

    it('routes pair canon to its canonical owner and shows it on the other card', async () => {
        const f = setup();
        await f.ready;
        setUpIds();
        const [owner, other] = ['Brennan', 'Hiro'].sort((a, b) => subjectId(f, a).localeCompare(subjectId(f, b)));
        click(other);
        addCanon('Split the rent', owner);
        expect(document.querySelector('.vf-cc-card-title h4').textContent).toBe(owner);
        expect(document.querySelector('[aria-label="New canon text"]').value).toBe('Split the rent');
        click('Add');
        click('Save');
        expect(card(f, owner).authored[0]).toMatchObject({ fact: 'Split the rent', subjectIds: [subjectId(f, owner), subjectId(f, other)].sort() });
        click(other);
        expect(text()).toContain('Shared facts kept on other cards');
        expect(row('Split the rent')).toBeTruthy();
    });

    it('guards unsaved changes when switching characters and rejects stale saves', async () => {
        const f = setup();
        await f.ready;
        setUpIds();
        click('Brennan');
        addCanon('Unsaved canon');
        f.deps.confirm.mockReturnValueOnce(false);
        click('Alex');
        expect(document.querySelector('.vf-cc-card-title h4').textContent).toBe('Brennan');
        f.context.value = 'another chat';
        click('Save');
        expect(text()).toContain('nothing was saved');
        expect(f.settings.eventbase_npc_cards[subjectCardKey(f.identityKey, subjectId(f, 'Brennan'))]).toBeUndefined();
        f.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(f.deps.onClose).toHaveBeenCalled();
    });

    it('merges, ignores and restores names from the list', async () => {
        const f = setup();
        await f.ready;
        click('All 6');
        document.querySelector('[aria-label="Select Derek"]').click();
        document.querySelector('[aria-label="Select Brennan"]').click();
        click('Merge');
        const merged = f.settings.eventbase_character_alias_overrides[COLLECTION].find(g => g.aliases.includes('Derek'));
        expect(merged.aliases.sort()).toEqual(['Brennan', 'Derek']);
        expect(text()).toContain('All 5');
        document.querySelector('[aria-label="Select <img src=x onerror=alert(1)>"]').click();
        click('Ignore');
        expect(f.settings.eventbase_character_ignored_tags[COLLECTION]).toEqual(['<img src=x onerror=alert(1)>']);
        click('Ignored 1');
        click('Restore');
        expect(f.settings.eventbase_character_ignored_tags[COLLECTION]).toEqual([]);
    });

    it('suggests possible duplicates and generic roles with event counts, without writing anything', async () => {
        const f = setup({ extra: cleanupEvents }), before = structuredClone(f.settings);
        await f.ready;
        click('Possible duplicates 2');
        expect(text()).toContain('"Brennan" and "Brenan" are 1 letter apart');
        expect(text()).toContain('"Hiro" and "Hiro-kun" differ only in case, accents, titles or punctuation');
        expect(listed(suggestion('Brenan'))).toEqual([['Brennan', '35'], ['Brenan', '2'], ['Brennen', '1']]);
        expect([...suggestion('Brenan').querySelectorAll('input')].every(input => input.checked)).toBe(true);
        click('Generic roles 3');
        expect(listed(document.querySelector('.vf-cc-items'))).toEqual([['nurse', '2'], ['Delivery Driver', '1'], ['<img src=x onerror=alert(1)>', '1']]);
        expect([...document.querySelectorAll('.vf-cc-items input')].some(input => input.checked)).toBe(false);
        expect(document.querySelector('img,script')).toBeNull();
        expect(f.settings).toEqual(before);
        expect(f.deps.save).not.toHaveBeenCalled();
        expect(f.deps.confirm).not.toHaveBeenCalled();
    });

    it('merges an accepted suggestion through the alias overrides only after confirming', async () => {
        const f = setup({ extra: cleanupEvents });
        await f.ready;
        click('Possible duplicates 2');
        f.deps.confirm.mockReturnValueOnce(false);
        click('Merge Brennan, Brenan, Brennen');
        expect(f.settings.eventbase_character_alias_overrides).toBeUndefined();
        expect(f.deps.save).not.toHaveBeenCalled();
        document.querySelector('[aria-label="Include Brennen"]').click();
        click('Merge Brennan, Brenan, Brennen');
        expect(lastConfirm(f)).toContain('Merge Brennan, Brenan into one character, Brennan?');
        expect(lastConfirm(f)).toContain("Brennen will stay separate and won't be suggested with them again.");
        const overrides = f.settings.eventbase_character_alias_overrides[COLLECTION];
        expect(overrides.find(g => g.aliases.includes('Brenan'))).toEqual({ name: 'Brennan', aliases: ['Brennan', 'Brenan'] });
        expect(overrides.find(g => g.aliases.includes('Brennen')).aliases).toEqual(['Brennen']);
        expect(f.settings.eventbase_character_cleanup_dismissed[COLLECTION].pairs).toEqual([['Brennan', 'Brennen']]);
        expect(f.deps.save).toHaveBeenCalledTimes(1);
        expect(text()).toContain('Possible duplicates 1');
        expect(suggestion('Brennen')).toBeUndefined();
        expect(suggestion('Hiro-kun')).toBeTruthy();
    });

    it('keeps an ignored spelling with its group when a suggestion is merged', async () => {
        const f = setup({ extra: [...cleanupEvents, event('r0', ['Bren'], 306)] });
        f.settings.eventbase_character_alias_overrides = { [COLLECTION]: [{ name: 'Brennan', aliases: ['Brennan', 'Bren'] }] };
        f.settings.eventbase_character_ignored_tags = { [COLLECTION]: ['Bren'] };
        await f.ready;
        click('Possible duplicates 2');
        document.querySelector('[aria-label="Include Brennen"]').click();
        click('Merge Brennan, Brenan, Brennen');
        const merged = f.settings.eventbase_character_alias_overrides[COLLECTION].find(g => g.aliases.includes('Brenan'));
        expect(merged.aliases.sort()).toEqual(['Bren', 'Brenan', 'Brennan']);
    });

    it('remembers dismissed suggestions per collection until asked to show them again', async () => {
        const f = setup({ extra: cleanupEvents });
        await f.ready;
        click('Possible duplicates 2');
        click('Not the same: Hiro, Hiro-kun');
        expect(f.settings.eventbase_character_cleanup_dismissed).toEqual({ [COLLECTION]: { pairs: [['Hiro', 'Hiro-kun']], roles: [] } });
        expect(f.settings.eventbase_character_alias_overrides).toBeUndefined();
        expect(f.deps.save).toHaveBeenCalledTimes(1);
        expect(suggestion('Hiro-kun')).toBeUndefined();

        const reopened = setup({ extra: cleanupEvents, settings: structuredClone(f.settings) });
        await reopened.ready;
        click('Possible duplicates 1');
        expect(suggestion('Hiro-kun')).toBeUndefined();
        reopened.deps.confirm.mockReturnValueOnce(false);
        click('Show dismissed suggestions again');
        expect(reopened.settings.eventbase_character_cleanup_dismissed[COLLECTION].pairs).toHaveLength(1);
        click('Show dismissed suggestions again');
        expect(reopened.settings.eventbase_character_cleanup_dismissed[COLLECTION].pairs).toEqual([]);
        expect(text()).toContain('Possible duplicates 2');

        const elsewhere = setup({ extra: cleanupEvents, settings: { eventbase_character_cleanup_dismissed: { other: { pairs: [['Hiro', 'Hiro-kun']] } } } });
        await elsewhere.ready;
        expect(findButton('Possible duplicates 2')).toBeTruthy();
    });

    it('reviews generic role names, keeps some and ignores the ticked ones after confirming', async () => {
        const f = setup({ extra: cleanupEvents });
        await f.ready;
        click('Generic roles 3');
        click('Keep <img src=x onerror=alert(1)>');
        expect(f.settings.eventbase_character_cleanup_dismissed[COLLECTION].roles).toEqual(['<img src=x onerror=alert(1)>']);
        expect(text()).toContain('Generic roles 2');
        click('Select all 2');
        f.deps.confirm.mockReturnValueOnce(false);
        click('Ignore');
        expect(f.settings.eventbase_character_ignored_tags).toBeUndefined();
        click('Ignore');
        expect(lastConfirm(f)).toContain('Ignore nurse, Delivery Driver?');
        expect(f.settings.eventbase_character_ignored_tags[COLLECTION]).toEqual(['nurse', 'Delivery Driver']);
        expect(text()).toContain('Ignored 2');
        expect(text()).toContain('No more role names to review.');
        click('Suggest kept names as roles again');
        expect(f.settings.eventbase_character_cleanup_dismissed[COLLECTION].roles).toEqual([]);
        expect(text()).toContain('Generic roles 1');
    });

    it('shows the pending ID change in step 2 after accepting a merge, with one confirmation', async () => {
        const f = setup({ extra: cleanupEvents });
        await f.ready;
        click('Set up 10 characters');
        click('Apply IDs');
        expect(text()).toContain('Character IDs ready');
        click('Possible duplicates 2');
        f.deps.confirm.mockClear();
        click('Merge Hiro, Hiro-kun');
        expect(f.deps.confirm).toHaveBeenCalledTimes(1);
        expect(lastConfirm(f)).toContain('updating character IDs (step 2)');
        expect(text()).toContain('Update character IDs');
        expect(text()).toContain('1 name change to apply');
        click('Review 1 change');
        expect(text()).toContain('Merged characters: choose which existing ID to keep');
    });

    it('declares and removes the story so far and toggles prompt injection', async () => {
        const f = setup();
        await f.ready;
        click('Declare');
        expect(text()).toContain('78 events up to');
        click('Remove');
        expect(readStorySoFar(f.settings, continuityBackendNamespace(COLLECTION, f.settings), COLLECTION)).toBeNull();
        const toggle = [...document.querySelectorAll('.vf-cc-toggle input')][0];
        toggle.click();
        expect(f.settings.eventbase_npc_state_enabled).toBe(true);
        expect(f.deps.save).toHaveBeenCalled();
    });
});
