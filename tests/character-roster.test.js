import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    buildCharacterRoster, ensureCharacterIndex, getCharacterRoster,
    invalidateCharacterIndex, upsertCharacterEvents, pruneCharacterEvents,
    renderKnownCharacters, normalizeCharacterName, getIgnoredCharacterTags,
} from '../core/character-roster.js';
import { buildExtractionPrompt, buildEmbedText } from '../core/eventbase-schema.js';

vi.mock('../core/log.js', () => ({ log: { warn: vi.fn() } }));

const event = (id, characters, extra = {}) => ({ event_id: id, characters, summary: `Summary ${id}`, source_window_end: Number(id.replace(/\D/g, '')) || 0, ...extra });
const item = (id, characters, extra = {}) => {
    const e = event(id, characters, extra);
    return { hash: id, text: buildEmbedText(e), metadata: e };
};
const group = (roster, name) => roster.groups.find(g => g.name === name);

describe('character alias grouping', () => {
    it('combines Ezra and Ezra Blackwell automatically when the longer name is unique', () => {
        const roster = buildCharacterRoster([event('1', ['Ezra']), event('2', ['Ezra Blackwell']), event('3', ['Ezra', 'Ezra Blackwell'])]);
        expect(roster.groups).toHaveLength(1);
        expect(roster.groups[0]).toMatchObject({ name: 'Ezra Blackwell', aliases: ['Ezra', 'Ezra Blackwell'], eventCount: 3 });
    });

    it('groups a unique shorter name after stripping honorifics', () => {
        const roster = buildCharacterRoster([event('1', ['Brennan']), event('2', ['Dr. Howard Brennan'])]);
        expect(roster.groups).toHaveLength(1);
        expect(roster.groups[0].aliases).toEqual(['Brennan', 'Dr. Howard Brennan']);
        expect(normalizeCharacterName('  Dr.  Howard Brennan ')).toBe('howard brennan');
    });

    it('keeps a shared surname ambiguous and separate', () => {
        const roster = buildCharacterRoster([event('1', ['Brennan', 'Howard Brennan', 'Mary Brennan'])]);
        expect(roster.groups).toHaveLength(3);
        expect(group(roster, 'Brennan').ambiguous).toBe(true);
    });

    it('does not merge CJK names or substring matches', () => {
        const roster = buildCharacterRoster([event('1', ['田中', '田中 太郎', 'Ann', 'Joanne Smith'])]);
        expect(roster.groups).toHaveLength(4);
    });

    it('counts events once across lead spellings, with strict threshold and minimum', () => {
        const events = Array.from({ length: 20 }, (_, i) => event(String(i), i < 6 ? (i === 0 ? ['Kai', 'Kai Tanaka'] : [i % 2 ? 'Kai' : 'Kai Tanaka']) : ['Other']));
        const kai = group(buildCharacterRoster(events), 'Kai Tanaka');
        expect(kai.eventCount).toBe(6);
        expect(kai.share).toBe(0.3);
        expect(kai.isLead).toBe(true);
        expect(group(buildCharacterRoster(events.slice(0, 5)), 'Kai Tanaka').isLead).toBe(false);
        expect(group(buildCharacterRoster(events, [], { eventbase_lead_share_threshold: 0.3 }), 'Kai Tanaka').isLead).toBe(false);
    });

    it('manual merges, splits and renames override automatic grouping without rewriting events', () => {
        const events = [event('1', ['Howard Brennan', 'Brennan', 'Mary Brennan'])];
        const before = JSON.stringify(events);
        const split = buildCharacterRoster(events, [{ name: 'Howard', aliases: ['Howard Brennan'] }, { name: 'Surname only', aliases: ['Brennan'] }]);
        expect(split.groups).toHaveLength(3);
        expect(group(split, 'Howard').aliases).toEqual(['Howard Brennan']);
        const merged = buildCharacterRoster(events, [{ name: 'Lawyer', aliases: ['Howard Brennan', 'Brennan'] }]);
        expect(group(merged, 'Lawyer').eventCount).toBe(1);
        expect(merged.groups).toHaveLength(2);
        expect(JSON.stringify(events)).toBe(before);
    });

    it('does not auto-attach a shorter spelling to an explicitly isolated long name', () => {
        const roster = buildCharacterRoster([event('1', ['Kai', 'Kai Tanaka'])], [{ name: 'Kai Tanaka', aliases: ['Kai Tanaka'] }]);
        expect(roster.groups).toHaveLength(2);
    });

    it('persists explicit splits of honorific and case variants by raw spelling', () => {
        const events = [event('1', ['Kai']), event('2', ['Dr. Kai']), event('3', ['KAI', 'Kai'])];
        expect(buildCharacterRoster(events).groups).toHaveLength(1);
        const overrides = ['Kai', 'Dr. Kai', 'KAI'].map(alias => ({ name: alias, aliases: [alias] }));
        const roster = buildCharacterRoster(events, JSON.parse(JSON.stringify(overrides)));
        expect(roster.groups).toHaveLength(3);
        expect(group(roster, 'Kai').eventCount).toBe(2);
        expect(group(roster, 'Dr. Kai').eventCount).toBe(1);
        expect(group(roster, 'KAI').eventCount).toBe(1);
        for (const g of roster.groups) expect(g.aliases).toEqual([g.name]);
        expect(buildCharacterRoster(events, [{ name: 'Merged', aliases: overrides.map(o => o.name) }]).groups).toHaveLength(1);
    });

    it('does not absorb an unselected normalized spelling into a manual group', () => {
        const roster = buildCharacterRoster([event('1', ['Kai', 'Dr. Kai'])], [{ name: 'Doctor', aliases: ['Dr. Kai'] }]);
        expect(roster.groups).toHaveLength(2);
        expect(group(roster, 'Doctor').aliases).toEqual(['Dr. Kai']);
        expect(group(roster, 'Kai').aliases).toEqual(['Kai']);
    });
});

describe('collection event index', () => {
    beforeEach(() => {
        for (const id of ['one', 'two', 'three']) invalidateCharacterIndex(id);
    });

    it('handles capped pages, coalesces builds and routes prefixed IDs to a bare collection ID', async () => {
        const first = Array.from({ length: 500 }, (_, i) => item(String(i), ['Brennan']));
        const listChunks = vi.fn().mockResolvedValueOnce({ items: first, total: 501 }).mockResolvedValueOnce({ items: [item('500', ['Howard Brennan'])], total: 501 });
        const loader = vi.fn(async () => ({ listChunks }));
        const promise = ensureCharacterIndex('qdrant:one', {}, loader);
        expect(ensureCharacterIndex('one', {}, loader)).toBe(promise);
        expect(getCharacterRoster(['one']).ready).toBe(false);
        await promise;
        expect(loader).toHaveBeenCalledTimes(1);
        expect(listChunks.mock.calls.map(c => [c[0], c[2].offset])).toEqual([['one', 0], ['one', 500]]);
        expect(getCharacterRoster(['one']).totalEvents).toBe(501);
    });

    it('continues through backend-capped short pages when total says there is more', async () => {
        const listChunks = vi.fn().mockResolvedValueOnce({ items: [item('1', ['Kai'])], total: 2 }).mockResolvedValueOnce({ items: [item('2', ['Kai Tanaka'])], total: 2 });
        await ensureCharacterIndex('one', {}, async () => ({ listChunks }));
        expect(listChunks.mock.calls[1][2].offset).toBe(1);
        expect(getCharacterRoster(['one']).totalEvents).toBe(2);
    });

    it('requests a full listing once instead of repeating collection-wide scans', async () => {
        const items = Array.from({ length: 5000 }, (_, i) => item(String(i), ['Kai']));
        const listChunks = vi.fn(async (_id, _settings, { offset, limit }) => ({ items: items.slice(offset, offset + limit), total: items.length }));
        await ensureCharacterIndex('one', {}, async () => ({ listChunks }));
        expect(listChunks).toHaveBeenCalledTimes(1);
        expect(getCharacterRoster(['one']).totalEvents).toBe(5000);
    });

    it('restarts a capped scan when deletion shifts an untouched event behind the offset', async () => {
        let items = Array.from({ length: 501 }, (_, i) => item(String(i), ['Kai']));
        let resolve;
        const listChunks = vi.fn(async (_id, _settings, { offset }) => {
            if (listChunks.mock.calls.length === 2) return new Promise(r => { resolve = r; });
            return { items: items.slice(offset, offset + 500), total: items.length };
        });
        const build = ensureCharacterIndex('one', {}, async () => ({ listChunks }));
        await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
        items = items.slice(1);
        pruneCharacterEvents('one', ['0']);
        resolve({ items: items.slice(500), total: items.length });
        await build;
        expect(listChunks.mock.calls.map(c => c[2].offset)).toEqual([0, 500, 0]);
        const roster = getCharacterRoster(['one']);
        expect(roster.totalEvents).toBe(500);
        expect(roster.events.some(e => e.event_id === '500')).toBe(true);
        expect(roster.events.some(e => e.event_id === '0')).toBe(false);
    });

    it('leaves hashes-only fallback builds retryable after connectivity recovers', async () => {
        const listChunks = vi.fn()
            .mockResolvedValueOnce({ items: [{ hash: '1', text: '', metadata: {} }], total: 1 })
            .mockResolvedValueOnce({ items: [item('1', ['Kai'])], total: 1 });
        const loader = async () => ({ listChunks });
        expect(await ensureCharacterIndex('one', {}, loader)).toBeNull();
        expect(getCharacterRoster(['one']).ready).toBe(false);
        await ensureCharacterIndex('one', {}, loader);
        expect(listChunks).toHaveBeenCalledTimes(2);
        expect(getCharacterRoster(['one']).totalEvents).toBe(1);
        expect(getCharacterRoster(['one']).ready).toBe(true);
    });

    it('unions current locks, deduplicates overlapping event IDs and includes archive aliases', async () => {
        await ensureCharacterIndex('one', {}, async () => ({ listChunks: async () => ({ items: [item('1', ['Kai']), item('2', ['Brennan'])] }) }));
        await ensureCharacterIndex('two', {}, async () => ({ listChunks: async () => ({ items: [item('1', ['Kai']), item('3', ['Howard Brennan'])] }) }));
        const settings = { eventbase_character_alias_overrides: { two: [{ name: 'Lawyer', aliases: ['Brennan', 'Howard Brennan'] }] } };
        const union = getCharacterRoster(['one', 'qdrant:two'], settings);
        expect(union.totalEvents).toBe(3);
        expect(group(union, 'Lawyer').eventCount).toBe(2);
        expect(getCharacterRoster(['one']).totalEvents).toBe(2);
        expect(getCharacterRoster(['two']).totalEvents).toBe(2);
    });

    it('applies inserts and deletes during an in-flight build after the snapshot', async () => {
        let resolve;
        const response = new Promise(r => { resolve = r; });
        const build = ensureCharacterIndex('one', {}, async () => ({ listChunks: () => response }));
        upsertCharacterEvents('one', [item('1', ['New']), item('3', ['Added'])]);
        pruneCharacterEvents('one', ['2']);
        resolve({ items: [item('1', ['Old']), item('2', ['Deleted'])] });
        await build;
        const roster = getCharacterRoster(['one']);
        expect(roster.events.map(e => e.event_id).sort()).toEqual(['1', '3']);
        expect(roster.groups.map(g => g.name)).not.toContain('Old');
        pruneCharacterEvents('one', ['1']);
        expect(getCharacterRoster(['one']).totalEvents).toBe(1);
    });

    it('cannot revive an invalidated build and retries failed builds', async () => {
        let resolve;
        const build = ensureCharacterIndex('one', {}, async () => ({ listChunks: () => new Promise(r => { resolve = r; }) }));
        await Promise.resolve();
        invalidateCharacterIndex('one');
        resolve({ items: [item('1', ['Stale'])] });
        expect(await build).toBeNull();
        expect(getCharacterRoster(['one']).ready).toBe(false);
        await ensureCharacterIndex('one', {}, async () => ({ listChunks: async () => { throw new Error('offline'); } }));
        await ensureCharacterIndex('one', {}, async () => ({ listChunks: async () => ({ items: [] }) }));
        expect(getCharacterRoster(['one']).ready).toBe(true);
    });

    it('keeps only slim fields and recovers summaries from embed text', async () => {
        const e = item('1', ['Kai'], { DateTime: 'June 3', scene_time: '10:00', importance: 4, should_persist: true, event_type: 'other', heavy: 'omit' });
        delete e.metadata.summary;
        await ensureCharacterIndex('one', {}, async () => ({ listChunks: async () => ({ items: [e] }) }));
        const indexed = getCharacterRoster(['one']).events[0];
        expect(indexed.summary).toBe('Summary 1');
        expect(indexed.heavy).toBeUndefined();
        expect(indexed.scene_time).toBe('10:00');
    });

    it('ignores junk in the roster and extraction hints without changing events or their total', async () => {
        const junk = ['physics-ugrad-advising', 'nurse, the waitress'];
        const items = [item('1', ['Ezra', ...junk]), item('2', ['Ezra Blackwell']), item('3', junk)];
        const original = JSON.stringify(items);
        const listChunks = vi.fn(async () => ({ items }));
        await ensureCharacterIndex('one', {}, async () => ({ listChunks }));
        const settings = { eventbase_character_ignored_tags: { one: junk }, eventbase_lead_min_events: 3 };
        const roster = getCharacterRoster(['one'], settings);
        expect(roster.totalEvents).toBe(3);
        expect(roster.groups).toHaveLength(1);
        expect(group(roster, 'Ezra Blackwell')).toMatchObject({ eventCount: 2, share: 2 / 3, isLead: true });
        expect(renderKnownCharacters(roster)).toBe('Ezra Blackwell (also: Ezra)');
        expect(roster.events.find(e => e.event_id === '1').characters).toEqual(['Ezra', ...junk]);
        expect(getCharacterRoster(['one']).groups.map(g => g.name)).toEqual(expect.arrayContaining(junk));
        expect(JSON.stringify(items)).toBe(original);
        expect(listChunks).toHaveBeenCalledTimes(1);
    });

    it('restores ignored manual aliases and names losslessly from persisted settings', async () => {
        await ensureCharacterIndex('one', {}, async () => ({ listChunks: async () => ({ items: [item('1', ['Ezra']), item('2', ['Ezra Blackwell'])] }) }));
        const settings = JSON.parse(JSON.stringify({
            eventbase_character_alias_overrides: { one: [{ name: 'Ezra B.', aliases: ['Ezra', 'Ezra Blackwell'] }] },
            eventbase_character_ignored_tags: { one: ['Ezra', 'Ezra Blackwell'] },
        }));
        expect(getCharacterRoster(['one'], settings).groups).toHaveLength(0);
        settings.eventbase_character_ignored_tags.one = ['Ezra'];
        expect(getCharacterRoster(['one'], settings).groups[0]).toMatchObject({ name: 'Ezra B.', aliases: ['Ezra Blackwell'], eventCount: 1 });
        settings.eventbase_character_ignored_tags.one = [];
        expect(getCharacterRoster(['one'], settings).groups[0]).toMatchObject({ name: 'Ezra B.', aliases: ['Ezra', 'Ezra Blackwell'], eventCount: 2 });
    });

    it('keeps ignored tags excluded after later inserts and restores them without reloading', async () => {
        const listChunks = vi.fn(async () => ({ items: [item('1', ['the nurse'])] }));
        await ensureCharacterIndex('one', {}, async () => ({ listChunks }));
        const settings = { eventbase_character_ignored_tags: { one: ['the nurse'] } };
        upsertCharacterEvents('one', [item('2', ['the nurse', 'Ezra'])]);
        expect(getCharacterRoster(['one'], settings).groups.map(g => g.name)).toEqual(['Ezra']);
        settings.eventbase_character_ignored_tags.one = [];
        expect(group(getCharacterRoster(['one'], settings), 'the nurse').eventCount).toBe(2);
        expect(listChunks).toHaveBeenCalledTimes(1);
    });

    it('scopes ignores to each collection even when locked collections share an event ID', async () => {
        const items = [item('1', ['Ezra', 'the nurse'])];
        for (const id of ['one', 'two']) await ensureCharacterIndex(id, {}, async () => ({ listChunks: async () => ({ items }) }));
        const settings = { eventbase_character_ignored_tags: { one: ['the nurse'] } };
        expect(group(getCharacterRoster(['one'], settings), 'the nurse')).toBeUndefined();
        expect(group(getCharacterRoster(['qdrant:one', 'two'], settings), 'the nurse').eventCount).toBe(1);
        settings.eventbase_character_ignored_tags.two = ['the nurse'];
        const union = getCharacterRoster(['one', 'two'], settings);
        expect(union.totalEvents).toBe(1);
        expect(union.groups.map(g => g.name)).toEqual(['Ezra']);
    });

    it('ignores exact spellings without suppressing normalized name variants', async () => {
        await ensureCharacterIndex('one', {}, async () => ({ listChunks: async () => ({ items: [item('1', ['Kai', 'Dr. Kai', 'KAI'])] }) }));
        const settings = { eventbase_character_ignored_tags: { one: ['Kai', 'Kai', '', null] } };
        expect(getIgnoredCharacterTags('qdrant:one', settings)).toEqual(['Kai']);
        expect(getCharacterRoster(['one'], settings).groups[0].aliases).toEqual(['Dr. Kai', 'KAI']);
        expect(getIgnoredCharacterTags('two', settings)).toEqual([]);
    });
});

describe('known characters extraction placeholder', () => {
    it('renders grouped spellings ordered by count then recency and bounds size', () => {
        const roster = buildCharacterRoster([event('1', ['Brennan']), event('2', ['Howard Brennan']), event('3', ['Kai'])]);
        expect(renderKnownCharacters(roster)).toBe('Howard Brennan (also: Brennan)\nKai');
        expect(renderKnownCharacters(roster, { eventbase_known_characters_limit: 1 })).toBe('Howard Brennan (also: Brennan)');
        expect(renderKnownCharacters(roster, { eventbase_known_characters_max_chars: 5 })).toBe('Kai');
    });

    it('supports built-in prompts in every language and leaves old custom prompts unchanged', () => {
        for (const mode of ['intl', 'jieba', 'jieba_tw', 'tiny_segmenter', 'korean', 'others']) {
            expect(buildExtractionPrompt('excerpt', 5, '', mode, 'Howard Brennan (also: Brennan)')).toContain('Howard Brennan (also: Brennan)');
        }
        expect(buildExtractionPrompt('excerpt', 5, '{{text}} / {{maxCount}}', 'intl', 'Kai')).toBe('excerpt / 5');
        expect(buildExtractionPrompt('Price $& {{knownCharacters}}', 5, '{{knownCharacters}} / {{text}}', 'intl', 'Kai $&')).toBe('Kai $& / Price $& {{knownCharacters}}');
    });
});
