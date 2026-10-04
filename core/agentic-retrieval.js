/**
 * ============================================================================
 * AGENTIC RETRIEVAL
 * ============================================================================
 * Optional pre-retrieval LLM planning step that consumes the existing pre-search
 * candidates plus recent chat context, then emits 1-4 targeted follow-up queries
 * which run in parallel against Qdrant. Results merge with the pre-search output
 * and re-flow through the existing 4-weight re-ranker untouched.
 *
 * Purely additive — never replaces the existing flow. Every failure path falls
 * back cleanly to the pre-search output. Qdrant (A3) only.
 *
 * Planner object queries carry their own characters_any scope; legacy strings
 * inherit global filters. Validated filters reach supported native-hybrid calls
 * when agentic_filters_enabled is true. Query provenance survives identity
 * merging so the final trim can reserve each query's best surviving hit.
 *   - OpenRouter only. vLLM support is Phase 2.
 *
 * @see plans/agentic-retrieval-plan.md
 * ============================================================================
 */

import { getContext } from '../../../../extensions.js';
import { retrieveEvents, finalizeDeferredCrossEncoder } from './eventbase-retrieval.js';
import { queryCollection, supportsCollectionFilters } from './core-vector-api.js';
import { getCharacterRoster, normalizeCharacterName } from './character-roster.js';
import { warnUnsupportedFilters } from './search-filter-support.js';
import { resolveEventBaseOverfetch } from './eventbase-retrieval-settings.js';
import { buildPlannerUserMessage, getAgenticPlannerPrompt } from './prompts-i18n.js';
import { stripReasoningBlocks, stripGameSystemBlocks } from './text-cleaning.js';
import { getOpenRouterApiKey, getCustomApiKey } from './api-keys.js';
import { postChatCompletion, resolveModelParameterStyle, LlmCallError } from './llm-provider-call.js';
import { generationRateLimiter, generationRateLimitSettings } from './generation-rate-limiter.js';
import { resolveAgenticPlannerTimeoutMs, resolveAgenticQueryTimeoutMs, resolveAgenticMaxTokens } from './retrieval-budget.js';
import { log } from './log.js';
import { summarizePlannerQueries } from './eventbase-retrieval-debug.js';

// ============================================================================
// Public API
// ============================================================================

/**
 * Agentic wrapper around retrieveEvents. When `agentic_retrieval_enabled` is
 * true AND backend is Qdrant, calls the planner LLM, fans out its queries in
 * parallel, merges results with the pre-search output, and re-runs the
 * canonical re-ranker via retrieveEvents(skipLiveQuery: true).
 *
 * When agentic is disabled or unavailable, returns the unmodified pre-search
 * result so callers can use this as a drop-in replacement for retrieveEvents.
 *
 * @param {object} params - Same shape as retrieveEvents params; this function
 *        runs the pre-search itself before the planner sees the candidates.
 * @returns {Promise<{events: object[], candidates: object[], debug: object}>}
 */
export async function retrieveEventsWithAgent(params) {
    const { settings } = params;
    const agenticDebug = log.domainEnabled('agent');
    const tAgentStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // STAGE 1 — existing pre-search runs unconditionally.
    const deferCrossEncoder = settings?.eventbase_cross_encoder_enabled === true
        && settings?.agentic_retrieval_enabled && settings.vector_backend === 'qdrant' && !params.skipCrossEncoder;
    const preSearch = await retrieveEvents(deferCrossEncoder ? { ...params, skipCrossEncoder: true } : params);
    const finishPreSearch = () => deferCrossEncoder ? finalizeDeferredCrossEncoder(preSearch, params) : preSearch;

    // STAGE 2 — early exit if agentic is off or backend isn't Qdrant.
    if (!settings?.agentic_retrieval_enabled) {
        return finishPreSearch();
    }
    if (settings.vector_backend !== 'qdrant') {
        if (agenticDebug) {
            log.domain('agent', 'lifecycle', '[VectFox-Agentic] mode=SKIPPED reason=requires_qdrant_backend');
        }
        return finishPreSearch();
    }

    // STAGE 3 — gather context for planner and call LLM.
    const { liveCollectionIds, keywordQuery, searchText, additionalCandidates } = params;
    const llmCfg = _resolveAgenticLLMConfig(settings);
    if (!llmCfg.ok) {
        if (agenticDebug) {
            log.warn(`[VectFox-Agentic] mode=SKIPPED reason=${llmCfg.reason}`);
        }
        return finishPreSearch();
    }

    if (agenticDebug) {
        const topScore = preSearch.events?.[0]?._finalScore ?? preSearch.events?.[0]?.score ?? 0;
        log.domain('agent', 'lifecycle', `[VectFox-Agentic] mode=ON  trigger=user_message_len=${(keywordQuery || '').length}`);
        log.domain('agent', 'lifecycle', `[VectFox-Agentic] Pre-search returned ${preSearch.events?.length || 0} candidates (top score=${typeof topScore === 'number' ? topScore.toFixed(3) : '—'})`);
    }

    const recentTurns = _getRecentChatForPlanner(settings);
    if (agenticDebug) {
        log.domain('agent', 'lifecycle', `[VectFox-Agentic] Past chat turns sent to planner: ${recentTurns.length}`);
        log.domain('agent', 'verbose', '[VectFox-Agentic] Narrative context preview (one ~50-word snippet per turn):');
        recentTurns.forEach((turn, idx) => {
            const label = `[-${recentTurns.length - idx}]`;
            const snippet = _firstNWords(turn.text || '', 50);
            log.domain('agent', 'trace', `  ${label} ${turn.speaker}: ${snippet}`);
        });
    }

    const candidatesToShow = Math.max(1, Math.min(20, settings.agentic_retrieval_candidates_to_show || 12));
    const candidates = (preSearch.events || []).slice(0, candidatesToShow);

    const userMessage = buildPlannerUserMessage({
        recentTurns,
        userMessage: keywordQuery || '',
        candidates,
    });

    if (agenticDebug) {
        // Prompt size only — the full prompt is intentionally NOT dumped to keep
        // the log readable. The narrative-context preview above already shows
        // what the planner sees per turn; the static system prompt lives in
        // core/agentic-prompt.js for inspection.
        const systemPromptText = getAgenticPlannerPrompt(settings?.cjk_tokenizer_mode);
        const approxTokens = Math.round((systemPromptText.length + userMessage.length) / 4);
        log.domain('agent', 'lifecycle', `[VectFox-Agentic] LLM prompt size: system+user approx ${approxTokens} tokens (${systemPromptText.length}+${userMessage.length} chars)`);
    }

    const timeoutMs = resolveAgenticPlannerTimeoutMs(settings);
    let plan;
    const tLlmStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
        // Throttle the planner LLM call. Shares one budget with EventBase
        // extraction and NPC cards via generationRateLimiter (same
        // chat-completions provider). 0 = off. The outer retrieval bound allots
        // this stage one planner timeout, so time spent waiting for a slot comes
        // out of the call's timeout. A planner that cannot start with at least
        // half of it left is dropped unsent and falls back to pre-search, rather
        // than overrunning the bound (which would drop EventBase injection) or
        // spending quota on a result nobody waits for.
        const stageEnd = Date.now() + timeoutMs;
        plan = await generationRateLimiter.execute(
            () => _callPlanner({
                systemPrompt: getAgenticPlannerPrompt(settings?.cjk_tokenizer_mode),
                userMessage,
                llmCfg,
                timeoutMs: Math.max(1, stageEnd - Date.now()),
                maxTokens: resolveAgenticMaxTokens(settings),
            }),
            generationRateLimitSettings(settings),
            'agent',
            { deadline: stageEnd - timeoutMs / 2 },
        );
    } catch (err) {
        const tLlmMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tLlmStart));
        // A retired/unknown Agent Mode model would otherwise silently degrade to
        // pre-search forever. Warn the user (once) so they know to fix it; we still
        // fall back to pre-search below so retrieval keeps working in the meantime.
        const { isInvalidModelConfigError, notifyInvalidModel } = await import('./model-config-notifier.js');
        if (isInvalidModelConfigError(err)) {
            notifyInvalidModel(err.message);
        }
        // Matched by name: several tests mock the limiter module without the class.
        if (err?.name === 'GenerationQueueTimeoutError') {
            log.warn(`[VectFox-Agentic] Planner not sent: the shared generation rate limit had no free slot within ${tLlmMs}ms. Using pre-search only. Raise the generation rate limit if this repeats.`);
            return finishPreSearch();
        }
        // AbortSignal.timeout() throws either a TimeoutError or a generic
        // "user aborted a request" message depending on the runtime. Detect both
        // and surface a clearer log line so timeout vs. real error is obvious.
        const isTimeout =
            err?.name === 'TimeoutError' ||
            err?.name === 'AbortError' ||
            /aborted|timeout|timed out/i.test(err?.message || '');
        if (isTimeout) {
            log.warn(`[VectFox-Agentic] Planner LLM call TIMED OUT after ${tLlmMs}ms (configured limit: ${timeoutMs}ms). Falling back to pre-search only. Bump "Planner LLM Timeout" in the AgentMode tab if your model needs longer.`);
        } else {
            log.warn(`[VectFox-Agentic] Planner LLM call failed after ${tLlmMs}ms, using pre-search only: ${err?.message || err}`);
        }
        return finishPreSearch();
    }
    const tLlmMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tLlmStart));

    if (agenticDebug) {
        // Surface real token usage from the API response (when the provider
        // returns it — OpenRouter/OpenAI-compatible APIs do). The chars/4
        // estimate above is a rough guess; this is the truth from the provider.
        const usage = plan && plan.__usage;
        if (usage && usage.prompt_tokens != null) {
            const tokPerSec = usage.completion_tokens != null && tLlmMs > 0
                ? (usage.completion_tokens / (tLlmMs / 1000)).toFixed(1)
                : '—';
            log.domain('agent', 'verbose', `[VectFox-Agentic] LLM call complete: ${tLlmMs}ms — prompt=${usage.prompt_tokens} tok, completion=${usage.completion_tokens ?? '?'} tok, total=${usage.total_tokens ?? '?'} tok (${tokPerSec} tok/s output)`);
        } else {
            log.domain('agent', 'verbose', `[VectFox-Agentic] LLM call complete: ${tLlmMs}ms (provider did not return usage data)`);
        }
        log.domain('agent', 'verbose', '[VectFox-Agentic] Planner output:');
        log.domain('agent', 'verbose', JSON.stringify(plan, null, 2));
    }

    // Expose detections independently of filter enablement and query success.
    const characterLists = [plan?.filters?.characters_any,
        ...(Array.isArray(plan?.queries) ? plan.queries.map(query => query?.characters_any) : [])];
    preSearch.debug = { ...preSearch.debug, plannerCharacters: [...new Set(characterLists
        .filter(Array.isArray).flat().filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()))] };

    // Validate planner output.
    const maxQueries = Math.max(1, Math.min(6, settings.agentic_retrieval_max_queries || 6));
    const validatedQueries = _validateAndTrimQueries(plan?.queries, maxQueries, plan?.filters);
    if (validatedQueries.length === 0) {
        if (agenticDebug) {
            log.domain('agent', 'lifecycle', '[VectFox-Agentic] Planner returned 0 valid queries — falling back to pre-search only');
        }
        return finishPreSearch();
    }

    // STAGE 4 — run planner queries in parallel against all live collections.
    if (!liveCollectionIds?.length) {
        if (agenticDebug) {
            log.domain('agent', 'lifecycle', '[VectFox-Agentic] No live collections to query — falling back to pre-search only');
        }
        return finishPreSearch();
    }

    const ebSettings = {
        ...settings,
        keyword_scoring_method: settings.eventbase_keyword_scoring_method || 'bm25',
    };
    const topK = resolveEventBaseOverfetch(settings);

    const roster = getCharacterRoster(liveCollectionIds, settings);
    const queryFilters = validatedQueries.map(query => _validatePlannerFilters({
        ...plan?.filters, characters_any: query.characters_any,
    }, settings, roster));
    const hasPlannerFilters = queryFilters.some(filters => Object.keys(filters).length > 0);
    if (agenticDebug) {
        if (!hasPlannerFilters) {
            log.domain('agent', 'verbose', '[VectFox-Agentic] Planner filters: (none — running unfiltered)');
        } else {
            log.domain('agent', 'verbose', `[VectFox-Agentic] Per-query filters requested: ${JSON.stringify(queryFilters)}`);
        }
    }

    // Per-query timeout: the fanout runs in parallel, so the whole retrieval
    // waits on the SLOWEST query. A single embed/search latency spike (e.g. the
    // shared embedding provider stalling) could otherwise freeze the turn for
    // tens of seconds. Cap each query; a straggler is dropped and the other
    // queries' results still flow through. queryCollection has no abort hook, so
    // the underlying request keeps running — we just stop awaiting it.
    const queryTimeoutMs = resolveAgenticQueryTimeoutMs(settings);
    const tFanoutStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const fanoutPromises = [];
    for (const colId of liveCollectionIds) {
        // Share one capability lookup per collection, but never gate other
        // collections on it. Each task's deadline includes this lookup.
        let capabilityResolved = !hasPlannerFilters;
        const filterSupport = (async () => {
            if (!hasPlannerFilters) return true;
            try {
                const supported = await supportsCollectionFilters(colId, ebSettings);
                if (!supported) warnUnsupportedFilters();
                return supported;
            } catch (err) {
                log.warn(`[VectFox-Agentic] Could not check filter support (${colId}): ${err?.message || err}`);
                warnUnsupportedFilters();
                return false;
            } finally {
                capabilityResolved = true;
            }
        })();
        for (const [queryIndex, query] of validatedQueries.entries()) {
            const queryText = query.query;
            const plannerFilters = queryFilters[queryIndex];
            let expired = false;
            const queryTask = (async () => {
                const supported = Object.keys(plannerFilters).length ? await filterSupport : true;
                // A timeout cannot cancel the lookup. Do not dispatch a late
                // query if it eventually resolves after this task was dropped.
                if (expired) return { hashes: [], metadata: [] };
                return queryCollection(colId, queryText, topK, ebSettings, supported ? plannerFilters : {});
            })();
            fanoutPromises.push(
                _raceWithTimeout(queryTask, queryTimeoutMs)
                    .then(({ hashes, metadata }) => {
                        if (!hashes?.length) return { queryIndex, queryText, hits: [] };
                        // _sortFrame tags these live-collection hits with their source
                        // collection so the injector groups them into the same frame as
                        // the pre-search live events before the chronological sort.
                        const hits = metadata.map((meta, i) => ({ ...meta, _hash: hashes[i], _sortFrame: colId,
                            _plannerQueryIndices: [queryIndex] }));
                        return { queryIndex, queryText, hits };
                    })
                    .catch(err => {
                        if (err?.__timeout) {
                            expired = true;
                            if (!capabilityResolved) warnUnsupportedFilters();
                            log.warn(`[VectFox-Agentic] Query timed out after ${queryTimeoutMs}ms (${colId}, "${queryText}") — dropped; other queries still count. Raise "Per-query Timeout" in the AgentMode tab if needed.`);
                        } else {
                            log.warn(`[VectFox-Agentic] Query failed (${colId}, "${queryText}"): ${err?.message || err}`);
                        }
                        return { queryIndex, queryText, hits: [], error: err?.__timeout ? 'timeout' : 'failed' };
                    })
            );
        }
    }
    const fanoutResults = await Promise.all(fanoutPromises);
    const tFanoutMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tFanoutStart));

    const agenticHits = fanoutResults.flatMap(r => r.hits);

    if (agenticDebug) {
        log.domain('agent', 'verbose', `[VectFox-Agentic] Qdrant fanout: ${validatedQueries.length} queries × ${liveCollectionIds.length} collection(s) = ${fanoutPromises.length} parallel calls`);
        log.domain('agent', 'verbose', `[VectFox-Agentic] Qdrant fanout complete: ${tFanoutMs}ms`);
        log.domain('agent', 'verbose', '[VectFox-Agentic] Per-query hits:');
        fanoutResults.forEach((r, i) => {
            const topScore = r.hits[0]?.score ?? r.hits[0]?.vectorScore ?? 0;
            log.domain('agent', 'trace', `  Q${i + 1} "${r.queryText.slice(0, 60)}" → ${r.hits.length} hits (top score=${typeof topScore === 'number' ? topScore.toFixed(3) : '—'})`);
        });
        const preSearchIds = new Set((preSearch.events || []).map(e => e.event_id ?? e._hash));
        const newHits = agenticHits.filter(h => !preSearchIds.has(h.event_id ?? h._hash));
        log.domain('agent', 'lifecycle', `[VectFox-Agentic] Agentic-only hits (not already in pre-search): ${newHits.length}`);
    }

    // STAGE 5 — re-feed merged candidates through retrieveEvents for canonical rerank.
    // Keep the post-dedup, pre-trim pool, including surviving archive events.
    // Do not reintroduce archive candidates already rejected by the pre-search.
    // Fall back to the old result shape for callers supplying legacy results.
    const mergedAdditional = [
        ...(preSearch.candidates ?? [...(additionalCandidates || []), ...(preSearch.events || [])]),
        ...agenticHits,
    ];

    const final = await retrieveEvents({
        ...params,
        liveCollectionIds: [],          // already searched; skip live query in stage 5
        additionalCandidates: mergedAdditional,
        skipLiveQuery: true,
    });

    const tTotalMs = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tAgentStart));
    if (agenticDebug) {
        log.domain('agent', 'lifecycle', `[VectFox-Agentic] Final merged candidates: ${(preSearch.candidates || preSearch.events || []).length} pre-search + ${agenticHits.length} agentic = ${mergedAdditional.length} total → ${final.events?.length || 0} after rerank/dedup/trim`);
        log.domain('agent', 'lifecycle', `[VectFox-Agentic] Total wall-clock for agent overhead: ${tTotalMs}ms (LLM=${tLlmMs}ms, fanout=${tFanoutMs}ms)`);
    }

    // Annotate debug so callers can detect agentic mode in diagnostics.
    return {
        events: final.events,
        candidates: final.candidates,
        debug: {
            ...(final.debug || {}),
            // Keep pre-search cuts visible; the final pass is authoritative for
            // candidates encountered again (including all pre-search survivors).
            candidateOutcomes: {
                ...(preSearch.debug?.candidateOutcomes || {}),
                ...(final.debug?.candidateOutcomes || {}),
            },
            preSearchCandidateOutcomes: preSearch.debug?.candidateOutcomes || {},
            plannerQuerySummary: summarizePlannerQueries(validatedQueries, fanoutResults, final.events || []),
            agenticMode: true,
            plannerCharacters: preSearch.debug.plannerCharacters,
            agenticQueries: validatedQueries.map(query => query.query),
            agenticQueryFilters: queryFilters,
            agenticRationale: typeof plan?.rationale === 'string' ? plan.rationale : null,
            agenticLLMMs: tLlmMs,
            agenticFanoutMs: tFanoutMs,
            agenticTotalMs: tTotalMs,
            agenticHitCount: agenticHits.length,
        },
    };
}

// ============================================================================
// LLM planner call
// ============================================================================

/**
 * Resolve the effective LLM config for the planner. Reads agentic_retrieval_*
 * settings; falls back to summarize_* values when the agentic field is empty.
 *
 * Returns { ok: true, provider, model, apiKey, vllmUrl } on success, or
 * { ok: false, reason } when a required value is missing.
 */
export function _resolveAgenticLLMConfig(settings = {}) {
    const provider = (settings.agent_provider || settings.chat_provider || 'openrouter').toLowerCase();
    const model = (settings.agent_model || settings.chat_model || '').trim();

    if (!model) {
        return { ok: false, reason: 'missing_model' };
    }

    if (provider === 'openrouter') {
        // Single shared OpenRouter key (SECRET_KEYS.OPENROUTER). The
        // AgentMode-specific "override" slot was removed when the
        // architecture pivoted to one key per provider — see
        // core/api-keys.js docstring for rationale. The UI's
        // "(empty → inherit summarize key)" placeholder is now a
        // no-op visual hint; all three inputs (embedding/summarize/
        // agentic) write the same SECRET_KEYS.OPENROUTER slot.
        const apiKey = getOpenRouterApiKey(settings);
        if (!apiKey) {
            return { ok: false, reason: 'missing_openrouter_api_key' };
        }
        return { ok: true, provider, model, apiKey, parameterStyle: resolveModelParameterStyle(settings) };
    }

    if (provider === 'vllm') {
        const vllmUrl = (settings.agent_vllm_url || settings.chat_vllm_url || '').trim();
        if (!vllmUrl) {
            return { ok: false, reason: 'missing_vllm_url' };
        }
        // Key lives in SECRET_KEYS.CUSTOM (masked client-side). getCustomApiKey
        // returns the masked presence indicator; real key is read server-side
        // by ST's chat-completions proxy. Same shared slot as summarize/agent.
        const apiKey = getCustomApiKey(settings);
        if (!apiKey) {
            return { ok: false, reason: 'missing_vllm_api_key' };
        }
        return { ok: true, provider, model, vllmUrl, apiKey, parameterStyle: resolveModelParameterStyle(settings) };
    }

    return { ok: false, reason: `unknown_provider_${provider}` };
}

/**
 * Call the planner LLM and return parsed JSON output.
 * Throws on network/auth failure, empty response, or unparseable JSON.
 */
async function _callPlanner({ systemPrompt, userMessage, llmCfg, timeoutMs, maxTokens }) {
    // Shared HTTP + response classification (llm-provider-call.js). The planner
    // is a two-message, json_object call. authBranch:false preserves the prior
    // behavior of folding 401/403 into the model-config / generic paths (Agent
    // Mode had no dedicated auth branch — it degrades to pre-search upstream).
    let content, usage;
    try {
        ({ content, usage } = await postChatCompletion({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage },
            ],
            model: llmCfg.model,
            provider: llmCfg.provider,
            vllmUrl: llmCfg.vllmUrl || '',
            maxTokens,
            temperature: 0.2,
            timeoutMs,
            responseFormat: { type: 'json_object' },
            contextLabel: 'Agent Mode',
            authBranch: false,
            ...(llmCfg.parameterStyle || {}),
        }));
    } catch (e) {
        if (e instanceof LlmCallError) {
            const err = new Error(e.message);
            if (e.kind === 'model_config') err.code = 'invalid_model_config';
            throw err;
        }
        throw e;
    }

    // A thinking model emits its reasoning BEFORE the JSON — `<think>…</think>{…}`
    // — and `response_format: json_object` does not stop it. Left in, that leading
    // block fails JSON.parse and Agent Mode silently drops to pre-search, which is
    // the shape GitHub issue #18 was reported in. `should_disable_thinking` sends
    // `reasoning_effort: 'none'`, but that is a REQUEST: plenty of models ignore
    // it, and a 200 response never proves the parameter took effect. So strip
    // unconditionally rather than trusting the switch — same reasoning as the
    // stripReasoningBlocks() docstring, which is already unconditional for
    // exactly this class of failure.
    // Runs BEFORE the fence strip: a fenced reply reads ```json…``` only once the
    // reasoning ahead of it is gone.
    const withoutReasoning = stripReasoningBlocks(String(content));
    // Some providers wrap in markdown fences despite response_format=json_object.
    const cleaned = withoutReasoning.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (err) {
        throw new Error(`Planner output is not valid JSON: ${err.message}. Got: ${cleaned.slice(0, 200)}`);
    }

    // Attach usage as a non-enumerable property so callers can read it without
    // polluting the planner JSON contract (queries / filters / rationale).
    Object.defineProperty(parsed, '__usage', { value: usage, enumerable: false });
    return parsed;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve/reject with whichever settles first: the wrapped promise, or a timeout
 * that rejects with an error tagged `__timeout` after `ms`. Used to bound each
 * parallel fanout query so one slow Qdrant/embedding call can't stall the turn.
 * The timer is always cleared so a fast resolve doesn't leak a pending timeout.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function _raceWithTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error(`query timed out after ${ms}ms`);
            err.__timeout = true;
            reject(err);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Read recent non-system chat turns from getContext().chat. Source of "what
 * has been happening" context for the planner, independent from the embedding-
 * search's searchText parameter.
 */
function _getRecentChatForPlanner(settings) {
    const chat = getContext().chat || [];
    const depth = Math.max(1, Math.min(50, settings.agentic_retrieval_chat_depth || 3));
    return chat
        .filter(m => !m.is_system)
        .slice(-depth)
        .map(m => ({
            speaker: m.is_user ? '{{user}}' : (m.name || '{{character}}'),
            // Reduce each turn to narrative for the planner: drop the model's
            // <think>/planning blocks (chain-of-thought that names off-screen
            // characters and meta plot lines) and the MVU game-system blocks
            // (<UpdateVariable>/<JSONPatch>/<combat_log> bookkeeping). Otherwise
            // they dominate the 600-char per-turn budget and steer the queries.
            text: stripGameSystemBlocks(stripReasoningBlocks((m.mes || '').toString())),
        }));
}

/**
 * Take the first N whitespace-delimited words. Used for the debug-log
 * narrative-context preview (~50 words per turn).
 */
function _firstNWords(text, n) {
    if (!text) return '';
    const trimmed = String(text).replace(/\s+/g, ' ').trim();
    if (!trimmed) return '';
    const parts = trimmed.split(' ');
    if (parts.length <= n) return trimmed;
    return parts.slice(0, n).join(' ') + '...';
}

/**
 * Sanitize planner-emitted filters. Drops unknown keys, trims arrays to a
 * reasonable max, strips lead groups and expands NPC aliases. importance_gte
 * is omitted unless the legacy hard cutoff is enabled, then clamped to 1-10.
 * Returns {} on empty / invalid
 * input so callers can check `Object.keys(out).length === 0`.
 */
export function _validatePlannerFilters(raw, settings, roster = { groups: [] }) {
    if (!raw || typeof raw !== 'object') return {};
    if (settings?.agentic_filters_enabled === false) return {};

    const MAX_VALUES_PER_FIELD = 8;
    const out = {};
    const arrayFields = ['characters_any', 'locations_any', 'factions_any',
        'items_any', 'concepts_any', 'event_type_any'];
    for (const key of arrayFields) {
        const v = raw[key];
        if (Array.isArray(v) && v.length > 0) {
            const cleaned = [...new Set(
                v.filter(x => typeof x === 'string')
                 .map(x => x.trim())
                 .filter(x => x.length > 0)
            )].slice(0, MAX_VALUES_PER_FIELD);
            if (cleaned.length > 0) out[key] = cleaned;
        }
    }
    if (out.characters_any) {
        const expanded = out.characters_any.flatMap(name => {
            const key = normalizeCharacterName(name);
            const groups = roster.groups.filter(group => [group.name, ...group.aliases]
                .some(alias => normalizeCharacterName(alias) === key));
            if (groups.some(group => group.isLead)) return [];
            return groups.length ? groups.flatMap(group => group.aliases) : [name];
        });
        if (expanded.length) out.characters_any = [...new Set(expanded)];
        else delete out.characters_any;
    }
    if (settings?.agentic_importance_hard_filter === true && typeof raw.importance_gte === 'number' && Number.isFinite(raw.importance_gte)) {
        out.importance_gte = Math.max(1, Math.min(10, Math.round(raw.importance_gte)));
    }
    return out;
}

/**
 * Normalize object queries and legacy strings. Objects own their character
 * scope (missing/empty means unscoped); strings inherit the legacy global list.
 * Deduplicate by text AND character scope so distinct subjects remain separate.
 */
export function _validateAndTrimQueries(queries, maxQueries, legacyFilters) {
    if (!Array.isArray(queries)) return [];
    const seen = new Set();
    const out = [];
    for (const q of queries) {
        const text = typeof q === 'string' ? q : q?.query;
        if (typeof text !== 'string') continue;
        const trimmed = text.trim();
        if (trimmed.length < 3 || trimmed.length > 300) continue;
        const rawCharacters = typeof q === 'string' ? legacyFilters?.characters_any : q?.characters_any;
        const characters = Array.isArray(rawCharacters) ? [...new Set(rawCharacters
            .filter(name => typeof name === 'string').map(name => name.trim()).filter(Boolean))].slice(0, 8) : [];
        const key = JSON.stringify([trimmed.toLowerCase(), [...new Set(characters.map(normalizeCharacterName))].sort()]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ query: trimmed, characters_any: characters });
        if (out.length >= maxQueries) break;
    }
    return out;
}
