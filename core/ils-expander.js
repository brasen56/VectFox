/**
 * InlineSummary compatibility helpers.
 *
 * InlineSummary replaces a range of chat messages with one summary message and
 * keeps the originals either on the message itself or in chat metadata. EventBase
 * must operate on those originals so extraction hashes, window coordinates, and
 * auto-sync progress stay stable when the visible chat is compacted.
 *
 * This module is deliberately host-agnostic and side-effect free. Callers pass
 * SillyTavern's chat_metadata explicitly, which keeps the expansion logic easy to
 * test and safe to reuse from ingestion, status, retrieval, and ghosting.
 */

const MAX_NESTING_DEPTH = 64;

function ilsData(message) {
    const data = message?.extra?.ILS_Data;
    if (!data || typeof data !== 'object') return null;
    if (Array.isArray(data.OriginalMessages) || typeof data.Ref === 'string') return data;
    return null;
}

function resolveOriginals(data, chatMetadata) {
    if (Array.isArray(data?.OriginalMessages) && data.OriginalMessages.length > 0) {
        return data.OriginalMessages;
    }
    if (typeof data?.Ref === 'string') {
        const referenced = chatMetadata?.ILS_Originals?.[data.Ref];
        if (Array.isArray(referenced)) return referenced;
    }
    return Array.isArray(data?.OriginalMessages) ? data.OriginalMessages : null;
}

/**
 * Expand InlineSummary messages into their original leaf messages.
 *
 * Supported storage shapes:
 *   - message.extra.ILS_Data.OriginalMessages
 *   - chatMetadata.ILS_Originals[message.extra.ILS_Data.Ref]
 *
 * Nested summaries are flattened recursively. Dangling references, empty
 * original arrays, cycles, and excessive nesting retain the summary itself so
 * content is never silently discarded. Neither the input array nor its messages
 * are mutated.
 *
 * @param {object[]} messages
 * @param {object} [chatMetadata]
 * @returns {{
 *   expanded: object[],
 *   sourceIndices: number[],
 *   stats: {
 *     summariesFound: number,
 *     originalsRecovered: number,
 *     maxDepth: number,
 *     danglingSummaries: number,
 *     cycleOrDepthStops: number,
 *   }
 * }}
 */
export function expandILSMessages(messages, chatMetadata = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return {
            expanded: Array.isArray(messages) ? messages : [],
            sourceIndices: [],
            stats: {
                summariesFound: 0,
                originalsRecovered: 0,
                maxDepth: 0,
                danglingSummaries: 0,
                cycleOrDepthStops: 0,
            },
        };
    }

    const expanded = [];
    const sourceIndices = [];
    const stats = {
        summariesFound: 0,
        originalsRecovered: 0,
        maxDepth: 0,
        danglingSummaries: 0,
        cycleOrDepthStops: 0,
    };

    const push = (message, sourceIndex, recovered) => {
        if (!message) return;
        expanded.push(message);
        sourceIndices.push(sourceIndex);
        if (recovered) stats.originalsRecovered++;
    };

    const flatten = (message, sourceIndex, depth, path) => {
        const data = ilsData(message);
        if (!data) {
            push(message, sourceIndex, depth > 0);
            return;
        }

        stats.summariesFound++;
        stats.maxDepth = Math.max(stats.maxDepth, depth);

        if (depth >= MAX_NESTING_DEPTH || (message && path.has(message))) {
            stats.cycleOrDepthStops++;
            push(message, sourceIndex, false);
            return;
        }

        const originals = resolveOriginals(data, chatMetadata);
        if (!Array.isArray(originals) || originals.length === 0) {
            stats.danglingSummaries++;
            push(message, sourceIndex, false);
            return;
        }

        if (message && typeof message === 'object') path.add(message);
        for (const original of originals) {
            flatten(original, sourceIndex, depth + 1, path);
        }
        if (message && typeof message === 'object') path.delete(message);
    };

    messages.forEach((message, sourceIndex) => {
        flatten(message, sourceIndex, 0, new WeakSet());
    });

    return { expanded, sourceIndices, stats };
}

/**
 * Produce the exact non-empty message sequence EventBase should use.
 * Expansion happens before filtering so a summary with an empty visible body can
 * still recover non-empty originals.
 *
 * @param {object[]} messages
 * @param {object} [chatMetadata]
 * @returns {ReturnType<typeof expandILSMessages> & { messages: object[], visibleCount: number }}
 */
export function prepareMessagesForEventBase(messages, chatMetadata = {}) {
    const input = Array.isArray(messages) ? messages : [];
    const result = expandILSMessages(input, chatMetadata);
    const prepared = [];
    const preparedSourceIndices = [];

    for (let i = 0; i < result.expanded.length; i++) {
        const message = result.expanded[i];
        if (!message?.mes || !String(message.mes).trim()) continue;
        prepared.push(message);
        preparedSourceIndices.push(result.sourceIndices[i]);
    }

    return {
        ...result,
        expanded: prepared,
        messages: prepared,
        sourceIndices: preparedSourceIndices,
        visibleCount: input.filter(message => message?.mes && String(message.mes).trim()).length,
    };
}

/**
 * Translate an EventBase tip (exclusive index in expanded-message coordinates)
 * into an exclusive index in the visible top-level chat. A collapsed summary is
 * considered covered only when every recovered original beneath it is below the
 * tip. This conservative rule prevents prompt ghosting from hiding a summary whose
 * original range is only partially vectorized.
 *
 * @param {object[]} messages
 * @param {number} effectiveTip
 * @param {object} [chatMetadata]
 * @returns {{ topLevelExclusive: number, effectiveLength: number }}
 */
export function mapEffectiveTipToTopLevel(messages, effectiveTip, chatMetadata = {}) {
    const input = Array.isArray(messages) ? messages : [];
    const prepared = prepareMessagesForEventBase(input, chatMetadata);
    const tip = Math.max(0, Math.floor(Number(effectiveTip) || 0));
    const contributions = new Array(input.length).fill(0);
    for (const sourceIndex of prepared.sourceIndices) {
        if (sourceIndex >= 0 && sourceIndex < contributions.length) contributions[sourceIndex]++;
    }

    let consumed = 0;
    let topLevelExclusive = 0;
    for (let i = 0; i < contributions.length; i++) {
        const next = consumed + contributions[i];
        if (next > tip) break;
        consumed = next;
        topLevelExclusive = i + 1;
    }

    return {
        topLevelExclusive,
        effectiveLength: prepared.messages.length,
    };
}
