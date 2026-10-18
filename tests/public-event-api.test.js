import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} } }));
vi.mock('../../../../utils.js', () => ({ uuidv4: () => 'test' }));
vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../../../../openai.js', () => ({ oai_settings: {} }));
vi.mock('../core/providers.js', () => ({ getModelFromSettings: () => 'test-model', resolveProviderApiUrl: () => '' }));
import { StandardBackend } from '../backends/standard.js';
import { createPublicEventAPI } from '../core/public-event-api.js';
import { threadsDigest } from '../core/continuity.js';
import { captureEventSources, legacySourceHash, narrativeFingerprint, resolveEventSources } from '../core/event-sources.js';

const message = (mes, id = 'a') => ({ name: 'Alex', mes, id, extra: { mesid: id, mwt_uuid: 'private' } });
const collection = { collectionId: 'events', registryKey: 'qdrant:events' };
const event = (event_id, fields = {}) => ({ event_id, source_chat_id: 'chat', summary: event_id,
    characters: ['Alex', 'Ranger'], event_type: 'dialogue_significant', source_window_start: 0, ...fields });
function fixture(records = []) {
    const state = { ready: true, enabled: true, chatId: 'chat', chat: [message('hello')], chatMetadata: {},
        settings: {}, collections: [collection], availableCollections: [collection] };
    const backend = { listChunks: vi.fn(async () => ({ items: records.map(metadata => ({ metadata })), total: records.length })) };
    const api = createPublicEventAPI({ readState: () => state, loadBackend: async () => backend });
    return { state, backend, api };
}
async function refs(messages) {
    return (await captureEventSources(messages, 0)).map(source => ({ ...source, stored_fingerprint: source.fingerprint, source_chat_id: 'chat' }));
}
const resolve = (references, chat, chatMetadata = {}) => resolveEventSources(references, { chatId: 'chat', chat, chatMetadata });
afterEach(() => vi.unstubAllGlobals());

describe('Phase 0 source resolution', () => {
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
    it('reports ambiguity rather than silently merging two people', async () => {
        const { api } = fixture([event('one', { characters: ['Alex Smith', 'Alex Jones', 'Alex'] })]);
        expect((await api.findEvents({ subjects: [{ name: 'Alex' }] })).error.code).toBe('ambiguous_subject');
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
    it('bounds requests and explicitly rejects unsupported question research', async () => {
        const { api } = fixture();
        for (const request of [{ limit: 0 }, { limit: 501 }, { subjects: [null] }, { scope: { kind: 'bad' } }, { types: 'bad' }]) {
            expect((await api.findEvents(request)).error.code).toBe('invalid_request');
        }
        expect((await api.findEvents({ mode: 'question' })).error.code).toBe('unsupported');
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