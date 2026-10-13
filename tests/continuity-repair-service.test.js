import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ events: new Map(), write: vi.fn(), save: vi.fn(), fetch: vi.fn(), post: vi.fn(),
    execute: vi.fn(), settings: { vectfox: {} }, supported: true }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: mocks.settings }));
vi.mock('../../../../../script.js', () => ({ saveSettingsDebounced: mocks.save }));
vi.mock('../core/character-roster.js', () => ({
    rosterCollectionId: key => key.replace(/^qdrant:/, ''),
    ensureCharacterIndex: async () => ({ ready: true, events: mocks.events }),
    getCharacterRoster: () => ({ groups: [] }),
    upsertCharacterEvents: (id, items) => items.forEach(item => mocks.events.set(item.metadata.event_id, item.metadata)),
}));
vi.mock('../core/collection-ids.js', () => ({ resolveBackendForCollection: () => ({ backend: 'qdrant' }) }));
vi.mock('../backends/backend-manager.js', () => ({ getBackendForCollection: async () => ({ pluginAvailable: mocks.supported, updateChunkMetadata: mocks.write }), getBackend: vi.fn() }));
vi.mock('../core/collection-export.js', () => ({ fetchChunksWithVectors: mocks.fetch }));
vi.mock('../core/llm-provider-call.js', () => ({ postChatCompletion: mocks.post, resolveModelParameterStyle: () => ({}), parseJsonArrayFromLlm: text => JSON.parse(text) }));
vi.mock('../core/generation-rate-limiter.js', () => ({ generationRateLimiter: { execute: mocks.execute }, generationRateLimitSettings: () => ({}) }));
import { createContinuityRepair, markEventResolved, unmarkEventResolved, removeResolutionLink, repairConfiguration } from '../core/continuity-repair-service.js';

beforeEach(() => {
    vi.clearAllMocks(); mocks.supported = true; mocks.settings.vectfox = {};
    mocks.events = new Map([['e1', { event_id: 'e1', hash: 1, summary: 'Argument', result: 'Still in debt',
        open_threads: ['hurt', 'debt'], characters: ['Alex'], importance: 7, event_type: 'relationship_change', source_window_start: 0, source_window_end: 2 }]]);
    mocks.write.mockResolvedValue({ success: true });
    mocks.fetch.mockResolvedValue([{ hash: 1, vector: { '': [1, 0] }, metadata: { event_id: 'e1' } }]);
    mocks.execute.mockImplementation(fn => fn());
    mocks.post.mockResolvedValue({ content: '[]', finishReason: 'stop', usage: { prompt_tokens: 42 } });
});

describe('continuity repair browser adapter', () => {
    it.each([true, false])('reloads changed hashes and excludes stale exported vectors (fresh: %s)', async fresh => {
        const original = mocks.events.get('e1');
        mocks.events.set('copy', { ...original, event_id: 'copy', hash: 2 });
        mocks.fetch.mockResolvedValue([
            { hash: 1, vector: [1, 0], metadata: { event_id: 'e1' } },
            { hash: 2, vector: [1, 0], metadata: { event_id: 'copy' } },
        ]);
        const engine = await createContinuityRepair('qdrant:collection', { chat_model: 'model' });
        await engine.start(); engine.pause();
        mocks.events.get('copy').hash = 3;
        mocks.events.get('copy').summary = 'An unrelated edited event';
        if (fresh) mocks.fetch.mockResolvedValue([
            { hash: 1, vector: [1, 0], metadata: { event_id: 'e1' } },
            { hash: 3, vector: [0, 1], metadata: { event_id: 'copy' } },
        ]);
        await engine.resume();
        expect(mocks.fetch.mock.calls.length).toBeGreaterThan(1);
        const copy = engine.vectors.get('copy');
        expect(copy && Array.from(copy)).toEqual(fresh ? [0, 1] : undefined);
        expect(mocks.events.get('copy').continuity?.duplicate_of).toBeUndefined();
    });
    it('resolves and trims the same effective provider, model and endpoint used by the UI', () => {
        expect(repairConfiguration({ chat_provider: 'vllm', chat_model: ' A ', chat_vllm_url: ' http://old ' }))
            .toEqual({ provider: 'vllm', model: 'A', url: 'http://old' });
        expect(repairConfiguration({ chat_model: 'A' }, { provider: ' vllm ', model: ' B ', url: ' http://new ' }))
            .toEqual({ provider: 'vllm', model: 'B', url: 'http://new' });
    });

    it('refreshes a paused engine after a chunk edit and preserves a newer manual closure through apply and undo', async () => {
        const settings = { chat_model: 'model' };
        const engine = await createContinuityRepair('qdrant:collection', settings);
        await engine.start(); engine.pause();
        const detached = mocks.events;
        mocks.events = new Map(structuredClone([...detached]));
        mocks.events.get('e1').summary = 'Edited argument';
        await markEventResolved('qdrant:collection', 'e1', settings);
        const manual = structuredClone(mocks.events.get('e1').continuity.closed_threads);
        await engine.resume();
        expect(mocks.post).not.toHaveBeenCalled(); // The frozen digest no longer matches.
        await engine.propose([{ owner: 'e1', field: 'closed_threads', entry: {
            origin: 'repair', run: engine.state.run, status: 'proposed', threads: 'all' } }]);
        await engine.review(engine.state.run, true);
        await engine.undo(engine.state.run);
        expect(engine.events).toBe(mocks.events);
        expect(mocks.events.get('e1').continuity.closed_threads).toEqual(manual);
        expect(mocks.events.get('e1').summary).toBe('Edited argument');
    });

    it('refreshes before merging an in-flight response and does not replace a manual closure', async () => {
        const settings = { chat_model: 'model' };
        const engine = await createContinuityRepair('qdrant:collection', settings);
        await engine.start();
        mocks.post.mockImplementationOnce(async () => {
            mocks.events = new Map(structuredClone([...mocks.events]));
            await markEventResolved('qdrant:collection', 'e1', settings);
            return { content: JSON.stringify([{ ref: 'e1', self_closed: { threads: 'all', how: 'Settled.' } }]), usage: { prompt_tokens: 50 } };
        });
        await engine.resume();
        expect(mocks.events.get('e1').continuity.closed_threads.origin).toBe('user');
    });

    it.each(['truncated', 'malformed'])('accounts for a %s paid response and adds usage on resume without advancing the failed batch', async kind => {
        const settings = { chat_model: 'model' };
        const engine = await createContinuityRepair('qdrant:collection', settings);
        mocks.post.mockResolvedValueOnce({ content: kind === 'malformed' ? '{bad json' : '[]',
            finishReason: kind === 'truncated' ? 'length' : 'stop', usage: { prompt_tokens: 73 } });
        await engine.start();
        await expect(engine.resume()).rejects.toThrow();
        expect(engine.state).toMatchObject({ cursor: 0, status: 'paused', counts: { calls: 1, inputTokens: 73 } });
        expect(settings.eventbase_continuity_repair.collection.counts).toEqual({ calls: 1, inputTokens: 73 });
        await engine.resume();
        expect(engine.state).toMatchObject({ cursor: 1, counts: { calls: 2, inputTokens: 115 } });
    });

    it('does not charge a failed dispatch and estimates tokens for a completed response with no usage', async () => {
        const engine = await createContinuityRepair('qdrant:collection', { chat_model: 'model' });
        await engine.start();
        mocks.post.mockRejectedValueOnce(new Error('offline'));
        await expect(engine.resume()).rejects.toThrow('offline');
        expect(engine.state.counts).toEqual({ calls: 0, inputTokens: 0 });
        mocks.post.mockResolvedValueOnce({ content: '[]', finishReason: 'length' });
        await expect(engine.resume()).rejects.toThrow('truncated');
        expect(engine.state.counts.calls).toBe(1);
        expect(engine.state.counts.inputTokens).toBeGreaterThan(0);
        expect(engine.state.cursor).toBe(0);
    });

    it('treats a pause while queued as a pause, not a failed or charged call', async () => {
        const engine = await createContinuityRepair('qdrant:collection', { chat_model: 'model' });
        await engine.start();
        mocks.execute.mockImplementationOnce(fn => { engine.pause(); return fn(); });
        await expect(engine.resume()).resolves.toMatchObject({ status: 'paused', cursor: 0, counts: { calls: 0, inputTokens: 0 } });
        expect(mocks.post).not.toHaveBeenCalled();
    });

    it('writes only continuity and preserves archive metadata and previous closures through manual mark/unmark', async () => {
        const previous = { threads: [1], origin: 'repair', run: 'old', status: 'active' };
        mocks.events.get('e1').continuity = { v: 1, closed_threads: previous, resolves: [{ event_id: 'other' }] };
        const archive = structuredClone(mocks.events.get('e1'));
        await markEventResolved('qdrant:collection', 'e1', {}, [0], 'Reconciled');
        expect(mocks.write.mock.calls[0].slice(0, 2)).toEqual(['collection', 1]);
        expect(Object.keys(mocks.write.mock.calls[0][2])).toEqual(['continuity']);
        expect(mocks.events.get('e1').continuity.closed_threads).toMatchObject({ origin: 'user', status: 'active', threads: [0] });
        await unmarkEventResolved('qdrant:collection', 'e1', {});
        expect(mocks.events.get('e1')).toEqual(archive);
        await expect(markEventResolved('qdrant:collection', 'e1', {}, [8])).rejects.toThrow('valid original thread');
    });

    it('removes exactly the selected outgoing link', async () => {
        const first = { event_id: 'old', threads: [0] }, second = { event_id: 'old', threads: [1] };
        mocks.events.get('e1').continuity = { v: 1, resolves: [first, second] };
        await removeResolutionLink('qdrant:collection', 'e1', first, {});
        expect(mocks.events.get('e1').continuity.resolves).toEqual([second]);
    });

    it('routes stored vectors by collection backend and charges the repair rate gate with real usage', async () => {
        const settings = { vector_backend: 'standard', chat_provider: 'openrouter', chat_model: 'model' };
        const engine = await createContinuityRepair('qdrant:collection', settings);
        expect(mocks.fetch).toHaveBeenCalledWith('collection', expect.objectContaining({ vector_backend: 'qdrant' }));
        expect(engine.vectors.get('e1')).toBeInstanceOf(Float32Array);
        expect(Array.from(engine.vectors.get('e1'))).toEqual([1, 0]);
        await engine.start(); await engine.resume();
        expect(mocks.execute).toHaveBeenCalledWith(expect.any(Function), {}, 'repair');
        expect(engine.state.counts.inputTokens).toBe(42);
        expect(mocks.settings.vectfox.eventbase_continuity_repair.collection).toMatchObject({ cursor: 1, model: 'openrouter/model' });
        expect(mocks.settings.vectfox).not.toHaveProperty('eventbase_fingerprints');
    });

    it('rejects unsupported backends, incomplete vectors and truncated responses', async () => {
        const settings = { chat_model: 'model' };
        mocks.supported = false;
        await expect(createContinuityRepair('qdrant:collection', settings)).rejects.toThrow('readable metadata');
        mocks.supported = true; mocks.fetch.mockResolvedValue([]);
        await expect(createContinuityRepair('qdrant:collection', settings)).rejects.toThrow('Incomplete vector');
        mocks.fetch.mockResolvedValue([{ hash: 1, vector: [1, 0] }]);
        mocks.post.mockResolvedValue({ content: '[]', finishReason: 'length' });
        const engine = await createContinuityRepair('qdrant:collection', settings);
        await engine.start();
        await expect(engine.resume()).rejects.toThrow('truncated');
        expect(engine.state.cursor).toBe(0);
    });
});