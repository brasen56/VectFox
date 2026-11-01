import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContextTokenLifecycle } from '../core/context-token-lifecycle.js';

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

let lifecycle, handlers, enabled, chatId, registry, createTokenizer, count, readRegistry;
const settle = () => new Promise(resolve => setImmediate(resolve));
const emit = async (name, ...args) => {
    handlers.get(name)?.(...args);
    // Accounting is detached from events; drain its ready continuations separately.
    await settle();
};

beforeEach(() => {
    handlers = new Map();
    enabled = true;
    chatId = 'chat-a';
    registry = { '3_vectfox': { value: '<memory>live</memory>', position: 1, depth: 2 } };
    count = vi.fn(async () => 7);
    createTokenizer = vi.fn(async () => ({ identity: { key: 'gpt2' }, count }));
    readRegistry = vi.fn(() => registry);
    lifecycle = createContextTokenLifecycle({
        eventSource: {
            on: vi.fn((name, handler) => handlers.set(name, handler)),
            removeListener: vi.fn(name => handlers.delete(name)),
        },
        eventTypes: { GENERATION_ENDED: 'ended', CHAT_CHANGED: 'chat' },
        readEnabled: () => enabled, readChatId: () => chatId, readRegistry, createTokenizer,
    });
    lifecycle.initialize();
});

afterEach(() => lifecycle.dispose());

describe('context token generation lifecycle', () => {
    it.each(['success', 'tokenizer failure', 'loader failure', 'subscriber failure'])(
        'publishes text-free state without logging on %s', async outcome => {
            const spies = ['log', 'info', 'warn', 'error', 'debug', 'trace']
                .map(method => vi.spyOn(console, method).mockImplementation(() => {}));
            const privateText = 'PRIVATE BADGE PROMPT';
            registry['3_vectfox'].value = privateText;
            if (outcome === 'tokenizer failure') count.mockRejectedValueOnce(new Error(privateText));
            if (outcome === 'loader failure') createTokenizer.mockRejectedValueOnce(new Error(privateText));
            if (outcome === 'subscriber failure') lifecycle.subscribe(() => { throw new Error(privateText); });
            const subscriber = vi.fn();
            lifecycle.subscribe(subscriber);
            try {
                await emit('ended');
                expect(lifecycle.getState().status).toBe(outcome.includes('failure') && outcome !== 'subscriber failure'
                    ? 'unavailable' : 'available');
                expect(subscriber).toHaveBeenCalledOnce();
                expect(JSON.stringify(lifecycle.getState())).not.toContain(privateText);
                expect(JSON.stringify(subscriber.mock.calls)).not.toContain(privateText);
                expect(registry['3_vectfox'].value).toBe(privateText);
                for (const spy of spies) expect(spy).not.toHaveBeenCalled();
            } finally {
                for (const spy of spies) spy.mockRestore();
            }
        },
    );

    it.each(['resolve', 'reject'])('discards an older tokenizer load that later %s', async outcome => {
        const loading = deferred();
        createTokenizer.mockReturnValueOnce(loading.promise);
        await emit('ended');
        registry['3_vectfox'].value = 'new generation';
        await emit('ended');
        const latest = lifecycle.getState();
        expect(latest).toMatchObject({ status: 'available', result: { generationId: 2, total: 7 } });
        const listener = vi.fn();
        lifecycle.subscribe(listener);
        if (outcome === 'resolve') loading.resolve({ count });
        else loading.reject(new Error('private host failure'));
        await settle();
        expect(lifecycle.getState()).toBe(latest);
        expect(listener).not.toHaveBeenCalled();
        expect(count.mock.calls.map(([text]) => text)).toEqual(['new generation']);
    });

    it('keeps the last measured total visible until the next measurement completes', async () => {
        await emit('ended');
        const previous = lifecycle.getState();
        const pending = deferred();
        count.mockReturnValueOnce(pending.promise);
        await emit('ended');
        expect(lifecycle.getState()).toBe(previous);
        pending.resolve(21);
        await settle();
        expect(lifecycle.getState()).toMatchObject({ status: 'available', result: { total: 21, generationId: 2 } });
    });

    it.each(['success', 'rejection', 'missing tokenizer', 'broken subscriber'])(
        'isolates %s from prompt contents and later generation listeners', async outcome => {
            Object.freeze(registry['3_vectfox']);
            Object.freeze(registry);
            const before = JSON.stringify(registry);
            if (outcome === 'rejection') count.mockRejectedValue(new Error('private prompt failure'));
            if (outcome === 'missing tokenizer') createTokenizer.mockResolvedValue(null);
            if (outcome === 'broken subscriber') lifecycle.subscribe(() => { throw new Error('private UI failure'); });
            const laterListener = vi.fn();
            // Match a host emitter that awaits each listener in order.
            for (const listener of [handlers.get('ended'), laterListener]) await listener();
            await settle();
            expect(laterListener).toHaveBeenCalledOnce();
            expect(JSON.stringify(registry)).toBe(before);
            expect(lifecycle.getState().status).toBe(['rejection', 'missing tokenizer'].includes(outcome)
                ? 'unavailable' : 'available');
            expect(JSON.stringify(lifecycle.getState())).not.toMatch(/private|<memory>/);
        },
    );

    it('does not block later listeners in an emitter that awaits each listener', async () => {
        const pending = deferred();
        count.mockReturnValue(pending.promise);
        const later = vi.fn();
        const ended = handlers.get('ended');
        expect(ended()).toBeUndefined();
        const completion = (async () => {
            for (const listener of [ended, later]) await listener();
        })();
        try {
            await vi.waitFor(() => expect(later).toHaveBeenCalledOnce());
            expect(count).toHaveBeenCalled();
            expect(lifecycle.getState().status).toBe('unmeasured');
        } finally {
            pending.resolve(7);
            await completion;
            await settle();
        }
    });

    it.each(['disable', 'chat', 'identity', 'dispose', 'supersede'])(
        'stops remaining blocks when invalidated by %s', async reason => {
            const pending = deferred();
            count.mockReturnValueOnce(pending.promise);
            registry['3_vectfox_pos1'] = { value: 'second' };
            registry['3_vectfox_lorebook'] = { value: 'third' };
            await emit('ended');
            expect(count).toHaveBeenCalledOnce();
            const signal = count.mock.calls[0][1].signal;
            const listener = vi.fn();
            lifecycle.subscribe(listener);
            if (reason === 'disable') {
                enabled = false;
                lifecycle.refreshEnabled();
            } else if (reason === 'chat') {
                chatId = 'chat-b';
                await emit('chat');
            } else if (reason === 'identity') {
                chatId = 'chat-b';
            } else if (reason === 'dispose') {
                lifecycle.dispose();
            } else {
                registry = { '3_vectfox': { value: 'replacement' } };
                await emit('ended');
            }
            if (reason !== 'identity') expect(signal.aborted).toBe(true);
            const state = lifecycle.getState();
            listener.mockClear();
            pending.resolve(7);
            await settle();
            expect(count.mock.calls.map(([text]) => text)).toEqual(reason === 'supersede'
                ? ['<memory>live</memory>', 'replacement'] : ['<memory>live</memory>']);
            expect(lifecycle.getState()).toBe(state);
            expect(listener).not.toHaveBeenCalled();
        },
    );

    it('starts unmeasured and snapshots every category before loading the tokenizer', async () => {
        expect(lifecycle.getState()).toEqual({ status: 'unmeasured', result: null });
        const loading = deferred();
        createTokenizer.mockReturnValue(loading.promise);
        for (const suffix of ['_pos12', '_eventbase', '_summarizer', '_lorebook', '_future']) {
            registry[`3_vectfox${suffix}`] = { value: suffix };
        }
        registry.other = { value: 'unrelated' };
        const before = JSON.stringify(registry);
        const pending = emit('ended');
        expect(readRegistry).toHaveBeenCalledOnce();
        expect(JSON.stringify(registry)).toBe(before);
        registry['3_vectfox'].value = 'next turn';
        registry['3_vectfox_lorebook'].value = '';
        loading.resolve({ count });
        await pending;
        expect(count.mock.calls.map(([text]) => text)).toEqual([
            '<memory>live</memory>', '_pos12', '_eventbase', '_summarizer', '_lorebook', '_future',
        ]);
        expect(lifecycle.getState()).toMatchObject({ status: 'available', result: {
            chatId: 'chat-a', generationId: 1, total: 42,
        } });
        expect(JSON.stringify(lifecycle.getState())).not.toContain('<memory>');
    });

    it('quiet recounts are idempotent and aborted generations are still counted', async () => {
        await emit('ended');
        const first = lifecycle.getState().result;
        await emit('ended', 'quiet');
        expect(lifecycle.getState().result).toMatchObject({ total: first.total, generationId: 2 });
        await emit('ended', 'aborted');
        expect(lifecycle.getState().result).toMatchObject({ total: 7, generationId: 3 });
    });

    it('counts an empty retrieval as zero, without using stale results', async () => {
        await emit('ended');
        registry = {};
        await emit('ended');
        expect(lifecycle.getState()).toMatchObject({ status: 'available', result: { total: 0 } });
        expect(count).toHaveBeenCalledOnce();
    });

    it('only the latest ended generation may publish (regenerations and swipes)', async () => {
        const old = deferred();
        count.mockReturnValueOnce(old.promise).mockResolvedValueOnce(19);
        const older = emit('ended');
        await vi.waitFor(() => expect(count).toHaveBeenCalledOnce());
        registry['3_vectfox'].value = 'new generation';
        await emit('ended');
        old.resolve(3);
        await older;
        expect(lifecycle.getState().result).toMatchObject({ total: 19, generationId: 2 });
    });

    it('resets on chat change and discards results even after switching back', async () => {
        const old = deferred();
        count.mockReturnValue(old.promise);
        const pending = emit('ended');
        await vi.waitFor(() => expect(count).toHaveBeenCalledOnce());
        chatId = 'chat-b';
        emit('chat');
        chatId = 'chat-a';
        emit('chat');
        old.resolve(3);
        await pending;
        expect(lifecycle.getState()).toEqual({ status: 'unmeasured', result: null });
    });

    it('checks chat identity again even without a chat event', async () => {
        const loading = deferred();
        createTokenizer.mockReturnValue(loading.promise);
        const pending = emit('ended');
        chatId = 'chat-b';
        loading.resolve({ count });
        await pending;
        expect(count).not.toHaveBeenCalled();
        expect(lifecycle.getState().status).toBe('unmeasured');
    });

    it('does no measurement work when the preference or master gate is off', async () => {
        enabled = false;
        lifecycle.refreshEnabled();
        await emit('ended');
        expect(lifecycle.getState()).toEqual({ status: 'disabled', result: null });
        expect(readRegistry).not.toHaveBeenCalled();
        expect(createTokenizer).not.toHaveBeenCalled();
        expect(count).not.toHaveBeenCalled();
    });

    it('invalidates pending work across an off/on toggle', async () => {
        const old = deferred();
        count.mockReturnValueOnce(old.promise);
        const pending = emit('ended');
        await vi.waitFor(() => expect(count).toHaveBeenCalledOnce());
        enabled = false;
        lifecycle.refreshEnabled();
        enabled = true;
        lifecycle.refreshEnabled();
        old.resolve(3);
        await pending;
        expect(lifecycle.getState()).toEqual({ status: 'unmeasured', result: null });
        await emit('ended');
        expect(lifecycle.getState().result.total).toBe(7);
    });

    it.each(['registry', 'adapter', 'tokenizer', 'unavailable'])(
        '%s failures are nonfatal and never become zero', async failure => {
            if (failure === 'registry') readRegistry.mockImplementation(() => { throw new Error('private'); });
            if (failure === 'adapter') createTokenizer.mockRejectedValue(new Error('private'));
            if (failure === 'tokenizer') count.mockRejectedValue(new Error('private'));
            if (failure === 'unavailable') createTokenizer.mockResolvedValue(null);
            await expect(emit('ended')).resolves.toBeUndefined();
            expect(lifecycle.getState().status).toBe('unavailable');
            expect(lifecycle.getState().result?.total ?? null).toBeNull();
            expect(JSON.stringify(lifecycle.getState())).not.toContain('private');
        },
    );

    it('initializes once, isolates subscriber failures, and unsubscribes', async () => {
        const ended = handlers.get('ended');
        lifecycle.initialize();
        expect(handlers.size).toBe(2);
        expect(handlers.get('ended')).toBe(ended);
        lifecycle.subscribe(() => { throw new Error('broken UI'); });
        const listener = vi.fn();
        const unsubscribe = lifecycle.subscribe(listener);
        await emit('ended');
        expect(listener).toHaveBeenCalledOnce();
        unsubscribe();
        await emit('ended');
        expect(listener).toHaveBeenCalledOnce();
    });

    it('disposes listeners and prevents pending work from publishing', async () => {
        const loading = deferred();
        createTokenizer.mockReturnValue(loading.promise);
        const pending = emit('ended');
        lifecycle.dispose();
        lifecycle.dispose();
        loading.resolve({ count });
        await pending;
        expect(handlers.size).toBe(0);
        expect(lifecycle.getState().status).toBe('disabled');
        expect(count).not.toHaveBeenCalled();
        lifecycle.initialize();
        expect(handlers.size).toBe(2);
    });
});