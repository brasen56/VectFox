/**
 * ============================================================================
 * HOST TEXTGEN COMPAT SHIM
 * ============================================================================
 * SillyTavern exposes local-embedding server URLs (Ollama / llama.cpp / vLLM /
 * KoboldCpp) through `public/scripts/textgen-settings.js`, which exports
 * `textgen_types` (the source-name enum) and `textgenerationwebui_settings`
 * (whose `.server_urls[<type>]` holds the URL the user configured in the
 * Text Completion tab). VectFox reads that URL to auto-fill the embedding
 * endpoint for local providers.
 *
 * Some SillyTavern forks (e.g. Aikobots) drop that module entirely. A bare
 *   import { textgen_types, textgenerationwebui_settings }
 *       from '../../../../textgen-settings.js';
 * is a STATIC import, so on those forks the whole importing file fails to
 * evaluate at load time — taking most of VectFox down with it — even though
 * this data only feeds one convenience URL field.
 *
 * This shim isolates that dependency in a single place:
 *   - On stock SillyTavern the dynamic import resolves and we re-export the
 *     host's LIVE objects. The top-level `await` means consumers (which import
 *     this module statically) don't evaluate until the import settles, so they
 *     still read the values synchronously; and because we keep the same object
 *     reference, later UI edits to `server_urls` remain visible.
 *   - On forks without the module the import rejects, we swallow it, and fall
 *     back to a hardcoded `textgen_types` plus an empty `server_urls`. Local
 *     providers then rely on VectFox's own "use alternate endpoint" field
 *     (settings.use_alt_endpoint + settings.alt_endpoint_url); cloud providers
 *     are unaffected.
 *
 * Consumers import from HERE instead of from the host module directly.
 * ============================================================================
 */

// Hardcoded fallback for the four source enums VectFox actually references.
// These values match SillyTavern's own textgen_types strings, which are also
// the keys used in `server_urls` AND the `source` strings the server-side
// /api/vector/* handlers expect — so they stay correct whether or not the host
// module loads.
let textgen_types = {
    OLLAMA: 'ollama',
    LLAMACPP: 'llamacpp',
    VLLM: 'vllm',
    KOBOLDCPP: 'koboldcpp',
};

// Fallback: no configured server URLs. `.server_urls[type]` yields undefined,
// which is exactly the signal callers use to fall back to their alt-endpoint
// URL instead of a host-provided one.
let textgenerationwebui_settings = { server_urls: {} };

try {
    // Dynamic import: on forks lacking the module this rejects instead of
    // crashing the module graph. The path is relative to THIS file (core/) and
    // matches the depth the direct importers used previously.
    const host = await import('../../../../textgen-settings.js');

    if (host?.textgen_types) {
        textgen_types = host.textgen_types;
    }
    if (host?.textgenerationwebui_settings) {
        textgenerationwebui_settings = host.textgenerationwebui_settings;
        // Guard: ensure server_urls exists so `[type]` lookups never throw.
        if (!textgenerationwebui_settings.server_urls) {
            textgenerationwebui_settings.server_urls = {};
        }
    }
} catch (_err) {
    // Host module absent (non-SillyTavern fork). The fallbacks above stand.
    // Intentionally silent: a missing optional host module is expected here,
    // not an error worth surfacing to the user.
}

export { textgen_types, textgenerationwebui_settings };
