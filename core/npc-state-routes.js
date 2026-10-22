/** Summarizer uses characters, not the retrieval token envelope. Whole blocks only. */
import { estimateCastTokens } from './eventbase-injection.js';

export function combineNpcSummarizerState({ text = '', maxChars, stateLimit, contexts, settings, formatState }) {
    const blocks = [], omitted = [], excluded = [];
    let remaining = Math.max(0, stateLimit);
    for (const context of contexts) {
        const state = formatState({ settings, ...context, tokenBudget: remaining });
        if (state.text) {
            const candidate = [...blocks, state.text].join('\n\n');
            if (candidate.length <= maxChars) { blocks.push(state.text); remaining -= estimateCastTokens(state.text) + 1; }
            else omitted.push(...state.included.map(id => ({ id, reason: 'summarizer_character_budget' })));
        }
        omitted.push(...state.omitted); excluded.push(...state.excluded);
    }
    const state = blocks.join('\n\n');
    // Reserve state first. Historical summarizer blocks are atomic; do not slice provenance.
    if (state && text.length + state.length + 2 > maxChars) text = '';
    const combined = [state, text].filter(Boolean).join('\n\n');
    return { text: combined.length <= maxChars ? combined : '', omitted, excluded,
        characters: combined.length <= maxChars ? combined.length : 0, estimatedStateTokens: estimateCastTokens(state) };
}