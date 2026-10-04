import { describe, it, expect, vi } from 'vitest';
vi.mock('../core/log.js', () => ({ log: { warn: vi.fn() } }));
import { resolveEventBaseOverfetch } from '../core/eventbase-retrieval-settings.js';
import { filtersReachBackend, warnUnsupportedFilters } from '../core/search-filter-support.js';

describe('Phase 3A retrieval settings', () => {
    it('uses an absolute pool default and validates saved settings', () => {
        expect(resolveEventBaseOverfetch()).toBe(40);
        for (const value of [0, -2, 'invalid', Infinity]) {
            expect(resolveEventBaseOverfetch({ eventbase_retrieval_overfetch: value })).toBe(40);
        }
        expect(resolveEventBaseOverfetch({ eventbase_retrieval_overfetch: '55.9' })).toBe(55);
        expect(resolveEventBaseOverfetch({ eventbase_retrieval_overfetch: 999 })).toBe(200);
        expect(resolveEventBaseOverfetch({ eventbase_retrieval_overfetch: 1, eventbase_retrieval_top_k: 32 })).toBe(32);
    });
    it('requires native support and native preference even in hybrid mode', () => {
        expect(filtersReachBackend({}, true)).toBe(true);
        expect(filtersReachBackend({}, false)).toBe(false);
        expect(filtersReachBackend({ hybrid_native_prefer: false, keyword_scoring_method: 'bm25' }, true)).toBe(false);
        expect(filtersReachBackend({ hybrid_native_prefer: false, keyword_scoring_method: 'hybrid' }, true)).toBe(false);
    });
    it('warns visibly once per session', () => {
        vi.stubGlobal('toastr', { warning: vi.fn() });
        warnUnsupportedFilters();
        warnUnsupportedFilters();
        expect(toastr.warning).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });
});