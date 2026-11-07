import { describe, expect, it, vi } from 'vitest';
vi.mock('../core/log.js', () => ({ log: { warn: vi.fn() } }));
import { buildOpenThreadSnapshot, filterOpenThreads, loadOpenThreads } from '../core/open-threads.js';
import { ensureCharacterIndex, invalidateCharacterIndex } from '../core/character-roster.js';
import { threadsDigest, getContinuityView } from '../core/continuity.js';

const event = (id, extra = {}) => ({ event_id: id, summary: `Summary ${id}`, open_threads: ['debt', 'promise'],
    importance: 1, event_type: 'discovery', characters: ['Kai'], source_window_end: 1, ...extra });
const archive = events => [{ collection: 'a', events }];

describe('read-only thread projection', () => {
    it('uses all-scope enumeration, original partial indices and the resolver audit, without mutations', () => {
        const target = event('issue');
        const resolver = event('payment', { open_threads: [], continuity: { v: 1, resolves: [{ event_id: 'issue',
            threads: [0], threads_digest: threadsDigest(target), status: 'active', origin: 'extraction', how: 'Paid in full' }] } });
        const duplicate = event('duplicate', { continuity: { v: 1, duplicate_of: { status: 'active' } } });
        const before = JSON.stringify([target, resolver, duplicate]);
        const snapshot = buildOpenThreadSnapshot(archive([target, resolver, duplicate]));
        expect(snapshot.rows).toHaveLength(1);
        const row = snapshot.rows[0];
        expect(row.indices).toEqual([1]);
        expect(row.view).toEqual(getContinuityView(target, row.index));
        expect(row.view.resolutions[0]).toMatchObject({ origin: 'extraction', how: 'Paid in full' });
        expect(JSON.stringify([target, resolver, duplicate])).toBe(before);
    });
    it('keeps copies and closure authority collection-local, including digest-invalidated links', () => {
        const target = event('same');
        const closed = event('same', { continuity: { v: 1, closed_threads: { threads: 'all', status: 'active', threads_digest: threadsDigest(target) } } });
        const stale = event('stale', { continuity: { v: 1, closed_threads: { threads: 'all', status: 'active', threads_digest: 'old' } } });
        const snapshot = buildOpenThreadSnapshot([...archive([target, stale]), { collection: 'b', events: [closed] }]);
        expect(filterOpenThreads(snapshot)).toHaveLength(2);
        expect(filterOpenThreads(snapshot, { audit: true })).toHaveLength(3);
        expect(snapshot.rows.find(row => row.event === stale).view.inactiveLinks[0].reason).toBe('digest_mismatch');
    });
    it('sorts by story chronology with importance ties; labels approximate positions and ingestion fallback', () => {
        const snapshot = buildOpenThreadSnapshot(archive([
            event('new', { DateTime: '2000-01-03' }), event('low', { DateTime: '2000-01-01' }),
            event('high', { DateTime: '2000-01-01', importance: 9 }), event('undated', { source_window_end: 4 }),
            event('ingested', { source_window_end: null, created_at: '2026-01-01' }),
        ]));
        expect(snapshot.rows.map(row => row.event.event_id)).toEqual(['high', 'low', 'new', 'undated', 'ingested']);
        expect(snapshot.rows[0].age).toContain('2 story days old');
        expect(snapshot.rows[3].age).toContain('Approximate');
        expect(snapshot.rows[4].age).toContain('Ingested');
    });
    it('filters by aliases, collection identity and importance', () => {
        const snapshot = buildOpenThreadSnapshot([...archive([event('short'), event('long', { characters: ['Kai Tanaka'], importance: 8 })]),
            { collection: 'b', events: [event('copy')] }]);
        const group = snapshot.groups.find(group => group.collection === 'a' && group.aliases.includes('Kai'));
        expect(filterOpenThreads(snapshot, { group: group.key })).toHaveLength(2);
        expect(filterOpenThreads(snapshot, { group: group.key, importance: 7 }).map(row => row.event.event_id)).toEqual(['long']);
    });
    it('audits valid self closures and reopens links invalidated by resolving-event edits', () => {
        const target = event('issue');
        const resolver = event('resolver', { open_threads: [] });
        resolver.continuity = { v: 1, resolves: [{ event_id: 'issue', threads: 'all',
            threads_digest: threadsDigest(target), resolver_digest: threadsDigest(resolver), status: 'active', origin: 'repair' }] };
        const self = event('self');
        self.continuity = { v: 1, closed_threads: { threads: 'all', threads_digest: threadsDigest(self), status: 'active', origin: 'extraction', how: 'Outcome in this event' } };
        expect(filterOpenThreads(buildOpenThreadSnapshot(archive([target, resolver, self])))).toHaveLength(0);
        resolver.summary = 'Edited evidence';
        const snapshot = buildOpenThreadSnapshot(archive([target, resolver, self]));
        expect(filterOpenThreads(snapshot).map(row => row.event.event_id)).toEqual(['issue']);
        expect(snapshot.rows.find(row => row.event === target).view.inactiveLinks[0].reason).toBe('resolver_digest_mismatch');
        expect(filterOpenThreads(snapshot, { audit: true })).toHaveLength(2);
    });
    it('uses a warm roster without any backend reads and retains locations and keywords', async () => {
        invalidateCharacterIndex('warm-threads');
        const backend = { listChunks: vi.fn(async () => ({ total: 1, items: [{ hash: 'h', metadata: event('a', { locations: ['Port'], keywords: ['debt'] }) }] })) };
        await ensureCharacterIndex('warm-threads', {}, async () => backend);
        backend.listChunks.mockClear();
        const result = await loadOpenThreads(['warm-threads'], {}, ensureCharacterIndex);
        expect(backend.listChunks).not.toHaveBeenCalled();
        expect(result.rows[0].event).toMatchObject({ locations: ['Port'], keywords: ['debt'] });
        invalidateCharacterIndex('warm-threads');
    });
    it('pages a cold metadata scan, rejects oversized scans, and does not cache incomplete results', async () => {
        invalidateCharacterIndex('cold-threads');
        const backend = { listChunks: vi.fn(async (_, __, { offset }) => ({ total: 2,
            items: [{ hash: String(offset), metadata: event(String(offset)) }] })) };
        expect((await ensureCharacterIndex('cold-threads', {}, async () => backend, { maxRecords: 2, pageSize: 1 })).events.size).toBe(2);
        expect(backend.listChunks).toHaveBeenCalledTimes(2);
        invalidateCharacterIndex('cold-threads');
        expect(await ensureCharacterIndex('cold-threads', {}, async () => backend, { maxRecords: 1 })).toBeNull();
        expect((await ensureCharacterIndex('cold-threads', {}, async () => backend)).ready).toBe(true);
        invalidateCharacterIndex('cold-threads');
    });
    it('enforces collection and aggregate ceilings and aborts before another collection', async () => {
        const ensure = vi.fn(async () => ({ ready: true, events: new Map() }));
        await expect(loadOpenThreads(Array.from({ length: 21 }, (_, i) => `${i}`), {}, ensure)).rejects.toThrow('20');
        const controller = new AbortController(); controller.abort();
        await expect(loadOpenThreads(['a'], {}, ensure, controller.signal)).rejects.toThrow();
        expect(ensure).not.toHaveBeenCalled();
        ensure.mockResolvedValue({ ready: true, events: new Map(Array.from({ length: 10001 }, (_, i) => [i, event(`${i}`)])) });
        await expect(loadOpenThreads(['a'], {}, ensure)).rejects.toThrow('10,000');
    });
});