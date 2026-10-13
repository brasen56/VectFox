import { describe, it, expect, vi } from 'vitest';
vi.mock('../core/log.js', () => ({ log: { warn: vi.fn(), lifecycle: vi.fn() } }));
import { threadsDigest, buildResolvedBy, getContinuityView, renderResolution, annotateContinuity,
    selectOpenIssues, mapResolutionRefs } from '../core/continuity.js';
import { buildExtractionPrompt, validateEvent, buildEmbedText } from '../core/eventbase-schema.js';
import { getEventBaseExtractionPrompt, getAgenticPlannerPrompt, buildPlannerUserMessage } from '../core/prompts-i18n.js';
import { formatEventsForInjectionDetailed, formatCastHistoryDetailed, estimateCastTokens } from '../core/eventbase-injection.js';
import { npcCardSnapshot } from '../core/npc-cards.js';
import { ensureCharacterIndex, getCharacterRoster, upsertCharacterEvents, pruneCharacterEvents,
    invalidateCharacterIndex } from '../core/character-roster.js';

function fixture(threads = [0, 1]) {
    const conflict = { event_id: 'conflict', summary: 'Alex threatens to leave.', text: '[relationship_change] Alex threatens to leave.',
        event_type: 'relationship_change', importance: 7, should_persist: true, characters: ['Alex'],
        source_window_end: 10, open_threads: ['Will Alex stay?', 'Will the debt be paid?'], _collectionIds: ['chat'] };
    const resolver = { event_id: 'resolver', summary: 'Derek apologizes and Alex stays. They embrace.', source_window_end: 40,
        characters: ['Alex'], open_threads: [], _collectionIds: ['chat'],
        continuity: { v: 1, resolves: [{ event_id: 'conflict', threads, threads_digest: threadsDigest(conflict),
            how: 'Alex stays.', origin: 'extraction', status: 'active', run: null }] } };
    const group = { name: 'Alex', aliases: ['Alexander'], eventIds: new Set(['conflict', 'resolver']), isLead: true };
    const roster = { ready: true, events: [conflict, resolver], groups: [group], resolvedBy: buildResolvedBy([conflict, resolver]) };
    return { conflict, resolver, group, roster };
}

describe('derived continuity', () => {
    it('invalidates self closure when the archived result changes', () => {
        const f = fixture();
        f.conflict.result = 'Debt paid';
        const digest = threadsDigest(f.conflict);
        f.conflict.continuity = { v: 1, closed_threads: { threads: 'all', threads_digest: digest, status: 'active' } };
        expect(getContinuityView(f.conflict, f.roster).fullyResolved).toBe(true);
        f.conflict.result = 'Debt remains outstanding';
        expect(threadsDigest(f.conflict)).not.toBe(digest);
        expect(getContinuityView(f.conflict, f.roster).fullyResolved).toBe(false);
    });
    it('unions incoming and local closure without changing the archive', () => {
        const f = fixture([0]);
        const original = JSON.stringify(f.conflict);
        expect(getContinuityView(f.conflict, f.roster)).toMatchObject({ remainingThreads: ['Will the debt be paid?'], closedThreads: [0], fullyResolved: false });
        expect(renderResolution(getContinuityView(f.conflict, f.roster))).toBe('Derek apologizes and Alex stays. (message 40)');
        expect(JSON.stringify(f.conflict)).toBe(original);
        f.conflict.continuity = { v: 1, closed_threads: { threads: [1], threads_digest: threadsDigest(f.conflict), how: 'Debt paid.', origin: 'manual', status: 'active' } };
        expect(getContinuityView(f.conflict, f.roster)).toMatchObject({ remainingThreads: [], closedThreads: [0, 1], fullyResolved: true });
    });
    it('ignores proposed, invalid and stale links, including summary edits', () => {
        const f = fixture();
        const link = f.resolver.continuity.resolves[0];
        link.status = 'proposed';
        expect(getContinuityView(f.conflict, f.roster).fullyResolved).toBe(false);
        link.status = 'active';
        link.threads = [100];
        expect(getContinuityView(f.conflict, f.roster).inactiveLinks[0].reason).toBe('invalid_threads');
        link.threads = 'all';
        f.conflict.summary = 'Edited conflict';
        expect(getContinuityView(f.conflict, f.roster).inactiveLinks[0].reason).toBe('digest_mismatch');
    });
    it('requires eligible target and resolver, and supports local how fallback', () => {
        const f = fixture('all');
        expect(getContinuityView(f.conflict, { events: [f.conflict] }).fullyResolved).toBe(false);
        expect(getContinuityView(f.conflict, { events: [f.resolver], resolvedBy: f.roster.resolvedBy }).inactiveLinks[0].reason).toBe('ineligible_collection');
        f.conflict.continuity = { v: 1, closed_threads: { ...f.resolver.continuity.resolves[0], how: 'Settled in this scene.' } };
        expect(renderResolution(getContinuityView(f.conflict))).toBe('Settled in this scene.');
    });
    it.each(['densetext', 'json', 'summaryonly'])('renders atomic outcomes in %s', format => {
        const f = fixture([0]);
        const event = annotateContinuity(f.conflict, f.roster);
        const output = formatEventsForInjectionDetailed([event], { eventbase_injection_format: format }).text;
        expect(output).toContain('Derek apologizes and Alex stays.');
        expect(output).not.toContain('Will Alex stay?');
        if (format !== 'summaryonly') expect(output).toContain('Will the debt be paid?');
        const budget = estimateCastTokens(output) - 1;
        const compact = formatEventsForInjectionDetailed([event], { eventbase_injection_format: format }, budget);
        if (compact.includedCount) expect(compact.text).toContain('Derek apologizes and Alex stays.');
    });
    it('renders cast outcomes on the same budgeted line', () => {
        const f = fixture();
        const result = formatCastHistoryDetailed({ roster: f.roster, cast: [{ group: f.group }], settings: { eventbase_cast_token_budget: 500 } });
        expect(result.text).toContain('Alex threatens to leave. — later resolved: Derek apologizes and Alex stays. (message 40)');
    });
    it('changes NPC evidence digests only for affected records', () => {
        const f = fixture();
        const initial = npcCardSnapshot({ ...f.roster, events: [f.conflict], resolvedBy: new Map() }, f.group);
        const linked = npcCardSnapshot(f.roster, f.group);
        expect(linked.digests.get('conflict')).not.toBe(initial.digests.get('conflict'));
        const before = linked.digests.get('resolver');
        f.resolver.continuity.resolves[0].status = 'proposed';
        expect(npcCardSnapshot(f.roster, f.group).digests.get('resolver')).toBe(before);
    });
    it('selects matching leads, prior unresolved issues, preserving original thread indices', () => {
        const f = fixture([0]);
        const issues = selectOpenIssues({ roster: f.roster, windowStart: 50, text: 'Alexander talks to Derek.' });
        expect(issues.text).toContain('(1) Will the debt be paid?');
        expect(issues.text).not.toContain('(0)');
        expect(issues.refMap.get('I1')).toBe(f.conflict);
        // Only this window's own records are excluded; positions are not a clock across chat files.
        expect(selectOpenIssues({ roster: f.roster, windowStart: 8, windowEnd: 12, text: 'Alex' }).text).toBe('(none)');
        expect(selectOpenIssues({ roster: f.roster, windowStart: 50, text: 'Alexandra' }).text).toBe('(none)');
        expect(selectOpenIssues({ roster: f.roster, windowStart: 50, text: 'Alex', settings: { eventbase_open_issues_max: 0 } }).text).toBe('(none)');
    });
    it('orders open issues by story time, not message position, and ignores misdated outliers', () => {
        const events = Array.from({ length: 12 }, (_, i) => ({ event_id: `e${i}`, summary: `Issue ${i}.`, event_type: 'relationship_change',
            importance: 6, characters: ['Alex'], open_threads: [`Thread ${i}`], DateTime: `2000-05-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
            source_window_end: (i * 7919) % 1000 }));
        events.push({ event_id: 'misdated', summary: 'Misdated.', event_type: 'relationship_change', importance: 6, characters: ['Alex'],
            open_threads: ['Outlier'], DateTime: '2024-07-24T10:50:00Z', source_window_end: 999 });
        const group = { name: 'Alex', aliases: [], eventIds: new Set(events.map(e => e.event_id)) };
        const roster = { ready: true, events, groups: [group], resolvedBy: new Map() };
        const issues = selectOpenIssues({ roster, windowStart: 6000, windowEnd: 6010, text: 'Alex', settings: { eventbase_open_issues_max: 3 } });
        expect([...issues.refMap.values()].map(e => e.event_id)).toEqual(['e11', 'e10', 'e9']);
        expect(issues.text).toContain('I1: [story time 2000-05-12T12:00:00Z, importance 6]');
    });
    it('rejects an extraction link whose resolution precedes the issue', () => {
        const f = fixture();
        const issue = { ...f.conflict, DateTime: '2000-08-16T09:00:00Z' };
        const refMap = new Map([['I1', issue]]);
        const resolves = [{ ref: 'I1', threads: [0], how: 'Alex stays.' }];
        const warn = vi.fn();
        expect(mapResolutionRefs(resolves, refMap, warn, { resolver: { DateTime: '2000-05-25T17:00:00Z' }, windowStart: 50 })).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('later than its resolution'));
        expect(mapResolutionRefs(resolves, refMap, warn, { resolver: { DateTime: '2000-08-18T10:00:00Z' }, windowStart: 5 })).toBeDefined();
        // Undated: the issue must sit before this window in the same conversation.
        expect(mapResolutionRefs(resolves, new Map([['I1', f.conflict]]), warn, { resolver: {}, windowStart: 5 })).toBeUndefined();
        expect(mapResolutionRefs(resolves, new Map([['I1', f.conflict]]), warn, { resolver: {}, windowStart: 50 })).toBeDefined();
    });
    it('validates and maps refs, dropping unknown and out-of-range threads without embedding changes', () => {
        const f = fixture();
        const raw = { summary: 'They reconcile.', event_type: 'relationship_change', importance: 7,
            resolves: [{ ref: 'I1', threads: [0, 0, -1, 1.5, 99], how: 'x'.repeat(250) }, { ref: 'I99', threads: [0], how: 'Unknown' }] };
        const { event } = validateEvent(raw);
        const before = buildEmbedText(event);
        const warn = vi.fn();
        event.continuity = mapResolutionRefs(event.resolves, new Map([['I1', f.conflict]]), warn);
        expect(event.continuity.resolves).toHaveLength(1);
        expect(event.continuity.resolves[0]).toMatchObject({ event_id: 'conflict', threads: [0], status: 'active', origin: 'extraction' });
        expect(event.continuity.resolves[0].how).toHaveLength(200);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(buildEmbedText(event)).toBe(before);
    });
    it.each(['intl', 'jieba', 'jieba_tw', 'tiny_segmenter', 'korean', 'others'])('enables default resolution instructions and recall in %s', mode => {
        const template = getEventBaseExtractionPrompt(mode);
        expect(template).toContain('{{openIssues}}');
        expect(template).toContain('5. RESOLUTION OF LISTED ISSUES');
        expect(template.indexOf('5. RESOLUTION')).toBeGreaterThan(template.indexOf('4. REASONING'));
        expect(buildExtractionPrompt('excerpt', 3, '', mode, 'Alex', 'I1: issue')).toContain('I1: issue');
        expect(getAgenticPlannerPrompt(mode)).toContain('recall_past_event');
    });
    it('respects custom templates and labels resolved planner candidates', () => {
        expect(buildExtractionPrompt('excerpt', 3, '{{text}}', 'intl', '', 'I1: issue')).toBe('excerpt');
        expect(buildExtractionPrompt('excerpt', 3, '{{openIssues}} {{text}}')).toBe('(none) excerpt');
        const f = fixture();
        expect(buildPlannerUserMessage({ candidates: [annotateContinuity(f.conflict, f.roster)] })).toContain('[resolved]');
    });
    it('reads continuity and updates reverse links after roster upsert and prune', async () => {
        const f = fixture();
        const id = 'continuity-test';
        invalidateCharacterIndex(id);
        const item = event => ({ hash: event.event_id, text: event.text || `[other] ${event.summary}`, metadata: { ...event, timeline_sort_key: 123 } });
        await ensureCharacterIndex(id, {}, async () => ({ listChunks: async () => ({ items: [item(f.conflict), item(f.resolver)], total: 2 }) }));
        let roster = getCharacterRoster([id]);
        expect(roster.events[0].timeline_sort_key).toBe(123);
        expect(getContinuityView(roster.events[0], roster).fullyResolved).toBe(true);
        pruneCharacterEvents(id, ['resolver']);
        roster = getCharacterRoster([id]);
        expect(getContinuityView(roster.events[0], roster).fullyResolved).toBe(false);
        upsertCharacterEvents(id, [item(f.resolver)]);
        roster = getCharacterRoster([id]);
        expect(getContinuityView(roster.events[0], roster).fullyResolved).toBe(true);
        invalidateCharacterIndex(id);
    });
});