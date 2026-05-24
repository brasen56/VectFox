/**
 * ============================================================================
 * VectFox API KEY HELPERS
 * ============================================================================
 *
 * Single source of truth for resolving API keys at runtime, and the
 * one-shot migration that consolidates legacy per-feature key fields
 * into a single key per provider.
 *
 * ARCHITECTURE (post-2026-05-25 simplification):
 *
 * The original H-1 fix tried to use VectFox-specific `secret_state` slots
 * (e.g. `'summarize_openrouter_api_key'`) to keep summarize/embedding/
 * agentic OpenRouter keys separate. That failed in practice: ST's
 * `writeSecret(customSlot, value)` accepts the write but `readSecretState`
 * doesn't surface custom slots back into the in-memory `secret_state`
 * object — so the keys were write-only and the migration effectively
 * destroyed them. The BananaBread comment at ui-manager.js:3589 had
 * warned about this; we re-learned it the hard way.
 *
 * Current model — reuse whatever ST already round-trips:
 *
 *   - OpenRouter (one key for embedding + summarize + agent):
 *     Stored in ST's well-known `SECRET_KEYS.OPENROUTER` slot. ST
 *     round-trips this correctly because it uses it for its own
 *     chat-completion settings. All three VectFox UI inputs (Embedding /
 *     LLM Summarization / AgentMode) write to and read from this slot —
 *     they all reflect the same value. Setting the key in any of them
 *     updates the others.
 *
 *   - vLLM (one key for embedding + summarize + agent):
 *     Stored as plaintext in `settings.vllm_api_key`. There's no ST
 *     well-known slot for vLLM (`SECRET_KEYS` has no VLLM entry), and
 *     custom slots don't work. Plaintext in settings.json is justified
 *     by the personal-use / LAN-only scope (see Doc/dev_helper.md §15).
 *
 *   - qdrant_api_key, ollama_api_key:
 *     Stay as plaintext in settings.json. Same scope justification.
 *
 *   - bananabread_api_key:
 *     Untouched — the provider has been unselectable since day one
 *     (commented out in EMBEDDING_PROVIDERS). Its dual-storage code
 *     stays alive as zombie. No shipped user can have a value set.
 *
 * Migration (`migrateLegacyApiKeys`) runs once at init:
 *   - Consolidates the three legacy OpenRouter slots
 *     (`summarize_openrouter_api_key`, `agentic_retrieval_openrouter_api_key`,
 *     `openrouter_api_key`) into `SECRET_KEYS.OPENROUTER` IF that slot is
 *     currently empty (won't clobber a value the user already set in ST's
 *     UI). Always deletes the three legacy fields from settings.json.
 *   - Consolidates the three legacy vLLM slots
 *     (`summarize_vllm_api_key`, `agentic_retrieval_vllm_api_key`,
 *     `vllm_api_key`) into a single `vllm_api_key` plaintext field. The
 *     first non-empty value wins.
 *   - Idempotent: empty fields = no-op. Wrapped in try/catch — failures
 *     are non-fatal and don't lock users out of their keys.
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { SECRET_KEYS, secret_state, writeSecret, readSecretState } from '../../../../secrets.js';
import { saveSettingsDebounced } from '../../../../../script.js';

// ─── Internal helpers ───────────────────────────────────────────────────

/**
 * Extract the actual key value from `secret_state[slot]`.
 *
 * `secret_state` schema varies by slot — observed in production:
 * array-of-secrets shape for `SECRET_KEYS.OPENROUTER` (multiple keys
 * with `.active`/`.value` per entry), plus simpler string or object
 * shapes for other slots. Defensive against all three.
 *
 * Only call this for slots ST natively round-trips (the `SECRET_KEYS`
 * constants). Custom slot names don't survive `readSecretState`.
 *
 * @param {string} slot
 * @returns {string} trimmed value, or empty string
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

// ─── Public readers ─────────────────────────────────────────────────────

/**
 * Resolve the OpenRouter API key. ONE key shared across embedding,
 * summarize, and agentic-retrieval paths.
 *
 * Reads `SECRET_KEYS.OPENROUTER` (ST's well-known slot). All three UI
 * inputs (Embedding OpenRouter, LLM Summarization OpenRouter, AgentMode
 * OpenRouter) write to this slot, so setting the key in any of them
 * affects all three usages.
 *
 * @param {object} [settings] - kept for signature compat with older callers;
 *                              not read (legacy plaintext is migrated away by init).
 * @returns {string} key value or empty string
 */
export function getOpenRouterApiKey(settings) {
    return _readSecretValue(SECRET_KEYS.OPENROUTER);
}

/**
 * Resolve the vLLM API key. ONE key shared across embedding, summarize,
 * and agentic-retrieval paths.
 *
 * Reads `settings.vllm_api_key` (plaintext in settings.json). No ST
 * `SECRET_KEYS` slot exists for vLLM; custom slots don't round-trip;
 * plaintext is justified by the personal/LAN deployment scope.
 *
 * @param {object} [settings] - extension_settings.vectfox
 * @returns {string} key value or empty string
 */
export function getVllmApiKey(settings) {
    const v = settings?.vllm_api_key;
    return (typeof v === 'string') ? v.trim() : '';
}

/**
 * Resolve the Qdrant API key. Plaintext storage.
 * @param {object} [settings] - extension_settings.vectfox
 * @returns {string} key value or empty string
 */
export function getQdrantApiKey(settings) {
    const v = settings?.qdrant_api_key;
    return (typeof v === 'string') ? v.trim() : '';
}

/**
 * Resolve the Ollama API key. Plaintext storage.
 * @param {object} [settings] - extension_settings.vectfox
 * @returns {string} key value or empty string
 */
export function getOllamaApiKey(settings) {
    const v = settings?.ollama_api_key;
    return (typeof v === 'string') ? v.trim() : '';
}

// ─── One-shot legacy field migration ────────────────────────────────────

/**
 * Consolidate legacy per-feature key fields into the new one-key-per-provider
 * shape. Runs once at init from `index.js`.
 *
 * For OpenRouter:
 *   - Legacy fields: `summarize_openrouter_api_key`,
 *     `agentic_retrieval_openrouter_api_key`, `openrouter_api_key`
 *   - Picks the first non-empty value as the canonical key.
 *   - Writes to `SECRET_KEYS.OPENROUTER` ONLY IF that slot is currently
 *     empty (don't clobber a value the user set through ST's own UI).
 *   - Deletes all three legacy fields from `extension_settings.vectfox`.
 *
 * For vLLM:
 *   - Legacy fields: `summarize_vllm_api_key`,
 *     `agentic_retrieval_vllm_api_key`, `vllm_api_key`
 *   - Picks the first non-empty value, stores it in `vllm_api_key` plaintext.
 *   - Deletes the other two from `extension_settings.vectfox`.
 *
 * qdrant_api_key, ollama_api_key, bananabread_api_key: left untouched.
 *
 * Idempotent: on subsequent runs the legacy fields are already absent
 * and the function is a no-op.
 *
 * @returns {Promise<{summary: string}>}
 */
export async function migrateLegacyApiKeys() {
    const vf = extension_settings?.vectfox;
    if (!vf) {
        console.warn('[VectFox migrate] extension_settings.vectfox not initialized — skipping');
        return { summary: 'not-initialized' };
    }

    let mutated = false;
    const moves = []; // human-readable log entries

    // ─── OpenRouter consolidation ───
    const orLegacy = [
        'summarize_openrouter_api_key',
        'agentic_retrieval_openrouter_api_key',
        'openrouter_api_key',
    ];
    let orValue = '';
    for (const field of orLegacy) {
        if (!Object.prototype.hasOwnProperty.call(vf, field)) continue;
        const v = vf[field];
        if (!orValue && typeof v === 'string' && v.trim().length > 0) {
            orValue = v.trim();
            moves.push(`OpenRouter source: ${field} (len=${orValue.length})`);
        }
        delete vf[field];
        mutated = true;
    }
    if (orValue) {
        const existing = _readSecretValue(SECRET_KEYS.OPENROUTER);
        if (!existing) {
            try {
                await writeSecret(SECRET_KEYS.OPENROUTER, orValue);
                moves.push(`OpenRouter → wrote to SECRET_KEYS.OPENROUTER (was empty)`);
            } catch (err) {
                console.warn('[VectFox migrate] writeSecret(SECRET_KEYS.OPENROUTER) failed:', err?.message || err);
                moves.push(`OpenRouter → writeSecret FAILED, key not migrated`);
            }
        } else {
            moves.push(`OpenRouter → SECRET_KEYS.OPENROUTER already has a key, keeping that one (didn't clobber)`);
        }
    }

    // ─── vLLM consolidation ───
    // First pick a winning value from any of the three legacy slots, then
    // write to the canonical `vllm_api_key` plaintext field and drop the
    // other two. If `vllm_api_key` itself wins, we still rewrite it to
    // ensure it's the only field present.
    const vllmLegacy = [
        'summarize_vllm_api_key',
        'agentic_retrieval_vllm_api_key',
        'vllm_api_key',
    ];
    let vllmValue = '';
    for (const field of vllmLegacy) {
        if (!Object.prototype.hasOwnProperty.call(vf, field)) continue;
        const v = vf[field];
        if (!vllmValue && typeof v === 'string' && v.trim().length > 0) {
            vllmValue = v.trim();
            moves.push(`vLLM source: ${field} (len=${vllmValue.length})`);
        }
        delete vf[field];
        mutated = true;
    }
    if (vllmValue) {
        vf.vllm_api_key = vllmValue;
        moves.push(`vLLM → consolidated into settings.vllm_api_key (plaintext, single source)`);
    }

    if (mutated) {
        // saveSettingsDebounced flushes our deletions/consolidations to
        // settings.json. Without this, the in-memory changes don't reach
        // disk until something else triggers a save.
        saveSettingsDebounced();
    }

    if (moves.length > 0) {
        console.log(`[VectFox migrate] Migration complete:\n  - ${moves.join('\n  - ')}`);
        // Refresh in-memory secret_state if we wrote OpenRouter
        try { await readSecretState(); } catch {}
    } else {
        console.log('[VectFox migrate] No legacy API-key fields found — nothing to migrate');
    }

    return { summary: moves.length > 0 ? moves.join('; ') : 'nothing-to-migrate' };
}
