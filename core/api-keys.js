/**
 * ============================================================================
 * VectFox API KEY HELPERS
 * ============================================================================
 *
 * Single source of truth for resolving API keys at runtime, and the
 * one-shot migration that moved them from `extension_settings.vectfox.*`
 * plaintext to SillyTavern's `secret_state`.
 *
 * Background (2026-05-24, external code review item H-1):
 *
 * VectFox originally stored summarize_openrouter_api_key and
 * summarize_vllm_api_key as plain strings in settings.json — alongside
 * non-secret config. That meant:
 *   1. Keys persisted unencrypted to disk, visible to anyone with file
 *      access (backup, screenshot, git accident).
 *   2. The same key value got logged into diagnostic prints as a
 *      truthy/falsy check (`hasOpenRouterKey: !!settings.X`), which is
 *      benign but the underlying field was still plaintext.
 *
 * Fix: store these via `writeSecret(slot, value)` into ST's secret_state,
 * read via the same in-memory `secret_state` map. Plaintext settings
 * field is cleared on first load via `migrateLegacyApiKeys` (idempotent —
 * empty settings field on subsequent loads is a no-op).
 *
 * Why TWO new dedicated slots instead of reusing `SECRET_KEYS.OPENROUTER`:
 * a user may legitimately want different keys for the embedding side
 * (ST core's OpenRouter slot, used by the embedding section's UI) versus
 * the summarization side (this new dedicated slot). Different rate-limit
 * tiers, different accounts. The fallback to SECRET_KEYS.OPENROUTER
 * preserves the legacy UX where a user with only the embedding key set
 * gets the same key for summarization automatically.
 *
 * Reader fallback order (per key):
 *   1. Dedicated summarize slot in secret_state — post-migration canonical
 *   2. Legacy plaintext in settings.json — only non-empty in the brief
 *      window between user upgrade and first `migrateLegacyApiKeys` run
 *   3. (OpenRouter only) ST core's SECRET_KEYS.OPENROUTER — the embedding
 *      key, preserved as the "user only set embedding, summarize inherits"
 *      shortcut from pre-H-1 behavior.
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { SECRET_KEYS, secret_state, writeSecret, readSecretState } from '../../../../secrets.js';

// Dedicated slot names — keep in sync with the writeSecret() calls in
// ui-manager.js summarize sections. Constants here so a typo can't drift
// between writer and reader.
export const SUMMARIZE_OPENROUTER_SECRET_SLOT = 'summarize_openrouter_api_key';
export const SUMMARIZE_VLLM_SECRET_SLOT = 'summarize_vllm_api_key';

// AgentMode (Agentic Retrieval) optional override slots. When the user
// sets one of these, the agentic-retrieval planner uses it instead of
// inheriting the summarize key. Same H-1 storage migration applies.
export const AGENTIC_OPENROUTER_SECRET_SLOT = 'agentic_retrieval_openrouter_api_key';
export const AGENTIC_VLLM_SECRET_SLOT = 'agentic_retrieval_vllm_api_key';

/**
 * Extract the actual key value from a `secret_state[slot]` entry.
 *
 * `secret_state` schema varies by ST version / secret backend — observed
 * in production: array-of-secrets shape used by SECRET_KEYS.OPENROUTER
 * (multiple keys with `.active` / `.value` per entry) AND simpler string
 * or object shapes for other slots. Defensive against all three.
 *
 * An earlier code review (item L-9) claimed `secret_state[KEY]` returns
 * a boolean — verified false: the embedding section's display at
 * ui-manager.js:3744 reads `.active` and `.value` off array entries
 * and works in production (user sees masked key in placeholder). The
 * fallback branches in this helper are real, not dead code.
 *
 * @param {string} slot - secret_state key name
 * @returns {string} key value, trimmed; empty string if not set
 */
function _readSecretValue(slot) {
    if (!slot) return '';
    const stored = secret_state?.[slot];
    if (!stored) return '';
    if (typeof stored === 'string') return stored.trim();
    if (Array.isArray(stored) && stored.length > 0) {
        const active = stored.find(s => s?.active) || stored[0];
        if (typeof active?.value === 'string') return active.value.trim();
    }
    if (typeof stored === 'object' && typeof stored.value === 'string') {
        return stored.value.trim();
    }
    return '';
}

/**
 * Resolve the OpenRouter API key for summarization paths
 * (summarizer.js, eventbase-extractor.js, agentic-retrieval.js).
 *
 * @param {object} [settings] - extension_settings.vectfox (for legacy fallback)
 * @returns {string} key value or empty string
 */
export function getSummarizeOpenRouterKey(settings) {
    // 1. Dedicated summarize slot (post-migration canonical)
    const dedicated = _readSecretValue(SUMMARIZE_OPENROUTER_SECRET_SLOT);
    if (dedicated) return dedicated;

    // 2. Legacy plaintext (only non-empty pre-migration; cleared by
    //    migrateLegacyApiKeys on first load post-upgrade)
    if (settings?.summarize_openrouter_api_key) {
        return settings.summarize_openrouter_api_key.trim();
    }

    // 3. Fall back to ST core's OpenRouter slot — the embedding key.
    //    Preserves the pre-H-1 UX where a user setting only the embedding
    //    OpenRouter key automatically got summarization too.
    return _readSecretValue(SECRET_KEYS.OPENROUTER);
}

/**
 * Resolve the vLLM API key for summarization paths.
 *
 * Same fallback ladder as OpenRouter except there's no ST-core fallback
 * (no shared "vLLM key" slot).
 *
 * @param {object} [settings] - extension_settings.vectfox (for legacy fallback)
 * @returns {string} key value or empty string
 */
export function getSummarizeVllmKey(settings) {
    const dedicated = _readSecretValue(SUMMARIZE_VLLM_SECRET_SLOT);
    if (dedicated) return dedicated;
    if (settings?.summarize_vllm_api_key) {
        return settings.summarize_vllm_api_key.trim();
    }
    return '';
}

/**
 * Resolve the AgentMode OpenRouter override key.
 *
 * Returns only the dedicated override (or legacy plaintext during the
 * migration window). Does NOT fall through to the summarize key — that
 * inheritance is handled by the caller (agentic-retrieval.js) so the
 * "empty → inherit" UX stays explicit at the call site.
 *
 * @param {object} [settings] - extension_settings.vectfox
 * @returns {string} override key value or empty string (caller decides
 *                   whether to inherit from getSummarizeOpenRouterKey)
 */
export function getAgenticOpenRouterKey(settings) {
    const dedicated = _readSecretValue(AGENTIC_OPENROUTER_SECRET_SLOT);
    if (dedicated) return dedicated;
    if (settings?.agentic_retrieval_openrouter_api_key) {
        return settings.agentic_retrieval_openrouter_api_key.trim();
    }
    return '';
}

/**
 * Resolve the AgentMode vLLM override key. Same shape as the OpenRouter
 * override above — caller decides whether to inherit.
 *
 * @param {object} [settings] - extension_settings.vectfox
 * @returns {string} override key value or empty string
 */
export function getAgenticVllmKey(settings) {
    const dedicated = _readSecretValue(AGENTIC_VLLM_SECRET_SLOT);
    if (dedicated) return dedicated;
    if (settings?.agentic_retrieval_vllm_api_key) {
        return settings.agentic_retrieval_vllm_api_key.trim();
    }
    return '';
}

/**
 * One-shot migration: copy any plaintext `*_api_key` values from
 * extension_settings.vectfox into ST's secret_state, then clear them
 * from settings.json so the plaintext copy stops persisting.
 *
 * Migrates four slots:
 *   - summarize_openrouter_api_key
 *   - summarize_vllm_api_key
 *   - agentic_retrieval_openrouter_api_key (AgentMode override)
 *   - agentic_retrieval_vllm_api_key (AgentMode override)
 *
 * Called once during index.js init. Idempotent — subsequent calls see
 * empty settings fields and do nothing.
 *
 * Does NOT migrate ST core's SECRET_KEYS.OPENROUTER (the embedding key) —
 * that slot was already correctly stored by the embedding section's
 * existing writeSecret() flow.
 *
 * @returns {Promise<{migrated: number, slots: string[]}>}
 */
export async function migrateLegacyApiKeys() {
    const vf = extension_settings?.vectfox;
    if (!vf) return { migrated: 0, slots: [] };

    // Pairs of (legacy plaintext field on extension_settings.vectfox,
    // dedicated secret_state slot name).
    const MIGRATIONS = [
        ['summarize_openrouter_api_key', SUMMARIZE_OPENROUTER_SECRET_SLOT],
        ['summarize_vllm_api_key',       SUMMARIZE_VLLM_SECRET_SLOT],
        ['agentic_retrieval_openrouter_api_key', AGENTIC_OPENROUTER_SECRET_SLOT],
        ['agentic_retrieval_vllm_api_key',       AGENTIC_VLLM_SECRET_SLOT],
    ];

    const moved = [];
    for (const [legacyField, slot] of MIGRATIONS) {
        const val = vf[legacyField];
        if (typeof val !== 'string' || val.trim().length === 0) continue;
        try {
            await writeSecret(slot, val.trim());
            vf[legacyField] = '';
            moved.push(slot);
        } catch (err) {
            console.warn(`[VectFox] Failed to migrate ${slot}:`, err?.message || err);
        }
    }

    if (moved.length > 0) {
        // Refresh in-memory state so subsequent reads see the new values
        try { await readSecretState(); } catch {}
        console.log(`[VectFox] Migrated ${moved.length} plaintext API key(s) from settings.json to ST secret_state: ${moved.join(', ')}. Plaintext copies cleared from settings.json.`);
    }

    return { migrated: moved.length, slots: moved };
}
