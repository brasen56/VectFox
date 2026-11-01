// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContextTokenBadge } from '../ui/context-token-badge.js';
import { createContextTokenLifecycle } from '../core/context-token-lifecycle.js';
import { countContextTokens } from '../core/context-token-accounting.js';

let badge, lifecycle, state, visible, listeners;
const summary = () => document.querySelector('#VectFox_context_token_badge summary');
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
    document.body.innerHTML = '<main id="sheld"><div id="chat"></div><form id="form_sheld"><button>Send</button></form></main>';
    visible = true;
    state = { status: 'unmeasured', result: null };
    listeners = new Set();
    lifecycle = {
        getState: () => state,
        refreshEnabled: vi.fn(),
        subscribe: vi.fn(listener => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }),
    };
    badge = createContextTokenBadge({ lifecycle, readVisible: () => visible });
});

afterEach(() => {
    badge.dispose();
    document.body.replaceChildren();
});

function publish(status, result = null) {
    state = { status, result };
    for (const listener of listeners) listener(state);
}

describe('context token badge', () => {
    it.each([
        ['3_vectfox', 'ChunkBase'],
        ['3_vectfox_eventbase', 'EventBase'],
        ['3_vectfox_summarizer', 'Summarizer'],
        ['3_vectfox_lorebook', 'Separate lorebook'],
        ['3_vectfox_future', 'Other VectFox injection (3_vectfox_future)'],
    ])('renders an isolated %s measurement and its subtotal', async (tag, category) => {
        const result = await countContextTokens({ [tag]: { value: 'PRIVATE INJECTION' } },
            { tokenizer: { count: () => 13 } });
        badge.initialize();
        publish('available', result);
        expect(summary().textContent).toBe('VectFox: ~13 tokens');
        expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
        expect(document.querySelector('tbody code').textContent).toBe(tag);
        expect(document.querySelector('dl').textContent).toBe(`${category}13Total13`);
        expect(document.body.textContent).not.toContain('PRIVATE INJECTION');
    });

    it('preserves an open keyboard-focused breakdown through a generation update', async () => {
        badge.initialize();
        const details = summary().parentElement;
        details.open = true;
        const region = document.querySelector('[role="region"]');
        region.focus();
        const result = await countContextTokens({ '3_vectfox': { value: 'private' } },
            { tokenizer: { count: () => 8 } });
        publish('available', result);
        expect(details.open).toBe(true);
        expect(document.activeElement).toBe(region);
        expect(region.tabIndex).toBe(0);
        expect(region.getAttribute('aria-label')).toBe('VectFox context token breakdown');
        const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        region.dispatchEvent(escape);
        expect(escape.defaultPrevented).toBe(true);
        expect(details.open).toBe(false);
        expect(document.activeElement).toBe(summary());
    });

    it.each(['reject', 'unavailable'])('does not change narration prompts when the tokenizer is %s', async failure => {
        const events = new Map();
        const registry = Object.freeze({ '3_vectfox': Object.freeze({ value: '<memory>PRIVATE</memory>' }) });
        const count = vi.fn().mockRejectedValue(new Error('PRIVATE tokenizer failure'));
        const realLifecycle = createContextTokenLifecycle({
            eventSource: { on: (name, handler) => events.set(name, handler), removeListener: name => events.delete(name) },
            eventTypes: { GENERATION_ENDED: 'ended', CHAT_CHANGED: 'chat' },
            readEnabled: () => visible, readChatId: () => 'chat', readRegistry: () => registry,
            createTokenizer: async () => failure === 'unavailable' ? null : { count },
        });
        badge.dispose();
        badge = createContextTokenBadge({ lifecycle: realLifecycle, readVisible: () => visible });
        realLifecycle.initialize();
        badge.initialize();
        try {
            const laterListener = vi.fn();
            for (const listener of [events.get('ended'), laterListener]) await listener();
            await settle();
            expect(laterListener).toHaveBeenCalledOnce();
            expect(registry['3_vectfox'].value).toBe('<memory>PRIVATE</memory>');
            expect(summary().textContent).toBe('VectFox: Count unavailable');
            expect(document.querySelector('dl').textContent).toContain('TotalUnavailable');
            expect(document.body.textContent).not.toContain('PRIVATE');
        } finally {
            realLifecycle.dispose();
        }
    });

    it.each([
        ['disabled', null, 'VectFox: Disabled'],
        ['unmeasured', null, 'VectFox: —'],
        ['unavailable', null, 'VectFox: Count unavailable'],
        ['available', 0, 'VectFox: 0 tokens'],
        ['available', 1248, `VectFox: ~${(1248).toLocaleString()} tokens`],
    ])('renders %s with total %s', (status, total, expected) => {
        badge.initialize();
        publish(status, total === null ? null : { total, slots: [], perCategory: {}, tokenizer: null });
        expect(summary().textContent).toBe(expected);
    });

    it('renders per-slot metadata, category subtotals, total, tokenizer and accuracy without prompt text', async () => {
        const result = await countContextTokens({
            '3_vectfox': { value: 'private prompt', position: 1, depth: 2 },
            '3_vectfox_pos12': { value: 'other private prompt', position: 0, depth: 8 },
            '3_vectfox_eventbase': { value: 'event', position: 1, depth: 3 },
        }, { tokenizer: { identity: { name: 'Test tokenizer', id: 7, key: 'TEST', model: 'test-model' }, count: () => 10 } });
        badge.initialize();
        publish('available', result);
        expect(document.querySelectorAll('tbody tr')).toHaveLength(3);
        const text = document.querySelector('.vectfox-token-breakdown').textContent;
        for (const expected of ['Last measured turn', 'ChunkBase — position group 12', '3_vectfox_pos12',
            '0 / 8', 'ChunkBase20', 'EventBase10', 'Total30', 'Test tokenizer', 'id: 7', 'TEST', 'test-model',
            'sum-of-blocks', 'not monetary cost']) expect(text).toContain(expected);
        expect(text).not.toContain('private prompt');
    });

    it('never displays a partial failed measurement as a valid total', async () => {
        const result = await countContextTokens({
            '3_vectfox': { value: 'ok' }, '3_vectfox_eventbase': { value: 'fails' },
        }, { tokenizer: { count: text => { if (text === 'fails') throw new Error('private'); return 5; } } });
        badge.initialize();
        publish('unavailable', result);
        expect(summary().textContent).toBe('VectFox: Count unavailable');
        expect(document.querySelector('dl').textContent).toContain('TotalUnavailable');
        expect(document.body.textContent).not.toContain('private');
    });

    it('inserts before the composer and uses a native keyboard/touch disclosure with Escape focus return', () => {
        badge.initialize();
        const root = document.querySelector('#VectFox_context_token_badge');
        expect(root.nextElementSibling.id).toBe('form_sheld');
        expect(document.querySelector('#form_sheld button').textContent).toBe('Send');
        const details = root.querySelector('details');
        // Native summary supplies Enter/Space and click/touch activation in the browser.
        expect(summary().parentElement).toBe(details);
        expect(summary().getAttribute('aria-controls')).toBe('VectFox_context_token_breakdown');
        details.open = true;
        document.querySelector('[role="region"]').focus();
        root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(details.open).toBe(false);
        expect(document.activeElement).toBe(summary());
    });

    it('removes UI subscriptions and listeners immediately when hidden and recreates once when enabled', () => {
        badge.initialize();
        badge.initialize();
        badge.refresh();
        expect(document.querySelectorAll('#VectFox_context_token_badge')).toHaveLength(1);
        expect(listeners.size).toBe(1);
        const root = document.querySelector('#VectFox_context_token_badge');
        const details = root.querySelector('details');
        details.open = true;
        visible = false;
        badge.refresh();
        expect(summary()).toBeNull();
        expect(listeners.size).toBe(0);
        root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(details.open).toBe(true);
        visible = true;
        badge.refresh();
        expect(summary()).not.toBeNull();
        expect(listeners.size).toBe(1);
    });

    it('replaces an earlier controller without duplicate nodes or subscriptions', () => {
        badge.initialize();
        const replacement = createContextTokenBadge({ lifecycle, readVisible: () => visible });
        replacement.initialize();
        expect(document.querySelectorAll('#VectFox_context_token_badge')).toHaveLength(1);
        expect(listeners.size).toBe(1);
        replacement.dispose();
        expect(listeners.size).toBe(0);
    });

    it('waits for a late composer and cancels the pending mount when disabled', async () => {
        document.body.replaceChildren();
        badge.initialize();
        visible = false;
        badge.refresh();
        document.body.innerHTML = '<main><form id="form_sheld"></form></main>';
        await settle();
        expect(summary()).toBeNull();
        visible = true;
        badge.refresh();
        expect(summary()).not.toBeNull();
        badge.dispose();
        document.body.replaceChildren();
        badge.initialize();
        document.body.innerHTML = '<main><form id="form_sheld"></form></main>';
        await settle();
        expect(document.querySelectorAll('#VectFox_context_token_badge')).toHaveLength(1);
    });

    it('treats unknown tag labels and tokenizer metadata as text, not HTML', () => {
        badge.initialize();
        publish('available', { total: 1, perCategory: { '<img src=x>': 1 },
            tokenizer: { name: '<script>bad()</script>' },
            slots: [{ label: '<img src=x>', tag: '<svg onload=bad()>', count: 1, position: null, depth: null }] });
        expect(document.querySelector('img, script, svg')).toBeNull();
        expect(document.body.textContent).toContain('<img src=x>');
    });

    it('integrates immediate preference/master changes with measurement cancellation and chat reset', async () => {
        const events = new Map();
        let master = true, resolveCount;
        const count = vi.fn(() => new Promise(resolve => { resolveCount = resolve; }));
        const realLifecycle = createContextTokenLifecycle({
            eventSource: { on: (name, handler) => events.set(name, handler), removeListener: name => events.delete(name) },
            eventTypes: { GENERATION_ENDED: 'ended', CHAT_CHANGED: 'chat' },
            readEnabled: () => visible && master,
            readChatId: () => 'chat',
            readRegistry: () => ({ '3_vectfox': { value: 'private prompt' } }),
            createTokenizer: async () => ({ count }),
        });
        badge.dispose();
        badge = createContextTokenBadge({ lifecycle: realLifecycle, readVisible: () => visible });
        realLifecycle.initialize();
        badge.initialize();
        events.get('ended')();
        await settle();
        visible = false;
        badge.refresh();
        resolveCount(12);
        await settle();
        expect(summary()).toBeNull();
        expect(realLifecycle.getState().status).toBe('disabled');
        visible = true;
        badge.refresh();
        expect(summary().textContent).toBe('VectFox: —');
        master = false;
        badge.refresh();
        expect(summary().textContent).toBe('VectFox: Disabled');
        events.get('ended')();
        await settle();
        expect(count).toHaveBeenCalledTimes(1);
        master = true;
        badge.refresh();
        events.get('chat')();
        expect(summary().textContent).toBe('VectFox: —');
        realLifecycle.dispose();
    });
});

describe('token badge preference binding', () => {
    it('loads the saved preference, saves changes, and immediately notifies the badge', () => {
        // Exercise the actual binding without importing unrelated SillyTavern modules.
        const source = readFileSync(resolve(process.cwd(), 'ui/ui-manager.js'), 'utf8');
        const binding = source.slice(source.indexOf('    // Token badge preference'), source.indexOf('    // Master switch — global enable/disable.'));
        const bind = new Function('$', 'settings', 'extension_settings', 'saveSettingsDebounced', 'callbacks', binding);
        const control = {
            checked: false,
            prop(name, value) { if (value === undefined) return this.checked; this.checked = value; return this; },
            off: vi.fn().mockReturnThis(),
            on(name, handler) { this.handler = handler; return this; },
        };
        const settings = { show_token_badge: true };
        const saved = { vectfox: {} }, save = vi.fn(), refresh = vi.fn();
        const $ = () => control;
        bind($, settings, saved, save, { onTokenBadgeChange: refresh });
        expect(control.checked).toBe(true);
        control.checked = false;
        control.handler.call(control);
        expect(saved.vectfox.show_token_badge).toBe(false);
        expect(save).toHaveBeenCalledOnce();
        expect(refresh).toHaveBeenCalledOnce();
        bind($, saved.vectfox, saved, save, { onTokenBadgeChange: refresh });
        expect(control.checked).toBe(false);
        expect(source).toContain('Show floating token badge');
    });
});