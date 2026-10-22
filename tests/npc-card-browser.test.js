// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { mountNpcCardEditor } from '../ui/npc-card-editor.js';
import { subjectCardKey, upgradeNpcCard } from '../core/npc-card-state.js';

function setup() {
    document.body.replaceChildren();
    const host = document.createElement('div'); document.body.append(host);
    const registryKey = JSON.stringify(['backend', 'events']);
    const binding = { registryKey, subjectId: 'a', key: subjectCardKey(registryKey, 'a'), collection: 'events', namespace: 'backend' };
    const settings = { eventbase_npc_cards_enabled: false, eventbase_subject_registries: {
        [registryKey]: { v: 1, revision: 1, subjects: [{ id: 'a', name: 'A', aliases: ['A'] }] } },
    eventbase_npc_cards: { [binding.key]: upgradeNpcCard({ v: 2, facts: [{ fact: '<img src=x onerror=alert(1)>', source_ids: ['e'] }], cited: { e: 1 } }, binding) } };
    const snapshot = { events: [{ event_id: 'e', summary: '<script>evil()</script>' }], digests: new Map([['e', 1]]) };
    return { host, settings, binding, snapshot, contextKey: 'chat', save: vi.fn() };
}
const click = text => [...document.querySelectorAll('button')].find(b => b.textContent === text).click();

describe('NPC card browser editor', () => {
    it('renders untrusted facts/sources as text without model calls or writes', () => {
        const f = setup(), before = structuredClone(f.settings);
        mountNpcCardEditor(f);
        expect(document.querySelector('img,script')).toBeNull();
        expect(f.host.textContent).toContain('<script>evil()</script>');
        expect(f.host.textContent).toContain('Generation disabled');
        expect(f.settings).toEqual(before); expect(f.save).not.toHaveBeenCalled();
    });
    it('supports Save, Cancel, diff, correction, suppression and restore', () => {
        const f = setup(); mountNpcCardEditor(f);
        const input = () => document.querySelector('[aria-label="New canon text"]');
        input().value = 'Authored loft'; click('Add canon');
        expect(f.host.textContent).toContain('Before / after');
        click('Cancel / reload'); expect(f.host.textContent).not.toContain('Authored loft');
        input().value = 'Authored loft'; click('Add canon'); click('Save');
        expect(f.save).toHaveBeenCalledOnce();
        expect(f.settings.eventbase_npc_cards[f.binding.key].authored[0].fact).toBe('Authored loft');
        click('Suppress'); click('Save'); expect(f.host.textContent).toContain('suppressed');
        click('Restore'); click('Save'); expect(f.settings.eventbase_npc_cards[f.binding.key].suppressions).toEqual([]);
        document.querySelector('[aria-label="Correct fact text"]').value = 'User correction';
        click('Correct as user-authored'); click('Save');
        expect(f.settings.eventbase_npc_cards[f.binding.key].authored[1]).toMatchObject({ fact: 'User correction', source_refs: [], origin: 'authored' });
    });
    it('rejects stale scope saves and offers read-only legacy inspection', () => {
        const f = setup(); let context = 'chat';
        mountNpcCardEditor({ ...f, readContext: () => context });
        document.querySelector('[aria-label="New canon text"]').value = 'Unsaved'; click('Add canon');
        context = 'sibling'; click('Save');
        expect(f.host.textContent).toContain('nothing was saved'); expect(f.save).not.toHaveBeenCalled();
        f.host.replaceChildren();
        mountNpcCardEditor({ ...f, binding: null, legacyKey: f.binding.key });
        expect(f.host.textContent).toContain('Read-only');
        expect([...f.host.querySelectorAll('button')].some(b => b.textContent === 'Save')).toBe(false);
    });
});