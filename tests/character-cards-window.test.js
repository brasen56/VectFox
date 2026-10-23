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

function setup({ legacyCard = false } = {}) {
    document.body.replaceChildren();
    const root = document.createElement('div');
    document.body.append(root);
    const events = [
        ...Array.from({ length: 40 }, (_, i) => event(`a${i}`, ['Alex', 'Hiro'], i)),
        ...Array.from({ length: 35 }, (_, i) => event(`b${i}`, ['Brennan', 'Alex'], 100 + i)),
        event('d0', ['Derek'], 200), event('h0', ['Hiro-kun'], 201),
        event('x0', ['<img src=x onerror=alert(1)>'], 202),
    ];
    const settings = { eventbase_npc_cards_enabled: false, eventbase_npc_cards: {} };
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
