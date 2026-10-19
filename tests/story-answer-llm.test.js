import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../core/llm-provider-call.js', () => ({ postChatCompletion: vi.fn(),
    resolveModelParameterStyle: () => ({ sendTemperature: false, tokenLimitParameter: 'max_completion_tokens' }) }));
vi.mock('../core/generation-rate-limiter.js', () => ({ generationRateLimiter: { execute: vi.fn() },
    generationRateLimitSettings: () => ({ rate_limit_calls: 3 }) }));
import { postChatCompletion } from '../core/llm-provider-call.js';
import { generationRateLimiter } from '../core/generation-rate-limiter.js';
import { completeStoryAnswer } from '../core/story-answer-llm.js';

const settings = { chat_provider: 'openrouter', chat_model: 'model' };
beforeEach(() => {
    vi.clearAllMocks();
    generationRateLimiter.execute.mockImplementation(async work => work());
    postChatCompletion.mockResolvedValue({ content: '{}', finishReason: 'stop' });
});
describe('Ask answer provider', () => {
    it('uses the configured provider, shared rate gate, output cap and signal exactly once', async () => {
        const controller = new AbortController();
        expect(await completeStoryAnswer('question', settings, controller.signal)).toBe('{}');
        expect(generationRateLimiter.execute).toHaveBeenCalledWith(expect.any(Function), { rate_limit_calls: 3 }, 'ask-story', { signal: controller.signal });
        expect(postChatCompletion).toHaveBeenCalledWith(expect.objectContaining({ model: 'model', provider: 'openrouter',
            maxTokens: 2048, responseFormat: { type: 'json_object' }, signal: controller.signal, tokenLimitParameter: 'max_completion_tokens' }));
        expect(postChatCompletion).toHaveBeenCalledTimes(1);
    });
    it('does not send a queued request if cancelled before dispatch', async () => {
        const controller = new AbortController();
        generationRateLimiter.execute.mockImplementation(async work => { controller.abort(); return work(); });
        await expect(completeStoryAnswer('question', settings, controller.signal)).rejects.toThrow();
        expect(postChatCompletion).not.toHaveBeenCalled();
    });
    it('rejects truncation and failures without retries', async () => {
        postChatCompletion.mockResolvedValueOnce({ content: '{}', finishReason: 'length' });
        await expect(completeStoryAnswer('question', settings)).rejects.toMatchObject({ stage: 'output_truncation', message: expect.stringContaining('truncated') });
        expect(postChatCompletion).toHaveBeenCalledTimes(1);
        postChatCompletion.mockRejectedValueOnce(new Error('provider failure'));
        await expect(completeStoryAnswer('question', settings)).rejects.toThrow('provider failure');
        expect(postChatCompletion).toHaveBeenCalledTimes(2);
    });
    it('requires a supported provider and configured model', async () => {
        await expect(completeStoryAnswer('q', {})).rejects.toThrow('Configure');
        await expect(completeStoryAnswer('q', { ...settings, chat_provider: 'unknown' })).rejects.toThrow('Configure');
        expect(generationRateLimiter.execute).not.toHaveBeenCalled();
    });
    it('labels a token-exhausted empty completion as output truncation', async () => {
        postChatCompletion.mockRejectedValue(Object.assign(new Error('Token budget exhausted'), { kind: 'model_config', finishReason: 'length' }));
        await expect(completeStoryAnswer('q', settings)).rejects.toMatchObject({ stage: 'output_truncation' });
    });
    it('requests JSON for the custom/vLLM provider too', async () => {
        await completeStoryAnswer('q', { ...settings, chat_provider: 'vllm', chat_vllm_url: 'http://localhost:8000' });
        expect(postChatCompletion).toHaveBeenCalledWith(expect.objectContaining({ provider: 'vllm', responseFormat: { type: 'json_object' } }));
    });
});