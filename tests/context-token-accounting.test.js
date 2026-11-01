import { describe, it, expect, vi } from 'vitest';
import { countContextTokens, snapshotContextTokenPrompts } from '../core/context-token-accounting.js';
import { createContextTokenHostPort } from '../core/context-token-host.js';

const port = count => ({ identity: { id: 1, key: 'gpt2', name: 'GPT-2' }, count: vi.fn(count) });
const snapshot = value => ({ '3_vectfox': { value, position: 1, depth: 2 } });

describe('context token accounting', () => {
    it.each([
        ['3_vectfox', 'chunkbase'],
        ['3_vectfox_pos123', 'chunkbase'],
        ['3_vectfox_eventbase', 'eventbase'],
        ['3_vectfox_summarizer', 'summarizer'],
        ['3_vectfox_lorebook', 'lorebook'],
        ['3_vectfox_future', '3_vectfox_future'],
    ])('counts the final wrapper and substituted text for %s', async (tag, category) => {
        const value = '<memory>\nBackground for Alice\n\nFinal injected text\n</memory>';
        const tokenizer = port(text => text === value ? 17 : 999);
        const registry = Object.freeze({
            [tag]: Object.freeze({ value, position: 0, depth: 4 }),
            other_3_vectfox: Object.freeze({ value: 'unrelated extension' }),
        });
        const result = await countContextTokens(registry, { tokenizer });
        expect(tokenizer.count.mock.calls).toEqual([[value]]);
        expect(result).toMatchObject({ status: 'ok', total: 17, perCategory: { [category]: 17 },
            slots: [{ tag, category, count: 17, position: 0, depth: 4 }] });
        expect(JSON.stringify(result)).not.toContain(value);
        expect(registry[tag].value).toBe(value);
    });

    it('sums independent blocks rather than tokenizing their concatenation', async () => {
        const counts = new Map([['alpha', 2], ['beta', 3], ['alphabeta', 1]]);
        const tokenizer = port(text => counts.get(text));
        const result = await countContextTokens({ ...snapshot('alpha'),
            '3_vectfox_pos0': { value: 'beta' } }, { tokenizer });
        expect(tokenizer.count.mock.calls).toEqual([['alpha'], ['beta']]);
        expect(result.total).toBe(5);
        expect(Object.values(result.perCategory).reduce((sum, count) => sum + count, 0)).toBe(result.total);
        expect(result.slots.reduce((sum, slot) => sum + slot.count, 0)).toBe(result.total);
    });

    it('does not retain arbitrary tokenizer metadata, functions or prompt payloads', async () => {
        const tokenizer = port(() => 2);
        Object.assign(tokenizer.identity, { prompt: 'PRIVATE PAYLOAD', nested: { value: 'PRIVATE PAYLOAD' },
            callback: () => 'PRIVATE PAYLOAD' });
        const result = await countContextTokens(snapshot('PRIVATE PAYLOAD'), { tokenizer });
        expect(result.tokenizer).toEqual({ id: 1, key: 'gpt2', name: 'GPT-2' });
        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
        expect(JSON.stringify(result)).not.toContain('PRIVATE PAYLOAD');
        expect(result.tokenizer).not.toBe(tokenizer.identity);
    });

    it.each(['resolve', 'reject'])('discards cancelled accounting after a pending block %s', async outcome => {
        const controller = new AbortController();
        let resolve, reject;
        const tokenizer = port(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
        const pending = countContextTokens({ ...snapshot('first'), '3_vectfox_pos1': { value: 'second' } },
            { tokenizer, signal: controller.signal });
        expect(tokenizer.count).toHaveBeenCalledWith('first', { signal: controller.signal });
        controller.abort();
        if (outcome === 'resolve') resolve(3);
        else reject(new Error('private'));
        expect(await pending).toBeNull();
        expect(tokenizer.count).toHaveBeenCalledOnce();
    });

    it('skips tokenization when already cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        const tokenizer = port(() => 1);
        expect(await countContextTokens(snapshot('text'), { tokenizer, signal: controller.signal })).toBeNull();
        expect(await countContextTokens(snapshot('text'), { tokenizer, isCurrent: () => false })).toBeNull();
        expect(tokenizer.count).not.toHaveBeenCalled();
    });

    it('counts literal blocks once and rolls up all known and unknown slots', async () => {
        const tags = ['3_vectfox', '3_vectfox_pos12', '3_vectfox_eventbase', '3_vectfox_summarizer',
            '3_vectfox_lorebook', '3_vectfox_future', '3_vectfox2'];
        const registry = Object.fromEntries(tags.map(tag => [tag, Object.freeze({ value: '<xml>same</xml>', position: 1, depth: 2 })]));
        registry.other_extension = { value: 'private unrelated content' };
        Object.freeze(registry);
        const tokenizer = port(() => 4);
        const result = await countContextTokens(registry, { chatId: 'chat', generationId: 3, tokenizer });
        expect(result).toMatchObject({ chatId: 'chat', generationId: 3, status: 'ok', total: 28,
            partial: false, countingConvention: 'sum-of-blocks', tokenizer: tokenizer.identity,
            perCategory: { chunkbase: 8, eventbase: 4, summarizer: 4, lorebook: 4, '3_vectfox_future': 4, '3_vectfox2': 4 } });
        expect(result.slots).toHaveLength(7);
        expect(result.slots[1]).toMatchObject({ tag: '3_vectfox_pos12', label: 'ChunkBase — position group 12', position: 1, depth: 2, count: 4 });
        expect(tokenizer.count.mock.calls).toEqual(tags.map(() => ['<xml>same</xml>']));
        expect(result.slots.reduce((sum, slot) => sum + slot.count, 0)).toBe(result.total);
        expect(JSON.stringify(result)).not.toContain('<xml>');
    });

    it('skips empty strings but counts whitespace and identical blocks separately', async () => {
        const tokenizer = port(() => 1);
        const result = await countContextTokens({ ...snapshot(''), '3_vectfox_pos0': { value: ' ' },
            '3_vectfox_pos1': { value: ' ' } }, { tokenizer });
        expect(result.total).toBe(2);
        expect(tokenizer.count.mock.calls).toEqual([[' '], [' ']]);
    });

    it('copies values and metadata before awaiting and never mutates the registry', async () => {
        let resolve;
        const tokenizer = port(() => new Promise(done => { resolve = done; }));
        const registry = snapshot('original');
        registry['3_vectfox_pos11'] = { value: 'second', position: 4, depth: 5 };
        const pending = countContextTokens(registry, { tokenizer });
        registry['3_vectfox_pos11'].value = 'changed';
        registry['3_vectfox_pos11'].depth = 99;
        tokenizer.count.mockImplementation(() => 2);
        resolve(1);
        const result = await pending;
        expect(tokenizer.count.mock.calls).toEqual([['original'], ['second']]);
        expect(result.slots[1].depth).toBe(5);
        expect(registry['3_vectfox'].value).toBe('original');
    });

    it('only reports successful zero when a tokenizer is available', async () => {
        const tokenizer = port(() => 1);
        expect(await countContextTokens({}, { tokenizer })).toMatchObject({ status: 'ok', total: 0 });
        expect(tokenizer.count).not.toHaveBeenCalled();
        expect(await countContextTokens({})).toMatchObject({ status: 'unavailable-tokenizer', total: null });
        expect(await countContextTokens(snapshot('text'))).toMatchObject({ status: 'unavailable-tokenizer',
            total: null, perCategory: { chunkbase: null } });
    });

    it.each([undefined, null, NaN, Infinity, -1, 1.2, '4', {}, Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid count %j without inventing zero', async count => {
            expect(await countContextTokens(snapshot('text'), { tokenizer: port(() => count) }))
                .toMatchObject({ status: 'failed', total: null, slots: [{ error: 'invalid-count', count: null }] });
        });

    it('retains explicit partial diagnostics but not a complete total or private errors', async () => {
        const tokenizer = port(() => 3);
        tokenizer.count.mockRejectedValueOnce(new Error('SECRET PROMPT CONTENT'));
        const result = await countContextTokens({ ...snapshot('secret'), '3_vectfox_pos0': { value: 'second' },
            '3_vectfox_lorebook': { value: 'third' } }, { tokenizer });
        expect(result).toMatchObject({ status: 'failed', total: null, partialTotal: 6, partial: true,
            perCategory: { chunkbase: null, lorebook: 3 } });
        expect(JSON.stringify(result)).not.toMatch(/SECRET|secret|second|third/);
    });

    it.each([null, undefined, 4, {}])('marks malformed owned entries unavailable: %j', async entry => {
        const tokenizer = port(() => 2);
        const result = await countContextTokens({ '3_vectfox': entry }, { tokenizer });
        expect(result).toMatchObject({ status: 'failed', total: null, slots: [{ error: 'invalid-value' }] });
        expect(tokenizer.count).not.toHaveBeenCalled();
    });

    it.each([null, [], 'text'])('handles invalid snapshots: %j', async input => {
        expect(await countContextTokens(input)).toMatchObject({ status: 'failed', total: null, error: 'invalid-snapshot' });
    });

    it('rejects overflow rather than returning an inexact total', async () => {
        const result = await countContextTokens({ ...snapshot('a'), '3_vectfox_pos0': { value: 'b' } },
            { tokenizer: port(() => Number.MAX_SAFE_INTEGER) });
        expect(result).toMatchObject({ status: 'failed', total: null, partial: true });
    });

    it('snapshots only owned scalar fields and has no dependency on host modules', () => {
        expect(snapshotContextTokenPrompts({ ...snapshot('text'), other: { value: 'excluded' } }))
            .toEqual(snapshot('text'));
    });
});

function hostOptions(key = 'gpt2', data = { ids: [1, 2], count: 2 }) {
    const host = {
        getFriendlyTokenizerName: () => ({ tokenizerId: 1, tokenizerKey: key, tokenizerName: key }),
        getTokenizerModel: () => 'gpt-4o', getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        getRemoteSettings: vi.fn(async () => ({ url: 'http://localhost:5000', model: 'model', api_type: 'tabby' })),
    };
    return { host, load: async () => host, fetchImpl: vi.fn(async () => ({ ok: true, json: async () => data })) };
}

describe('SillyTavern context token adapter', () => {
    it.each(['gpt2', 'llama', 'llama3', 'nerd', 'nerd2', 'mistral', 'yi', 'claude', 'gemma',
        'jamba', 'qwen2', 'command_r', 'command_a', 'nemo', 'deepseek'])('supports %s without using the fallback count helper', async key => {
        const options = hostOptions(key);
        const tokenizer = await createContextTokenHostPort(options);
        expect(await tokenizer.count('<xml>text</xml>')).toBe(2);
        const [url, request] = options.fetchImpl.mock.calls[0];
        expect(url).toMatch(/^\/api\/tokenizers\/.+\/encode$/);
        expect(JSON.parse(request.body)).toEqual({ text: '<xml>text</xml>' });
        expect(tokenizer.identity.key).toBe(key);
    });

    it('captures the OpenAI tokenizer model before counting', async () => {
        const options = hostOptions('openai');
        const tokenizer = await createContextTokenHostPort(options);
        options.host.getTokenizerModel = () => 'changed';
        await tokenizer.count('text');
        expect(options.fetchImpl.mock.calls[0][0]).toBe('/api/tokenizers/openai/encode?model=gpt-4o');
        expect(tokenizer.identity.model).toBe('gpt-4o');
    });

    it.each(['none', 'best_match', 'future'])('does not guess for %s', async key => {
        const options = hostOptions(key);
        expect(await createContextTokenHostPort(options)).toBeNull();
        expect(options.fetchImpl).not.toHaveBeenCalled();
    });

    it('handles missing host exports or failed loading', async () => {
        expect(await createContextTokenHostPort({ load: async () => ({}) })).toBeNull();
        expect(await createContextTokenHostPort({ load: async () => { throw new Error('private'); } })).toBeNull();
    });

    it.each([{ count: 3, ids: [] }, { count: 0 }, { ids: [1], count: 3 }, { ids: [-1] },
        { ids: ['1'] }, { ids: [1], error: 'failed' }, null])('rejects estimates and malformed responses: %j', async data => {
        const tokenizer = await createContextTokenHostPort(hostOptions('gpt2', data));
        await expect(tokenizer.count('text')).rejects.toThrow();
    });

    it.each(['api_kobold', 'api_textgenerationwebui'])('uses %s with frozen connection settings', async key => {
        const options = hostOptions(key, { count: 7 });
        const tokenizer = await createContextTokenHostPort(options);
        options.host.getRemoteSettings.mockResolvedValue({ url: 'changed' });
        expect(await tokenizer.count('text')).toBe(7);
        expect(JSON.parse(options.fetchImpl.mock.calls[0][1].body)).toMatchObject({ url: 'http://localhost:5000', text: 'text' });
    });

    it.each(['kobold', 'textgenerationwebui'])('resolves api_current for %s', async mainApi => {
        const options = hostOptions('api_current', { count: 3 });
        options.host.mainApi = mainApi;
        const tokenizer = await createContextTokenHostPort(options);
        expect(tokenizer.identity.key).toBe(mainApi === 'kobold' ? 'api_kobold' : 'api_textgenerationwebui');
        expect(await tokenizer.count('text')).toBe(3);
    });

    it.each([0, -1, 1.5, '3', undefined])('rejects invalid remote counts: %j', async count => {
        const tokenizer = await createContextTokenHostPort(hostOptions('api_kobold', { count }));
        await expect(tokenizer.count('text')).rejects.toThrow();
    });

    it('turns HTTP failures into unavailable measurements', async () => {
        const options = hostOptions();
        options.fetchImpl.mockResolvedValue({ ok: false });
        const tokenizer = await createContextTokenHostPort(options);
        expect(await countContextTokens(snapshot('text'), { tokenizer })).toMatchObject({ status: 'failed', total: null });
    });

    it('aborts an active request on measurement cancellation and removes its listener', async () => {
        const options = hostOptions();
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');
        options.fetchImpl.mockImplementation((url, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }));
        const tokenizer = await createContextTokenHostPort(options);
        const pending = tokenizer.count('text', { signal: controller.signal });
        const rejected = expect(pending).rejects.toThrow('aborted');
        controller.abort();
        await rejected;
        expect(options.fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('does not fetch when the measurement is already cancelled', async () => {
        const options = hostOptions();
        const tokenizer = await createContextTokenHostPort(options);
        const controller = new AbortController();
        controller.abort();
        await expect(tokenizer.count('text', { signal: controller.signal })).rejects.toThrow();
        expect(options.fetchImpl).not.toHaveBeenCalled();
    });

    it('aborts stalled requests', async () => {
        const options = hostOptions();
        options.fetchImpl.mockImplementation((url, { signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }));
        const tokenizer = await createContextTokenHostPort({ ...options, timeoutMs: 5 });
        await expect(tokenizer.count('text')).rejects.toThrow('aborted');
    });
});