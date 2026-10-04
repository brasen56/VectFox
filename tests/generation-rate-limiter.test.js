import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationRateLimiter, generationRateLimitSettings } from '../core/generation-rate-limiter.js';

vi.mock('../core/log.js', () => ({ log: { verbose: vi.fn() } }));

const quota = { rate_limit_calls: 1, rate_limit_interval: 1 };
afterEach(() => vi.useRealTimers());

describe('shared generation priority queue', () => {
    it('dispatches planner before queued cards without exceeding the shared quota', async () => {
        vi.useFakeTimers();
        const limiter = new GenerationRateLimiter();
        const calls = [];
        const run = label => limiter.execute(() => { calls.push([label, Date.now()]); return label; }, quota, label);
        await run('extraction');
        const firstCard = run('npc-card');
        const secondCard = run('npc-card');
        const planner = run('agent');
        expect(calls.map(c => c[0])).toEqual(['extraction']);
        await vi.advanceTimersByTimeAsync(1100);
        expect(await planner).toBe('agent');
        expect(calls.map(c => c[0])).toEqual(['extraction', 'agent']);
        await vi.runAllTimersAsync();
        await Promise.all([firstCard, secondCard]);
        expect(calls.map(c => c[0])).toEqual(['extraction', 'agent', 'npc-card', 'npc-card']);
        for (let i = 1; i < calls.length; i++) expect(calls[i][1] - calls[i - 1][1]).toBeGreaterThanOrEqual(1000);
    });
    it('keeps FIFO within each priority and ranks extraction above cards', async () => {
        vi.useFakeTimers();
        const limiter = new GenerationRateLimiter();
        const calls = [];
        const run = (name, label) => limiter.execute(() => calls.push(name), quota, label);
        await run('seed', 'extraction');
        const pending = [run('card1', 'npc-card'), run('extract1', 'extraction'),
            run('agent1', 'agent'), run('card2', 'npc-card'), run('agent2', 'agent'), run('extract2', 'extraction')];
        await vi.runAllTimersAsync();
        await Promise.all(pending);
        expect(calls).toEqual(['seed', 'agent1', 'agent2', 'extract1', 'extract2', 'card1', 'card2']);
    });
    it('does not wait for or preempt an already-dispatched card response', async () => {
        vi.useFakeTimers();
        const limiter = new GenerationRateLimiter();
        let finish;
        const card = limiter.execute(() => new Promise(resolve => { finish = resolve; }), quota, 'npc-card');
        const fn = vi.fn(() => 'plan');
        const planner = limiter.execute(fn, quota, 'agent');
        expect(fn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1100);
        expect(await planner).toBe('plan');
        finish('card');
        expect(await card).toBe('card');
    });
    it('charges failed dispatches but does not strand the queue', async () => {
        vi.useFakeTimers();
        const limiter = new GenerationRateLimiter();
        await expect(limiter.execute(() => { throw new Error('sync'); }, quota, 'agent')).rejects.toThrow('sync');
        const failed = limiter.execute(() => Promise.reject(new Error('async')), quota, 'agent');
        const caught = expect(failed).rejects.toThrow('async');
        const next = limiter.execute(() => 'ok', quota, 'npc-card');
        await vi.runAllTimersAsync();
        await caught;
        expect(await next).toBe('ok');
        expect(limiter.queue).toEqual([]);
        expect(limiter.timer).toBeNull();
    });
    it('drops a request whose deadline passes before a slot opens, without charging quota', async () => {
        vi.useFakeTimers();
        const limiter = new GenerationRateLimiter();
        await limiter.execute(() => 'seed', quota, 'extraction');
        const fn = vi.fn(() => 'plan');
        const planner = limiter.execute(fn, quota, 'agent', { deadline: Date.now() + 400 });
        const rejected = expect(planner).rejects.toMatchObject({ name: 'GenerationQueueTimeoutError' });
        const extraction = limiter.execute(() => 'extract', quota, 'extraction');
        await vi.advanceTimersByTimeAsync(400);
        await rejected;
        expect(fn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(700);
        expect(await extraction).toBe('extract');
        expect(limiter.timestamps).toHaveLength(1);
        expect(limiter.queue).toEqual([]);
    });
    it('keeps the window\'s last slot free from background cards', async () => {
        vi.useFakeTimers();
        const limiter = new GenerationRateLimiter();
        const twoPerSecond = { rate_limit_calls: 2, rate_limit_interval: 1 };
        const calls = [];
        const run = label => limiter.execute(() => calls.push([label, Date.now()]), twoPerSecond, label);
        await run('extraction');
        const card = run('npc-card');
        expect(calls.map(c => c[0])).toEqual(['extraction']);
        await run('agent');
        expect(calls.map(c => c[0])).toEqual(['extraction', 'agent']);
        await vi.runAllTimersAsync();
        await card;
        expect(calls.map(c => c[0])).toEqual(['extraction', 'agent', 'npc-card']);
        expect(calls[2][1]).toBeGreaterThanOrEqual(1000);
        const solo = new GenerationRateLimiter();
        expect(await solo.execute(() => 'card', quota, 'npc-card')).toBe('card');
    });
    it('preserves disabled passthrough and uses updated settings on queued work', async () => {
        vi.useFakeTimers();
        const limiter = new GenerationRateLimiter();
        const settings = generationRateLimitSettings({ generation_rate_limit_calls: 1, generation_rate_limit_interval: 1 });
        await limiter.execute(() => 'seed', settings, 'extraction');
        const fn = vi.fn(() => 'card');
        const pending = limiter.execute(fn, settings, 'npc-card');
        settings.rate_limit_calls = 0;
        expect(await limiter.execute(() => 'planner', settings, 'agent')).toBe('planner');
        expect(await pending).toBe('card');
        expect(fn).toHaveBeenCalledTimes(1);
        expect(limiter.timer).toBeNull();
    });
});