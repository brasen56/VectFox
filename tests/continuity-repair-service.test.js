import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ events: new Map(), write: vi.fn(), save: vi.fn(), fetch: vi.fn(), post: vi.fn(),
    execute: vi.fn(), settings: { vectfox: {} }, supported: true }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: mocks.settings }));
vi.mock('../../../../../script.js', () => ({ saveSettingsDebounced: mocks.save }));
vi.mock('../core/character-roster.js', () => ({
    rosterCollectionId: key => key.replace(/^qdrant:/, ''),
    rosterCollectionKey: key => key.includes(':') ? key : `qdrant:${key}`,
    ensureCharacterIndex: async () => ({ ready: true, events: mocks.events }),
    getCharacterRoster: () => ({ groups: [] }),
    upsertCharacterEvents: (id, items) => items.forEach(item => mocks.events.set(item.metadata.event_id, item.metadata)),
}));
vi.mock('../core/collection-ids.js', () => ({ resolveBackendForCollection: () => ({ backend: 'qdrant' }) }));
vi.mock('../backends/backend-manager.js', () => ({ getBackendForCollection: async () => ({ pluginAvailable: mocks.supported, updateChunkMetadata: mocks.write }), getBackend: vi.fn() }));
vi.mock('../core/collection-export.js', () => ({ fetchChunksWithVectors: mocks.fetch }));
vi.mock('../core/llm-provider-call.js', () => ({ postChatCompletion: mocks.post, resolveModelParameterStyle: () => ({}), parseJsonArrayFromLlm: text => JSON.parse(text) }));
vi.mock('../core/generation-rate-limiter.js', () => ({ generationRateLimiter: { execute: mocks.execute }, generationRateLimitSettings: () => ({}) }));
import { createContinuityRepair, markEventResolved, unmarkEventResolved, reopenEventSelfClosure, removeResolutionLink, repairConfiguration, continuityCollection } from '../core/continuity-repair-service.js';
import { continuityActionSnapshot, getContinuityView, threadsDigest } from '../core/continuity.js';

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
    it.each(['mark', 'unmark', 'reopen', 'remove'])('rejects changes since review before %s can PATCH', async action => {
        const event = mocks.events.get('e1');
        event.continuity = { v: 1, closed_threads: { threads: 'all', threads_digest: threadsDigest(event),
            origin: action === 'unmark' ? 'user' : 'repair', status: 'active' } };
        const expected = continuityActionSnapshot(event);
        mocks.events.set('e1', { ...event, hash: 99, summary: 'Replacement', open_threads: ['Unrelated replacement'] });
        const invoke = () => action === 'mark' ? markEventResolved('collection', 'e1', {}, [0], 'Paid', expected)
            : action === 'unmark' ? unmarkEventResolved('collection', 'e1', {}, [0], expected)
                : action === 'reopen' ? reopenEventSelfClosure('collection', 'e1', {}, expected)
                    : removeResolutionLink('collection', 'e1', {}, {}, expected);
        await expect(invoke()).rejects.toThrow('Refresh and review');
        mocks.events.set('e1', { ...event, continuity: { ...event.continuity, closed_threads: { ...event.continuity.closed_threads, how: 'New closure' } } });
        await expect(invoke()).rejects.toThrow('Refresh and review');
        expect(mocks.write).not.toHaveBeenCalled();
    });

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

    it('accumulates successive partial marks instead of replacing them', async () => {
        mocks.events.get('e1').open_threads = ['hurt', 'debt', 'rent'];
        await markEventResolved('qdrant:collection', 'e1', {}, [0]);
        await markEventResolved('qdrant:collection', 'e1', {}, [2], 'Rent paid');
        const event = mocks.events.get('e1');
        expect(event.continuity.closed_threads).toMatchObject({ threads: [0, 2], origin: 'user', how: 'Rent paid' });
        expect(event.continuity.user_previous_closure).toBeUndefined();
        expect(getContinuityView(event)).toMatchObject({ closedThreads: [0, 2], remainingThreads: ['debt'] });
        await markEventResolved('qdrant:collection', 'e1', {}, 'all');
        await markEventResolved('qdrant:collection', 'e1', {}, [1]);
        expect(mocks.events.get('e1').continuity.closed_threads.threads).toBe('all');
    });

    it('keeps a displaced repair closure in force under a partial mark and restores it on unmark', async () => {
        const event = mocks.events.get('e1');
        event.open_threads = ['hurt', 'debt', 'rent'];
        const repair = { threads: [0, 1], threads_digest: threadsDigest(event), how: 'Settled.', origin: 'repair', run: 'r1', status: 'active' };
        event.continuity = { v: 1, closed_threads: repair };
        await markEventResolved('qdrant:collection', 'e1', {}, [2]);
        const marked = mocks.events.get('e1');
        expect(marked.continuity).toMatchObject({ closed_threads: { threads: [2], origin: 'user' }, user_previous_closure: repair });
        expect(getContinuityView(marked)).toMatchObject({ closedThreads: [0, 1, 2], fullyResolved: true });
        await unmarkEventResolved('qdrant:collection', 'e1', {});
        const unmarked = mocks.events.get('e1');
        expect(unmarked.continuity).toEqual({ v: 1, closed_threads: repair });
        expect(getContinuityView(unmarked).closedThreads).toEqual([0, 1]);
    });

    it('takes no indices from a prior user mark that no longer applies', async () => {
        mocks.events.get('e1').continuity = { v: 1, closed_threads: { threads: [0], threads_digest: 'stale', origin: 'user', run: null, status: 'active' } };
        await markEventResolved('qdrant:collection', 'e1', {}, [1]);
        expect(mocks.events.get('e1').continuity.closed_threads.threads).toEqual([1]);
        expect(getContinuityView(mocks.events.get('e1')).closedThreads).toEqual([1]);
    });

    it('removes exactly the selected outgoing link', async () => {
        const first = { event_id: 'old', threads: [0] }, second = { event_id: 'old', threads: [1] };
        mocks.events.get('e1').continuity = { v: 1, resolves: [first, second] };
        await removeResolutionLink('qdrant:collection', 'e1', first, {});
        expect(mocks.events.get('e1').continuity.resolves).toEqual([second]);
    });

    it('unmarks selected indices from all and restores the prior closure after the last user index', async () => {
        const event = mocks.events.get('e1');
        const previous = { threads: [0], threads_digest: threadsDigest(event), origin: 'extraction', status: 'active' };
        event.continuity = { v: 1, closed_threads: previous };
        await markEventResolved('qdrant:collection', 'e1', {});
        await unmarkEventResolved('qdrant:collection', 'e1', {}, [0]);
        expect(mocks.events.get('e1').continuity.closed_threads.threads).toEqual([1]);
        expect(getContinuityView(mocks.events.get('e1')).closedThreads).toEqual([0, 1]);
        await unmarkEventResolved('qdrant:collection', 'e1', {}, [1]);
        expect(mocks.events.get('e1').continuity).toEqual({ v: 1, closed_threads: previous });
        expect(getContinuityView(mocks.events.get('e1')).closedThreads).toEqual([0]);
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.post).not.toHaveBeenCalled();
    });

    it.each(['repair', 'extraction'])('reopens a whole %s self-closure, directly and beneath user marks', async origin => {
        const original = structuredClone(mocks.events.get('e1'));
        const closure = { threads: [0], threads_digest: threadsDigest(original), origin, run: 'r1', status: 'active' };
        for (const beneath of [false, true]) {
            mocks.events.set('e1', { ...original, continuity: { v: 1, closed_threads: closure, resolves: [{ event_id: 'other' }] } });
            if (beneath) await markEventResolved('qdrant:collection', 'e1', {}, [1]);
            await reopenEventSelfClosure('qdrant:collection', 'e1', {});
            const event = mocks.events.get('e1');
            expect(getContinuityView(event).closedThreads).toEqual(beneath ? [1] : []);
            expect(event.continuity.user_previous_closure).toBeUndefined();
            expect(event.continuity.resolves).toEqual([{ event_id: 'other' }]);
            const { continuity, ...archive } = event;
            expect(archive).toEqual(original);
        }
        expect(mocks.write.mock.calls.every(call => Object.keys(call[2]).join() === 'continuity')).toBe(true);
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.post).not.toHaveBeenCalled();
        expect(mocks.execute).not.toHaveBeenCalled();
    });

    it.each(['not_active', 'digest_mismatch'])('never activates an invalid prior closure on partial unmark: %s', async reason => {
        const event = mocks.events.get('e1');
        event.continuity = { v: 1, closed_threads: { threads: [0], threads_digest: reason === 'digest_mismatch' ? 'old' : threadsDigest(event),
            origin: 'repair', status: reason === 'not_active' ? 'undone' : 'active' } };
        await markEventResolved('qdrant:collection', 'e1', {});
        await unmarkEventResolved('qdrant:collection', 'e1', {}, [0]);
        expect(getContinuityView(mocks.events.get('e1')).closedThreads).toEqual([1]);
        await unmarkEventResolved('qdrant:collection', 'e1', {});
        expect(getContinuityView(mocks.events.get('e1')).closedThreads).toEqual([]);
    });

    it('restricts unmark to user marks and reopen to extraction/repair closures', async () => {
        const event = mocks.events.get('e1');
        event.continuity = { v: 1, closed_threads: { threads: 'all', threads_digest: threadsDigest(event), origin: 'repair', status: 'active' } };
        await unmarkEventResolved('qdrant:collection', 'e1', {});
        expect(mocks.write).not.toHaveBeenCalled();
        await markEventResolved('qdrant:collection', 'e1', {});
        await expect(unmarkEventResolved('qdrant:collection', 'e1', {}, [])).rejects.toThrow('valid original');
        await reopenEventSelfClosure('qdrant:collection', 'e1', {});
        mocks.write.mockClear();
        await reopenEventSelfClosure('qdrant:collection', 'e1', {});
        expect(mocks.write).not.toHaveBeenCalled();
        expect(getContinuityView(mocks.events.get('e1')).closedThreads).toEqual([0, 1]);
    });

    it('rejects stale archive or continuity snapshots before metadata PATCH', async () => {
        const context = await continuityCollection('qdrant:collection', {});
        const event = structuredClone(mocks.events.get('e1'));
        mocks.events.get('e1').summary = 'Edited';
        await expect(context.write(event, { v: 1 })).rejects.toThrow('Event changed');
        mocks.events.set('e1', { ...event, continuity: { v: 1 } });
        await expect(context.write(event, { v: 1 })).rejects.toThrow('Event changed');
        expect(mocks.write).not.toHaveBeenCalled();
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