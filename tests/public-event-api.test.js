import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} } }));
vi.mock('../../../../utils.js', () => ({ uuidv4: () => 'test' }));
vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../../../../openai.js', () => ({ oai_settings: {} }));
vi.mock('../core/providers.js', () => ({ getModelFromSettings: () => 'test-model', resolveProviderApiUrl: () => '' }));
import { StandardBackend } from '../backends/standard.js';
import { createPublicEventAPI } from '../core/public-event-api.js';
import { threadsDigest } from '../core/continuity.js';
import { askStory } from '../core/story-research.js';
import { captureEventSources, legacySourceHash, narrativeFingerprint, resolveEventSources } from '../core/event-sources.js';

const message = (mes, id = 'a') => ({ name: 'Alex', mes, id, extra: { mesid: id, mwt_uuid: 'private' } });
const collection = { collectionId: 'events', registryKey: 'qdrant:events' };
const event = (event_id, fields = {}) => ({ event_id, source_chat_id: 'chat', summary: event_id,
    characters: ['Alex', 'Ranger'], event_type: 'dialogue_significant', source_window_start: 0, ...fields });
function fixture(records = [], querySemantic) {
    const state = { ready: true, enabled: true, chatId: 'chat', chat: [message('hello')], chatMetadata: {},
        settings: {}, collections: [collection], availableCollections: [collection] };
    const backend = { listChunks: vi.fn(async () => ({ items: records.map(metadata => ({ metadata })), total: records.length })) };
    const api = createPublicEventAPI({ readState: () => state, loadBackend: async () => backend, querySemantic });
    return { state, backend, api };
}
async function refs(messages) {
    return (await captureEventSources(messages, 0)).map(source => ({ ...source, stored_fingerprint: source.fingerprint, source_chat_id: 'chat' }));
}
const resolve = (references, chat, chatMetadata = {}) => resolveEventSources(references, { chatId: 'chat', chat, chatMetadata });
afterEach(() => vi.unstubAllGlobals());

describe('caller-asserted aliases and stock source edits', () => {
    it('unions separate roster groups for a subject across history and candidate windows', async () => {
        const { api } = fixture([event('full', { characters: ['Seraphine'], source_message_ids: [0] }),
            event('short', { characters: ['Sera'], source_message_ids: [0] })]);
        const subjects = [{ name: 'Seraphine', aliases: ['Sera'] }];
        const history = await api.findEvents({ subjects });
        expect(history.ok).toBe(true);
        expect(history.events.map(e => e.event_id)).toEqual(['full', 'short']);
        expect((await api.findCandidateWindows({ subjects })).ok).toBe(true);
    });
    it('flags a dated stock narrative edit without returning it as usable evidence', async () => {
        const original = { name: 'Alex', mes: 'Original.', send_date: '2026-01-01' };
        const references = await refs([original]);
        const [changed] = await resolve(references, [{ ...original, mes: 'Rewritten.' }]);
        expect(changed).toMatchObject({ status: 'changed', reason: 'narrative_changed', message: null });
        expect((await resolve(references, [{ ...original, mes: 'Other.', send_date: '2026-01-02' }]))[0].status).toBe('unresolved');
    });
});

describe('Phase 2 candidate-window API', () => {
    it('preserves earlier candidate pages when archive references exceed the cache', async () => {
        const originals = Array.from({ length: 20 }, (_, index) => message(`Source ${index}`, `id:${index}`));
        const stored = await captureEventSources(originals, 0);
        const records = Array.from({ length: 2010 }, (_, index) => event(`e${index}`, {
            source_window_start: 0, source_messages: stored,
        }));
        const f = fixture(records);
        f.state.chat = originals;
        f.backend.listChunks.mockImplementation(async (_id, _settings, { offset, limit }) => ({
            items: records.slice(offset, offset + limit).map(metadata => ({ metadata })), total: records.length,
        }));
        const first = await f.api.findCandidateWindows({ max_windows: 1 });
        expect(first.ok).toBe(true);
        const retained = first.windows.flatMap(window => window.source_refs);
        const second = await f.api.findCandidateWindows({ max_windows: 1, offset: 1,
            scope_token: first.scope_token, retain_sources: retained });
        expect(second.ok).toBe(true);
        const resolved = await f.api.resolveSources({ scope_token: first.scope_token, sources: retained });
        expect(resolved.ok).toBe(true);
        expect(resolved.sources.every(source => source.status === 'verified')).toBe(true);
        expect((await f.api.findCandidateWindows({ retain_sources: ['forged'] })).error.code).toBe('invalid_reference');
        expect((await f.api.findCandidateWindows({ retain_sources: Array(121).fill(retained[0]) })).error.code).toBe('invalid_request');
    });
    it('finds validated off-screen acquisition recipients without inferring acquisitions from characters', async () => {
        const knowledge = { v: 1, presence: [], acquisitions: [{ character: 'Ranger', claim: 'A delivery occurred.',
            basis: 'document', epistemic_status: 'fact', uncertainty: '',
            evidence: [{ source_index: 0, quote: 'Ranger read the report.' }] }] };
        const f = fixture([event('offscreen', { characters: ['Alex'], knowledge, source_message_ids: [0] }),
            event('invalid', { characters: ['Alex'], knowledge: { ...knowledge, v: 2 } })]);
        const result = await f.api.findEvents({ subjects: [{ name: 'Ranger' }] });
        expect(result.events.map(event => event.event_id)).toEqual(['offscreen']);
        expect(result.events[0].characters).toEqual(['Alex']);
    });
    it('exposes cleaned evidence separately from the fingerprint-verified raw original', async () => {
        const originals = [message('<b>Alex</b> delivered a letter.')];
        const f = fixture([event('cleaned', { source_messages: await captureEventSources(originals, 0) })]);
        f.state.chat = originals;
        const found = await f.api.findEvents();
        const resolved = await f.api.resolveSources({ scope_token: found.scope_token, sources: found.events[0].source_refs });
        expect(resolved.sources[0]).toMatchObject({ status: 'verified',
            evidence_narrative: { version: 1, text: 'Alex delivered a letter.' },
            message: { mes: '<b>Alex</b> delivered a letter.' } });
    });
    it('paginates independent scenes with scope-bound offsets', async () => {
        const originals = Array.from({ length: 8 }, (_, index) => message(`Scene ${index}`, `id:${index}`));
        const stored = await captureEventSources(originals, 0);
        const f = fixture(stored.map((source, index) => event(`e${index}`, {
            source_window_start: index, source_messages: [source] })));
        f.state.chat = originals;
        const first = await f.api.findCandidateWindows();
        const second = await f.api.findCandidateWindows({ scope_token: first.scope_token, offset: first.next_offset });
        expect(first.windows.flatMap(window => window.event_refs)).toHaveLength(4);
        expect(new Set([...first.windows, ...second.windows].flatMap(window => window.event_refs)).size).toBe(8);
        expect(second.next_offset).toBeNull();
        expect((await f.api.findCandidateWindows({ offset: -1 })).error.code).toBe('invalid_request');
    });
    it('keeps scenes beyond the public 500-event history sample eligible', async () => {
        const f = fixture(Array.from({ length: 504 }, (_, index) => event(`e${index}`, {
            source_window_start: index, source_message_ids: [index],
        })));
        const result = await f.api.findCandidateWindows({ offset: 500 });
        expect(result.ok).toBe(true);
        expect(result.windows).toHaveLength(4);
        expect(result.next_offset).toBeNull();
        expect(result.coverage.returned_count).toBe(504);
    });
    it('publishes validated acquisition citations as resolvable scope-bound references', async () => {
        const originals = [message('Ranger watched the delivery.')];
        const knowledge = { v: 1, presence: [], acquisitions: [{ character: 'Ranger', claim: 'A delivery occurred.',
            basis: 'witnessed', epistemic_status: 'fact', uncertainty: '',
            evidence: [{ source_index: 0, quote: 'Ranger watched the delivery.' }] }] };
        const f = fixture([event('delivery', { knowledge, source_messages: await captureEventSources(originals, 0) }),
            event('legacy'), event('bad', { knowledge: { ...knowledge, v: 2 } })]);
        f.state.chat = originals;
        expect(f.api.getStatus().capabilities.knowledge_acquisition).toMatchObject({ available: true, schema_version: 1 });
        const found = await f.api.findEvents();
        const [recorded, legacy, bad] = found.events;
        expect(recorded.knowledge_status).toBe('recorded');
        const ref = recorded.knowledge.acquisitions[0].evidence[0].source_ref;
        expect(ref).toBe(recorded.source_refs[0].ref);
        expect((await f.api.resolveSources({ scope_token: found.scope_token, sources: [ref] })).sources[0].status).toBe('verified');
        expect(legacy).toMatchObject({ knowledge_status: 'unknown', knowledge: null });
        expect(bad).toMatchObject({ knowledge_status: 'invalid', knowledge: null });
        recorded.knowledge.acquisitions[0].claim = 'MUTATED';
        expect((await f.api.findEvents()).events[0].knowledge.acquisitions[0].claim).toBe('A delivery occurred.');
    });
    it('returns scoped ranked scene handles and verified source availability without generation', async () => {
        const originals = [message('Alex keeps the promise.'), message('Ranger thanks Alex.', 'b')];
        const stored = await captureEventSources(originals, 0);
        const f = fixture([event('scene-a', { source_messages: stored }),
            event('scene-b', { source_messages: stored })]);
        f.state.chat = originals;
        expect(f.api.getStatus().capabilities.candidate_windows.available).toBe(true);
        const result = await f.api.findCandidateWindows({ subjects: [{ name: 'Alex' }],
            scope_token: f.api.getStatus().scope_token, max_windows: 4 });
        expect(result.ok).toBe(true);
        expect(result.windows).toHaveLength(1);
        expect(result.windows[0]).toMatchObject({ availability: 'verified', available_sources: 2,
            scope_token: result.scope_token });
        expect(result.windows[0].event_refs).toHaveLength(2);
        expect(result.windows[0].source_refs).toHaveLength(2);
        expect(result.windows[0].window_ref).toBeTruthy();
        expect(result.windows[0].ranking.score).toBeGreaterThan(0);
    });
    it('rejects cross-chat selection, excessive budgets and stale scopes', async () => {
        const f = fixture();
        expect((await f.api.findCandidateWindows({ scope: { kind: 'selected_collections' } })).error.code).toBe('invalid_request');
        expect((await f.api.findCandidateWindows({ max_windows: 5 })).error.code).toBe('invalid_request');
        const token = f.api.getStatus().scope_token;
        f.api.invalidate();
        expect((await f.api.findCandidateWindows({ scope_token: token })).error.code).toBe('stale_scope');
    });
});

describe('Scope exclusion coverage', () => {
    it('distinguishes excluded unknown and other-chat entries from included archive entries', async () => {
        const { api } = fixture([event('local'), event('unknown', { source_chat_id: null }), event('other', { source_chat_id: 'other' })]);
        const current = await api.findEvents();
        expect(current.coverage.exclusions).toEqual([
            { reason: 'unknown_source_chat', count: 1 }, { reason: 'other_source_chat', count: 1 } ]);
        expect(current.coverage.unknown_source_chat_included_count).toBe(0);
        const archive = await api.findEvents({ scope: { kind: 'selected_collections', collections: ['qdrant:events'] } });
        expect(archive.coverage.exclusions).toEqual([]);
        expect(archive.coverage.unknown_source_chat_included_count).toBe(1);
    });
});

describe('Phase 0 source resolution', () => {
    it.each([0, 1])('does not verify a deleted dated duplicate against its survivor (%i)', async deleted => {
        const messages = ['2026-01-01', '2026-01-02'].map(send_date => ({ name: 'Alex', mes: 'same', send_date }));
        const stored = await captureEventSources(messages, 0);
        const f = fixture([event('duplicates', { source_messages: stored })]);
        f.state.chat = messages.filter((_, i) => i !== deleted);
        const history = await f.api.findEvents();
        const result = await f.api.resolveSources({ sources: history.events[0].source_refs, scope_token: history.scope_token });
        expect(result.sources[deleted]).toMatchObject({ status: 'unresolved', message: null });
        expect(result.sources[1 - deleted]).toMatchObject({ status: 'verified', message: { send_date: messages[1 - deleted].send_date } });
    });
    it('keeps undated legacy and same-date duplicates unresolved without host IDs', async () => {
        const original = { name: 'Alex', mes: 'same', send_date: '2026-01-01' };
        const references = await refs([original]);
        expect((await resolve(references, [original, { ...original }]))[0]).toMatchObject({ status: 'unresolved', reason: 'ambiguous_duplicate', message: null });
        delete references[0].send_date;
        expect((await resolve(references, [original]))[0]).toMatchObject({ status: 'unresolved', message: null });
    });
    it.each([undefined, {}, { subtle: { digest: async () => { throw new Error('unavailable'); } } }])(
        'degrades safely when hashing is unavailable (%j)', async crypto => {
            const original = message('hello');
            const references = await refs([original]);
            vi.stubGlobal('crypto', crypto);
            expect(await narrativeFingerprint(original)).toBeNull();
            expect((await captureEventSources([original], 0))[0].fingerprint).toBeNull();
            expect((await resolve(references, [original]))[0]).toMatchObject({
                status: 'unresolved', reason: 'fingerprinting_unavailable', message: null,
            });
            expect((await resolve(references, [message('edited')]))[0].status).toBe('changed');
        });
    it('fingerprints normalized narrative with SHA-256, excluding engine blocks', async () => {
        expect(await narrativeFingerprint(message('hello <combat_log>x</combat_log>'))).toBe(await narrativeFingerprint(message('hello')));
        expect(await narrativeFingerprint(message('hello'))).toMatch(/^sha256-narrative-v1:[a-f0-9]{64}$/);
    });
    it('resolves live messages after positions shift and exposes only public fields', async () => {
        const original = message('hello');
        const result = await resolve(await refs([original]), [message('earlier', 'b'), original]);
        expect(result[0]).toMatchObject({ status: 'verified', expanded_index: 1, visible_index: 1, recovered_ils: false });
        expect(result[0].message.extra).toEqual({ mesid: 'a' });
    });
    it('distinguishes several nested ILS leaves beneath one visible container', async () => {
        const originals = [message('first'), message('second', 'b')];
        const nested = { mes: 'nested', extra: { ILS_Data: { Ref: 'originals' } } };
        const summary = { mes: 'summary', extra: { ILS_Data: { OriginalMessages: [nested] } } };
        const result = await resolve(await refs(originals), [summary], { ILS_Originals: { originals } });
        expect(result.map(r => r.status)).toEqual(['verified', 'verified']);
        expect(result.map(r => r.visible_index)).toEqual([0, 0]);
        expect(result.map(r => r.expanded_index)).toEqual([0, 1]);
        expect(result.every(r => r.recovered_ils)).toBe(true);
    });
    it.each(['edited', 'swiped'])('reports a %s message as changed', async text => {
        const result = await resolve(await refs([message('original')]), [message(text)]);
        expect(result[0]).toMatchObject({ status: 'changed', reason: 'narrative_changed' });
    });
    it('reports tracker-only edits as changed despite the same narrative fingerprint', async () => {
        const result = await resolve(await refs([message('hello<combat_log>old</combat_log>')]), [message('hello<combat_log>new</combat_log>')]);
        expect(result[0]).toMatchObject({ status: 'changed', reason: 'raw_content_changed' });
        expect(result[0].current_fingerprint).toBe(result[0].stored_fingerprint);
    });
    it('keeps stored extraction hashes separate from versioned raw-content hashes', async () => {
        const original = { ...message('hello<combat_log>old</combat_log>'), hash: 12345 };
        const references = await refs([original]);
        expect(references[0]).toMatchObject({ legacy_hash: 12345, raw_content_hash: expect.stringMatching(/^djb2-raw-v1:/) });
        expect((await resolve(references, [original]))[0]).toMatchObject({ status: 'verified', reason: null });
        expect((await resolve(references, [{ ...original, hash: 67890 }]))[0].status).toBe('verified');
        const edited = { ...original, mes: 'hello<combat_log>new</combat_log>' };
        expect((await resolve(references, [edited]))[0]).toMatchObject({ status: 'changed', reason: 'raw_content_changed' });
        expect((await resolve(references, [{ ...original, mes: 'different narrative' }]))[0])
            .toMatchObject({ status: 'changed', reason: 'narrative_changed' });
    });
    it('does not treat legacy hashes with unknown conventions as raw edit signals', async () => {
        const original = { ...message('hello'), hash: 12345 };
        const references = await refs([original]);
        delete references[0].raw_content_hash;
        expect((await resolve(references, [original]))[0].status).toBe('verified');
        vi.stubGlobal('crypto', undefined);
        expect((await resolve(references, [original]))[0]).toMatchObject({ status: 'unresolved', message: null });
    });
    it('reports deleted host identities as missing', async () => {
        expect((await resolve(await refs([message('hello')]), []))[0].status).toBe('missing');
    });
    it('does not map missing ILS originals onto a summary', async () => {
        const summary = { mes: 'hello', extra: { ILS_Data: { Ref: 'missing' } } };
        expect((await resolve(await refs([message('hello')]), [summary]))[0].status).toBe('missing');
        const noIdentity = { name: 'Alex', mes: 'hello' };
        const sameTextSummary = { ...noIdentity, extra: { ILS_Data: { Ref: 'missing' } } };
        expect((await resolve(await refs([noIdentity]), [sameTextSummary]))[0].status).toBe('unresolved');
    });
    it('does not resolve other or unknown chats against loaded messages', async () => {
        const reference = (await refs([message('hello')]))[0];
        for (const source_chat_id of ['other', null]) {
            expect((await resolve([{ ...reference, source_chat_id }], [message('hello')]))[0]).toMatchObject({ status: 'unresolved', message: null });
        }
    });
    it('refuses identical duplicates without host identity and legacy hash-only proof', async () => {
        const original = { name: 'Alex', mes: 'same' };
        expect((await resolve(await refs([original]), [original, { ...original }]))[0].reason).toBe('ambiguous_duplicate');
        const result = await resolve([{ source_chat_id: 'chat', expanded_index: 0, legacy_hash: legacySourceHash(original) }], [original]);
        expect(result[0]).toMatchObject({ status: 'unresolved', message: null });
    });
});

describe('Phase 0 public history API', () => {
    it('samples beyond 500 matches through the paged history contract without changing the default prefix', async () => {
        const records = Array.from({ length: 501 }, (_, i) => event(`event-${i}`, {
            source_window_start: i, event_type: i === 500 ? 'revelation' : 'introduction',
            DateTime: '2026-10-19T12:00:00Z', scene_time: 'At noon on the final day',
        }));
        const f = fixture(records);
        f.backend.listChunks.mockImplementation(async (_id, _settings, { offset, limit }) => ({
            items: records.slice(offset, offset + limit).map(metadata => ({ metadata })), total: records.length,
        }));
        const request = { mode: 'history', subjects: [{ name: 'Alex' }], limit: 500 };
        const prefix = await f.api.findEvents(request);
        expect(prefix.events.at(-1).event_id).toBe('event-499');
        const result = await f.api.findEvents({ ...request, history_selection: 'representative' });
        expect(result.events).toHaveLength(500);
        expect(new Set(result.events.map(e => e.event_ref)).size).toBe(500);
        expect(result.events[0].event_id).toBe('event-0');
        expect(result.events.at(-1)).toMatchObject({ event_id: 'event-500',
            DateTime: '2026-10-19T12:00:00Z', scene_time: 'At noon on the final day' });
        expect(result.coverage).toMatchObject({ matched_count: 501, returned_count: 500,
            sampled: true, truncated: true, counts_exact: true });
        expect(f.backend.listChunks).toHaveBeenCalledWith(collection.collectionId, f.state.settings, { offset: 500, limit: 500 });
        const resolved = await f.api.resolveSources({ scope_token: result.scope_token, sources: result.events.at(-1).source_refs });
        expect(resolved.ok).toBe(true);
    });

    it('shares representative slots across selected collections and retains source order', async () => {
        const collections = ['a', 'z'].map(id => ({ collectionId: id, registryKey: `qdrant:${id}` }));
        const f = fixture();
        f.state.collections = f.state.availableCollections = collections;
        f.backend.listChunks.mockImplementation(async (id, _settings, { offset, limit }) => ({
            items: Array.from({ length: 601 }, (_, i) => ({ metadata: event(`${id}-${i}`, {
                source_chat_id: id, source_window_start: i,
            }) })).slice(offset, offset + limit), total: 601,
        }));
        const result = await f.api.findEvents({ mode: 'history', history_selection: 'representative',
            limit: 500, subjects: [{ name: 'Alex' }],
            scope: { kind: 'selected_collections', collections: collections.map(c => c.registryKey) } });
        expect(result.events).toHaveLength(500);
        for (const id of ['a', 'z']) {
            const group = result.events.filter(e => e.source_chat_id === id);
            expect(group).toHaveLength(250);
            expect(group[0].event_id).toBe(`${id}-0`);
            expect(group.at(-1).event_id).toBe(`${id}-600`);
            expect(group.map(e => e.source_window_start)).toEqual(group.map(e => e.source_window_start).sort((a, b) => a - b));
        }
        expect(result.coverage).toMatchObject({ matched_count: 1202, sampled: true, truncated: true });
    });

    it('handles small representative budgets, complete matches, and invalid selection policies', async () => {
        const { api } = fixture([event('early'), event('late', { source_window_start: 10 })]);
        const single = await api.findEvents({ history_selection: 'representative', limit: 1 });
        expect(single.events.map(e => e.event_id)).toEqual(['late']);
        const complete = await api.findEvents({ history_selection: 'representative', limit: 2 });
        expect(complete.events.map(e => e.event_id)).toEqual(['early', 'late']);
        expect(complete.coverage).toMatchObject({ sampled: false, truncated: false });
        for (const request of [{ history_selection: 'unknown' },
            { mode: 'question', question: 'Alex?', history_selection: 'representative' }]) {
            expect(await api.findEvents(request)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
        }
    });

    it('merges paraphrase-only semantic candidates and carries them through answer selection', async () => {
        const query = vi.fn(async () => ({ metadata: [event('rescue', { summary: 'A stranger pulls the child ashore', characters: [] })] }));
        const f = fixture([], query);
        const complete = vi.fn(async prompt => {
            const data = JSON.parse(prompt.split('Research data: ')[1]);
            expect(data.evidence.map(e => e.summary)).toContain('A stranger pulls the child ashore');
            return JSON.stringify({ status: 'answered', gap: '', claims: [{ sentence: 'A rescue was recorded.', event_refs: [data.evidence[0].event_ref] }] });
        });
        const result = await askStory({ api: f.api, question: 'Who prevented a drowning?', complete });
        expect(result.evidence).toHaveLength(1);
        expect(result.coverage.semantic).toMatchObject({ attempted: true, candidate_count: 1, unavailable: [] });
        expect(query).toHaveBeenCalledWith(collection, 'Who prevented a drowning?', 200, f.state.settings);
        expect(f.api.getStatus().capabilities.semantic_search.available).toBe(true);
        query.mockClear();
        await f.api.findEvents();
        expect(query).not.toHaveBeenCalled();
    });
    it.each([null, ''])('recovers semantic-only summaries from embedded text (%j)', async summary => {
        const sentence = 'The bridge stands north of the old mill.';
        const f = fixture([], async () => ({ metadata: [event('bridge', {
            summary, text: `[location_change] ${sentence}`,
        })] }));
        const complete = vi.fn(async prompt => {
            const data = JSON.parse(prompt.split('Research data: ')[1]);
            expect(data.evidence[0].summary).toBe(sentence);
            return JSON.stringify({ status: 'answered', gap: '', claims: [{ sentence,
                event_refs: [data.evidence[0].event_ref] }] });
        });
        expect((await askStory({ api: f.api, question: 'Where is the bridge?', complete })).status).toBe('answered');
        expect(complete).toHaveBeenCalledOnce();
    });
    it('deduplicates semantic hits and applies source, subject, type and active-duplicate filters', async () => {
        const records = [event('keep'), event('other', { source_chat_id: 'other' }),
            event('subject', { characters: ['Morgan'] }), event('type', { event_type: 'combat' }),
            event('duplicate', { continuity: { v: 1, duplicate_of: { status: 'active', event_id: 'keep' } } })];
        const f = fixture(records, async () => ({ metadata: records }));
        const result = await f.api.findEvents({ mode: 'question', question: 'Alex', subjects: [{ name: 'Alex' }], types: ['dialogue_significant'] });
        expect(result.events.map(e => e.event_id)).toEqual(['keep']);
        expect(result.events[0].retrieval.semantic_rank).toBe(0);
    });
    it('reports semantic failure without discarding lexical evidence', async () => {
        const f = fixture([event('keep', { summary: 'Alex negotiates' })], async () => { throw new Error('Embedding offline'); });
        const result = await f.api.findEvents({ mode: 'question', question: 'Alex negotiates' });
        expect(result.events.map(e => e.event_id)).toEqual(['keep']);
        expect(result.coverage).toMatchObject({ partial: true, semantic: { unavailable: [{ code: 'semantic_error', reason: 'Embedding offline' }] } });
    });
    it('rejects scope changes during a semantic query', async () => {
        const query = vi.fn(async () => { f.state.chatId = 'new'; return { metadata: [event('stale')] }; });
        const f = fixture([], query);
        expect(await f.api.findEvents({ mode: 'question', question: 'rescue' })).toMatchObject({ ok: false, error: { code: 'stale_scope' } });
    });
    it('does not generate after cancellation during semantic retrieval', async () => {
        const controller = new AbortController();
        const f = fixture([], async () => {
            controller.abort();
            return { metadata: [event('rescue', { summary: 'A stranger pulls the child ashore', characters: [] })] };
        });
        const complete = vi.fn();
        await expect(askStory({ api: f.api, question: 'drowning', signal: controller.signal, complete })).rejects.toThrow();
        expect(complete).not.toHaveBeenCalled();
    });
    it('caps vector candidates and reports a saturated search budget', async () => {
        const f = fixture([], async () => ({ metadata: Array.from({ length: 250 }, (_, i) =>
            event(String(i), { summary: 'A stranger pulls the child ashore', characters: [] })) }));
        const result = await f.api.findEvents({ mode: 'question', question: 'drowning' });
        expect(result.events).toHaveLength(200);
        expect(result.coverage).toMatchObject({ truncated: true, semantic: { candidate_count: 200, truncated: true } });
    });
    it('qualifies semantic identities and divides the vector budget across selected collections', async () => {
        const query = vi.fn(async () => ({ metadata: [event('same', { characters: [], summary: 'A stranger pulls the child ashore' })] }));
        const f = fixture([], query);
        f.state.collections = f.state.availableCollections = [collection, { collectionId: 'archive', registryKey: 'standard:archive' }];
        const result = await f.api.findEvents({ mode: 'question', question: 'drowning', scope: { kind: 'selected_collections', collections: ['qdrant:events', 'standard:archive'] } });
        expect(result.events).toHaveLength(2);
        expect(new Set(result.events.map(e => e.event_ref)).size).toBe(2);
        expect(query.mock.calls.map(call => call[2])).toEqual([100, 100]);
    });
    it('separates matching, continuity and cached sources for identical IDs on different backends', async () => {
        const { state } = fixture();
        state.chat.push(message('second source', 'b'));
        state.collections = state.availableCollections = ['standard', 'qdrant'].map(backend => ({
            collectionId: 'events', registryKey: `${backend}:events`,
        }));
        const issue = event('same', { characters: ['Alex'], open_threads: ['task'],
            source_messages: await captureEventSources([state.chat[0]], 0) });
        const copy = { ...issue, characters: ['Ranger'], source_messages: await captureEventSources([state.chat[1]], 1) };
        const resolver = event('resolver', { characters: ['Ranger'], continuity: { v: 1, resolves: [{
            event_id: 'same', threads: 'all', status: 'active', threads_digest: threadsDigest(copy),
        }] } });
        const api = createPublicEventAPI({ readState: () => state, loadBackend: async collection => ({
            listChunks: async () => ({ items: (collection.registryKey === 'standard:events' ? [issue] : [copy, resolver])
                .map(metadata => ({ metadata })), total: collection.registryKey === 'standard:events' ? 1 : 2 }),
        }) });
        for (const match of ['all', 'any']) {
            expect((await api.findEvents({ subjects: [{ name: 'Alex' }], match })).events
                .map(e => e.collection_key)).toEqual(['standard:events']);
        }
        const found = await api.findEvents();
        const copies = found.events.filter(e => e.event_id === 'same');
        expect(copies.map(e => e.collection_id)).toEqual(['events', 'events']);
        expect(new Set(copies.map(e => e.event_ref)).size).toBe(2);
        expect(new Set(copies.map(e => e.source_refs[0].ref)).size).toBe(2);
        expect(copies.map(e => e.continuity_view.fullyResolved)).toEqual([false, true]);
        const resolved = await api.resolveSources({ scope_token: found.scope_token, sources: copies.flatMap(e => e.source_refs) });
        expect(resolved.sources.map(s => [s.collection_key, s.status, s.message.mes])).toEqual([
            ['standard:events', 'verified', 'hello'], ['qdrant:events', 'verified', 'second source'],
        ]);
    });
    it('retains the healthy backend records when the same-named collection fails on another backend', async () => {
        const { state } = fixture();
        state.collections = state.availableCollections = ['standard', 'qdrant'].map(backend => ({
            collectionId: 'events', registryKey: `${backend}:events`,
        }));
        const api = createPublicEventAPI({ readState: () => state, loadBackend: async collection => ({
            listChunks: async () => {
                if (collection.registryKey === 'qdrant:events') throw new Error('offline');
                return { items: [{ metadata: event('same') }], total: 1 };
            },
        }) });
        expect(await api.findEvents()).toMatchObject({ ok: true, events: [{ collection_key: 'standard:events' }],
            coverage: { partial: true, counts_exact: false, unavailable: [{ collection_key: 'qdrant:events' }] } });
    });
    it.each(['503', 'transport'])('rejects empty native fallback after plugin %s and recovers on retry', async failure => {
        const { state } = fixture();
        const backend = new StandardBackend();
        backend.pluginAvailable = true;
        const fetch = vi.fn();
        if (failure === '503') fetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Unavailable', text: async () => 'offline' });
        else fetch.mockRejectedValueOnce(new Error('Network error'));
        fetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
        vi.stubGlobal('fetch', fetch);
        const api = createPublicEventAPI({ readState: () => state, loadBackend: async () => backend });
        expect(await api.findEvents()).toMatchObject({ ok: false, error: { code: 'unsupported' } });
        expect(backend.pluginAvailable).toBe(true);
        expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/plugins/similharity/chunks/list', '/api/vector/list']);
        expect(api.getStatus().capabilities.history).toMatchObject({ available: false, reason: 'metadata_listing_unavailable' });
        api.invalidate();
        expect(api.getStatus().capabilities.history).toMatchObject({ available: true,
            backend_support: [{ available: null, reason: 'not_probed' }] });
        fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [], total: 0 }) });
        expect(await api.findEvents()).toMatchObject({ ok: true, events: [], coverage: { counts_exact: true, partial: false } });
        expect(api.getStatus().capabilities.history.available).toBe(true);
    });
    it.each([undefined, {}])('initializes and reads history without secure-context crypto (%j)', async crypto => {
        vi.stubGlobal('crypto', crypto);
        const { api } = fixture([event('one')]);
        const second = fixture().api;
        expect(api.getStatus().scope_token).not.toBe(second.getStatus().scope_token);
        expect(api.getStatus()).toMatchObject({ ready: true,
            capabilities: { source_resolution: { available: false, reason: 'fingerprinting_unavailable' } } });
        expect(await api.findEvents()).toMatchObject({ ok: true, events: [{ event_id: 'one' }] });
    });
    it('returns complete records in source order independent of injection settings', async () => {
        const { api, state, backend } = fixture([event('late', { source_window_start: 50 }), event('early', { importance: 1, cause: 'cause', locations: ['home'], source_message_ids: [0] })]);
        state.settings = { eventbase_min_importance: 10, eventbase_resolved_downrank: 0, eventbase_top_k: 1 };
        const result = await api.findEvents({ subjects: [{ name: 'Alex', aliases: [] }, { name: 'Ranger' }], match: 'all' });
        expect(result.events.map(e => e.event_id)).toEqual(['early', 'late']);
        expect(result.events[0]).toMatchObject({ cause: 'cause', locations: ['home'], source_status: 'unresolved' });
        expect(result.events[0].source_refs).toHaveLength(1);
        expect(backend.listChunks).toHaveBeenCalledTimes(1);
        result.events[0].characters.push('mutated');
        expect((await api.findEvents()).events[0].characters).not.toContain('mutated');
    });
    it('filters current chat strictly but permits explicitly selected cross-chat events', async () => {
        const { api } = fixture([event('current'), event('other', { source_chat_id: 'other' }), event('unknown', { source_chat_id: null })]);
        expect((await api.findEvents()).events.map(e => e.event_id)).toEqual(['current']);
        const result = await api.findEvents({ scope: { kind: 'selected_collections', collections: ['events'] } });
        expect(result.events).toHaveLength(3);
        expect(result.coverage.partial).toBe(true);
    });
    it('supports aliases within a subject without treating them as separate people', async () => {
        const { api, state } = fixture([event('one', { characters: ['Alex'] }), event('two', { characters: ['Alexander'] }), event('three', { characters: ['Ranger'] })]);
        state.settings.eventbase_character_alias_overrides = { events: [{ name: 'Alex', aliases: ['Alex', 'Alexander'] }] };
        expect((await api.findEvents({ subjects: [{ name: 'Alex', aliases: ['Alexander'] }] })).events).toHaveLength(2);
        expect((await api.findEvents({ subjects: [{ name: 'Alex' }, { name: 'Ranger' }], match: 'all' })).events).toHaveLength(0);
        expect((await api.findEvents({ subjects: [{ name: 'Alex' }, { name: 'Ranger' }], match: 'any' })).events).toHaveLength(3);
    });
    it('research retrieves old and resolved events despite aggressive injection settings', async () => {
        const old = event('old', { source_window_start: 0, characters: ['Alexander'],
            summary: 'Alexander met Ranger at the old gate.', open_threads: ['return sword'],
            continuity: { v: 1 } });
        old.continuity.closed_threads = { status: 'active', threads: 'all', threads_digest: threadsDigest(old), how: 'Returned' };
        const { api, state } = fixture([old, event('recent', { source_window_start: 999, summary: 'Unrelated recent business', characters: [] })]);
        Object.assign(state.settings, { eventbase_top_k: 1, eventbase_exclude_recent: 1000,
            eventbase_resolved_downrank: 0, eventbase_character_alias_overrides: { events: [{ name: 'Alex', aliases: ['Alexander'] }] } });
        const result = await api.findEvents({ mode: 'question', question: 'How did Alex meet Ranger?', limit: 10 });
        expect(result.events.map(e => e.event_id)).toContain('old');
        expect(result.events.find(e => e.event_id === 'old').continuity_view.fullyResolved).toBe(true);
        expect(result.events.map(e => e.event_id)).not.toContain('recent');
    });
    it('surfaces ambiguous roster subjects in research questions', async () => {
        const { api } = fixture([event('one', { characters: ['Alex Smith', 'Alex Jones', 'Alex'] })]);
        expect(await api.findEvents({ mode: 'question', question: 'What did Alex do?' }))
            .toMatchObject({ ok: false, error: { code: 'ambiguous_subject' } });
    });
    it('carries a full character chronology through real API research and answer evidence', async () => {
        const { api } = fixture(Array.from({ length: 300 }, (_, i) => event(String(i), {
            source_window_start: i, characters: ['Alex'], summary: 'Alex continues the journey',
        })));
        const candidates = await api.findEvents({ mode: 'question', question: 'Give me a timeline of Alex' });
        expect(candidates.events).toHaveLength(200);
        expect(candidates.events.at(-1).event_id).toBe('299');
        const complete = vi.fn(async prompt => {
            const data = JSON.parse(prompt.split('Research data: ')[1]);
            expect(data.evidence).toHaveLength(40);
            expect(data.evidence[0].source_window_start).toBe(0);
            expect(data.evidence.at(-1).source_window_start).toBe(299);
            expect(data.evidence.some(e => e.source_window_start >= 140 && e.source_window_start <= 160)).toBe(true);
            return JSON.stringify({ status: 'partial', gap: 'History was sampled.', claims: [{
                sentence: 'Alex continued the journey.', event_refs: [data.evidence[0].event_ref],
            }] });
        });
        const result = await askStory({ api, complete, question: 'Give me a timeline of Alex' });
        expect(result.coverage.sampled).toBe(true);
        expect(complete).toHaveBeenCalledOnce();
    });
    it('expands subject anchors into topical same-chat outcomes but keeps history strict', async () => {
        const { api } = fixture([
            event('unrelated', { source_window_start: 0, summary: 'A merchant counts coins.', characters: ['Merchant'] }),
            event('promise', { source_window_start: 1, summary: 'Alex promises to bring an antidote.', characters: ['Alex'] }),
            event('outcome', { source_window_start: 2, summary: 'The antidote arrives and the patient recovers.', characters: ['Patient'] }),
            event('distant', { source_window_start: 3, summary: 'The antidote is sold elsewhere.', characters: ['Merchant'] }),
            event('other-chat', { source_chat_id: 'other', source_window_start: 0,
                summary: 'The antidote arrives.', characters: ['Patient'] }),
        ]);
        for (const scope of [undefined, { kind: 'selected_collections', collections: ['events'] }]) {
            const result = await api.findEvents({ mode: 'question', question: 'Did Alex deliver the antidote?', scope });
            expect(result.events.map(e => e.event_id)).toEqual(['promise', 'outcome']);
        }
        expect((await api.findEvents({ subjects: [{ name: 'Alex' }] })).events.map(e => e.event_id)).toEqual(['promise']);
        const complete = vi.fn(async prompt => {
            const data = JSON.parse(prompt.split('Research data: ')[1]);
            expect(data.evidence.map(e => e.summary)).toEqual([
                'Alex promises to bring an antidote.', 'The antidote arrives and the patient recovers.',
            ]);
            return JSON.stringify({ status: 'partial', gap: 'Delivery by Alex is not established.', claims: [{
                sentence: 'The patient recovered after the antidote arrived.', event_refs: [data.evidence[1].event_ref],
            }] });
        });
        await askStory({ api, complete, question: 'Did Alex deliver the antidote?' });
        expect(complete).toHaveBeenCalledOnce();
    });
    it('reports ambiguity rather than silently merging two people', async () => {
        const { api } = fixture([event('one', { characters: ['Alex Smith', 'Alex Jones', 'Alex'] })]);
        expect((await api.findEvents({ subjects: [{ name: 'Alex' }] })).error.code).toBe('ambiguous_subject');
    });
    it('prefers full names at overlapping positions but retains independent short-name ambiguity', async () => {
        const { api } = fixture(['Alex', 'Alex Smith', 'Alex Jones'].map(name => event(name, { characters: [name] })));
        for (const name of ['Alex Smith', 'Alex Jones']) {
            const result = await api.findEvents({ mode: 'question', question: `What did ${name} do?` });
            expect(result.ok).toBe(true);
            expect(result.events.map(e => e.event_id)).toEqual([name]);
        }
        for (const question of ['What did Alex do?', 'What did Alex Smith tell Alex?', 'Did Alexander see Alex?']) {
            expect(await api.findEvents({ mode: 'question', question }))
                .toMatchObject({ ok: false, error: { code: 'ambiguous_subject' } });
        }
    });
    it('preserves a manually resolved alias through public research and answer generation', async () => {
        const { api, state } = fixture([event('task', { summary: 'Elizabeth repaired the gate.', characters: ['Elizabeth'] }),
            event('unrelated', { summary: 'Ranger slept.', characters: ['Ranger'] })]);
        state.settings.eventbase_character_alias_overrides = { events: [{ name: 'Bess', aliases: ['Elizabeth'] }] };
        const complete = vi.fn(async prompt => {
            const data = JSON.parse(prompt.split('Research data: ')[1]);
            expect(data.evidence.map(e => e.summary)).toEqual(['Elizabeth repaired the gate.']);
            expect(data.question).toBe('What did Bess do?');
            return JSON.stringify({ status: 'answered', gap: '', claims: [{ sentence: 'Bess repaired the gate.',
                event_refs: [data.evidence[0].event_ref] }] });
        });
        const result = await askStory({ api, complete, question: 'What did Bess do?' });
        expect(result.status).toBe('answered');
        expect(result.evidence.map(e => e.event_id)).toEqual(['task']);
        expect(complete).toHaveBeenCalledOnce();
    });
    it.each([false, true])('keeps subject membership collection-qualified (ignored tag: %s)', async ignored => {
        const { api, state, backend } = fixture();
        const second = { collectionId: 'second', registryKey: 'qdrant:second' };
        state.collections = state.availableCollections = [collection, second];
        if (ignored) state.settings.eventbase_character_ignored_tags = { second: ['Alex'] };
        backend.listChunks.mockImplementation(async id => ({ items: [{ metadata: event('same', {
            characters: id === 'events' ? ['Alex'] : ignored ? ['Alex', 'Ranger'] : ['Ranger'],
        }) }], total: 1 }));
        for (const match of ['all', 'any']) {
            const result = await api.findEvents({ subjects: [{ name: 'Alex' }], match });
            expect(result.events.map(e => [e.collection_id, e.event_id])).toEqual([['events', 'same']]);
        }
        expect((await api.findEvents({ subjects: [{ name: 'Alex' }, { name: 'Ranger' }], match: 'all' })).events).toEqual([]);
        expect((await api.findEvents({ subjects: [{ name: 'Alex' }, { name: 'Ranger' }], match: 'any' })).events).toHaveLength(2);
    });
    it.each(['identical', 'diverged'])('does not close another collection copy with %s duplicate IDs', async kind => {
        const issue = event('issue', { open_threads: ['task'] });
        const copy = { ...issue, source_chat_id: 'other', summary: kind === 'diverged' ? 'Different issue' : issue.summary };
        const resolver = event('resolver', { source_chat_id: 'other', continuity: { v: 1, resolves: [{
            event_id: 'issue', threads: 'all', status: 'active', threads_digest: threadsDigest(copy),
        }] } });
        const { api, state, backend } = fixture();
        const second = { collectionId: 'second', registryKey: 'qdrant:second' };
        state.collections = state.availableCollections = [collection, second];
        backend.listChunks.mockImplementation(async id => ({ items: (id === 'events' ? [issue] : [copy, resolver])
            .map(metadata => ({ metadata })), total: id === 'events' ? 1 : 2 }));
        const current = await api.findEvents();
        expect(current.events).toHaveLength(1);
        expect(current.events[0].continuity_view.fullyResolved).toBe(false);
        const all = await api.findEvents({ scope: { kind: 'selected_collections', collections: ['events', 'second'] } });
        expect(all.events.find(e => e.collection_id === 'second' && e.event_id === 'issue').continuity_view.fullyResolved).toBe(true);
    });
    it('does not select an ambiguous cross-collection target', async () => {
        const issue = event('issue', { open_threads: ['task'] });
        const resolver = event('resolver', { continuity: { v: 1, resolves: [{ event_id: 'issue',
            threads: 'all', status: 'active', threads_digest: threadsDigest(issue) }] } });
        const { api, state, backend } = fixture();
        state.collections = state.availableCollections = ['events', 'second', 'third'].map(collectionId => ({
            collectionId, registryKey: `qdrant:${collectionId}`,
        }));
        backend.listChunks.mockImplementation(async id => ({ items: [{ metadata: id === 'third' ? resolver : issue }], total: 1 }));
        const result = await api.findEvents();
        expect(result.events.filter(e => e.event_id === 'issue').every(e => !e.continuity_view.fullyResolved)).toBe(true);
    });
    it.each(['cross-chat', 'cross-collection'])('retains %s continuity outside the returned records', async kind => {
        const issue = event('issue', { characters: ['Alex'], open_threads: ['Will Alex stay?'] });
        const resolver = event('resolver', { source_chat_id: 'other', characters: ['Ranger'], event_type: 'relationship_change',
            continuity: { v: 1, resolves: [{ event_id: 'issue', threads: 'all', status: 'active',
                threads_digest: threadsDigest(issue), resolver_digest: threadsDigest(event('resolver')) }] } });
        const { api, state, backend } = fixture([issue, resolver]);
        let scope;
        if (kind === 'cross-collection') {
            const second = { collectionId: 'second', registryKey: 'qdrant:second' };
            state.availableCollections = [collection, second];
            scope = { kind: 'selected_collections', collections: ['events', 'second'] };
            backend.listChunks.mockImplementation(async id => ({ items: (id === 'events' ? [issue] : [resolver])
                .map(metadata => ({ metadata })), total: 1 }));
        }
        const request = { scope, subjects: [{ name: 'Alex' }], types: ['dialogue_significant'] };
        const result = await api.findEvents(request);
        expect(result.events.map(e => e.event_id)).toEqual(['issue']);
        expect(result.events[0].continuity_view).toMatchObject({ fullyResolved: true, remainingThreads: [],
            resolutions: [{ event_id: 'resolver' }] });
        if (kind === 'cross-collection') {
            expect((await api.findEvents({ ...request, scope: { ...scope, collections: ['events'] } }))
                .events[0].continuity_view.fullyResolved).toBe(false);
        }
        resolver.continuity.duplicate_of = { status: 'active', event_id: 'another' };
        expect((await api.findEvents(request)).events[0].continuity_view.fullyResolved).toBe(false);
    });
    it('separates loading, disabled, unsupported, empty and partial results', async () => {
        const { api, state, backend } = fixture();
        state.ready = false;
        expect((await api.findEvents()).error.code).toBe('loading');
        state.ready = true;
        state.enabled = false;
        expect((await api.findEvents()).error.code).toBe('disabled');
        state.enabled = true;
        expect(await api.findEvents()).toMatchObject({ ok: true, events: [] });
        backend.pluginAvailable = false;
        expect((await api.findEvents()).error.code).toBe('unsupported');
        delete backend.pluginAvailable;
        backend.listChunks.mockResolvedValue({ items: [{ hash: 1, text: '', metadata: {} }], total: 1 });
        expect((await api.findEvents()).error.code).toBe('unsupported');
        const second = { collectionId: 'second', registryKey: 'qdrant:second' };
        state.collections.push(second);
        backend.listChunks.mockImplementation(async id => { if (id === 'second') throw new Error('offline'); return { items: [], total: 0 }; });
        expect(await api.findEvents()).toMatchObject({ ok: true, coverage: { partial: true } });
    });
    it('bounds requests and requires a question for research', async () => {
        const { api } = fixture();
        for (const request of [{ limit: 0 }, { limit: 501 }, { subjects: [null] }, { scope: { kind: 'bad' } }, { types: 'bad' }]) {
            expect((await api.findEvents(request)).error.code).toBe('invalid_request');
        }
        expect((await api.findEvents({ mode: 'question' })).error.code).toBe('invalid_request');
        expect(await api.findEvents({ mode: 'question', question: 'A timeline of the story' })).toMatchObject({ ok: true });
        expect(api.getStatus().capabilities.question_research.available).toBe(true);
        expect(api.getStatus().capabilities.semantic_search.available).toBe(false);
    });
    it('rejects stale async reads on chat switches, locks, and message edits', async () => {
        for (const mutate of [s => { s.chatId = 'other'; }, s => { s.collections = []; }, s => { s.chat[0].mes = 'edit'; }]) {
            const { api, state, backend } = fixture();
            backend.listChunks.mockImplementation(async () => { mutate(state); return { items: [], total: 0 }; });
            expect((await api.findEvents()).error.code).toBe('stale_scope');
        }
    });
    it.each([
        ['embedding_ollama_model', 'new-model'], ['embedding_vllm_model', 'new-model'],
        ['embedding_openrouter_model', 'new-model'], ['qdrant_host', 'other-host'],
        ['qdrant_port', 6334], ['qdrant_use_cloud', true], ['qdrant_url', 'https://other.example'],
        ['qdrant_multitenancy', true],
    ])('invalidates pending reads and tokens when %s changes', async (key, value) => {
        const { api, state, backend } = fixture();
        state.settings.embedding_provider = key.startsWith('embedding_') ? key.split('_')[1] : 'ollama';
        const originalToken = api.getStatus().scope_token;
        let finish;
        const pendingListing = new Promise(resolve => { finish = resolve; });
        backend.listChunks.mockReturnValue(pendingListing);
        const pending = api.findEvents();
        await vi.waitFor(() => expect(backend.listChunks).toHaveBeenCalledOnce());
        state.settings[key] = value;
        finish({ items: [], total: 0 });
        expect(await pending).toMatchObject({ ok: false, error: { code: 'stale_scope' } });
        expect(api.getStatus().scope_token).not.toBe(originalToken);
        expect((await api.findEvents({ scope_token: originalToken })).error.code).toBe('stale_scope');
    });
    it('resolves only issued references and invalidates them on content edits', async () => {
        const source = await captureEventSources([message('hello')], 0);
        const { api, state } = fixture([event('one', { source_messages: source })]);
        const found = await api.findEvents();
        const request = { scope_token: found.scope_token, sources: found.events[0].source_refs };
        expect((await api.resolveSources(request)).sources[0].status).toBe('verified');
        expect((await api.resolveSources({ ...request, sources: ['forged'] })).error.code).toBe('invalid_reference');
        state.chat[0].mes = 'edit';
        expect((await api.resolveSources(request)).error.code).toBe('stale_scope');
    });
    it('reports truncation without sampling or pretending counts are complete', async () => {
        const { api } = fixture([event('a'), event('b')]);
        expect((await api.findEvents({ limit: 1 })).coverage).toMatchObject({ truncated: true, sampled: false, matched_count: 2, returned_count: 1 });
    });
    it('paginates metadata listings and discloses unknown totals', async () => {
        const { api, backend } = fixture();
        backend.listChunks.mockImplementation(async (_, __, { offset }) => ({ items: [{ metadata: event(`e${offset}`) }], total: 2 }));
        expect((await api.findEvents()).events).toHaveLength(2);
        expect(backend.listChunks.mock.calls.map(call => call[2].offset)).toEqual([0, 1]);
        backend.listChunks.mockResolvedValue({ items: [{ metadata: event('unknown-total') }] });
        expect((await api.findEvents()).coverage).toMatchObject({ counts_exact: false, partial: true, truncated: true });
    });
    it('preserves derived closure while excluding active duplicate events', async () => {
        const { api } = fixture([event('closed', { open_threads: ['task'], continuity: { v: 1,
            closed_threads: { status: 'active', threads: 'all', threads_digest: 'wrong' } } }),
        event('duplicate', { continuity: { v: 1, duplicate_of: { status: 'active', event_id: 'closed' } } })]);
        const result = await api.findEvents();
        expect(result.events).toHaveLength(1);
        expect(result.events[0].continuity_view).toMatchObject({ remainingThreads: ['task'], fullyResolved: false });
    });
    it('invalidates requests when archive mutations occur and tracks unsupported status', async () => {
        const { api, state, backend } = fixture();
        backend.listChunks.mockImplementation(async () => { state.archiveRevision = 1; return { items: [], total: 0 }; });
        expect((await api.findEvents()).error.code).toBe('stale_scope');
        backend.pluginAvailable = false;
        expect((await api.findEvents()).error.code).toBe('unsupported');
        expect(api.getStatus().capabilities.history).toMatchObject({ available: false, reason: 'metadata_listing_unavailable' });
    });
});