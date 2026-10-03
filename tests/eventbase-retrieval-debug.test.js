import { describe, it, expect } from 'vitest';
import {
    createCandidateOutcomes, recordCandidateOutcome, summarizePlannerQueries,
    formatRetrievalDiagnostics,
} from '../core/eventbase-retrieval-debug.js';

describe('EventBase recall diagnostics', () => {
    it('attributes shared survivors to every query and distinguishes empty/failed calls', () => {
        const shared = { event_id: 'shared' };
        const hashOnly = { _hash: 'hash' };
        const summary = summarizePlannerQueries(['first', 'second', 'empty'], [
            { queryText: 'first', hits: [shared, hashOnly] },
            { queryText: 'first', hits: [shared] },
            { queryText: 'second', hits: [shared, { event_id: 'cut' }] },
            { queryText: 'empty', hits: [], error: 'timeout' },
            { queryText: 'empty', hits: [], error: 'failed' },
        ], [shared, hashOnly]);
        expect(summary.map(q => [q.hitsReturned, q.uniqueHits, q.survivedCount])).toEqual([
            [3, 2, 2], [2, 2, 1], [0, 0, 0],
        ]);
        expect(summary[2]).toMatchObject({ failedCalls: 1, timedOutCalls: 1 });
    });

    it('renders cuts and per-query counts as plain text, excluding injected candidates', () => {
        const events = [{ event_id: 'cut', summary: '<script>bad()</script>' }, { event_id: 'kept' }];
        const candidateOutcomes = createCandidateOutcomes(events);
        recordCandidateOutcome(candidateOutcomes, events[0], 'cut_at_trim');
        recordCandidateOutcome(candidateOutcomes, events[1], 'injected');
        const result = formatRetrievalDiagnostics({ candidateOutcomes,
            plannerQuerySummary: summarizePlannerQueries(['query'], [{ queryText: 'query', hits: events }], [events[1]]),
        });
        expect(result.cutCount).toBe(1);
        expect(result.cutText).toContain('cut — cut at trim');
        expect(result.cutText).toContain('<script>bad()</script>');
        expect(result.cutText).not.toContain('kept');
        expect(result.queryText).toContain('2 hit(s) returned (2 unique); 1 injected');
    });

    it('supports absent debug data', () => {
        expect(formatRetrievalDiagnostics()).toEqual({
            cutCount: 0, cutText: 'No returned candidates were cut.', queryText: '',
        });
    });
});