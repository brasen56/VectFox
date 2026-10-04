/** One estimated-token envelope for the retrieval main lane and cast lane. */
import { estimateCastTokens, formatEventsForInjectionDetailed, formatCastHistoryDetailed } from './eventbase-injection.js';
import { resolveCastSetting } from './scene-cast-settings.js';

export const EVENTBASE_TOKEN_BUDGET_DEFAULT = 4000;

export function resolveEventBaseTokenBudget(settings = {}) {
    const value = Number(settings.eventbase_token_budget ?? EVENTBASE_TOKEN_BUDGET_DEFAULT);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : EVENTBASE_TOKEN_BUDGET_DEFAULT;
}

export function formatBudgetedEventBase({ events = [], settings = {}, globalContext = '', xmlTag = '', ...castOptions }) {
    const budget = resolveEventBaseTokenBudget(settings);
    const wrap = text => {
        if (!text) return '';
        if (globalContext) text = `${globalContext}\n\n${text}`;
        return xmlTag ? `<${xmlTag}>\n${text}\n</${xmlTag}>` : text;
    };
    // Reserve wrapper and lane separator costs. An oversized wrapper means no
    // injection, rather than silently exceeding the configured envelope.
    const overhead = estimateCastTokens(wrap('x')) + estimateCastTokens('\n\n');
    const available = Math.max(0, budget - overhead);
    const castReserve = castOptions.roster?.ready && castOptions.cast?.length
        ? Math.min(available, resolveCastSetting(settings, 'eventbase_cast_token_budget')) : 0;
    const makeMain = limit => events.length ? formatEventsForInjectionDetailed(events, settings, limit)
        : { text: '', events: [], includedCount: 0, compactEventIds: [] };
    let main = makeMain(available - castReserve);
    const makeCast = result => castOptions.roster?.ready
        ? formatCastHistoryDetailed({ ...castOptions, mainEvents: result.events || [],
            settings: { ...settings, eventbase_cast_token_budget: Math.min(resolveCastSetting(settings, 'eventbase_cast_token_budget'),
                Math.max(0, available - estimateCastTokens(result.text))) } })
        : { text: '', events: [], includedCount: 0, zeroInjectionCharacters: [], cardCharacters: [] };
    let cast = makeCast(main);
    // Return unused cast capacity to the topical lane. Rebuild cast exclusions
    // against the ACTUAL final main selection, not the retrieval Top-K.
    main = makeMain(Math.max(0, available - estimateCastTokens(cast.text)));
    cast = makeCast(main);
    const text = wrap([main.text, cast.text].filter(Boolean).join('\n\n'));
    return { text, main, cast, budget, estimatedTokens: estimateCastTokens(text) };
}