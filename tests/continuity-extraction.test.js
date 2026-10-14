import { describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ complete: vi.fn(), roster: null }));
vi.mock('../core/api-keys.js', () => ({ getOpenRouterApiKey: () => 'key', getCustomApiKey: () => 'key' }));
vi.mock('../core/llm-provider-call.js', async importOriginal => ({ ...(await importOriginal()), postChatCompletion: (...args) => mocks.complete(...args) }));
vi.mock('../core/log.js', () => ({ log: new Proxy({}, { get: () => vi.fn() }) }));
vi.mock('../core/character-roster.js', () => ({ getCharacterRoster: () => mocks.roster, renderKnownCharacters: () => 'Alex' }));
vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} } }));
vi.mock('../core/text-cleaning.js', () => ({ cleanText: text => text }));
import { extractEvents } from '../core/eventbase-extractor.js';
import { threadsDigest } from '../core/continuity.js';

describe('resolution-aware extraction integration', () => {
    it('sends the selected profile, preserves custom precedence, and benchmarks both window sizes', async () => {
        mocks.roster = { ready: false };
        mocks.complete.mockClear();
        mocks.complete.mockResolvedValue({ content: JSON.stringify([{ event_type: 'other', importance: 3, summary: 'Alex prefers unsweetened tea.' }]) });
        const settings = { chat_provider: 'openrouter', chat_model: 'model', eventbase_extraction_profile: 'slice_of_life' };
        const params = { messages: [{ name: 'Alex', mes: 'I prefer tea without sugar.' }], windowStart: 0, windowEnd: 0, settings };
        const events = await extractEvents(params);
        expect(events[0].importance).toBe(3);
        expect(mocks.complete.mock.calls.at(-1)[0].messages[0].content).toContain('FUTURE-CONTINUITY TEST');
        await extractEvents({ ...params, settings: { ...settings, eventbase_custom_prompt: 'CUSTOM {{text}}' } });
        expect(mocks.complete.mock.calls.at(-1)[0].messages[0].content).toContain('CUSTOM Alex:');
        expect(mocks.complete.mock.calls.at(-1)[0].messages[0].content).not.toContain('FUTURE-CONTINUITY TEST');
        const { benchmarkExtractionProfiles } = await import('../diagnostics/extraction-profile-benchmark.js');
        const before = mocks.complete.mock.calls.length;
        const report = await benchmarkExtractionProfiles({ ...settings, eventbase_custom_prompt: 'must not affect benchmark' });
        expect(mocks.complete.mock.calls.length - before).toBe(22);
        expect(report.rows.map(row => [row.windowSize, row.maxEvents, row.calls])).toEqual([[2, 3, 10], [2, 3, 10], [20, 10, 1], [20, 10, 1]]);
        expect(report.comparisons.map(row => row.extraExtracted)).toEqual([0, 0]); // Mock verifies plumbing, not model quality.
    });
    it('runs review cases per profile and skips a whole-case run that would repeat the default window', async () => {
        const { benchmarkExtractionCases } = await import('../diagnostics/extraction-profile-benchmark.js');
        const extract = vi.fn(async ({ messages, settings }) => settings.eventbase_extraction_profile === 'slice_of_life'
            && messages.some(m => m.mes === 'fact') ? [{ event_type: 'other', importance: 4, summary: 'A fact.', open_threads: [] }] : []);
        const cases = [
            { id: 'P', kind: 'positive', messages: ['fact', 'a', 'b'].map(mes => ({ name: 'A', mes })), expect: ['the fact'], mustNot: [] },
            { id: 'N', kind: 'negative', messages: [{ name: 'A', mes: 'filler' }], expect: [], mustNot: ['a preference'] },
        ];
        const report = await benchmarkExtractionCases({ chat_model: 'm', eventbase_custom_prompt: 'ignored' }, cases, { extract });
        expect(report.calls).toBe(8);
        expect(report.rows.map(row => [row.id, row.config, row.profile, row.calls, row.verdict])).toEqual([
            ['P', 'default', 'story', 2, 'check: nothing stored'],
            ['P', 'default', 'slice_of_life', 2, 'review'],
            ['P', 'whole', 'story', 1, 'check: nothing stored'],
            ['P', 'whole', 'slice_of_life', 1, 'review'],
            ['N', 'default', 'story', 1, 'pass'],
            ['N', 'default', 'slice_of_life', 1, 'pass'],
        ]);
        expect(extract.mock.calls.every(([args]) => args.settings.eventbase_custom_prompt === '' && !args.collectionIds.length)).toBe(true);
        expect(report.reviewText).toContain('== N (negative) ==\nExpect: -\nMust not: a preference');
        expect(report.reviewText).toContain('   [other 4] A fact.');
    });
    it('uses window refs and attaches active continuity without changing embed fields', async () => {
        const conflict = { event_id: 'old', summary: 'Alex threatens to leave.', event_type: 'relationship_change', importance: 7,
            characters: ['Alex'], open_threads: ['Will Alex stay?'], source_window_end: 10 };
        mocks.roster = { ready: true, events: [conflict], groups: [{ name: 'Alex', aliases: [], isLead: true, eventIds: new Set(['old']) }] };
        mocks.complete.mockResolvedValue({ content: JSON.stringify([{ event_type: 'relationship_change', importance: 7,
            summary: 'Alex stays after an apology.', open_threads: [], resolves: [{ ref: 'I1', threads: [0], how: 'Alex stays.' }] }]) });
        const params = { messages: [{ name: 'Alex', mes: 'Alex accepts the apology and agrees to stay.' }], windowStart: 40, windowEnd: 40,
            collectionIds: ['chat'], settings: { chat_provider: 'openrouter', chat_model: 'model' } };
        const events = await extractEvents(params);
        expect(mocks.complete.mock.calls.at(-1)[0].messages[0].content).toContain('I1: [message 10, importance 7]');
        expect(events[0].continuity.resolves[0]).toMatchObject({ event_id: 'old', threads: [0], threads_digest: threadsDigest(conflict), status: 'active' });
        expect(events[0].resolves).toBeUndefined();
        const custom = await extractEvents({ ...params, settings: { ...params.settings, eventbase_custom_prompt: '{{text}}' } });
        expect(custom[0].continuity).toBeUndefined();
        expect(mocks.complete.mock.calls.at(-1)[0].messages[0].content).not.toContain('I1:');
        mocks.roster.continuitySupported = false;
        const unsupported = await extractEvents(params);
        expect(unsupported[0].continuity).toBeUndefined();
    });
});