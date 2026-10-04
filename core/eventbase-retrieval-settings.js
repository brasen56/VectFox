export const EVENTBASE_RETRIEVAL_OVERFETCH_DEFAULT = 40;
export const EVENTBASE_RETRIEVAL_OVERFETCH_MAX = 200;

/** Candidate count per collection/query, never smaller than the final top-K. */
export function resolveEventBaseOverfetch(settings = {}) {
    const raw = Number(settings.eventbase_retrieval_overfetch);
    const count = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : EVENTBASE_RETRIEVAL_OVERFETCH_DEFAULT;
    const topK = Number(settings.eventbase_retrieval_top_k);
    return Math.max(Number.isFinite(topK) && topK > 0 ? Math.floor(topK) : 8,
        Math.min(EVENTBASE_RETRIEVAL_OVERFETCH_MAX, Math.max(1, count)));
}