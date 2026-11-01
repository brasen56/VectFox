/** Generation accounting only: no prompt writes, persistence, or UI dependencies. */
import { countContextTokens, snapshotContextTokenPrompts } from './context-token-accounting.js';

export function createContextTokenLifecycle({
    eventSource, eventTypes, readEnabled, readChatId, readRegistry, createTokenizer,
}) {
    let revision = 0;
    let generationId = 0;
    let initialized = false;
    let activeController = null;
    let state = Object.freeze({ status: 'disabled', result: null });
    const listeners = new Set();

    function publish(status, result = null) {
        state = Object.freeze({ status, result });
        for (const listener of listeners) {
            // A broken badge renderer must never affect generation or other subscribers.
            try { listener(state); } catch { /* No private error payloads in logs. */ }
        }
    }

    function invalidate() {
        revision++;
        activeController?.abort();
        activeController = null;
    }

    function reset() {
        invalidate();
        publish(readEnabled() ? 'unmeasured' : 'disabled');
    }

    function refreshEnabled() {
        if (!readEnabled()) {
            invalidate();
            publish('disabled');
        } else if (state.status === 'disabled') {
            reset();
        }
    }

    async function measureGeneration() {
        // No registry reads, tokenizer loading, or tokenization while disabled.
        if (!readEnabled()) {
            refreshEnabled();
            return;
        }
        invalidate();
        const currentRevision = revision;
        const currentGeneration = ++generationId;
        const controller = new AbortController();
        activeController = controller;
        let chatId;
        const isCurrent = () => !controller.signal.aborted && initialized && revision === currentRevision &&
            readEnabled() && readChatId() === chatId;
        try {
            chatId = readChatId();
            // Must precede the first await, including the lazy host adapter load.
            const snapshot = snapshotContextTokenPrompts(readRegistry());
            const tokenizer = await createTokenizer();
            if (!isCurrent()) return;
            const result = await countContextTokens(snapshot, {
                chatId, generationId: currentGeneration, tokenizer, signal: controller.signal, isCurrent,
            });
            if (result && isCurrent()) publish(result.status === 'ok' ? 'available' : 'unavailable', result);
        } catch {
            if (isCurrent()) publish('unavailable');
        } finally {
            if (activeController === controller) activeController = null;
        }
    }

    function onGenerationEnded() {
        // Snapshot capture runs synchronously, but host listeners must not await accounting.
        void measureGeneration().catch(() => { /* Detached accounting must never reject into the host. */ });
    }

    return {
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        refreshEnabled,
        initialize() {
            if (initialized) return;
            initialized = true;
            eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
            eventSource.on(eventTypes.CHAT_CHANGED, reset);
            reset();
        },
        dispose() {
            if (!initialized) return;
            initialized = false;
            invalidate();
            eventSource.removeListener(eventTypes.GENERATION_ENDED, onGenerationEnded);
            eventSource.removeListener(eventTypes.CHAT_CHANGED, reset);
            publish('disabled');
            listeners.clear();
        },
    };
}