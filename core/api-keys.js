/**
 * ============================================================================
 * VectFox API KEY HELPERS
 * ============================================================================
 *
 * VectFox owns the OpenRouter and Custom/vLLM multi-key arrays in
 * extension_settings.vectfox. Adding, activating, renaming, or deleting
 * keys never mutates SillyTavern's main-chat secret slots.
 *
 * LLM calls use the active isolated key through llm-provider-call.js.
 * If none is saved, the old ST proxy remains available for existing users.
 * Shared-slot readers below are presence indicators only; their masked
 * values must never be sent as Authorization headers.
 *
 * Keys in the isolated arrays are plaintext in settings.json, as on main.
 * They can be included in settings backups/exports. Direct browser calls
 * require the provider to allow CORS.
 *
 * Embeddings still use ST/plugin server-side authentication. The key
 * manager controls LLM credentials; it cannot override embedding secrets.
 * Qdrant continues to use its dedicated api_key_qdrant server secret.
 * Legacy per-feature plaintext keys migrate into the isolated arrays.
 *
 * @author Kritblade
 * @version 3.3.1
 * ============================================================================
 */

import { extension_settings } from '../../../../extensions.js';
import { SECRET_KEYS, secret_state, writeSecret } from '../../../../secrets.js';
import { saveSettings, saveSettingsDebounced } from '../../../../../script.js';
import { log } from './log.js';

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
 * Resolve OpenRouter key presence — RETURNS A MASKED VALUE, not the real key.
 * Prefers the active VectFox key, then the shared ST slot for compatibility.
 *
 * ST's `getSecretState` masks all values for non-EXPORTABLE_KEYS (OpenRouter
 * is not exportable), so what we get back is something like "*******abcd".
 * Use this for:
 *   - Presence checks (empty string ⇒ no key configured)
 *   - UI placeholder masking
 *
 * DO NOT pass the return value as a Bearer token — you'll get 401. Instead,
 * use postChatCompletion in llm-provider-call.js. It selects the active
 * isolated key or the ST proxy without sending masked values upstream.
 *
 * @param {object} [settings] - kept for signature compat; not read.
 * @returns {string} masked value (presence indicator) or empty string
 */
export function getOpenRouterApiKey(settings) {
    return maskVectFoxApiKey(getVectFoxOpenRouterApiKey()) || _readSecretValue(SECRET_KEYS.OPENROUTER);
}

/**
 * Resolve Custom/vLLM key presence, preferring the active VectFox key,
 * then the shared ST slot for compatibility. RETURNS A MASKED VALUE,
 * not the real key — same as `getOpenRouterApiKey`. Use for presence
 * checks and placeholder masking only; chat-side calls route through
 * ST's `/api/backends/chat-completions/generate` proxy with
 * `chat_completion_source: 'custom'` where the server reads the real
 * key via `readSecret(SECRET_KEYS.CUSTOM)`.
 *
 * @param {object} [settings] - kept for signature compat; not read.
 * @returns {string} masked value (presence indicator) or empty string
 */
export function getCustomApiKey(settings) {
    return maskVectFoxApiKey(getVectFoxCustomApiKey()) || _readSecretValue(SECRET_KEYS.CUSTOM);
}

/**
 * @deprecated Use {@link getCustomApiKey}. Kept as an alias for the
 * transition period; both readers point at the same `SECRET_KEYS.CUSTOM`
 * slot. Pre-2026-05-26 callers expected plaintext from
 * `settings.vllm_api_key` — that field is migrated and deleted on first
 * load post-upgrade. Remove this alias once all call sites are confirmed
 * migrated.
 */
export const getVllmApiKey = getCustomApiKey;

/**
 * Resolve the Qdrant API key presence indicator.
 *
 * Post-2026-05-26: the key lives in ST's secret_state under the custom slot
 * `api_key_qdrant`. That slot is NOT in ST's `SECRET_KEYS` enum, so
 * `getSecretState` (and therefore client-side `secret_state.api_key_qdrant`)
 * does NOT surface it. Server-side `readSecret(directories, 'api_key_qdrant')`
 * DOES read it correctly — that's how the Similharity plugin auth-flows the
 * real key value into Qdrant.
 *
 * For client-side presence checks (UI placeholder, "is the key set"), call
 * `fetchQdrantApiKeyPresence()` below — it round-trips to the plugin's
 * `/qdrant/key-status` endpoint which returns `{set, masked}`.
 *
 * This synchronous reader is kept ONLY as a transition fallback for the
 * pre-migration plaintext field. After migration drains it, this returns ''
 * and the UI/backends rely on the async presence fetch + server-side
 * resolution respectively.
 *
 * @param {object} [settings] - extension_settings.vectfox
 * @returns {string} pre-migration plaintext value, or '' once migrated
 */
export function getQdrantApiKey(settings) {
    const v = settings?.qdrant_api_key;
    return (typeof v === 'string') ? v.trim() : '';
}

/**
 * Async presence fetch for the Qdrant API key via the Similharity plugin's
 * `/qdrant/key-status` endpoint. Returns `{set: false, masked: ''}` when the
 * plugin is unreachable so callers can degrade gracefully.
 *
 * @returns {Promise<{set: boolean, masked: string}>}
 */
export async function fetchQdrantApiKeyPresence() {
    try {
        // No plugin → no /qdrant/key-status endpoint. Skip the request so the
        // browser doesn't log a red 404 on plugin-less (fully supported) setups.
        // Dynamic import to avoid a static cycle, matching the migration block.
        const { checkPluginAvailable } = await import('./collection-loader.js');
        if (!(await checkPluginAvailable())) {
            return { set: false, masked: '' };
        }
        const response = await fetch('/api/plugins/similharity/qdrant/key-status', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) {
            return { set: false, masked: '' };
        }
        const data = await response.json();
        return {
            set: !!data?.set,
            masked: typeof data?.masked === 'string' ? data.masked : '',
        };
    } catch (err) {
        // Plugin unreachable (not installed, network error, etc.) — caller
        // should treat as "presence unknown" and not render the key indicator.
        return { set: false, masked: '' };
    }
}

// getOllamaApiKey was removed 2026-05-26: ST has no SECRET_KEYS.OLLAMA slot
// and no getOllamaHeaders branch in additional-headers.js. ST's vector handler
// calls setAdditionalHeadersByType(headers, TEXTGEN_TYPES.OLLAMA, ...) which is
// a silent no-op for ollama — no Authorization header is ever sent. VectFox's
// ollama_api_key field was dead code on both sides. The plaintext field is
// drained-and-deleted by migrateLegacyApiKeys() below (no destination —
// nothing to migrate to since ST itself doesn't authenticate ollama). If a
// user needs auth for a proxied ollama endpoint, configure it at the proxy.

// ─── VectFox-owned multi-key store (post-2026-06-17) ────────────────────
// Each provider ('openrouter' | 'custom') maps to an array of
//   { id, label, value, active }
// stored in extension_settings.vectfox under vectfox_<provider>_keys. This is
// VectFox's OWN storage — it NEVER touches ST's secret_state, so adding,
// switching, renaming or deleting a key here does NOT change the main chat's
// Connection Profile (and changing the profile does not change VectFox). The
// stored `value` is the REAL key (plaintext in settings.json — same trust
// model as the single-string isolated field this replaces).
//
// The store is CANONICAL on extension_settings.vectfox. Readers ignore any
// passed-in `settings` copy: the runtime `settings` object in index.js is a
// shallow spread of extension_settings.vectfox, so reading the
// live store is the only way to stay consistent across the UI's
// `Object.assign(extension_settings.vectfox, settings)` writebacks.

const _VF_KEYS_FIELD = {
    openrouter: 'vectfox_openrouter_keys',
    custom: 'vectfox_custom_keys',
};
const _VF_LEGACY_FIELD = {
    openrouter: 'vectfox_openrouter_api_key',
    custom: 'vectfox_custom_api_key',
};

function _vfNewId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch { /* fall through to the manual id */ }
    return `vfk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Live key array for a provider, on extension_settings.vectfox. Creates the
 * array when missing and lazily seeds it from the legacy single-string
 * isolated field (vectfox_<provider>_api_key) so keys saved under the
 * pre-array shape still appear as one active entry. Idempotent and free of a
 * save side effect — the next mutation persists it, and an unpersisted seed
 * re-derives identically on reload.
 * @param {string} provider 'openrouter' | 'custom'
 * @returns {Array<{id:string,label:string,value:string,active:boolean}>}
 */
function _vfKeyArray(provider) {
    const vf = extension_settings?.vectfox;
    if (!Object.hasOwn(_VF_KEYS_FIELD, provider)) throw new Error(`Unsupported VectFox key provider: ${provider}`);
    const field = _VF_KEYS_FIELD[provider];
    if (!vf) return [];
    if (!Array.isArray(vf[field])) {
        vf[field] = [];
        const legacy = vf[_VF_LEGACY_FIELD[provider]];
        if (typeof legacy === 'string' && legacy.trim().length > 0) {
            vf[field].push({ id: _vfNewId(), label: 'Imported key', value: legacy.trim(), active: true });
        }
    }
    return vf[field];
}

/** Ensures exactly one entry is active (the given id, else the first). */
function _vfNormalizeActive(arr, activeId) {
    let found = false;
    for (const e of arr) {
        e.active = (e.id === activeId);
        if (e.active) found = true;
    }
    if (!found && arr.length) arr[0].active = true;
}

/**
 * List a provider's saved keys (the live array — treat as read-only).
 * @param {string} provider
 * @returns {Array<{id:string,label:string,value:string,active:boolean}>}
 */
export function listVectFoxKeys(provider) {
    return _vfKeyArray(provider);
}

/** Number of saved keys for a provider. */
export function getVectFoxKeyCount(provider) {
    return _vfKeyArray(provider).length;
}

/** The active key's label for a provider, or '' if none. */
export function getActiveVectFoxKeyLabel(provider) {
    const arr = _vfKeyArray(provider);
    const active = arr.find(e => e.active) || arr[0];
    return active?.label || '';
}

/** The active key's REAL value for a provider, or '' if none configured. */
export function getActiveVectFoxKeyValue(provider) {
    const arr = _vfKeyArray(provider);
    const active = arr.find(e => e.active) || arr[0];
    const v = active?.value;
    return (typeof v === 'string' && v.trim().length > 0) ? v.trim() : '';
}

/** Mask for UI/presence checks; never reveal a short key in full. */
export function maskVectFoxApiKey(value) {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!key) return '';
    if (key.length <= 4) return '*'.repeat(key.length);
    return '*'.repeat(Math.min(key.length - 4, 8)) + key.slice(-4);
}

/**
 * Add a key for a provider and make it active. Dedupes by value: pasting a key
 * that already exists just re-activates that entry instead of creating a
 * duplicate. Returns the entry id, or null when the value is empty.
 * @param {string} provider
 * @param {string} value REAL key
 * @param {string} [label]
 * @returns {string|null}
 */
export function addVectFoxKey(provider, value, label) {
    const v = (typeof value === 'string' ? value : '').trim();
    if (!v) return null;
    if (!extension_settings?.vectfox) throw new Error('VectFox settings are not initialized');
    const arr = _vfKeyArray(provider);
    const existing = arr.find(e => e.value === v);
    if (existing) {
        if (typeof label === 'string' && label.trim()) existing.label = label.trim();
        _vfNormalizeActive(arr, existing.id);
        saveSettingsDebounced();
        return existing.id;
    }
    const id = _vfNewId();
    arr.push({ id, label: (typeof label === 'string' && label.trim()) || `Key ${arr.length + 1}`, value: v, active: true });
    _vfNormalizeActive(arr, id);
    saveSettingsDebounced();
    return id;
}

/** Make a saved key active. @returns {boolean} whether the id was found. */
export function activateVectFoxKey(provider, id) {
    const arr = _vfKeyArray(provider);
    if (!arr.some(e => e.id === id)) return false;
    _vfNormalizeActive(arr, id);
    saveSettingsDebounced();
    return true;
}

/** Rename a saved key. @returns {boolean} whether the id was found. */
export function renameVectFoxKey(provider, id, label) {
    const arr = _vfKeyArray(provider);
    const e = arr.find(x => x.id === id);
    if (!e) return false;
    e.label = (typeof label === 'string' ? label.trim() : '') || e.label;
    saveSettingsDebounced();
    return true;
}

/**
 * Delete a saved key; promotes the first remaining entry to active when the
 * deleted one was active (parity with ST's deleteSecret).
 * @returns {boolean} whether the id was found.
 */
export function deleteVectFoxKey(provider, id) {
    const arr = _vfKeyArray(provider);
    const idx = arr.findIndex(e => e.id === id);
    if (idx === -1) return false;
    const wasActive = arr[idx].active;
    arr.splice(idx, 1);
    if (wasActive && arr.length && !arr.some(e => e.active)) arr[0].active = true;
    // Once the array is canonical, an old single-string field must not revive
    // a deleted key on a future reload/migration.
    delete extension_settings.vectfox[_VF_LEGACY_FIELD[provider]];
    saveSettingsDebounced();
    return true;
}

// ─── Provider-specific convenience readers/writers ──────────────────────
// Readers used by the shared LLM helper and settings UI.
// The summarizer/agentic/
// extractor callers don't change — they now resolve the ACTIVE key from the
// array store above. The `settings` param is accepted for signature compat
// but ignored (the store is canonical on extension_settings.vectfox).

export function getVectFoxOpenRouterApiKey(settings) {
    return getActiveVectFoxKeyValue('openrouter');
}

export function getVectFoxCustomApiKey(settings) {
    return getActiveVectFoxKeyValue('custom');
}

export function hasVectFoxOpenRouterApiKey(settings) {
    return getActiveVectFoxKeyValue('openrouter').length > 0;
}

export function hasVectFoxCustomApiKey(settings) {
    return getActiveVectFoxKeyValue('custom').length > 0;
}

/**
 * Save an OpenRouter key from the paste-to-save input — appends to the store
 * (dedupe + activate). `liveSettings` is accepted for call-site compat but
 * unused (the store is canonical on extension_settings.vectfox).
 */
export function setVectFoxOpenRouterApiKey(value, liveSettings) {
    addVectFoxKey('openrouter', value);
}

export function setVectFoxCustomApiKey(value, liveSettings) {
    addVectFoxKey('custom', value);
}

// ─── One-shot legacy field migration ────────────────────────────────────

/**
 * Migrate legacy OpenRouter/Custom plaintext fields into isolated key arrays.
 * Existing active selections and all distinct legacy keys are preserved.
 * Shared ST secrets cannot be copied because the client sees masked values;
 * users can re-enter those keys, with the ST proxy as a compatibility fallback.
 * Qdrant still migrates to its dedicated server secret when supported.
 * Runs before index.js refreshes its settings snapshot; idempotent on reload.
 * @returns {Promise<{summary: string}>}
 */
export async function migrateLegacyApiKeys() {
    const vf = extension_settings?.vectfox;
    if (!vf) {
        log.warn('[VectFox migrate] extension_settings.vectfox not initialized — skipping');
        return { summary: 'not-initialized' };
    }

    // ─── Diagnostic snapshot: what's in vf at migration start? ───
    // Helps debug the "settings.json has plaintext keys but migration says
    // nothing to migrate" scenario — if a field shows up here but isn't
    // listed in the post-migration "deleted" log, something is filtering it
    // out before migration runs (defaults merge, etc.).
    const apiKeyFieldsBefore = Object.keys(vf).filter(k => k.includes('api_key'));
    log.lifecycle(`[VectFox migrate] START. vf has ${apiKeyFieldsBefore.length} *api_key* field(s):`, apiKeyFieldsBefore);
    if (apiKeyFieldsBefore.length > 0) {
        // Show length only (never log the actual key value)
        log.lifecycle(`[VectFox migrate] *api_key* field details:`, apiKeyFieldsBefore.map(k => {
            const v = vf[k];
            return {
                field: k,
                hasOwnProperty: Object.prototype.hasOwnProperty.call(vf, k),
                type: typeof v,
                length: typeof v === 'string' ? v.length : null,
                isEmpty: typeof v === 'string' && v.trim().length === 0,
            };
        }));
    }

    let mutated = false;
    const moves = []; // human-readable log entries

    // Preserve every distinct legacy key in VectFox's own store. Never write
    // to OPENROUTER/CUSTOM/VLLM: those slots belong to ST's connections.
    for (const [provider, fields] of Object.entries({
        openrouter: ['summarize_openrouter_api_key', 'agentic_retrieval_openrouter_api_key', 'openrouter_api_key', 'vectfox_openrouter_api_key'],
        custom: ['summarize_vllm_api_key', 'agentic_retrieval_vllm_api_key', 'vllm_api_key', 'vectfox_custom_api_key'],
    })) {
        const keys = _vfKeyArray(provider);
        const activeId = (keys.find(key => key.active) || keys[0])?.id;
        for (const field of fields) {
            if (!Object.prototype.hasOwnProperty.call(vf, field)) continue;
            const value = typeof vf[field] === 'string' ? vf[field].trim() : '';
            if (value && !keys.some(key => key.value === value)) {
                keys.push({ id: _vfNewId(), label: `Imported key ${keys.length + 1}`, value, active: false });
                moves.push(`${provider} → imported legacy key into VectFox store`);
            }
            delete vf[field];
            mutated = true;
        }
        _vfNormalizeActive(keys, activeId);
    }
    // ─── Qdrant API key → 'api_key_qdrant' (custom slot) drain ───
    // Pre-2026-05-26: VectFox stored the Qdrant Cloud API key plaintext in
    // settings.qdrant_api_key. The backends/qdrant.js init flow sent the raw
    // value to the Similharity plugin which then auth'd to Qdrant Cloud.
    // Post-refactor: client sends `apiKey: null` to the plugin, which reads
    // the real value server-side from ST's secret_state slot 'api_key_qdrant'
    // via readSecret. The slot is a custom name (not in ST's SECRET_KEYS enum)
    // because no enum slot exists for Qdrant. writeSecret accepts any string
    // slot name; readSecret reads it correctly server-side; client-side
    // secret_state filters non-enum slots, so the UI presence indicator goes
    // through the plugin's /qdrant/key-status endpoint instead (see
    // fetchQdrantApiKeyPresence above).
    //
    // ⚠️ Capability probe BEFORE migration: if the user is on a pre-2026-05-26
    // Similharity plugin, the /qdrant/key-status endpoint doesn't exist yet.
    // Migrating in that state would write to secret_state but leave the
    // plugin unable to read it back — silently breaking Qdrant Cloud auth
    // while deleting the user's only working key from settings.json. The
    // probe gates BOTH the write and the delete: if the plugin doesn't yet
    // support secret_state lookup, we no-op and retry on next reload. The
    // migration is idempotent — once the plugin updates, the next ST start
    // probes successfully and the drain runs cleanly.
    const QDRANT_SLOT = 'api_key_qdrant';
    let pluginSupportsQdrantSecretSlot = false;
    // Only probe the plugin if there's actually a legacy plaintext field to
    // drain. On a fresh / no-plugin install there's nothing to migrate, so
    // pinging /qdrant/key-status just produces a misleading 404 warning.
    if (Object.prototype.hasOwnProperty.call(vf, 'qdrant_api_key')) {
        // First, the canonical plugin-presence check (session-cached /health
        // probe). This cleanly separates "no plugin installed at all" from
        // "plugin installed but pre-2026-05-26 (no /qdrant/key-status yet)" —
        // the two cases that the /qdrant/key-status 404 alone can't tell apart.
        // Dynamic import to avoid a static cycle (collection-loader →
        // core-vector-api → … back here), matching corpus-stats.js.
        let pluginUp = false;
        try {
            const { checkPluginAvailable } = await import('./collection-loader.js');
            pluginUp = await checkPluginAvailable();
        } catch (err) {
            log.warn(`[VectFox migrate] Plugin availability check failed; skipping Qdrant key migration this run. Plaintext key in settings.json is PRESERVED. Reason:`, err?.message || err);
        }

        if (!pluginUp) {
            // No plugin → nothing can read secret_state.api_key_qdrant back, so
            // migrating would strand the key. Skip and keep the plaintext value.
            // NOT a warning: running without the plugin is a supported choice,
            // not an error. Gated/verbose so it stays out of the normal console
            // and only surfaces when someone is actually debugging migration.
            log.verbose(`[VectFox migrate] Similharity server plugin not installed — Qdrant key migration skipped (expected when running plugin-less). Plaintext qdrant_api_key in settings.json is PRESERVED.`);
        } else {
            // Plugin is up; now capability-probe the specific endpoint to confirm
            // it's new enough to support the secret_state Qdrant slot.
            try {
                const probe = await fetch('/api/plugins/similharity/qdrant/key-status', {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' },
                });
                pluginSupportsQdrantSecretSlot = probe.ok;
                if (!probe.ok) {
                    log.warn(`[VectFox migrate] Plugin /qdrant/key-status probe returned ${probe.status} — Similharity plugin is pre-2026-05-26. Skipping Qdrant key migration this run; plaintext key in settings.json is PRESERVED. Update the Similharity plugin (cd plugins/similharity && git pull && restart ST) to enable secret_state storage.`);
                }
            } catch (err) {
                log.warn(`[VectFox migrate] Plugin /qdrant/key-status probe failed (plugin unreachable or pre-2026-05-26). Skipping Qdrant key migration this run; plaintext key in settings.json is PRESERVED. Reason:`, err?.message || err);
            }
        }
    }

    if (pluginSupportsQdrantSecretSlot) {
        const rawQdrantPlaintext = vf?.qdrant_api_key;
        const hasPlaintextField = Object.prototype.hasOwnProperty.call(vf, 'qdrant_api_key');
        const hasPlaintextValue = typeof rawQdrantPlaintext === 'string' && rawQdrantPlaintext.trim().length > 0;
        let writeSucceeded = !hasPlaintextValue; // nothing to write = trivially succeeded

        if (hasPlaintextValue) {
            // No don't-clobber check: custom slot is undefined in client-side
            // secret_state, so we can't presence-check from JS. Plugin-side
            // this overwrites any prior value — acceptable for the first
            // migration pass (slot is brand new for VectFox users).
            try {
                await writeSecret(QDRANT_SLOT, rawQdrantPlaintext.trim());
                moves.push(`Qdrant → wrote to secret_state.${QDRANT_SLOT} (len=${rawQdrantPlaintext.trim().length})`);
                writeSucceeded = true;
            } catch (err) {
                log.warn('[VectFox migrate] writeSecret(api_key_qdrant) failed:', err?.message || err);
                moves.push(`Qdrant → writeSecret(${QDRANT_SLOT}) FAILED — plaintext key PRESERVED in settings.json for safety, retry next reload`);
                // writeSucceeded stays false → plaintext stays in settings.json
            }
        }

        // Delete the plaintext field ONLY after a confirmed-successful write
        // (or when there was no value to migrate). Never delete in a half-
        // migrated state — the user's only working key would be lost.
        if (writeSucceeded && hasPlaintextField) {
            delete vf.qdrant_api_key;
            mutated = true;
            if (!hasPlaintextValue) {
                moves.push(`Qdrant → removed empty plaintext qdrant_api_key from settings.json`);
            }
        }
    }

    // ─── Ollama plaintext drain (no destination — ST has no ollama auth) ───
    // ST has no SECRET_KEYS.OLLAMA and no getOllamaHeaders branch in
    // additional-headers.js. ST's ollama-vectors.js calls
    // setAdditionalHeadersByType(headers, TEXTGEN_TYPES.OLLAMA, ...) which
    // is a silent no-op for ollama — no Authorization header is ever sent
    // to the upstream Ollama endpoint. So whatever VectFox previously
    // stored in settings.ollama_api_key was dead weight on BOTH sides.
    // Migration just deletes the field. No probe gate needed — there's
    // nothing to write anywhere.
    if (Object.prototype.hasOwnProperty.call(vf, 'ollama_api_key')) {
        const hadValue = typeof vf.ollama_api_key === 'string' && vf.ollama_api_key.trim().length > 0;
        delete vf.ollama_api_key;
        mutated = true;
        moves.push(hadValue
            ? `Ollama → removed plaintext ollama_api_key from settings.json (ST does not authenticate ollama; field was a no-op)`
            : `Ollama → removed empty plaintext ollama_api_key from settings.json`);
    }

    if (mutated) {
        log.lifecycle(`[VectFox migrate] mutated=true → calling await saveSettings() (synchronous)`);
        // Synchronous save (NOT debounced) — see index.js eventbase migration
        // comment for the full rationale. Short version: if user reloads
        // before the debounce flushes, settings.json keeps the stale legacy
        // fields even though extension_settings.vectfox is clean in memory.
        // Confirmed scenario 2026-05-26.
        await saveSettings();
        log.lifecycle(`[VectFox migrate] saveSettings() returned. Disk should be in sync with memory now.`);
    } else {
        log.lifecycle(`[VectFox migrate] mutated=false → skipping saveSettings(). If settings.json has stale fields, they will NOT be cleared by this migration run (in-memory state was already clean).`);
    }

    // Diagnostic: what's left in vf after migration?
    const apiKeyFieldsAfter = Object.keys(vf).filter(k => k.includes('api_key'));
    log.lifecycle(`[VectFox migrate] END. vf has ${apiKeyFieldsAfter.length} *api_key* field(s) remaining:`, apiKeyFieldsAfter);

    if (moves.length > 0) {
        log.lifecycle(`[VectFox migrate] Migration complete:\n  - ${moves.join('\n  - ')}`);
    } else {
        log.lifecycle('[VectFox migrate] No legacy API-key fields found — nothing to migrate');
    }

    return { summary: moves.length > 0 ? moves.join('; ') : 'nothing-to-migrate' };
}
