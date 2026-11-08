// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('../core/log.js', () => ({ log: { warn: vi.fn() } }));
import { mountOpenThreadsWindow } from '../ui/open-threads-window.js';
import { continuityActionSnapshot, threadsDigest } from '../core/continuity.js';

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const click = text => [...document.querySelectorAll('button')].find(node => node.textContent === text).click();
const change = (label, value, checked = false) => {
    const node = document.querySelector(`[aria-label="${label}"]`);
    if (checked) node.checked = value; else node.value = value;
    node.dispatchEvent(new Event('change'));
};
let windowHandle;
afterEach(() => { windowHandle?.close(); document.body.replaceChildren(); });
const mount = (events, extra = {}) => {
    const root = document.createElement('div'); document.body.append(root);
    const deps = { ensureIndex: vi.fn(async () => ({ ready: true, events: new Map(events.map(e => [e.event_id, e])) })),
        openEvent: vi.fn(), onClose: vi.fn(() => root.remove()), ...extra };
    windowHandle = mountOpenThreadsWindow({ root, settings: Object.freeze({}), collections: ['a', 'b'], activeCollection: 'a', deps });
    return { root, deps };
};

describe('Open Threads window', () => {
    it('overrides the shared modal layout and explicitly themes the form controls', () => {
        const style = document.createElement('style');
        // jsdom cannot resolve custom properties in background shorthands.
        style.textContent = (readFileSync('styles/modals.css', 'utf8')
            + readFileSync('ui/open-threads.css', 'utf8'))
            .replace(/var\(--SmartThemeBlurTintColor(?:,[^)]*)?\)/g, '#242424')
            .replace(/var\(--SmartThemeBodyColor(?:,[^)]*)?\)/g, '#ddd');
        document.head.append(style);
        try {
            const { root } = mount([]);
            root.classList.add('vectfox-modal-content');
            expect(getComputedStyle(root).display).toBe('block');
            expect(getComputedStyle(root).overflow).toBe('auto');
            expect(getComputedStyle(root).maxWidth).toBe('1100px');
            const scope = root.querySelector('[aria-label="Collection scope"]');
            expect(getComputedStyle(scope).width).toBe('100%');
            expect(getComputedStyle(scope).whiteSpace).toBe('nowrap');
            expect(getComputedStyle(scope.options[0]).whiteSpace).toBe('nowrap');
            for (const control of [scope, scope.options[0], root.querySelector('[aria-label="Cast group"]'),
                root.querySelector('[aria-label="Minimum importance"]')]) {
                const computed = getComputedStyle(control);
                expect(computed.backgroundColor).toBe('rgb(36, 36, 36)');
                expect(computed.color).toBe('rgb(221, 221, 221)');
            }
        } finally { style.remove(); }
    });
    it('preserves long collection identifiers and exposes the full name as a tooltip', async () => {
        const collection = `qdrant:VectFox_${'long_archive_name_'.repeat(20)}`;
        const root = document.createElement('div'); document.body.append(root);
        const ensureIndex = vi.fn(async () => ({ ready: true, events: new Map() }));
        windowHandle = mountOpenThreadsWindow({ root, settings: {}, collections: [collection, 'other'],
            activeCollection: collection, deps: { ensureIndex, onClose: () => root.remove() } });
        await settle();
        const scope = root.querySelector('[aria-label="Collection scope"]');
        expect(scope.multiple).toBe(true);
        expect(scope.size).toBe(2);
        expect(scope.options[0].textContent).toBe(collection);
        expect(scope.options[0].title).toBe(collection);
        expect(scope.selectedOptions[0].value).toBe(collection);
        expect(ensureIndex.mock.calls[0][0]).toBe(collection);
    });
    it('renders safe metadata, partial sibling status, source links and opt-in audit without reloading on filters', async () => {
        const event = { event_id: 'issue', summary: '<img src=x> debt', open_threads: ['paid', '<script>unpaid</script>'],
            characters: ['Kai'], locations: ['Port'], keywords: ['loan'], importance: 8 };
        event.continuity = { v: 1, closed_threads: { threads: [0], threads_digest: threadsDigest(event), status: 'active', origin: 'user', how: 'Settled' } };
        const { root, deps } = mount([event]); await settle();
        expect(root.textContent).toContain('1 remaining threads across 1 events');
        expect(root.textContent).toContain('Port');
        expect(root.textContent).toContain('1 remaining / 1 closed');
        expect(root.querySelector('img, script')).toBeNull();
        expect(root.textContent).not.toContain('How: Settled');
        change('Show closed threads', true, true);
        expect(root.textContent).toContain('How: Settled');
        expect(root.textContent).toContain('Resolution origin: user');
        [...root.querySelectorAll('button')].find(node => node.textContent.includes('View source event')).click();
        expect(deps.openEvent).toHaveBeenCalledWith('a', 'issue');
        change('Minimum importance', '9');
        expect(root.textContent).toContain('No stored threads match');
        expect(deps.ensureIndex).toHaveBeenCalledTimes(1);
    });
    it('renders only one page and does not poll', async () => {
        const { root, deps } = mount(Array.from({ length: 95 }, (_, i) => ({ event_id: String(i), open_threads: ['thread'], importance: 1 })));
        await settle();
        expect(root.querySelectorAll('article')).toHaveLength(40);
        click('Next page'); expect(root.querySelectorAll('article')).toHaveLength(40);
        click('Next page'); expect(root.querySelectorAll('article')).toHaveLength(15);
        expect(deps.ensureIndex).toHaveBeenCalledTimes(1);
        click('Refresh'); await settle(); expect(deps.ensureIndex).toHaveBeenCalledTimes(2);
    });
    it('surfaces invalidated closures as open with inactive-link reasons', async () => {
        const { root } = mount([{ event_id: 'stale', summary: 'Changed event', open_threads: ['Still pending'],
            continuity: { v: 1, closed_threads: { threads: 'all', status: 'active', threads_digest: 'old', origin: 'repair' } } }]);
        await settle();
        expect(root.textContent).toContain('Open: Still pending');
        expect(root.textContent).toContain('Inactive link: digest_mismatch');
    });
    it('runs explicit manual actions with original indices and refreshes derived verdicts', async () => {
        const event = { event_id: 'e', summary: 'Issue', open_threads: ['first', 'second'] };
        const continuityAction = vi.fn(async (name, collection, id, args) => {
            expect([collection, id]).toEqual(['a', 'e']);
            expect(name).toBe('markEventResolved');
            event.continuity = { v: 1, closed_threads: { threads: args[0], threads_digest: threadsDigest(event), origin: 'user', status: 'active', how: args[1] } };
        });
        const { root, deps } = mount([event], { continuityAction }); await settle();
        expect(continuityAction).not.toHaveBeenCalled();
        root.querySelector('[aria-label="Select thread 1"]').checked = true;
        root.querySelector('[aria-label="Outcome (optional)"]').value = 'Paid';
        const expected = continuityActionSnapshot(event);
        click('Mark selected threads resolved'); await settle();
        expect(continuityAction).toHaveBeenCalledWith('markEventResolved', 'a', 'e', [[1], 'Paid'], expected);
        expect(deps.ensureIndex).toHaveBeenCalledTimes(2);
        expect(root.textContent).toContain('1 remaining / 1 closed');
        expect(root.textContent).toContain('Unmark selected threads');
    });

    it('distinguishes external links and self-closures beneath a user mark', async () => {
        const event = { event_id: 'e', open_threads: ['a', 'b'] };
        const closure = { threads: [0], threads_digest: threadsDigest(event), origin: 'repair', status: 'active' };
        event.continuity = { v: 1, closed_threads: { ...closure, threads: [1], origin: 'user' }, user_previous_closure: closure };
        const link = { ...closure, event_id: 'e' };
        const resolver = { event_id: 'resolver', summary: 'Settled', continuity: { v: 1, resolves: [link] } };
        const continuityAction = vi.fn();
        const { root } = mount([event, resolver], { continuityAction }); await settle();
        change('Show closed threads', true, true);
        expect(root.textContent).toContain('Self-closure: repair');
        expect(root.textContent).toContain('External resolution link stored on resolver');
        click('Remove link from resolver'); await settle();
        expect(continuityAction).toHaveBeenLastCalledWith('removeResolutionLink', 'a', 'e', ['resolver', link], continuityActionSnapshot(resolver));
        click('Reopen self-closure'); await settle();
        expect(continuityAction).toHaveBeenLastCalledWith('reopenEventSelfClosure', 'a', 'e', [], continuityActionSnapshot(event));
        click('Unmark selected threads'); await settle();
        expect(continuityAction).toHaveBeenLastCalledWith('unmarkEventResolved', 'a', 'e', [[]], continuityActionSnapshot(event));
    });

    it('refreshes again after a write completes despite a same-scope refresh during the write', async () => {
        let finish;
        const event = { event_id: 'e', open_threads: ['pending'] };
        const continuityAction = vi.fn(async () => {
            await new Promise(resolve => { finish = resolve; });
            event.continuity = { v: 1, closed_threads: { threads: 'all', threads_digest: threadsDigest(event), origin: 'user', status: 'active' } };
        });
        const { root, deps } = mount([event], { continuityAction }); await settle();
        change('Show closed threads', true, true);
        click('Mark resolved — all'); click('Refresh'); await settle();
        expect(root.textContent).toContain('1 remaining threads');
        finish(); await settle();
        expect(deps.ensureIndex).toHaveBeenCalledTimes(3);
        expect(root.textContent).toContain('0 remaining threads');
        expect(root.textContent).toContain('Closed: pending');
        expect(root.textContent).toContain('Unmark');
    });

    it('reports write failures and allows retry without changing the displayed verdict', async () => {
        const continuityAction = vi.fn().mockRejectedValue(new Error('Backend unavailable'));
        const { root, deps } = mount([{ event_id: 'e', open_threads: ['pending'] }], { continuityAction }); await settle();
        click('Mark resolved — all'); await settle();
        expect(root.textContent).toContain('Continuity action failed: Backend unavailable');
        expect(root.textContent).toContain('Open: pending');
        expect(deps.ensureIndex).toHaveBeenCalledTimes(1);
        expect([...root.querySelectorAll('.vf-continuity-actions button')].every(b => !b.disabled)).toBe(true);
    });

    it.each(['scope', 'close', 'context'])('does not refresh a stale window after an in-flight write: %s', async kind => {
        let finish, context = 'a';
        const continuityAction = vi.fn(() => new Promise(resolve => { finish = resolve; }));
        const { deps } = mount([{ event_id: 'e', open_threads: ['pending'] }], { continuityAction, contextKey: () => context });
        await settle(); click('Mark resolved — all'); click('Mark resolved — all');
        expect(continuityAction).toHaveBeenCalledTimes(1);
        if (kind === 'scope') change('Collection scope', 'b');
        if (kind === 'close') click('Close');
        if (kind === 'context') { context = 'b'; document.dispatchEvent(new Event('vectfox:api-status-changed')); }
        finish(); await settle();
        expect(deps.ensureIndex).toHaveBeenCalledTimes(1);
    });
    it.each(['scope', 'close', 'cancel', 'context'])('drops delayed renders on %s changes', async kind => {
        let finish, signal, context = 'chat-a';
        const { root, deps } = mount([], { contextKey: () => context,
            ensureIndex: vi.fn((_, __, ___, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); }) });
        if (kind === 'scope') change('Collection scope', 'b');
        if (kind === 'close') click('Close');
        if (kind === 'cancel') click('Cancel load');
        if (kind === 'context') { context = 'chat-b'; document.dispatchEvent(new Event('vectfox:api-status-changed')); }
        expect(signal.aborted).toBe(true);
        finish({ ready: true, events: new Map([['e', { event_id: 'e', summary: 'MUST NOT RENDER', open_threads: ['x'] }]]) });
        await settle();
        expect(root.textContent).not.toContain('MUST NOT RENDER');
        expect(deps.ensureIndex).toHaveBeenCalledTimes(1);
    });
});