// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ collection: vi.fn(), mark: vi.fn(), unmark: vi.fn(), reopen: vi.fn(), remove: vi.fn() }));
vi.mock('../core/continuity-repair-service.js', () => ({ continuityCollection: mocks.collection,
    markEventResolved: mocks.mark, unmarkEventResolved: mocks.unmark,
    reopenEventSelfClosure: mocks.reopen, removeResolutionLink: mocks.remove }));
import { mountContinuityControls } from '../ui/continuity-controls.js';
import { threadsDigest } from '../core/continuity.js';

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const click = text => [...document.querySelectorAll('button')].find(node => node.textContent === text).click();
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); document.body.replaceChildren(); });

describe('database-browser shared continuity controls', () => {
    it('refreshes from the current entry and routes partial unmark, reopen and external link removal', async () => {
        // Minimal host adapter for the existing jQuery interface; controls themselves use DOM.
        vi.stubGlobal('$', markup => {
            const node = document.createElement(markup.match(/<([a-z0-9]+)/i)[1]);
            return { text(value) { node.textContent = value; return this; }, appendTo(host) { host[0].append(node); return this; } };
        });
        vi.stubGlobal('toastr', { error: vi.fn() });
        const root = document.createElement('div'); document.body.append(root);
        const host = { 0: root, empty: () => root.replaceChildren() };
        const event = { event_id: 'e', open_threads: ['hurt', 'debt'] };
        const closure = { threads: [0], threads_digest: threadsDigest(event), origin: 'repair', status: 'active' };
        event.continuity = { v: 1, closed_threads: closure };
        let events = new Map([['e', event]]);
        const currentEntry = vi.fn(async () => ({ events }));
        mocks.collection.mockResolvedValue({ entry: { events }, currentEntry });
        const settings = {}, changed = vi.fn();
        mocks.mark.mockImplementation(async () => {
            // Replace the entry map to ensure the browser does not render its old snapshot.
            events = new Map([['e', { ...event, continuity: { v: 1,
                closed_threads: { ...closure, threads: [1], origin: 'user' }, user_previous_closure: closure } }]]);
        });
        await mountContinuityControls(host, 'archive', 'e', settings, changed);
        expect([...root.querySelectorAll('button')].some(node => node.textContent === 'Unmark')).toBe(false);
        root.querySelector('[aria-label="Select thread 1"]').checked = true;
        click('Mark selected threads resolved'); await settle();
        expect(mocks.mark).toHaveBeenCalledWith('archive', 'e', settings, [1], 'Marked resolved by the user.');
        expect(root.textContent).toContain('Resolved');
        expect(root.textContent).toContain('Unmark selected threads');
        expect(changed).toHaveBeenCalledWith(events.get('e').continuity);
        root.querySelector('[aria-label="Select thread 1"]').checked = true;
        click('Unmark selected threads'); await settle();
        expect(mocks.unmark).toHaveBeenCalledWith('archive', 'e', settings, [1]);
        click('Reopen self-closure'); await settle();
        expect(mocks.reopen).toHaveBeenCalledWith('archive', 'e', settings);
        const link = { ...closure, event_id: 'e' };
        events.set('owner', { event_id: 'owner', continuity: { v: 1, resolves: [link] } });
        click('Unmark'); await settle();
        click('Remove link from owner'); await settle();
        expect(mocks.remove).toHaveBeenCalledWith('archive', 'owner', link, settings);
        expect(currentEntry.mock.calls.length).toBeGreaterThan(5);
    });
});