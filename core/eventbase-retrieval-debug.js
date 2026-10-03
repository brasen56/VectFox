/** Diagnostic helpers only — never change candidate selection or scoring. */
export function eventDebugKey(event) {
    return String(event.event_id ?? event._hash ?? JSON.stringify(event));
}

export function createCandidateOutcomes(events) {
    return Object.fromEntries(events.map(event => [eventDebugKey(event), {
        event_id: event.event_id ?? null,
        summary: String(event.summary ?? event.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
        outcome: 'reached_pool',
        stages: ['reached_pool'],
    }]));
}

export function recordCandidateOutcome(outcomes, event, outcome) {
    const entry = outcomes[eventDebugKey(event)];
    entry.outcome = outcome;
    entry.stages.push(outcome);
}

/** Counts returned hits across collections, but counts final survivors by identity.
 * A shared survivor counts for every query that returned it.
 */
export function summarizePlannerQueries(queries, results, finalEvents) {
    const finalIds = new Set(finalEvents.map(eventDebugKey));
    return queries.map(queryText => {
        const calls = results.filter(result => result.queryText === queryText);
        const hits = calls.flatMap(result => result.hits);
        const eventIds = [...new Set(hits.map(eventDebugKey))];
        return {
            queryText,
            hitsReturned: hits.length,
            uniqueHits: eventIds.length,
            survivedCount: eventIds.filter(id => finalIds.has(id)).length,
            eventIds,
            failedCalls: calls.filter(result => result.error === 'failed').length,
            timedOutCalls: calls.filter(result => result.error === 'timeout').length,
        };
    });
}

/** Plain text for the tester; render using .text(), never as HTML. */
export function formatRetrievalDiagnostics(debug = {}) {
    const cuts = Object.entries(debug.candidateOutcomes || {})
        .filter(([, entry]) => entry.outcome !== 'injected');
    const cutText = cuts.map(([id, entry]) =>
        `${id} — ${entry.outcome.replace(/_/g, ' ')}\n  ${entry.summary}`).join('\n\n');
    const queryText = (debug.plannerQuerySummary || []).map(query =>
        `${query.queryText}\n  ${query.hitsReturned} hit(s) returned (${query.uniqueHits} unique); ${query.survivedCount} injected`
        + (query.failedCalls ? `; ${query.failedCalls} failed call(s)` : '')
        + (query.timedOutCalls ? `; ${query.timedOutCalls} timed-out call(s)` : '')).join('\n\n');
    return { cutCount: cuts.length, cutText: cutText || 'No returned candidates were cut.', queryText };
}