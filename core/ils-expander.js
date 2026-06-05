/**
 * ============================================================================
 * INLINE SUMMARY (ILS) EXPANDER
 * ============================================================================
 * Expands InlineSummary summary messages back into their original messages
 * so VectFox can extract events from the full detailed content.
 *
 * This is a READ-ONLY operation — the original chat array is never modified.
 * A new array is returned with ILS summary messages replaced by their originals.
 *
 * InlineSummary stores original messages in:
 *   msg.extra.ILS_Data.OriginalMessages  (array of message objects)
 *
 * @author VectFox ILS Integration
 * ============================================================================
 */

import { log } from './log.js';

/**
 * Checks if a message is an InlineSummary summary message
 * @param {object} msg Chat message object
 * @returns {boolean} True if this is an ILS summary message
 */
function isILSSummaryMessage(msg) {
    return !!(msg?.extra?.ILS_Data?.OriginalMessages);
}

/**
 * Expands InlineSummary summary messages back into their original messages.
 *
 * When InlineSummary summarizes a range of messages, it:
 * 1. Replaces those messages with a single summary message
 * 2. Stores the originals in msg.extra.ILS_Data.OriginalMessages
 *
 * This function detects such summary messages and replaces each one with
 * its original messages, so the downstream pipeline sees full detail.
 *
 * PURE FUNCTION — does not modify the input array or any messages.
 *
 * @param {object[]} messages Array of chat message objects
 * @returns {{ expanded: object[], stats: { summariesFound: number, originalsRecovered: number } }}
 */
export function expandILSMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { expanded: messages, stats: { summariesFound: 0, originalsRecovered: 0 } };
    }

    let summariesFound = 0;
    let originalsRecovered = 0;
    const expanded = [];

    for (const msg of messages) {
        if (isILSSummaryMessage(msg)) {
            const originals = msg.extra.ILS_Data.OriginalMessages;
            summariesFound++;

            if (Array.isArray(originals) && originals.length > 0) {
                // Expand: push each original message
                for (const orig of originals) {
                    // Reconstruct a message-like object with the original fields
                    // Ensure mes and name are present for downstream consumers
                    if (orig && orig.mes) {
                        expanded.push(orig);
                        originalsRecovered++;
                    }
                }
                log.verbose(`[ILS Expander] Expanded ILS summary into ${originals.length} original messages`);
            } else {
                // No originals available — keep the summary as-is (better than dropping it)
                expanded.push(msg);
                log.verbose('[ILS Expander] ILS summary has no originals, keeping summary text');
            }
        } else {
            // Normal message — pass through unchanged
            expanded.push(msg);
        }
    }

    if (summariesFound > 0) {
        log.lifecycle(`[ILS Expander] Expanded ${summariesFound} ILS summaries, recovered ${originalsRecovered} original messages (input: ${messages.length}, output: ${expanded.length})`);
    }

    return { expanded, stats: { summariesFound, originalsRecovered } };
}