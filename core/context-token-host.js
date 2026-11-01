/**
 * SillyTavern adapter. Host imports are lazy and kept out of accounting.
 * Verified against upstream release public/scripts/tokenizers.js and
 * src/endpoints/tokenizers.js on 2026-11-01. getTokensAsync is not exported;
 * getTokenCountAsync silently estimates on some failures. Use strict requests
 * to the same host endpoints instead, without touching its settings or cache.
 */

const LOCAL_TOKENIZERS = Object.freeze({
    gpt2: 'gpt2', openai: 'openai', llama: 'llama', nerd: 'nerdstash',
    nerd2: 'nerdstash_v2', mistral: 'mistral', yi: 'yi', claude: 'claude',
    llama3: 'llama3', gemma: 'gemma', jamba: 'jamba', qwen2: 'qwen2',
    command_r: 'command-r', command_a: 'command-a', nemo: 'nemo', deepseek: 'deepseek',
});

async function loadHost() {
    const [tokenizers, script] = await Promise.all([
        import('../../../../../scripts/tokenizers.js'),
        import('../../../../../script.js'),
    ]);
    return { ...tokenizers, mainApi: script.main_api, getRequestHeaders: script.getRequestHeaders,
        async getRemoteSettings(key) {
            if (key === 'api_kobold') {
                const { kai_settings } = await import('../../../../../scripts/kai-settings.js');
                return { url: kai_settings.api_server };
            }
            const host = await import('../../../../../scripts/textgen-settings.js');
            return { url: host.getTextGenServer(), model: host.getTextGenModel(), api_type: host.textgenerationwebui_settings.type };
        },
    };
}

/**
 * Resolve and freeze the active tokenizer/configuration once per measurement.
 * Returns null when the host API is missing, estimation is selected, or the
 * tokenizer is unknown. HTTP/JSON/count failures reject count(), not generation.
 * Injectable host loader and fetch keep adapter tests independent of SillyTavern.
 * Requests use a timeout so a dead tokenizer cannot leave accounting pending.
 * @param {object} [options]
 * @returns {Promise<import('./context-token-accounting.js').ContextTokenPort|null>}
 */
export async function createContextTokenHostPort({ load = loadHost, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    try {
        const host = await load();
        const selected = host.getFriendlyTokenizerName();
        const identity = { id: selected.tokenizerId, key: selected.tokenizerKey, name: selected.tokenizerName };
        let key = identity.key;
        if (key === 'api_current') {
            key = host.mainApi === 'kobold' ? 'api_kobold'
                : host.mainApi === 'textgenerationwebui' ? 'api_textgenerationwebui' : null;
            identity.key = key;
            identity.name = key === 'api_kobold' ? 'API (KoboldAI Classic)' : 'API (Text Completion)';
            identity.id = host.tokenizers?.[key?.toUpperCase()] ?? identity.id;
        }
        let endpoint;
        let params = {};
        const remote = key === 'api_kobold' || key === 'api_textgenerationwebui';
        if (remote) {
            params = { ...await host.getRemoteSettings(key) };
            if (typeof params.url !== 'string' || !params.url) return null;
            if (key === 'api_textgenerationwebui') {
                if (typeof params.api_type !== 'string' || !params.api_type) return null;
                identity.model = params.model || '';
            }
            endpoint = key === 'api_kobold' ? '/api/tokenizers/remote/kobold/count'
                : '/api/tokenizers/remote/textgenerationwebui/encode';
        } else {
            const path = LOCAL_TOKENIZERS[key];
            if (!path) return null; // Includes NONE, BEST_MATCH not resolved by host, and future unknowns.
            endpoint = `/api/tokenizers/${path}/encode`;
            if (key === 'openai') {
                identity.model = host.getTokenizerModel();
                if (typeof identity.model !== 'string' || !identity.model) return null;
                endpoint += `?model=${encodeURIComponent(identity.model)}`;
            }
        }
        if (typeof fetchImpl !== 'function' || typeof host.getRequestHeaders !== 'function') return null;
        return {
            identity: Object.freeze(identity),
            async count(text, { signal } = {}) {
                const controller = new AbortController();
                const abort = () => controller.abort();
                signal?.addEventListener('abort', abort, { once: true });
                const timeout = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    if (signal?.aborted) controller.abort();
                    controller.signal.throwIfAborted();
                    const response = await fetchImpl(endpoint, {
                        method: 'POST', headers: host.getRequestHeaders(),
                        body: JSON.stringify({ ...params, text }), signal: controller.signal,
                    });
                    if (!response.ok) throw new Error('tokenizer-http-failed');
                    const data = await response.json();
                    if (data?.error) throw new Error('tokenizer-response-failed');
                    // Local fallback estimates have empty IDs. Require real IDs,
                    // not a plausible count alone. Remote count-only APIs are valid.
                    if (!remote && (!Array.isArray(data?.ids) || !data.ids.length ||
                        !data.ids.every(id => Number.isSafeInteger(id) && id >= 0))) {
                        throw new Error('tokenizer-ids-unavailable');
                    }
                    const count = remote ? data?.count : data.ids.length;
                    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('tokenizer-count-invalid');
                    if (!remote && data.count !== undefined && data.count !== count) throw new Error('tokenizer-count-mismatch');
                    return count;
                } finally {
                    clearTimeout(timeout);
                    signal?.removeEventListener('abort', abort);
                }
            },
        };
    } catch {
        // Do not log host errors: they may contain prompt text or server URLs.
        return null;
    }
}