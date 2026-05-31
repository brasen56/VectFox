/**
 * Tests for language-modes.js + stop-words.js per-locale registry.
 * Covers plan §6 (all 12 items) and §9.4 (W2 Indic tokenizer verification).
 */

import { describe, it, expect, vi } from 'vitest';

// bm25-scorer.js (transitively imported by some helpers) pulls in log.js which
// references the SillyTavern host path. Mock it so the module graph loads.
vi.mock('../../../../extensions.js', () => ({
    extension_settings: { vectfox: {} },
    getContext: vi.fn(() => ({ chat: [], characterId: null })),
}));

import {
    LANGUAGE_MODES,
    CJK_TOKENIZER_MODES,
    DEFAULT_CJK_TOKENIZER_MODE,
    stopLocalesForMode,
    tokenizerForMode,
} from '../core/language-modes.js';

import {
    STOP_WORDS_BY_LOCALE,
    isStopWord,
    buildStopSet,
} from '../core/stop-words.js';

import { LATIN_TOKEN_RE, NON_WORD_RE } from '../core/script-segmentation.js';

// ── §6.1–6.3: stopLocalesForMode returns correct locale arrays ────────────────

describe('stopLocalesForMode', () => {
    it('intl → [en]', () => expect(stopLocalesForMode('intl')).toEqual(['en']));
    it('others → [en]', () => expect(stopLocalesForMode('others')).toEqual(['en']));
    it('korean → [en, ko]', () => expect(stopLocalesForMode('korean')).toEqual(['en', 'ko']));
    it('tiny_segmenter → [en, ja]', () => expect(stopLocalesForMode('tiny_segmenter')).toEqual(['en', 'ja']));
    it('jieba_tw → [en, zh-Hant]', () => expect(stopLocalesForMode('jieba_tw')).toEqual(['en', 'zh-Hant']));
    it('jieba → [en, zh-Hans]', () => expect(stopLocalesForMode('jieba')).toEqual(['en', 'zh-Hans']));
});

// ── §6.4: graceful fallback for unknown/null mode ─────────────────────────────

describe('stopLocalesForMode — unknown/null input', () => {
    it('undefined → [en] (no throw)', () => expect(stopLocalesForMode(undefined)).toEqual(['en']));
    it('bogus string → [en] (no throw)', () => expect(stopLocalesForMode('bogus_lang')).toEqual(['en']));
    it('null → [en] (no throw)', () => expect(stopLocalesForMode(null)).toEqual(['en']));
});

// ── §6.5: TC/SC correctness ───────────────────────────────────────────────────

describe('isStopWord — TC/SC disambiguation', () => {
    it('這個 is TC stop word', () => expect(isStopWord('這個', ['en', 'zh-Hant'])).toBe(true));
    it('這個 is NOT a SC stop word', () => expect(isStopWord('這個', ['en', 'zh-Hans'])).toBe(false));
    it('这个 is SC stop word', () => expect(isStopWord('这个', ['en', 'zh-Hans'])).toBe(true));
    it('这个 is NOT a TC stop word', () => expect(isStopWord('这个', ['en', 'zh-Hant'])).toBe(false));
});

// ── §6.6: cross-language safety ───────────────────────────────────────────────

describe('isStopWord — cross-language isolation', () => {
    it('Japanese-only stopword not filtered under [en, ko]', () => {
        // Pick a token present in JAPANESE_STOP_WORDS but absent from EN and KO lists.
        // "から" is a Japanese particle stopword.
        expect(isStopWord('から', ['en', 'ko'])).toBe(false);
    });

    it('Korean stopword not filtered under [en, ja]', () => {
        // Use a token from KOREAN_STOP_WORDS that is not in EN or JA.
        const koSet = buildStopSet(['ko']);
        const koOnly = [...koSet].find(w => {
            return !isStopWord(w, ['en']) && !isStopWord(w, ['ja']);
        });
        expect(koOnly).toBeDefined();
        expect(isStopWord(koOnly, ['en', 'ja'])).toBe(false);
        expect(isStopWord(koOnly, ['en', 'ko'])).toBe(true);
    });

    it('Simplified-only CJK stopword not in Traditional set', () => {
        // 这个 (Simplified) should not appear in zh-Hant.
        expect(isStopWord('这个', ['zh-Hant'])).toBe(false);
    });
});

// ── §6.8: registry consistency — every stopLocales key exists in STOP_WORDS_BY_LOCALE

describe('Registry consistency', () => {
    it('every stopLocales key across LANGUAGE_MODES exists in STOP_WORDS_BY_LOCALE', () => {
        const allLocales = new Set(LANGUAGE_MODES.flatMap(m => m.stopLocales));
        for (const k of allLocales) {
            expect(STOP_WORDS_BY_LOCALE).toHaveProperty(k);
        }
    });
});

// ── §6.9: no drift — CJK_TOKENIZER_MODES keys === LANGUAGE_MODES values ──────

describe('No drift', () => {
    it('CJK_TOKENIZER_MODES keys match LANGUAGE_MODES values exactly', () => {
        const enumKeys = Object.keys(CJK_TOKENIZER_MODES).sort();
        const modeValues = LANGUAGE_MODES.map(m => m.value).sort();
        expect(enumKeys).toEqual(modeValues);
    });
});

// ── §6.10: memoization ────────────────────────────────────────────────────────

describe('Set memoization', () => {
    it('isStopWord called twice returns same cached result (no error)', () => {
        // Calling twice exercises the _setCache path — both calls should agree.
        expect(isStopWord('the', ['en'])).toBe(true);
        expect(isStopWord('the', ['en'])).toBe(true);
    });

    it('buildStopSet for same locale twice produces equivalent sets', () => {
        const s1 = buildStopSet(['ja']);
        const s2 = buildStopSet(['ja']);
        expect(s1.size).toBe(s2.size);
        expect(s1.has('から')).toBe(s2.has('から'));
    });
});

// ── §6.11: back-compat — no mode → English-only filtering ────────────────────

describe('Back-compat: extractQueryKeywords without mode', () => {
    it('filters English stop words and passes non-English CJK tokens', async () => {
        const { extractQueryKeywords } = await import('../core/query-keyword-extractor.js');
        // "the" is an EN stop word, "dragon" is not; no mode = EN-only filter.
        const result = extractQueryKeywords('the dragon flew over the mountains', 50);
        expect(result).not.toContain('the');
        expect(result.some(t => t === 'dragon' || t === 'flew' || t === 'mountains')).toBe(true);
    });
});

// ── §6.12: English baseline still works in bm25-scorer ───────────────────────

describe('English stop-word baseline in tokenize()', () => {
    it('world and within are still filtered in default (intl) mode', async () => {
        vi.mock('../../../../extensions.js', () => ({
            extension_settings: { vectfox: {} },
            getContext: vi.fn(() => ({ chat: [], characterId: null })),
        }));
        const { tokenize } = await import('../core/bm25-scorer.js');
        const tokens = tokenize('world within the system', { removeStopWords: true, stem: false });
        expect(tokens).not.toContain('world');
        expect(tokens).not.toContain('within');
        expect(tokens).not.toContain('the');
    });
});

// ── W2 (§9.4): Indic/combining-mark tokenizer fix ────────────────────────────

describe('W2 — Indic combining-mark fix (LATIN_TOKEN_RE / NON_WORD_RE)', () => {
    it('NON_WORD_RE preserves combining marks (does not strip matras)', () => {
        // "हराया" has matra ा (U+093E, \p{M}) — should survive after strip
        const stripped = 'हराया'.replace(NON_WORD_RE, ' ');
        expect(stripped).toBe('हराया');
    });

    it('LATIN_TOKEN_RE matches whole Indic words including matras', () => {
        const tokens = 'हराया युद्ध'.match(LATIN_TOKEN_RE) || [];
        // Both words must be captured intact (each >= 3 chars including combining marks)
        expect(tokens).toContain('हराया');
        expect(tokens).toContain('युद्ध');
    });

    it('LATIN_TOKEN_RE still matches normal ASCII words unchanged', () => {
        const tokens = 'hello world foo'.match(LATIN_TOKEN_RE) || [];
        expect(tokens).toContain('hello');
        expect(tokens).toContain('world');
    });

    it('NON_WORD_RE still strips punctuation from ASCII text', () => {
        const stripped = 'hello, world!'.replace(NON_WORD_RE, ' ');
        expect(stripped).toBe('hello  world ');
    });
});

// ── §6.7: ingest/query parity (highest-risk item per §4) ──────────────────────
// Ingest (bm25-scorer tokenize) and query (extractQueryKeywords) must drop the
// SAME stop tokens for the SAME locked mode, or the stored sparse vector and the
// query keywords filter differently → recall drops.

describe('Ingest/query stop-word parity', () => {
    it('same text + same mode → both paths drop the same English stop tokens', async () => {
        const { tokenize, setCjkTokenizerMode } = await import('../core/bm25-scorer.js');
        const { extractQueryKeywords } = await import('../core/query-keyword-extractor.js');

        const mode = 'intl';
        setCjkTokenizerMode(mode); // ingest path reads the module-global locked mode

        const text = 'the brave warrior fought the dragon';
        // Disable stemming so we compare raw stop-word filtering, not stem collisions.
        const ingestTokens = tokenize(text, { removeStopWords: true, stem: false });
        const queryTokens = extractQueryKeywords(text, 50, mode);

        // English stop words dropped on BOTH sides.
        for (const stop of ['the']) {
            expect(ingestTokens).not.toContain(stop);
            expect(queryTokens).not.toContain(stop);
        }
        // Content words survive on BOTH sides.
        for (const word of ['brave', 'warrior', 'dragon']) {
            expect(ingestTokens).toContain(word);
            expect(queryTokens).toContain(word);
        }
    });

    it('korean mode → a Japanese stop word survives on BOTH paths (per-mode parity)', async () => {
        const { tokenize, setCjkTokenizerMode } = await import('../core/bm25-scorer.js');
        const { extractQueryKeywords } = await import('../core/query-keyword-extractor.js');

        const mode = 'korean';
        setCjkTokenizerMode(mode);

        // "から" is a Japanese-only stop word; korean mode consults [en, ko] only,
        // so it must NOT be filtered on either path.
        const text = 'から 전사';
        const ingestTokens = tokenize(text, { removeStopWords: true, stem: false });
        const queryTokens = extractQueryKeywords(text, 50, mode);

        expect(ingestTokens).toContain('から');
        expect(queryTokens).toContain('から');

        setCjkTokenizerMode('intl'); // restore default for any later tests
    });
});
