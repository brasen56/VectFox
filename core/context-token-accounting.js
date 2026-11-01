/**
 * Host-independent accounting for final VectFox prompt blocks. No registry
 * mutation, logging, persistence, lifecycle listeners, or character heuristics.
 */
import { classifyContextTokenTag } from './context-token-contract.js';

export const CONTEXT_TOKEN_ACCURACY = 'Approximate last-measured-turn context contribution, not monetary cost or exact provider-request growth. Counts are summed per block; subsequent formatting and truncation may differ. The host-selected tokenizer may differ from the provider tokenizer.';

/** Copy only owned entries synchronously, before any asynchronous tokenization. */
export function snapshotContextTokenPrompts(registry) {
    return Object.fromEntries(Object.keys(registry).filter(tag => classifyContextTokenTag(tag)).map(tag => {
        const entry = registry[tag];
        return [tag, {
            value: typeof entry?.value === 'string' ? entry.value : null,
            position: Number.isFinite(entry?.position) ? entry.position : null,
            depth: Number.isFinite(entry?.depth) ? entry.depth : null,
        }];
    }));
}

/**
 * @typedef {object} ContextTokenPort
 * @property {{id?: number, key?: string, name?: string, model?: string}} identity
 * @property {function(string, {signal?: AbortSignal}?): Promise<number>|number} count Receives literal text and optional cancellation.
 */

/**
 * Count each nonempty owned block once, even when several blocks are identical.
 * Whitespace is not empty. The input is copied before the first await.
 *
 * Total is null unless ALL slots succeed. Failed categories also have null
 * counts; partialTotal and successful slots are diagnostics, not a badge total.
 * Error codes are fixed strings: tokenizer errors may contain private text and
 * must never be attached to the result. No returned object retains prompt text.
 *
 * @param {object} snapshot Registry-shaped snapshot (never mutated).
 * @param {object} options
 * @param {string|null} [options.chatId=null]
 * @param {number|null} [options.generationId=null]
 * @param {ContextTokenPort|null} [options.tokenizer=null]
 * @param {AbortSignal} [options.signal] Aborts the active tokenizer request.
 * @param {function(): boolean} [options.isCurrent] Checked before and after each block.
 * @returns {Promise<object|null>} Serializable, text-free result, or null when invalidated.
 */
export async function countContextTokens(snapshot, {
    chatId = null, generationId = null, tokenizer = null, signal, isCurrent = () => true,
} = {}) {
    const cancelled = () => signal?.aborted || !isCurrent();
    if (cancelled()) return null;
    const result = {
        chatId, generationId, status: 'ok', total: null, partialTotal: 0,
        perCategory: {}, slots: [], tokenizer: null,
        accuracy: CONTEXT_TOKEN_ACCURACY, countingConvention: 'sum-of-blocks',
        partial: false, error: null,
    };
    if (tokenizer?.identity) {
        // Copy known scalar metadata only; never retain a port or arbitrary data.
        result.tokenizer = Object.fromEntries(Object.entries(tokenizer.identity).filter(([key, value]) =>
            (key === 'id' && Number.isSafeInteger(value)) ||
            (['key', 'name', 'model'].includes(key) && typeof value === 'string')));
    }

    let entries;
    try {
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError();
        entries = snapshotContextTokenPrompts(snapshot);
    } catch {
        result.status = 'failed';
        result.error = 'invalid-snapshot';
        return result;
    }

    const available = typeof tokenizer?.count === 'function';
    if (!available) {
        result.status = 'unavailable-tokenizer';
        result.error = 'unavailable-tokenizer';
    }
    const categories = new Map();
    for (const [tag, entry] of Object.entries(entries)) {
        if (cancelled()) return null;
        if (entry.value === '') continue;
        const { category, label } = classifyContextTokenTag(tag);
        const slot = {
            tag, category, label, position: entry.position, depth: entry.depth,
            count: null, status: 'failed', error: null,
        };
        if (!categories.has(category)) categories.set(category, 0);
        if (entry.value === null) {
            slot.error = 'invalid-value';
        } else if (!available) {
            slot.status = 'unavailable-tokenizer';
            slot.error = 'unavailable-tokenizer';
        } else {
            try {
                const count = await (signal ? tokenizer.count(entry.value, { signal }) : tokenizer.count(entry.value));
                if (cancelled()) return null;
                if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(result.partialTotal + count)) {
                    slot.error = 'invalid-count';
                } else {
                    slot.count = count;
                    slot.status = 'ok';
                    result.partialTotal += count;
                    if (categories.get(category) !== null) categories.set(category, categories.get(category) + count);
                }
            } catch {
                if (cancelled()) return null;
                slot.error = 'tokenization-failed';
            }
        }
        if (slot.status !== 'ok') {
            categories.set(category, null);
            if (available) {
                result.status = 'failed';
                result.error = 'incomplete-measurement';
            }
        }
        result.slots.push(slot);
    }
    result.perCategory = Object.fromEntries(categories);
    result.partial = result.status !== 'ok' && result.slots.some(slot => slot.status === 'ok');
    if (result.status === 'ok') result.total = result.partialTotal;
    return result;
}