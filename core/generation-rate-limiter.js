/**
 * ============================================================================
 * GENERATION (chat-completions) RATE LIMITER
 * ============================================================================
 * Shared sliding-window throttle for non-embedding LLM calls:
 *   - EventBase summarization extraction (core/eventbase-workflow.js)
 *   - Agent Mode planner             (core/agentic-retrieval.js)
 *   - Background NPC cards           (core/npc-card-llm.js)
 *
 * All POST to /api/backends/chat-completions/generate, and Agent Mode's model
 * defaults to the summarizer's model — so they typically hit the SAME provider
 * quota. They therefore draw from ONE shared rate budget here, distinct from the
 * embedding limiter (`dynamicRateLimiter` in core/core-vector-api.js) which
 * throttles the embedding endpoint on its own separate budget.
 *
 * Throttled by settings.generation_rate_limit_calls / _interval (0 = disabled,
 * pure passthrough — the default, so existing users see no behavior change).
 * ============================================================================
 */

import { log } from './log.js';

/** Rejects a queued request whose caller deadline passed before dispatch. */
export class GenerationQueueTimeoutError extends Error {
    constructor(label, waitedMs) {
        super(`${label || 'generation'} request dropped after waiting ${waitedMs}ms for a rate-limit slot`);
        this.name = 'GenerationQueueTimeoutError';
    }
}

/** One quota, with planner > extraction > background cards at dispatch time.
 * In-flight calls are not preempted. Equal-priority work remains FIFO, and
 * requests do not hold the dispatch queue while awaiting their LLM response.
 * Background cards never take a window's last slot, and a request with a
 * `deadline` is dropped, uncharged, once its caller has stopped waiting.
 */
export class GenerationRateLimiter {
    constructor() {
        this.timestamps = [];
        this.queue = [];
        this.timer = null;
    }

    execute(fn, settings, label = '', { deadline = Infinity } = {}) {
        return new Promise((resolve, reject) => {
            const priority = label === 'agent' ? 2 : label === 'npc-card' ? 0 : 1;
            this.queue.push({ fn, settings, label, priority, deadline, queuedAt: Date.now(), resolve, reject });
            this.queue.sort((a, b) => b.priority - a.priority);
            this._drain();
        });
    }

    _drain() {
        // A new planner can overtake cards already waiting for the next slot.
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        while (this.queue.length) {
            const now = Date.now();
            this.queue = this.queue.filter(request => {
                if (request.deadline > now) return true;
                request.reject(new GenerationQueueTimeoutError(request.label, now - request.queuedAt));
                return false;
            });
            if (!this.queue.length) return;
            const request = this.queue[0];
            const maxCalls = request.settings.rate_limit_calls || 0;
            const intervalMs = (request.settings.rate_limit_interval || 60) * 1000;
            // Disabled throttling remains passthrough, as before.
            if (maxCalls > 0) {
                this.timestamps = this.timestamps.filter(t => now - t < intervalMs);
                // Leave the last slot for foreground work, so a planner that
                // arrives just after a card does not wait a full interval.
                const usable = request.priority === 0 && maxCalls > 1 ? maxCalls - 1 : maxCalls;
                if (this.timestamps.length >= usable) {
                    const waitTime = this.timestamps[this.timestamps.length - usable] + intervalMs - now + 100;
                    // Also wake for the earliest deadline, so its caller hears back promptly.
                    const deadlineWait = Math.min(...this.queue.map(r => r.deadline)) - now;
                    log.verbose(`VectFox: Rate limit reached${request.label ? ` [${request.label}]` : ''}. Waiting ${Math.round(waitTime / 1000)}s...`);
                    this.timer = setTimeout(() => this._drain(), Math.min(waitTime, deadlineWait));
                    return;
                }
                this.timestamps.push(now);
            }
            this.queue.shift();
            // Catch synchronous throws as well as rejected provider promises.
            try {
                Promise.resolve(request.fn()).then(request.resolve, request.reject);
            } catch (error) {
                request.reject(error);
            }
        }
    }
}

/** Single shared instance — one sliding window across all generation callers. */
export const generationRateLimiter = new GenerationRateLimiter();

/**
 * Map VectFox's `generation_*` keys onto the limiter's generic setting keys.
 * @param {object} settings - VectFox settings
 * @returns {{rate_limit_calls: number, rate_limit_interval: number}}
 */
export function generationRateLimitSettings(settings) {
    return {
        rate_limit_calls: settings?.generation_rate_limit_calls || 0,
        rate_limit_interval: settings?.generation_rate_limit_interval || 60,
    };
}
