/**
 * Phase 1 contract for the optional context-token badge. No host imports,
 * tokenization, registry mutation, persistence, or UI work belongs here.
 *
 * Measure literal VectFox-owned extension_prompts values snapshotted when
 * GENERATION_ENDED fires. Include wrappers and formatting; sum separately
 * tokenized blocks, not a concatenated prompt. This is context contribution,
 * not provider billing or an exact marginal provider-request token count.
 *
 * Exclude embedding, summarization/extraction and planner requests, ordinary
 * history, native World Info and other extensions' prompt entries. Ghosting
 * savings are separate and must never be subtracted from the injection total.
 * See Doc/floating-token-badge.md for the complete measurement boundaries.
 */

import { EXTENSION_PROMPT_TAG, LOREBOOK_PROMPT_TAG } from './constants.js';

export const CONTEXT_TOKEN_CATEGORIES = Object.freeze({
    CHUNKBASE: 'chunkbase',
    EVENTBASE: 'eventbase',
    SUMMARIZER: 'summarizer',
    LOREBOOK: 'lorebook',
});

/**
 * User-facing contract only; rendering and lifecycle selection come later.
 * Disabled is driven by the master switch, never inferred from an empty
 * registry. Only a successful measurement may show zero; failed or unavailable
 * tokenization must show UNAVAILABLE, not ZERO. Counting has no distinct label.
 */
export const CONTEXT_TOKEN_DISPLAY = Object.freeze({
    DISABLED: 'VectFox: Disabled',
    UNMEASURED: 'VectFox: —',
    AVAILABLE: 'VectFox: ~{total} tokens',
    ZERO: 'VectFox: 0 tokens',
    UNAVAILABLE: 'VectFox: Count unavailable',
});

/**
 * Classify a registry key exactly once, independently of its value.
 * Ownership is the literal startsWith('3_vectfox') contract, not a search for
 * the tag inside a key. Unknown prefixed keys each retain their full tag as a
 * distinct category ID, so future injection routes cannot silently disappear.
 * Position groups use the writer's numeric suffix, with no upper limit.
 *
 * @param {string} tag - extension_prompts registry key
 * @returns {{category: string, label: string}|null} null for non-owned keys
 */
export function classifyContextTokenTag(tag) {
    if (typeof tag !== 'string' || !tag.startsWith(EXTENSION_PROMPT_TAG)) return null;

    const suffix = tag.slice(EXTENSION_PROMPT_TAG.length);
    if (!suffix) {
        return { category: CONTEXT_TOKEN_CATEGORIES.CHUNKBASE, label: 'ChunkBase — main injection' };
    }
    if (/^_pos\d+$/.test(suffix)) {
        return { category: CONTEXT_TOKEN_CATEGORIES.CHUNKBASE, label: `ChunkBase — position group ${suffix.slice(4)}` };
    }
    if (suffix === '_eventbase') {
        return { category: CONTEXT_TOKEN_CATEGORIES.EVENTBASE, label: 'EventBase retrieval' };
    }
    if (suffix === '_summarizer') {
        return { category: CONTEXT_TOKEN_CATEGORIES.SUMMARIZER, label: 'Summarizer injection (including bundled NPC state)' };
    }
    if (tag === LOREBOOK_PROMPT_TAG) {
        return { category: CONTEXT_TOKEN_CATEGORIES.LOREBOOK, label: 'Separate lorebook injection' };
    }
    return { category: tag, label: `Other VectFox injection (${tag})` };
}