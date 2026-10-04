/** NPC cards reuse VectFox's configured summarization provider and rate gate. */
import { postChatCompletion, parseJsonArrayFromLlm, resolveModelParameterStyle } from './llm-provider-call.js';
import { generationRateLimiter, generationRateLimitSettings } from './generation-rate-limiter.js';

export async function completeNpcCard(prompt, settings) {
    const provider = String(settings.chat_provider || 'openrouter').toLowerCase();
    if (!['openrouter', 'vllm'].includes(provider)) throw new Error('Unsupported NPC card provider');
    if (!settings.chat_model?.trim()) throw new Error('NPC cards require a summarization model');
    const { content, finishReason } = await generationRateLimiter.execute(() => postChatCompletion({
        messages: [{ role: 'user', content: prompt }], model: settings.chat_model.trim(), provider,
        vllmUrl: settings.chat_vllm_url || '', maxTokens: settings.eventbase_max_tokens || 4096,
        temperature: 0.2, timeoutMs: settings.eventbase_timeout_ms || 60000,
        contextLabel: 'NPC card', ...resolveModelParameterStyle(settings),
    }), generationRateLimitSettings(settings), 'npc-card');
    if (finishReason === 'length') throw new Error('NPC card response truncated');
    return parseJsonArrayFromLlm(content, { label: 'NPC card', identKeys: ['fact'] });
}