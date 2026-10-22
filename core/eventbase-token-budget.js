/** One estimated-token envelope for the retrieval main lane and cast lane. */
import { estimateCastTokens, formatEventsForInjectionDetailed, formatCastHistoryDetailed } from './eventbase-injection.js';
import { resolveCastSetting } from './scene-cast-settings.js';
import { annotateContinuity } from './continuity.js';
import { formatNpcState } from './npc-card-state.js';

export const EVENTBASE_TOKEN_BUDGET_DEFAULT = 4000;

export function resolveEventBaseTokenBudget(settings = {}) {
    const value = Number(settings.eventbase_token_budget ?? EVENTBASE_TOKEN_BUDGET_DEFAULT);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : EVENTBASE_TOKEN_BUDGET_DEFAULT;
}

export function formatBudgetedEventBase({ events = [], settings = {}, globalContext = '', xmlTag = '', ...castOptions }) {
    for (const event of events) Object.assign(event, annotateContinuity(event, castOptions.roster, settings, castOptions.recallPastEvent));
    if (castOptions.roster) castOptions.roster = { ...castOptions.roster,
        events: castOptions.roster.events.map(e => annotateContinuity(e, castOptions.roster, settings, castOptions.recallPastEvent)) };
    const budget = resolveEventBaseTokenBudget(settings);
    const wrap = text => {
        if (!text) return '';
        if (globalContext) text = `${globalContext}\n\n${text}`;
        return xmlTag ? `<${xmlTag}>\n${text}\n</${xmlTag}>` : text;
    };
    // Reserve wrapper and lane separator costs. An oversized wrapper means no
    // injection, rather than silently exceeding the configured envelope.
    const overhead = estimateCastTokens(wrap('x')) + estimateCastTokens('\n\n');
    const envelope = Math.max(0, budget - overhead);
    const stateLimit = Math.min(envelope, Math.max(0, Number(settings.eventbase_npc_state_tokens ?? 350) || 0));
    const state = { text: '', included: [], omitted: [], excluded: [], estimatedTokens: 0 };
    for (const context of castOptions.stateContexts || (castOptions.stateOptions ? [castOptions.stateOptions] : [])) {
        const result = formatNpcState({ settings, ...context, tokenBudget: Math.max(0, stateLimit - estimateCastTokens(state.text) - 1) });
        if (result.text) state.text = [state.text, result.text].filter(Boolean).join('\n');
        for (const key of ['included', 'omitted', 'excluded']) state[key].push(...result[key]);
    }
    state.estimatedTokens = estimateCastTokens(state.text);
    const available = Math.max(0, envelope - estimateCastTokens(state.text) - (state.text ? estimateCastTokens('\n\n') : 0));
    const castReserve = castOptions.roster?.ready && castOptions.cast?.length
        ? Math.min(available, resolveCastSetting(settings, 'eventbase_cast_token_budget')) : 0;
    const makeMain = limit => events.length ? formatEventsForInjectionDetailed(events, settings, limit)
        : { text: '', events: [], includedCount: 0, compactEventIds: [] };
    let main = makeMain(available - castReserve);
    const makeCast = result => castOptions.roster?.ready
        ? formatCastHistoryDetailed({ ...castOptions, mainEvents: result.events || [],
            settings: { ...settings, eventbase_cast_token_budget: Math.min(resolveCastSetting(settings, 'eventbase_cast_token_budget'),
                Math.max(0, available - estimateCastTokens(result.text))) } })
        : { text: '', events: [], includedCount: 0, zeroInjectionCharacters: [], cardCharacters: [], cardOutcomes: [] };
    let cast = makeCast(main);
    // Return unused cast capacity to the topical lane. Rebuild cast exclusions
    // against the ACTUAL final main selection, not the retrieval Top-K.
    main = makeMain(Math.max(0, available - estimateCastTokens(cast.text)));
    cast = makeCast(main);
    const text = wrap([state.text, main.text, cast.text].filter(Boolean).join('\n\n'));
    return { text, main, cast, state, budget, estimatedTokens: estimateCastTokens(text) };
}