/** Ask reuses the configured Core chat model and shared generation rate gate. */
import { postChatCompletion, resolveModelParameterStyle } from './llm-provider-call.js';
import { generationRateLimiter, generationRateLimitSettings } from './generation-rate-limiter.js';

export async function completeStoryAnswer(prompt, settings, signal) {
    const provider = String(settings.chat_provider || 'openrouter').toLowerCase();
    if (!['openrouter', 'vllm'].includes(provider) || !settings.chat_model?.trim()) throw new Error('Configure a Core chat provider and model before asking');
    signal?.throwIfAborted();
    const result = await generationRateLimiter.execute(() => {
        signal?.throwIfAborted();
        return postChatCompletion({ messages: [{ role: 'user', content: prompt }], model: settings.chat_model.trim(), provider,
            vllmUrl: settings.chat_vllm_url || '', maxTokens: 2048, temperature: 0.2,
            timeoutMs: Math.min(120000, Math.max(1000, Number(settings.eventbase_timeout_ms) || 60000)),
            contextLabel: 'Ask the Story', signal, ...resolveModelParameterStyle(settings) });
    }, generationRateLimitSettings(settings), 'ask-story', { signal });
    signal?.throwIfAborted();
    if (result.finishReason === 'length') throw new Error('Answer was truncated; no answer accepted');
    return result.content;
}