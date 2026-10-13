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