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
    return queries.map((query, queryIndex) => {
        const queryText = typeof query === 'string' ? query : query.query;
        const calls = results.filter(result => result.queryIndex != null
            ? result.queryIndex === queryIndex : result.queryText === queryText);
        const hits = calls.flatMap(result => result.hits);
        const eventIds = [...new Set(hits.map(eventDebugKey))];
        return {
            queryText,
            ...(typeof query === 'object' ? { queryIndex, characters_any: query.characters_any } : {}),
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
    const finalIds = new Set(debug.finalInjectedEventIds || []);
    const cuts = Object.entries(debug.candidateOutcomes || {})
        .filter(([id, entry]) => debug.finalInjectedEventIds
            ? !finalIds.has(id) : entry.outcome !== 'injected');
    const rescues = (debug.castInjectedEventIds || []).filter(id =>
        debug.candidateOutcomes?.[id] && debug.candidateOutcomes[id].outcome !== 'injected');
    const budgetCuts = new Set(debug.budgetCutEventIds || []);
    const cutText = cuts.map(([id, entry]) =>
        `${id} — ${budgetCuts.has(id) ? 'cut by shared token budget' : entry.outcome.replace(/_/g, ' ')}\n  ${entry.summary}`).join('\n\n');
    const mainIds = debug.mainInjectedEventIds ? new Set(debug.mainInjectedEventIds) : null;
    const queryText = (debug.plannerQuerySummary || []).map(query =>
        `${query.queryText}`
        + (query.queryIndex != null ? ` [Q${query.queryIndex + 1}; characters: ${(query.characters_any || []).join(', ') || 'unscoped'}]` : '')
        + `\n  ${query.hitsReturned} hit(s) returned (${query.uniqueHits} unique); ${mainIds ? (query.eventIds || []).filter(id => mainIds.has(id)).length : query.survivedCount} injected in main lane`
        + (query.failedCalls ? `; ${query.failedCalls} failed call(s)` : '')
        + (query.timedOutCalls ? `; ${query.timedOutCalls} timed-out call(s)` : '')).join('\n\n');
    let castText = debug.castIndexReady === false
        ? `Scene-cast history skipped: roster still warming (${(debug.castPendingCollections || []).join(', ')}).`
        : debug.zeroInjectionCharacters
            ? `In play with zero events injected: ${debug.zeroInjectionCharacters.map(c => `${c.name} (${c.signals.join(' + ')})`).join(', ') || 'none'}.`
            : '';
    if (rescues.length) castText = [castText, `Rescued by cast history: ${rescues.join(', ')}.`].filter(Boolean).join('\n');
    if (debug.eventbaseTokenBudget != null) castText = [castText,
        `Shared EventBase budget: ${debug.estimatedInjectionTokens || 0}/${debug.eventbaseTokenBudget} estimated tokens.`,
        `Main events injected as compact summaries: ${(debug.compactMainEventIds || []).join(', ') || 'none'}.`,
        `NPC cards injected: ${(debug.npcCardCharacters || []).join(', ') || 'none'}.`].filter(Boolean).join('\n');
    return { cutCount: cuts.length, cutText: cutText || 'No returned candidates were cut.', queryText, ...(castText ? { castText } : {}) };
}