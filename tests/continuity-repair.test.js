import { ContinuityRepair, cosineSimilarity, repairCandidates, repairScope, findDuplicateProposals,
    validateRepairResponse, estimateRepair, buildCandidateIndex } from '../core/continuity-repair.js';
import { isActiveDuplicate, getContinuityView, buildResolvedBy, threadsDigest } from '../core/continuity.js';
import { GenerationRateLimiter } from '../core/generation-rate-limiter.js';

vi.mock('../core/log.js', () => ({ log: { verbose: vi.fn(), warn: vi.fn() } }));

const event = (id, end, extra = {}) => ({ event_id: id, hash: id, summary: `${id} incident`, result: '',
    characters: ['Alex', 'Derek'], open_threads: ['hurt feelings', 'unpaid debt'], importance: 7,
    event_type: 'relationship_change', source_window_start: end - 2, source_window_end: end, ...extra });
const fixture = () => {
    const events = new Map([event('conflict', 10), event('resolution', 40), event('affection', 50),
        event('new_argument', 400)].map(e => [e.event_id, e]));
    const vectors = new Map([...events.keys()].map(id => [id, [1, 0]]));
    return { events, vectors };
};
const makeEngine = (context = fixture(), extra = {}) => {
    const writes = [], checkpoints = [];
    const engine = new ContinuityRepair({ ...context, groups: [], model: 'test/model',
        write: async (e, continuity) => { writes.push({ id: e.event_id, continuity: structuredClone(continuity) }); },
        checkpoint: state => checkpoints.push(structuredClone(state)),
        complete: async () => ({ records: [{ ref: 'conflict', resolves: [{ ref: 'resolution', threads: [0], how: 'They reconcile.' }] }], inputTokens: 100 }), ...extra });
    return { engine, writes, checkpoints };
};

describe('continuity repair inventory and validation', () => {
    it('uses language-independent types, adjustable floors, aliases, pair and range scopes', () => {
        const events = [event('one', 10), event('two', 20, { importance: 5 }), event('three', 30, { event_type: 'discovery' })];
        expect(repairScope(events).map(e => e.event_id)).toEqual(['one']);
        expect(repairScope(events, { scope: 'all', start: 15, end: 25 }).map(e => e.event_id)).toEqual(['two']);
        expect(repairScope(events, { importance: 5, characters: ['A', 'Derek'] }, [{ name: 'A', aliases: ['Alex'] }])).toHaveLength(2);
        expect(repairScope(events, { characters: ['someone else'] })).toEqual([]);
    });

    it('selects only later shared-character candidates within 300 messages at cosine >= .6', () => {
        const { events, vectors } = fixture();
        events.set('other', event('other', 20, { characters: ['Bob'] })); vectors.set('other', [1, 0]);
        expect(repairCandidates(events.get('conflict'), [...events.values()], vectors).map(e => e.event_id)).toEqual(['resolution', 'affection']);
        expect(cosineSimilarity([1, 0], [0.6, 0.8])).toBeCloseTo(0.6);
        expect(cosineSimilarity([0], [0])).toBe(-1);
        expect(cosineSimilarity([1], [1, 2])).toBe(-1);
    });

    it('drops invented refs, invalid threads, empty outcomes and caps how text', () => {
        const { events } = fixture();
        const batch = [{ conflict: events.get('conflict'), candidates: [events.get('resolution')] }];
        const records = [{ ref: 'conflict', self_closed: { threads: [1], how: 'Paid.' }, resolves: [
            { ref: 'invented', threads: [0], how: 'No.' }, { ref: 'resolution', threads: [9], how: 'No.' },
            { ref: 'resolution', threads: [0, 0], how: 'x'.repeat(300) }] }, { ref: 'unknown', self_closed: { threads: 'all', how: 'No.' } }];
        const proposals = validateRepairResponse(records, batch, 'r1');
        expect(proposals).toHaveLength(2);
        expect(proposals[1].entry).toMatchObject({ threads: [0], origin: 'repair', run: 'r1', status: 'proposed' });
        expect(proposals[1].entry.how).toHaveLength(200);
        expect(estimateRepair(batch, 'model')).toMatchObject({ events: 1, calls: 1, model: 'model' });
    });

    it('marks five overlapping copies without LLM, preferring linked then earliest-created copies', () => {
        const events = Array.from({ length: 5 }, (_, i) => event(`e${i}`, 10, { created_at: `2026-01-0${i + 1}` }));
        const vectors = new Map(events.map(e => [e.event_id, [1, 0]]));
        expect(findDuplicateProposals(events, vectors, 'r1')).toHaveLength(4);
        events[4].continuity = { v: 1, resolves: [{ event_id: 'old' }] };
        expect(findDuplicateProposals(events, vectors, 'r1').every(item => item.entry.event_id === 'e4')).toBe(true);
        vectors.set('e0', [0.9, Math.sqrt(1 - 0.9 ** 2)]);
        expect(findDuplicateProposals(events, vectors, 'r1').some(item => item.owner === 'e0')).toBe(false);
        expect(findDuplicateProposals([events[0], event('later', 100)], new Map([['e0', [1, 0]], ['later', [1, 0]]]), 'r1')).toEqual([]);
    });
});

describe('durable repair lifecycle', () => {
    it('locks resume before refresh so eight conflicts are each judged once', async () => {
        const events = new Map(Array.from({ length: 8 }, (_, i) => [String(i), event(String(i), i * 10)]));
        const judged = [];
        const { engine } = makeEngine({ events, vectors: new Map() }, {
            refresh: async () => { await Promise.resolve(); return { events }; },
            complete: async prompt => {
                const { conflicts } = JSON.parse(prompt.split('\n').at(-1));
                expect(conflicts.every((item, i) => item.ref === `C${i + 1}`)).toBe(true);
                judged.push(...conflicts.map(item => item.summary.split(' ')[0])); return [];
            },
        });
        await engine.start();
        const first = engine.resume();
        await expect(engine.resume()).rejects.toThrow('already running');
        await first;
        expect(judged).toEqual([...events.keys()]);
        expect(engine.state.cursor).toBe(8);
    });

    it('serializes concurrent accepts on one owner and undo after review', async () => {
        const { engine } = makeEngine(fixture(), { write: async () => { await Promise.resolve(); } });
        await engine.start({ end: 10 }); await engine.resume();
        const first = engine.events.get('resolution').continuity.resolves[0];
        const second = { ...first, threads: [1] };
        await engine.propose([{ owner: 'resolution', field: 'resolves', entry: second }]);
        await Promise.all([first, second].map(entry => engine.review(engine.state.run, true, [{ owner: 'resolution', field: 'resolves', entry }])));
        expect(engine.events.get('resolution').continuity.resolves.map(link => link.status)).toEqual(['active', 'active']);
        await Promise.all([engine.review(engine.state.run, true), engine.undo(engine.state.run)]);
        expect(engine.events.get('resolution').continuity?.resolves).toBeUndefined();
        expect(engine.state.status).toBe('undone');
    });

    it('rejects edited resolver evidence and invalidates accepted links on later edits', async () => {
        const { engine } = makeEngine();
        await engine.start({ end: 10 }); await engine.resume();
        const resolver = engine.events.get('resolution');
        const original = resolver.summary;
        resolver.summary = 'Refuses to apologize';
        await engine.review(engine.state.run, true);
        expect(resolver.continuity.resolves[0].status).toBe('proposed');
        resolver.summary = original;
        await engine.review(engine.state.run, true);
        resolver.result = 'Refuses to reconcile';
        const roster = { events: [...engine.events.values()], resolvedBy: buildResolvedBy(engine.events.values()) };
        expect(getContinuityView(engine.events.get('conflict'), roster).inactiveLinks[0].reason).toBe('resolver_digest_mismatch');
    });

    it('keeps judged evidence frozen when the resolver is edited during the call', async () => {
        const context = fixture();
        const { engine } = makeEngine(context, { complete: async () => {
            context.events.get('resolution').summary = 'Refuses to apologize';
            return [{ ref: 'conflict', resolves: [{ ref: 'resolution', threads: [0], how: 'Apologizes' }] }];
        } });
        await engine.start({ end: 10 }); await engine.resume();
        expect(context.events.get('resolution').continuity?.resolves).toBeUndefined();
    });

    it('shares serialization across engines for the same collection', async () => {
        const context = fixture(), operations = { tail: Promise.resolve() };
        const { engine } = makeEngine(context, { operations });
        await engine.start({ end: 10 }); await engine.resume();
        const first = context.events.get('resolution').continuity.resolves[0];
        const second = { ...first, threads: [1] };
        await engine.propose([{ owner: 'resolution', field: 'resolves', entry: second }]);
        const { engine: other } = makeEngine(context, { operations });
        await Promise.all([
            engine.review(engine.state.run, true, [{ owner: 'resolution', field: 'resolves', entry: first }]),
            other.review(engine.state.run, true, [{ owner: 'resolution', field: 'resolves', entry: second }]),
        ]);
        expect(context.events.get('resolution').continuity.resolves.map(link => link.status)).toEqual(['active', 'active']);
    });

    it('rechecks incoming and outgoing link ownership when accepting duplicates', async () => {
        for (const incoming of [true, false]) {
            const events = new Map([event('canonical', 10), event('copy', 10), event('later', 20)].map(e => [e.event_id, e]));
            const { engine } = makeEngine({ events, vectors: new Map([...events.keys()].map(id => [id, [1, 0]])) }, { complete: async () => [] });
            await engine.start({ end: 10 }); await engine.resume();
            if (incoming) events.get('later').continuity = { v: 1, resolves: [{ event_id: 'copy', status: 'active' }] };
            else events.get('copy').continuity.resolves = [{ event_id: 'later', status: 'active' }];
            await engine.review(engine.state.run, true);
            expect(events.get('copy').continuity.duplicate_of.status).toBe('proposed');
        }
    });

    it('preserves cancelled checkpoints until undo permits a replacement', async () => {
        const { engine } = makeEngine();
        await engine.start({ end: 10 }); await engine.resume(); engine.cancel();
        const run = engine.state.run;
        await expect(engine.start()).rejects.toThrow('undo');
        expect(engine.state.run).toBe(run);
        await engine.undo(run);
        await engine.start();
        expect(engine.state.run).not.toBe(run);
    });

    it('rejects endpoint changes when resuming the same model', async () => {
        const { engine } = makeEngine(fixture(), { endpoint: 'http://original' });
        await engine.start();
        engine.endpoint = 'http://other';
        await expect(engine.resume()).rejects.toThrow('original endpoint');
    });

    it('refreshes proposal targets before merge and review so edited evidence cannot be accepted', async () => {
        let current = fixture();
        const { engine } = makeEngine(current, { refresh: async () => ({ events: current.events }) });
        await engine.start({ end: 10 }); await engine.resume();
        current = { ...current, events: new Map(structuredClone([...current.events])) };
        current.events.get('conflict').summary = 'Edited evidence';
        await engine.review(engine.state.run, true);
        expect(current.events.get('resolution').continuity.resolves[0].status).toBe('proposed');
        const previous = structuredClone(current.events.get('resolution').continuity);
        await engine.propose([{ owner: 'resolution', field: 'resolves', entry: {
            event_id: 'conflict', threads: [1], threads_digest: 'outdated', origin: 'repair', run: engine.state.run, status: 'proposed' } }]);
        expect(current.events.get('resolution').continuity).toEqual(previous);
        await engine.review(engine.state.run, false);
        expect(current.events.get('resolution').continuity.resolves).toEqual([]);
    });

    it('stores proposals, resumes frozen scope and applies twice without duplicate writes', async () => {
        const { engine, writes, checkpoints } = makeEngine();
        await engine.start({ end: 10 });
        engine.events.set('new_event', event('new_event', 60));
        await engine.resume();
        expect(engine.state.cursor).toBe(1);
        expect(checkpoints.at(-1).status).toBe('complete');
        expect(engine.events.get('resolution').continuity.resolves).toHaveLength(1);
        await engine.resume();
        expect(engine.events.get('resolution').continuity.resolves).toHaveLength(1);
        await engine.review(engine.state.run, true);
        const count = writes.length;
        await engine.review(engine.state.run, true);
        expect(writes).toHaveLength(count);
        expect(engine.events.get('resolution').continuity.resolves[0].status).toBe('active');
    });

    it('replays a partially persisted batch safely after interruption', async () => {
        const context = fixture(); let fail = true;
        const { engine } = makeEngine(context, { write: async e => { if (e.event_id === 'resolution' && fail) throw new Error('offline'); } });
        await engine.start({ end: 10 });
        await expect(engine.resume()).rejects.toThrow('offline');
        expect(engine.state.cursor).toBe(0);
        const checkpoint = structuredClone(engine.state);
        fail = false;
        const { engine: restarted } = makeEngine(context);
        await restarted.resume(checkpoint);
        expect(context.events.get('resolution').continuity.resolves).toHaveLength(1);
    });

    it('pauses after a batch, cancels without erasing proposals, and rejects a model mismatch', async () => {
        const { engine } = makeEngine();
        engine.complete = async () => { engine.pause(); return []; };
        await engine.start(); await engine.resume();
        expect(engine.state.status).toBe('paused');
        engine.model = 'other/model';
        await expect(engine.resume()).rejects.toThrow('original model');
        engine.cancel();
        await expect(engine.resume()).rejects.toThrow('No resumable repair');
    });

    it('undo removes only the run, preserving previous continuity, archive and extraction state', async () => {
        const context = fixture();
        const previous = { v: 1, resolves: [{ event_id: 'old', threads: 'all', run: null, origin: 'extraction', status: 'active' }] };
        context.events.get('resolution').continuity = structuredClone(previous);
        const original = structuredClone([...context.events.values()].map(({ continuity, ...archive }) => archive));
        const settings = { fingerprints: { a: 1 }, markers: { a: 9 }, tips: { a: 10 } };
        const beforeSettings = structuredClone(settings);
        const { engine } = makeEngine(context);
        await engine.start({ end: 10 }); await engine.resume(); await engine.review(engine.state.run, true);
        await engine.undo(engine.state.run);
        expect(context.events.get('resolution').continuity).toEqual(previous);
        expect([...context.events.values()].map(({ continuity, ...archive }) => archive)).toEqual(original);
        expect(settings).toEqual(beforeSettings);
        await engine.undo(engine.state.run);
        expect(context.events.get('resolution').continuity).toEqual(previous);
    });

    it('proposals stay inactive, partial closure keeps debt open, and edited targets deactivate links', async () => {
        const { engine } = makeEngine();
        await engine.start({ end: 10 }); await engine.resume();
        const roster = () => ({ events: [...engine.events.values()], eventById: engine.events, resolvedBy: buildResolvedBy(engine.events.values()) });
        const conflict = engine.events.get('conflict');
        expect(getContinuityView(conflict, roster()).remainingThreads).toHaveLength(2);
        await engine.review(engine.state.run, true);
        expect(getContinuityView(conflict, roster()).remainingThreads).toEqual(['unpaid debt']);
        conflict.summary = 'Edited';
        expect(getContinuityView(conflict, roster()).remainingThreads).toHaveLength(2);
    });

    it('suppresses only active duplicates, including roster-side metadata', () => {
        const duplicate = event('copy', 10, { continuity: { v: 1, duplicate_of: { event_id: 'canonical', status: 'proposed' } } });
        expect(isActiveDuplicate(duplicate)).toBe(false);
        duplicate.continuity.duplicate_of.status = 'active';
        expect(isActiveDuplicate({ metadata: duplicate })).toBe(true);
        expect(isActiveDuplicate({ event_id: 'copy' }, { duplicateIds: new Set(['copy']) })).toBe(true);
    });

    it('starts another run once the finished run is reviewed, and undoes an earlier run by ID', async () => {
        const { engine } = makeEngine();
        await engine.start({ end: 10 }); await engine.resume();
        const first = engine.state.run;
        await expect(engine.start({ end: 10 })).rejects.toThrow('remaining proposals');
        await engine.review(first, true);
        expect(engine.startBlockedReason()).toBeNull();
        engine.complete = async () => [];
        await engine.start({ scope: 'all' }); await engine.resume();
        expect(engine.state.run).not.toBe(first);
        expect(engine.listRuns().map(item => item.run)).toEqual(expect.arrayContaining([first, engine.state.run]));
        expect(engine.events.get('resolution').continuity.resolves[0]).toMatchObject({ run: first, status: 'active' });
        await engine.undo(first);
        expect(engine.events.get('resolution').continuity?.resolves).toBeUndefined();
        expect(engine.state.status).toBe('complete');
    });

    it('compacts the run manifest once the run ends', async () => {
        const { engine } = makeEngine();
        await engine.start({ end: 10 });
        const host = [...engine.events.values()].find(e => e.continuity?.repair_runs);
        expect(host.continuity.repair_runs[0].plan).toHaveLength(1);
        expect(host.continuity.repair_runs[0]).not.toHaveProperty('inventory');
        await engine.resume();
        expect(host.continuity.repair_runs[0]).toEqual(expect.objectContaining({ run: engine.state.run, status: 'complete' }));
        expect(host.continuity.repair_runs[0]).not.toHaveProperty('plan');
    });

    it('skips a batch after repeated paid but unusable responses instead of blocking the run', async () => {
        const unusable = () => Object.assign(new Error('Repair judge response truncated'), { completedCall: true, inputTokens: 10 });
        const { engine } = makeEngine(fixture(), { complete: async () => { throw unusable(); } });
        await engine.start({ end: 10 });
        await expect(engine.resume()).rejects.toThrow('truncated');
        expect(engine.state).toMatchObject({ cursor: 0, status: 'paused' });
        await engine.resume();
        expect(engine.state).toMatchObject({ cursor: 1, status: 'complete', counts: { calls: 2, inputTokens: 20 } });
        expect(engine.state.skipped).toEqual([expect.objectContaining({ cursor: 0, ids: ['conflict'] })]);
    });

    it('treats a pause while queued as a pause, not a failure', async () => {
        const { engine } = makeEngine(fixture(), { complete: async () => {
            engine.pause(); throw Object.assign(new Error('Repair paused before dispatch'), { repairPaused: true });
        } });
        await engine.start({ end: 10 });
        await expect(engine.resume()).resolves.toMatchObject({ status: 'paused', cursor: 0, counts: { calls: 0 } });
    });

    it('skips settled conflicts and offers only open threads under short refs', async () => {
        const context = fixture();
        const conflict = context.events.get('conflict');
        context.events.set('settled', event('settled', 12));
        const settled = context.events.get('settled');
        context.events.get('affection').continuity = { v: 1, resolves: [
            { event_id: 'conflict', threads: [0], threads_digest: threadsDigest(conflict), origin: 'extraction', status: 'active' },
            { event_id: 'settled', threads: 'all', threads_digest: threadsDigest(settled), origin: 'extraction', status: 'active' }] };
        const prompts = [];
        const { engine } = makeEngine(context, { complete: async prompt => { prompts.push(prompt); return []; } });
        expect(engine.plan({ end: 20 }).map(item => item.conflict.event_id)).toEqual(['conflict']);
        await engine.start({ end: 20 }); await engine.resume();
        const data = JSON.parse(prompts[0].split('\n').at(-1));
        // 'settled' has no stored vector, so only the two embedded later events are offered.
        expect(data.conflicts[0]).toMatchObject({ ref: 'C1', threads: ['(1) unpaid debt'], candidates: ['R1', 'R2'] });
        expect(data.candidates.map(item => item.ref)).toEqual(['R1', 'R2']);
        expect([...data.conflicts, ...data.candidates].every(item => !('event_id' in item))).toBe(true);
        const proposals = validateRepairResponse([{ ref: 'C1', resolves: [{ ref: 'R1', threads: [1], how: 'Debt paid.' }] }],
            [{ conflict, candidates: [context.events.get('resolution')] }], 'r1');
        expect(proposals[0]).toMatchObject({ owner: 'resolution', entry: { event_id: 'conflict', threads: [1] } });
    });

    it('pairs candidates by story time when message numbering spans sibling chat files', () => {
        const conflict = event('conflict', 3599, { DateTime: '2000-08-16T09:00:00Z' });
        const later = event('later', 719, { DateTime: '2000-08-18T10:00:00Z' });
        const earlier = event('earlier', 3614, { DateTime: '2000-05-25T17:00:00Z' });
        const tooLate = event('tooLate', 3700, { DateTime: '2000-09-30T10:00:00Z' });
        const vectors = new Map([conflict, later, earlier, tooLate].map(e => [e.event_id, [1, 0]]));
        expect(repairCandidates(conflict, [conflict, later, earlier, tooLate], vectors).map(e => e.event_id)).toEqual(['later']);
    });

    it('finds the same candidates through the look-ahead index as by scanning every event', () => {
        const events = Array.from({ length: 60 }, (_, i) => event(`e${i}`, (i * 37) % 500, {
            ...(i % 3 ? { DateTime: `2000-06-${String(1 + (i % 20)).padStart(2, '0')}T0${i % 10}:00:00Z` } : {}),
            timeline_sort_key: i }));
        const vectors = new Map(events.map((e, i) => [e.event_id, [1, (i % 7) / 10, (i % 5) / 10]]));
        const range = null;
        const index = buildCandidateIndex(events, vectors, range);
        for (const conflict of events) {
            expect(repairCandidates(conflict, events, vectors, [], range, index).map(e => e.event_id))
                .toEqual(repairCandidates(conflict, events, vectors, [], range).map(e => e.event_id));
        }
    });

    it('runs a duplicates-only scope without any LLM call', async () => {
        const events = new Map([event('canonical', 10), event('copy', 10)].map(e => [e.event_id, e]));
        const complete = vi.fn();
        const { engine } = makeEngine({ events, vectors: new Map([...events.keys()].map(id => [id, [1, 0]])) }, { complete });
        expect(engine.plan({ scope: 'duplicates' })).toEqual([]);
        await engine.start({ scope: 'duplicates' }); await engine.resume();
        expect(complete).not.toHaveBeenCalled();
        expect(engine.state.status).toBe('complete');
        expect(events.get('copy').continuity.duplicate_of).toMatchObject({ event_id: 'canonical', status: 'proposed' });
    });

    it('queues repair below NPC cards and reserves the last foreground rate slot', async () => {
        vi.useFakeTimers();
        const limiter = new GenerationRateLimiter(), calls = [];
        const settings = { rate_limit_calls: 2, rate_limit_interval: 1 };
        await limiter.execute(() => calls.push('first'), settings, 'extraction');
        const repair = limiter.execute(() => calls.push('repair'), settings, 'repair');
        const card = limiter.execute(() => calls.push('card'), settings, 'npc-card');
        await limiter.execute(() => calls.push('agent'), settings, 'agent');
        expect(calls).toEqual(['first', 'agent']);
        await vi.advanceTimersByTimeAsync(1100); await card;
        expect(calls).toEqual(['first', 'agent', 'card']);
        await vi.advanceTimersByTimeAsync(1100); await repair;
        expect(calls.at(-1)).toBe('repair');
        vi.useRealTimers();
    });
});