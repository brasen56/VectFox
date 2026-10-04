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

const MAIN_OR_VISIBLE = 'events already in the main block or recent context';

function describeCardInjection(outcome) {
    if (!outcome) return 'injection outcome not recorded';
    const gated = outcome.facts - outcome.eligibleFacts;
    switch (outcome.outcome) {
    case 'injected': {
        const claimed = outcome.eligibleFacts - outcome.injectedFacts;
        return [`injected ${outcome.injectedFacts} of ${outcome.facts} fact(s)`,
            gated ? `${gated} cite ${MAIN_OR_VISIBLE}` : '',
            claimed ? `${claimed} cite events another character's history already used` : ''].filter(Boolean).join('; ');
    }
    case 'gated': return `not injected: all ${outcome.facts} fact(s) cite ${MAIN_OR_VISIBLE}`;
    case 'claimed': return `not injected: ${gated ? `${gated} fact(s) cite ${MAIN_OR_VISIBLE} and ` : ''}the rest cite events another character's history already used`;
    case 'over_slice': return `not injected: the card (~${outcome.cardTokens} tokens) exceeds its share of the cast budget (${outcome.sliceTokens} tokens)`;
    case 'no_events': return `not injected: all of their events are already in the main block, recent context, or another character's history`;
    default: return 'not injected';
    }
}

function describeNpcCard(status, outcome) {
    const count = `${status.events} event(s)`;
    const lastError = status.lastError ? ` Last build failed: ${status.lastError}` : '';
    switch (status.status) {
    case 'below_min': return `${count}, below the ${status.minEvents}-event minimum; no card is built.`;
    case 'building': return `${count}; no usable card yet; a build is queued or running.`;
    case 'retry_wait': return `${count}; no card; the last build failed (${status.lastError || 'unknown error'}), next try in about ${Math.max(1, Math.ceil((status.retryAt - Date.now()) / 60000))} min.`;
    case 'stale': return `${count}; the stored card is in an old format or none of its facts match their sources; it is rebuilt on a real turn.${lastError}`;
    case 'not_built': return `${count}; no card yet. Cards are built in the background on real turns, never on dry-runs.${lastError}`;
    }
    const facts = status.storedFacts > status.intactFacts
        ? `${status.intactFacts} of ${status.storedFacts} stored fact(s) still match their sources`
        : `${status.intactFacts} fact(s)`;
    const unread = status.unreadEvents ? `, ${status.unreadEvents} newer event(s) not yet in it` : '';
    return `${count}; card has ${facts}${unread}; ${describeCardInjection(outcome)}.`;
}

/** One line per scene-cast character: whether a card exists, and why it was or was not injected. */
function formatNpcCardStatus(debug) {
    if (debug.npcCardsEnabled === false) return ['NPC card status: disabled in settings.'];
    if (!debug.npcCardStatus?.length) return [];
    const outcomes = new Map((debug.npcCardOutcomes || []).map(outcome => [outcome.name, outcome]));
    return ['NPC card status:', ...debug.npcCardStatus.map(status =>
        `  ${status.name}: ${describeNpcCard(status, outcomes.get(status.name))}`)];
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
        `NPC cards injected: ${(debug.npcCardCharacters || []).join(', ') || 'none'}.`,
        ...formatNpcCardStatus(debug)].filter(Boolean).join('\n');
    if (debug.crossEncoder?.enabled) {
        const ce = debug.crossEncoder;
        const status = ce.used ? 'used' : ce.deferred ? 'deferred' : ce.skippedReason ? 'skipped' : 'original order';
        castText = [castText, `Cross-encoder: ${status}; ${ce.documentsSent || 0} document(s); ${ce.durationMs || 0}ms${ce.skippedReason ? `; ${ce.skippedReason}` : ''}${ce.error ? `; ${ce.error}` : ''}.`].filter(Boolean).join('\n');
    }
    return { cutCount: cuts.length, cutText: cutText || 'No returned candidates were cut.', queryText, ...(castText ? { castText } : {}) };
}
