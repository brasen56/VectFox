import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ backends: {} }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} } }));
vi.mock('../../../../../script.js', () => ({ saveSettingsDebounced: vi.fn() }));
vi.mock('../core/collection-ids.js', async () => import('../core/collection-id-routing.js'));
vi.mock('../backends/backend-manager.js', () => ({
    getBackendForCollection: async backend => mocks.backends[backend],
    getBackend: async settings => mocks.backends[settings.vector_backend || 'standard'],
}));
vi.mock('../core/collection-export.js', () => ({ fetchChunksWithVectors: vi.fn() }));
vi.mock('../core/llm-provider-call.js', () => ({ postChatCompletion: vi.fn(), parseJsonArrayFromLlm: vi.fn(), resolveModelParameterStyle: vi.fn() }));
vi.mock('../core/generation-rate-limiter.js', () => ({ generationRateLimiter: {}, generationRateLimitSettings: vi.fn() }));
vi.mock('../core/log.js', () => ({ log: { warn: vi.fn() } }));
vi.mock('../core/collection-storage.js', async importOriginal => ({
    ...await importOriginal(),
    resolveCollectionStorage: async key => {
        const backend = key.split(':')[0];
        return { backend, source: 'transformers', model: '', identity: backend };
    },
}));

import { ensureCharacterIndex, getCharacterRoster, invalidateCharacterIndex, pruneCharacterEvents, upsertCharacterEvents } from '../core/character-roster.js';
import { markEventResolved, removeResolutionLink, reopenEventSelfClosure } from '../core/continuity-repair-service.js';
import { continuityActionSnapshot, threadsDigest } from '../core/continuity.js';

const id = 'write-isolation';
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const event = hash => ({ hash, event_id: 'e', summary: hash, open_threads: ['Debt', 'Promise'], characters: ['Kai'] });
beforeEach(() => {
    for (const backend of ['qdrant', 'standard']) {
        invalidateCharacterIndex(`${backend}:${id}`);
        mocks.backends[backend] = {
            listChunks: vi.fn(async () => ({ items: [{ hash: backend, metadata: event(backend) }] })),
            updateChunkMetadata: vi.fn(async () => ({ success: true })),
        };
    }
});

describe('canonical cache and continuity write isolation', () => {
    it('shares aliases, isolates mutations and invalidation, and writes only Standard evidence', async () => {
        const q = await ensureCharacterIndex(`qdrant:${id}`, {});
        const s = await ensureCharacterIndex(`standard:${id}`, {});
        expect(await ensureCharacterIndex(id, { vector_backend: 'vectra' })).toBe(s);
        expect(await ensureCharacterIndex(`vectra:${id}`, {})).toBe(s);
        await markEventResolved(`standard:${id}`, 'e', {}, [0]);
        expect(mocks.backends.standard.updateChunkMetadata).toHaveBeenCalledWith(id, 'standard',
            { continuity: expect.objectContaining({ closed_threads: expect.objectContaining({ threads: [0] }) }) },
            expect.objectContaining({ embedding_provider: 'transformers', collection_storage: expect.objectContaining({ identity: 'standard' }) }));
        expect(q.events.get('e').continuity).toBeUndefined();
        const link = { event_id: 'other', threads: 'all', status: 'active' };
        const stored = s.events.get('e');
        const continuity = { ...stored.continuity, resolves: [link], user_previous_closure: {
            threads: 'all', threads_digest: threadsDigest(stored), origin: 'repair', status: 'active',
        } };
        upsertCharacterEvents(id, [{ hash: 'standard', metadata: { ...stored, continuity } }], { vector_backend: 'standard' });
        await removeResolutionLink(`standard:${id}`, 'e', link, {});
        await reopenEventSelfClosure(`vectra:${id}`, 'e', {});
        expect(s.events.get('e').continuity).toMatchObject({ resolves: [], closed_threads: { threads: [0] } });
        expect(s.events.get('e').continuity.user_previous_closure).toBeUndefined();
        expect(mocks.backends.qdrant.updateChunkMetadata).not.toHaveBeenCalled();
        pruneCharacterEvents(`standard:${id}`, ['standard']);
        expect(s.events.size).toBe(0);
        expect(q.events.size).toBe(1);
        invalidateCharacterIndex(id, { vector_backend: 'standard' });
        expect(getCharacterRoster([`standard:${id}`]).ready).toBe(false);
        expect(await ensureCharacterIndex(`qdrant:${id}`, {})).toBe(q);
        await ensureCharacterIndex(`standard:${id}`, {});
        expect(mocks.backends.standard.listChunks).toHaveBeenCalledTimes(2);
        expect(mocks.backends.qdrant.listChunks).toHaveBeenCalledTimes(1);
    });

    it.each(['mark', 'remove', 'reopen'])('rejects a queued stale %s after an in-flight mark', async action => {
        const entry = await ensureCharacterIndex(`standard:${id}`, {});
        const stored = entry.events.get('e');
        const link = { event_id: 'other', threads: 'all', status: 'active' };
        stored.continuity = { v: 1, resolves: [link], closed_threads: {
            threads: [1], threads_digest: threadsDigest(stored), origin: 'repair', status: 'active',
        } };
        const expected = continuityActionSnapshot(stored);
        let release;
        const patch = mocks.backends.standard.updateChunkMetadata;
        patch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const first = markEventResolved(`standard:${id}`, 'e', {}, [0], 'Panel mark', expected);
        await settle();
        expect(patch).toHaveBeenCalledTimes(1);
        // Bare and qualified callers (the two UI surfaces) must share the same lock.
        const settings = { vector_backend: 'standard' };
        const second = action === 'mark' ? markEventResolved(id, 'e', settings, [1], 'Browser mark', expected)
            : action === 'remove' ? removeResolutionLink(id, 'e', link, settings, expected)
                : reopenEventSelfClosure(id, 'e', settings, expected);
        const rejected = expect(second).rejects.toThrow('Refresh and review');
        await settle();
        expect(patch).toHaveBeenCalledTimes(1);
        release({ success: true });
        await first;
        await rejected;
        expect(patch).toHaveBeenCalledTimes(1);
        expect(entry.events.get('e').continuity).toMatchObject({ resolves: [link], closed_threads: { threads: [0] } });
    });

    it('releases a failed write lock so the next action can succeed', async () => {
        const patch = mocks.backends.standard.updateChunkMetadata;
        patch.mockRejectedValueOnce(new Error('Network failure'));
        await expect(markEventResolved(id, 'e', {}, [0])).rejects.toThrow('Network failure');
        await markEventResolved(id, 'e', {}, [1]);
        expect(patch).toHaveBeenCalledTimes(2);
    });

    it('also rejects stale replacements from callers without reviewed snapshots', async () => {
        const patch = mocks.backends.standard.updateChunkMetadata;
        let release;
        patch.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const first = markEventResolved(id, 'e', {}, [0]);
        await settle();
        const second = markEventResolved(`standard:${id}`, 'e', {}, [1]);
        const rejected = expect(second).rejects.toThrow('Event changed before continuity write');
        await settle();
        expect(patch).toHaveBeenCalledTimes(1);
        release({ success: true });
        await first;
        await rejected;
        expect(patch).toHaveBeenCalledTimes(1);
        await markEventResolved(id, 'e', {}, [1]);
        expect(getCharacterRoster([id]).events[0].continuity.closed_threads.threads).toEqual([0, 1]);
    });
});