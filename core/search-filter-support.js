import { log } from './log.js';

/** Only native hybrid dispatch forwards payload filters to the backend. */
export function filtersReachBackend(settings, nativeHybridAvailable) {
    return nativeHybridAvailable === true && settings?.hybrid_native_prefer !== false;
}

let warned = false;

/** One visible warning per session, independent of debug logging. */
export function warnUnsupportedFilters() {
    if (warned) return;
    warned = true;
    const message = 'Planner filters are disabled on this search path. Enable native hybrid search on Qdrant to apply them. Agent queries will continue unfiltered.';
    log.warn(`[VectFox] ${message}`);
    if (typeof toastr !== 'undefined') {
        toastr.warning(message, 'VectFox — planner filters unavailable');
    }
}