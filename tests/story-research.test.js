import { describe, it, expect, vi } from 'vitest';
import { askStory, selectStoryEvents, validateStoryAnswer, STORY_LIMITS } from '../core/story-research.js';

const event = (id, summary = 'Alex meets Ranger', extra = {}) => ({ event_id: id, event_ref: `ref:${id}`,
    source_chat_id: 'chat', source_window_start: Number(id) || 0, summary,
    characters: ['Alex', 'Ranger'], source_refs: [{ ref: `source:${id}` }], ...extra });
const response = (events, extra = {}) => ({ ok: true, events, scope_token: 'scope',
    coverage: { returned_count: events.length, matched_count: events.length, partial: false, sampled: false, truncated: false }, ...extra });
const content = (refs, status = 'answered', gap = '') => JSON.stringify({ status, gap,
    claims: refs.length ? [{ sentence: 'The recorded meeting happened here.', event_refs: refs }] : [] });
function fixture(events = [event('1')]) {
    let token = 'scope';
    const api = { getStatus: () => ({ ready: true, scope_token: token }),
        findEvents: vi.fn(async () => response(events)),
        resolveSources: vi.fn(async ({ sources }) => ({ ok: true, sources: sources.map(source => ({ ...source, status: 'verified', message: { mes: 'original' } })) })) };
    return { api, complete: vi.fn(async () => content(['ref:1'])), setToken: value => { token = value; } };
}

describe('Ask the Story research', () => {
    it.each([
        ['provider', new Error('HTTP 429: rate limited')],
        ['malformed_json', 'not JSON'],
        ['malformed_json', JSON.stringify({ status: 'answered', claims: [], gap: '' })],
        ['invalid_citations', content(['invented'])],
    ])('retains evidence, coverage and sources on %s failure', async (stage, raw) => {
        const f = fixture();
        if (raw instanceof Error) f.complete.mockRejectedValue(raw);
        else f.complete.mockResolvedValue(raw);
        await expect(askStory({ ...f, question: 'Alex' })).rejects.toMatchObject({ stage,
            result: { status: 'failed', claims: [], evidence: [expect.objectContaining({ event_ref: 'ref:1' })],
                sources: [expect.objectContaining({ status: 'verified' })], coverage: { evidence_count: 1 },
                scope_token: 'scope', calls: 1 } });
        expect(f.complete).toHaveBeenCalledOnce();
    });
    it.each([false, true])('labels retrieval failures without evidence or generation (%s)', async thrown => {
        const f = fixture();
        if (thrown) f.api.findEvents.mockRejectedValue(new Error('Database offline'));
        else f.api.findEvents.mockResolvedValue({ ok: false, error: { message: 'Database offline' } });
        await expect(askStory({ ...f, question: 'Alex' })).rejects.toMatchObject({ stage: 'retrieval', message: 'Database offline' });
        expect(f.complete).not.toHaveBeenCalled();
    });
    it('retains evidence if source resolution throws after generation fails', async () => {
        const f = fixture();
        f.complete.mockResolvedValue('invalid');
        f.api.resolveSources.mockRejectedValue(new Error('Originals offline'));
        await expect(askStory({ ...f, question: 'Alex' })).rejects.toMatchObject({
            stage: 'malformed_json', result: { evidence: [expect.any(Object)], sources: [],
                coverage: { sources_unavailable: true, source_resolution_error: 'Originals offline' } } });
    });
    it('does not attach stale evidence when scope changes during a provider failure', async () => {
        const f = fixture();
        f.complete.mockImplementation(async () => { f.setToken('changed'); throw new Error('Provider failed'); });
        try { await askStory({ ...f, question: 'Alex' }); expect.fail('Should reject'); }
        catch (error) { expect(error.message).toContain('scope changed'); expect(error.result).toBeUndefined(); }
        expect(f.api.resolveSources).not.toHaveBeenCalled();
    });
    it('protects semantic-only anchors against lexical competition at both record budgets', () => {
        const events = Array.from({ length: 240 }, (_, i) => event(String(i), 'drowning prevention'));
        events[239] = event('239', 'A stranger pulls the child ashore', { characters: [], retrieval: { semantic_rank: 0 } });
        for (const limit of [1, 40, 200]) {
            expect(selectStoryEvents(events, 'drowning prevention', limit).events).toContain(events[239]);
        }
    });
    it('preserves semantic-only evidence when the character budget forces reselection', async () => {
        const events = Array.from({ length: 40 }, (_, i) => event(String(i), `drowning ${'detail '.repeat(250)}`));
        events.push(event('semantic', 'A stranger pulls the child ashore', { characters: [], retrieval: { semantic_rank: 0 } }));
        const f = fixture(events);
        f.complete.mockImplementation(async prompt => {
            const data = JSON.parse(prompt.split('Research data: ')[1]);
            expect(JSON.stringify(data.evidence).length).toBeLessThanOrEqual(STORY_LIMITS.evidenceChars);
            expect(data.evidence.some(e => e.event_ref === 'ref:semantic')).toBe(true);
            return content(['ref:semantic']);
        });
        const result = await askStory({ ...f, question: 'drowning prevention' });
        expect(result.coverage.truncated).toBe(true);
        expect(f.complete).toHaveBeenCalledOnce();
    });
    it('passes explicit archive scope through and preserves unresolved provenance', async () => {
        const f = fixture([event('1', 'Alex remembers the archive', { source_chat_id: null })]);
        f.api.resolveSources.mockResolvedValue({ ok: true, sources: [{ ref: 'source:1', status: 'unresolved', reason: 'unknown_source_chat', message: null }] });
        const scope = { kind: 'selected_collections', collections: ['qdrant:archive'] };
        const result = await askStory({ ...f, question: 'Alex', scope });
        expect(f.api.findEvents).toHaveBeenCalledWith(expect.objectContaining({ scope }));
        expect(result.sources[0]).toMatchObject({ status: 'unresolved', message: null });
        expect(result.coverage.sources_unavailable).toBe(true);
    });
    it.each([40, 200])('reserves nearby topical outcomes ahead of subject-only matches at limit %i', limit => {
        const events = Array.from({ length: limit + 20 }, (_, i) => event(String(i), 'Alex rests'));
        events[5] = event('5', 'Alex arranges antidote delivery');
        events[6] = event('6', 'The antidote delivery saves the patient', { characters: [] });
        const anchors = events.flatMap((e, i) => e.characters.includes('Alex') ? [i] : []);
        const result = selectStoryEvents(events, 'What happened with Alex and the antidote delivery?', limit, ['Alex'], anchors);
        expect(result.events).toContain(events[5]);
        expect(result.events).toContain(events[6]);
        expect(result.events).toHaveLength(limit);
        events[6] = { ...events[6], source_chat_id: 'other' };
        expect(selectStoryEvents(events, 'Alex antidote delivery', limit, ['Alex'], anchors).events).not.toContain(events[6]);
    });
    it('retains early, middle and late history when serialized evidence exceeds the character budget', async () => {
        const events = Array.from({ length: 100 }, (_, i) => event(String(i),
            `${i < 80 ? 'Alex negotiates the treaty' : 'Alex returns home'} ${'detail '.repeat(180)}`));
        const f = fixture(events);
        f.complete.mockImplementation(async prompt => {
            const data = JSON.parse(prompt.split('Research data: ')[1]);
            expect(JSON.stringify(data.evidence).length).toBeLessThanOrEqual(STORY_LIMITS.evidenceChars);
            expect(data.evidence[0].event_ref).toBe('ref:0');
            expect(data.evidence.at(-1).event_ref).toBe('ref:99');
            expect(data.evidence.some(e => e.source_window_start >= 35 && e.source_window_start <= 65)).toBe(true);
            return content([data.evidence[0].event_ref]);
        });
        const result = await askStory({ ...f, question: 'Timeline of Alex and the treaty' });
        expect(result.coverage.truncated).toBe(true);
    });
    it('preserves a meeting sequence without promoting a co-mention to a first meeting', async () => {
        const f = fixture([event('0', 'Alex mentions Ranger but has never met him.'), event('1', 'Alex first meets Ranger at the gate.'),
            event('2', 'Ranger introduces himself to Alex.')]);
        f.complete.mockImplementation(async prompt => {
            expect(prompt).toContain('earlier co-mention does not establish a meeting');
            const data = JSON.parse(prompt.split('Research data: ')[1]);
            expect(data.evidence.map(e => e.event_ref)).toEqual(['ref:0', 'ref:1', 'ref:2']);
            return content(['ref:1', 'ref:2']);
        });
        const result = await askStory({ ...f, question: 'How did Alex meet Ranger?' });
        expect(result.claims[0].event_refs).toEqual(['ref:1', 'ref:2']);
        expect(f.complete).toHaveBeenCalledTimes(1);
        expect(f.api.findEvents).toHaveBeenCalledWith(expect.objectContaining({ mode: 'question', scope: { kind: 'current_chat' } }));
    });
    it('protects late relevant hits before spine sampling and discloses sampled history', () => {
        const events = Array.from({ length: 1000 }, (_, i) => event(String(i), i === 900 ? 'The dragon treaty' : 'Routine business', { characters: [] }));
        const result = selectStoryEvents(events, 'Timeline of the dragon treaty history', 20);
        expect(result.events).toContain(events[900]);
        expect(result.events).toHaveLength(20);
        expect(result.sampled).toBe(true);
    });
    it('uses remaining thread state for outstanding obligations', () => {
        const events = [event('0', 'An obligation', { continuity_view: { remainingThreads: [] } }),
            event('1', 'An obligation', { continuity_view: { remainingThreads: ['return sword'] } })];
        expect(selectStoryEvents(events, 'outstanding obligations', 1).events).toEqual([events[1]]);
    });
    it('samples the full subject chronology at both candidate and evidence limits', () => {
        const events = Array.from({ length: 300 }, (_, i) => event(String(i), 'Alex continues the journey'));
        const candidates = selectStoryEvents(events, 'Give me a timeline of Alex', STORY_LIMITS.candidates, ['Alex']);
        const evidence = selectStoryEvents(candidates.events, 'Give me a timeline of Alex', STORY_LIMITS.evidence, ['Alex']);
        for (const [selection, limit] of [[candidates, STORY_LIMITS.candidates], [evidence, STORY_LIMITS.evidence]]) {
            expect(selection.events).toHaveLength(limit);
            expect(selection.events[0]).toBe(events[0]);
            expect(selection.events.at(-1)).toBe(events[299]);
            expect(selection.events.some(e => e.source_window_start >= 140 && e.source_window_start <= 160)).toBe(true);
            expect(selection.sampled).toBe(true);
        }
    });
    it('reserves chronological coverage even when topical matches exceed the budget', () => {
        const events = Array.from({ length: 300 }, (_, i) => event(String(i),
            i < 250 ? 'Alex negotiates the treaty' : 'Alex returns home'));
        const result = selectStoryEvents(events, 'Timeline of Alex and the treaty', 40, ['Alex']);
        expect(result.events).toContain(events[299]);
        expect(result.events.filter(e => e.summary.includes('treaty')).length).toBeGreaterThanOrEqual(30);
    });
    it.each([30, 40])('prioritizes interleaved matches and reports omitted hits with a limit of %i', limit => {
        const events = Array.from({ length: 80 }, (_, i) => event(String(i),
            i % 2 === 0 ? 'The dragon treaty advances' : 'Routine business', { characters: [] }));
        const matches = events.filter((_, i) => i % 2 === 0);
        const result = selectStoryEvents(events, 'dragon treaty', limit);
        expect(result.events).toEqual(matches.slice(0, limit));
        expect(result.sampled).toBe(false);
        expect(result.truncated).toBe(limit < matches.length);
    });
    it.each(['What happened?', 'Summarize the story'])('answers broad history requests with bounded sampling: %s', async question => {
        const events = Array.from({ length: 80 }, (_, i) => event(String(i), 'Routine business', { characters: [] }));
        const f = fixture(events);
        f.complete.mockImplementation(async prompt => {
            const data = JSON.parse(prompt.split('Research data: ')[1]);
            expect(data.evidence).toHaveLength(STORY_LIMITS.evidence);
            expect(data.evidence[0].event_ref).toBe('ref:0');
            expect(data.evidence.at(-1).event_ref).toBe('ref:79');
            return content([data.evidence[0].event_ref]);
        });
        const result = await askStory({ ...f, question });
        expect(result).toMatchObject({ status: 'answered', calls: 1, coverage: { sampled: true } });
        expect(f.complete).toHaveBeenCalledTimes(1);
    });
    it.each(['Who stole diamonds?', 'What happened to the diamonds?', 'Summarize the diamond theft'])('does not broadly sample a specific unsupported question: %s', question => {
        expect(selectStoryEvents([event('1', 'A quiet afternoon', { characters: [] })], question, 40).events).toEqual([]);
    });
    it('supplies stored dates for date questions without inventing dates for undated events', async () => {
        const f = fixture([event('1', 'Alex signed the treaty.', {
            DateTime: '1577-08-17T22:30:00Z', scene_time: '17 August 1577, 22:30',
        }), event('2', 'Alex delivered the treaty.')]);
        f.complete.mockImplementation(async prompt => {
            const data = JSON.parse(prompt.split('Research data: ')[1]);
            expect(data.evidence[0]).toMatchObject({ DateTime: '1577-08-17T22:30:00Z', scene_time: '17 August 1577, 22:30' });
            expect(data.evidence[1]).not.toHaveProperty('DateTime');
            expect(data.evidence[1]).not.toHaveProperty('scene_time');
            expect(prompt).toContain('Do not infer missing dates');
            return JSON.stringify({ status: 'answered', gap: '', claims: [{
                sentence: 'Alex signed the treaty on 17 August 1577 at 22:30.', event_refs: ['ref:1'],
            }] });
        });
        const result = await askStory({ ...f, question: 'When did Alex sign the treaty?' });
        expect(result.claims[0].sentence).toContain('17 August 1577');
    });
    it('does not generate for an unsupported question with no lexical evidence', async () => {
        const f = fixture([event('1', 'A quiet afternoon', { characters: [] })]);
        expect(await askStory({ ...f, question: 'Who stole diamonds?' })).toMatchObject({ status: 'no_evidence', calls: 0 });
        expect(f.complete).not.toHaveBeenCalled();
    });
    it('accepts explicit partial evidence and gaps', async () => {
        const f = fixture();
        f.complete.mockResolvedValue(content(['ref:1'], 'partial', 'No later interaction was recorded.'));
        expect(await askStory({ ...f, question: 'Alex and Ranger' })).toMatchObject({ status: 'partial', gap: expect.any(String) });
    });
    it.each(['not JSON', content(['invented']), JSON.stringify({ status: 'answered', claims: [], gap: '' }),
        content(['ref:1'], 'partial')])('rejects malformed or uncited output without retries: %s', async raw => {
        const f = fixture();
        f.complete.mockResolvedValue(raw);
        await expect(askStory({ ...f, question: 'Alex' })).rejects.toThrow();
        expect(f.complete).toHaveBeenCalledTimes(STORY_LIMITS.calls);
    });
    it('validates references against only the evidence shown to the model', () => {
        expect(() => validateStoryAnswer(content(['ref:2']), [event('1')])).toThrow('citation');
    });
    it('bounds evidence input and reports truncation', async () => {
        const events = Array.from({ length: 100 }, (_, i) => event(String(i), `Alex ${'detail '.repeat(400)}`));
        const f = fixture(events);
        f.complete.mockImplementation(async prompt => {
            const data = JSON.parse(prompt.split('Research data: ')[1]);
            expect(JSON.stringify(data.evidence).length).toBeLessThanOrEqual(STORY_LIMITS.evidenceChars);
            return content([data.evidence[0].event_ref]);
        });
        expect((await askStory({ ...f, question: 'Alex timeline' })).coverage.truncated).toBe(true);
    });
    it('rejects a scope switch during generation', async () => {
        const f = fixture();
        f.complete.mockImplementation(async () => { f.setToken('new'); return content(['ref:1']); });
        await expect(askStory({ ...f, question: 'Alex' })).rejects.toThrow('scope changed');
        expect(f.api.resolveSources).not.toHaveBeenCalled();
    });
    it('rejects cancellation before and after generation', async () => {
        for (const before of [true, false]) {
            const f = fixture(), controller = new AbortController();
            if (before) controller.abort();
            else f.complete.mockImplementation(async () => { controller.abort(); return content(['ref:1']); });
            await expect(askStory({ ...f, question: 'Alex', signal: controller.signal })).rejects.toThrow();
            expect(f.complete).toHaveBeenCalledTimes(before ? 0 : 1);
        }
    });
    it('preserves live, recovered ILS and cross-chat unavailable source distinctions', async () => {
        const f = fixture([event('1'), event('2'), event('3')]);
        f.complete.mockResolvedValue(content(['ref:1', 'ref:2', 'ref:3']));
        f.api.resolveSources.mockResolvedValue({ ok: true, sources: [
            { ref: 'source:1', status: 'verified', recovered_ils: false, message: { mes: 'live' } },
            { ref: 'source:2', status: 'verified', recovered_ils: true, message: { mes: 'ILS original' } },
            { ref: 'source:3', status: 'unresolved', reason: 'cross_chat_unavailable', message: null }] });
        const result = await askStory({ ...f, question: 'Alex' });
        expect(result.sources[1].recovered_ils).toBe(true);
        expect(result.sources[2].message).toBeNull();
        expect(result.coverage.sources_unavailable).toBe(true);
    });
});