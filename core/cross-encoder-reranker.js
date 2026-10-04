/** Optional external second pass, adapted from OpenVault's reranker client.
 * Never replaces stored events or the original weighted relevance scores.
 */
import { log } from './log.js';
import { resolveCrossEncoderTimeoutMs, resolveCrossEncoderMaxDocuments } from './cross-encoder-settings.js';

const warnedFailures = new Set();

function warnFailure(message) {
    log.warn(`[EventBase cross-encoder] ${message}; keeping the original relevance order.`);
    if (warnedFailures.has(message)) return;
    warnedFailures.add(message);
    try {
        toastr.warning(`${message}. EventBase memory still uses its original relevance order.`,
            'VectFox — cross-encoder reranker', { timeOut: 12000, extendedTimeOut: 4000 });
    } catch (_) { /* host toast unavailable in tests */ }
}

/** Explicit indices are mandatory for object rows: never guess document identity. */
export function parseCrossEncoderResults(payload, count) {
    let rows;
    if (Array.isArray(payload?.results)) rows = payload.results;
    else if (Array.isArray(payload?.data)) rows = payload.data;
    else if (Array.isArray(payload)) rows = payload;
    else throw new Error('Reranker returned an unsupported response');

    const numeric = rows.length === count && rows.every(score => typeof score === 'number' && Number.isFinite(score));
    const seen = new Set();
    const ranked = rows.map((row, i) => {
        const index = numeric ? i : row?.index ?? row?.document_index ?? row?.documentIndex;
        const score = numeric ? row : row?.relevance_score ?? row?.score ?? row?.relevanceScore;
        if (!Number.isInteger(index) || index < 0 || index >= count || seen.has(index)
            || typeof score !== 'number' || !Number.isFinite(score)) {
            throw new Error('Reranker returned invalid scores or document indices');
        }
        seen.add(index);
        return { index, score };
    });
    if (!ranked.length) throw new Error('Reranker returned no results');
    return ranked.sort((a, b) => b.score - a.score);
}

function documentText(event) {
    const content = String(event.summary || event.text || '').trim();
    if (!content) return '';
    const characters = Array.isArray(event.characters) ? event.characters.join(', ') : '';
    return [event.event_type, characters, content].filter(Boolean).join('\n');
}

/** Returns every candidate exactly once. Partial responses and capped tails
 * retain their original order after explicitly ranked documents.
 */
export async function rerankEventCandidates(events, query, settings = {}) {
    const meta = { enabled: settings.eventbase_cross_encoder_enabled === true, used: false, documentsSent: 0 };
    const fallback = { events, meta };
    if (!meta.enabled || !String(query || '').trim() || events.length < 2) return fallback;
    const candidates = events.map((event, position) => ({ event, position, text: documentText(event) }))
        .filter(candidate => candidate.text).slice(0, resolveCrossEncoderMaxDocuments(settings));
    if (candidates.length < 2) return fallback;

    const started = Date.now();
    const controller = new AbortController();
    let timer;
    try {
        const url = new URL(String(settings.eventbase_cross_encoder_api_url || '').trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw new Error('Reranker URL must be an HTTP(S) endpoint without credentials, query or fragment');
        }
        url.pathname = url.pathname.replace(/\/+$/, '');
        if (!url.pathname.endsWith('/rerank')) url.pathname += '/rerank';
        const headers = { 'Content-Type': 'application/json' };
        const apiKey = String(settings.eventbase_cross_encoder_api_key || '').trim();
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const body = { query: String(query).trim(), documents: candidates.map(candidate => candidate.text), top_n: candidates.length };
        const model = String(settings.eventbase_cross_encoder_model || '').trim();
        if (model) body.model = model;
        const timeoutMs = resolveCrossEncoderTimeoutMs(settings);
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`Reranker timed out after ${timeoutMs / 1000}s`));
                controller.abort();
            }, timeoutMs);
        });
        meta.documentsSent = candidates.length;
        const request = (async () => {
            const response = await fetch(url.href, {
                method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
                credentials: 'omit', redirect: 'error',
            });
            // Do not log response bodies: providers can echo credentials or story text.
            if (!response.ok) throw new Error(`Reranker API HTTP ${response.status}`);
            return parseCrossEncoderResults(await response.json(), candidates.length);
        })();
        const ranked = await Promise.race([request, timeout]);
        const positions = new Set(ranked.map(row => candidates[row.index].position));
        const ordered = ranked.map(row => ({ ...candidates[row.index].event, _crossEncoderScore: row.score }));
        ordered.push(...events.filter((_, position) => !positions.has(position)));
        meta.used = true;
        meta.resultsReturned = ranked.length;
        return { events: ordered, meta };
    } catch (error) {
        // Avoid embedding endpoint URLs/keys in diagnostics, including fetch errors.
        const detail = error?.message || '';
        meta.error = /^Reranker (?:API HTTP \d+|timed out after [\d.]+s|returned .+|URL must be .+)$/.test(detail)
            ? detail : 'Reranker request failed; check endpoint, browser CORS access and credentials';
        warnFailure(meta.error);
        return fallback;
    } finally {
        clearTimeout(timer);
        meta.durationMs = Date.now() - started;
    }
}