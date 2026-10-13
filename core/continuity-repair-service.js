/** Browser integration: backend routing, tiny settings checkpoints and shared generation quota. */
import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { ensureCharacterIndex, getCharacterRoster, rosterCollectionId, upsertCharacterEvents } from './character-roster.js';
import { resolveBackendForCollection } from './collection-ids.js';
import { getBackend, getBackendForCollection } from '../backends/backend-manager.js';
import { fetchChunksWithVectors } from './collection-export.js';
import { postChatCompletion, parseJsonArrayFromLlm, resolveModelParameterStyle } from './llm-provider-call.js';
import { generationRateLimiter, generationRateLimitSettings } from './generation-rate-limiter.js';
import { ContinuityRepair } from './continuity-repair.js';
import { threadsDigest } from './continuity.js';

const collectionOperations = new Map();

export async function continuityCollection(collectionKey, settings) {
    const id = rosterCollectionId(collectionKey);
    const resolved = resolveBackendForCollection(collectionKey);
    const backend = resolved.backend ? await getBackendForCollection(resolved.backend, settings) : await getBackend(settings);
    const currentEntry = async () => {
        const entry = await ensureCharacterIndex(collectionKey, settings);
        if (!entry?.ready || backend.pluginAvailable === false || typeof backend.updateChunkMetadata !== 'function') {
            throw new Error('Continuity requires readable metadata and Qdrant or Standard with the Similharity plugin');
        }
        return entry;
    };
    const entry = await currentEntry();
    const write = async (event, continuity) => {
        const latest = (await currentEntry()).events.get(event.event_id);
        if (!latest || threadsDigest(latest) !== threadsDigest(event)
            || JSON.stringify(latest.continuity) !== JSON.stringify(event.continuity)) {
            throw new Error('Event changed before continuity write; retry with the current inventory');
        }
        // Metadata PATCH changes no text, vector, archive fields or extraction bookkeeping.
        const result = await backend.updateChunkMetadata(id, event.hash, { continuity }, settings);
        if (result?.success === false) throw new Error(result.error || 'Continuity write failed');
        const current = (await currentEntry()).events.get(event.event_id);
        if (current) upsertCharacterEvents(id, [{ hash: current.hash, metadata: { ...current, continuity } }]);
    };
    return { id, entry, backend, write, currentEntry };
}

export function repairConfiguration(settings, override = {}) {
    return { provider: (override.provider || settings.chat_provider || 'openrouter').trim(),
        model: (override.model || settings.chat_model || '').trim(),
        url: (override.url || settings.chat_vllm_url || '').trim() };
}

export async function createContinuityRepair(collectionKey, settings, override = {}) {
    const context = await continuityCollection(collectionKey, settings);
    const { provider, model, url } = repairConfiguration(settings, override);
    if (!model || !['openrouter', 'vllm'].includes(provider)) throw new Error('Select a valid repair provider and model');
    const vectorSettings = { ...settings, vector_backend: context.backend.type || resolveBackendForCollection(collectionKey).backend || settings.vector_backend };
    let vectors = new Map(), vectorHashes = new Map();
    const loadVectors = async events => {
        const raw = await fetchChunksWithVectors(context.id, vectorSettings);
        const byHash = new Map([...events.values()].map(event => [String(event.hash), event.event_id]));
        const next = new Map(), hashes = new Map();
        for (const item of raw) {
            const hash = String(item.hash ?? item.metadata?.hash);
            const id = item.metadata?.event_id || item.event_id || byHash.get(hash);
            const value = item.vector || item.metadata?.vector;
            const dense = Array.isArray(value) ? value : value?.[''];
            if (events.has(id) && String(events.get(id).hash) === hash && Array.isArray(dense)) {
                // Half the memory of plain number arrays for thousands of 1024-dimension vectors.
                next.set(id, Float32Array.from(dense)); hashes.set(id, hash);
            }
        }
        vectors = next; vectorHashes = hashes;
    };
    await loadVectors(context.entry.events);
    if (vectors.size < context.entry.events.size) throw new Error('Incomplete vector inventory; repair cannot safely proceed');
    if (!collectionOperations.has(context.id)) collectionOperations.set(context.id, { tail: Promise.resolve() });
    const effectiveModel = `${provider}/${model}`;
    const engine = new ContinuityRepair({ events: context.entry.events, vectors,
        operations: collectionOperations.get(context.id),
        groups: getCharacterRoster([context.id], settings).groups, write: context.write, model: effectiveModel, endpoint: url,
        refresh: async () => {
            const events = (await context.currentEntry()).events;
            if (events.size !== vectorHashes.size || [...events.values()].some(event => vectorHashes.get(event.event_id) !== String(event.hash))) {
                // Missing or stale exported vectors are excluded, never paired with edited text.
                await loadVectors(events);
            }
            return { events, vectors, groups: getCharacterRoster([context.id], settings).groups };
        },
        checkpoint: state => {
            settings.eventbase_continuity_repair ??= {};
            settings.eventbase_continuity_repair[context.id] = JSON.parse(JSON.stringify(state));
            extension_settings.vectfox.eventbase_continuity_repair = settings.eventbase_continuity_repair;
            saveSettingsDebounced();
        },
        complete: async prompt => {
            const response = await generationRateLimiter.execute(() => {
                // A pause while queued must not turn into a paid call later.
                if (engine.stop) throw Object.assign(new Error('Repair paused before dispatch'), { repairPaused: true });
                return postChatCompletion({ messages: [{ role: 'user', content: prompt }], provider, model,
                    vllmUrl: url, maxTokens: settings.eventbase_max_tokens || 4096,
                    temperature: 0.2, timeoutMs: settings.eventbase_timeout_ms || 60000, contextLabel: 'Continuity repair',
                    ...resolveModelParameterStyle(settings) });
            }, generationRateLimitSettings(settings), 'repair');
            try {
                if (response.finishReason === 'length') throw new Error('Repair judge response truncated; batch not committed');
                return { records: parseJsonArrayFromLlm(response.content, { label: 'Continuity repair', identKeys: ['ref'] }),
                    inputTokens: response.usage?.prompt_tokens };
            } catch (error) {
                error.completedCall = true;
                error.inputTokens = response.usage?.prompt_tokens;
                throw error;
            }
        } });
    engine.state = settings.eventbase_continuity_repair?.[context.id];
    return engine;
}

export async function markEventResolved(collectionKey, eventId, settings, threads = 'all', how = 'Marked resolved by the user.') {
    const { entry, write } = await continuityCollection(collectionKey, settings);
    const event = entry.events.get(eventId);
    if (!event) throw new Error('Event is no longer in the collection');
    if (threads !== 'all' && (!Array.isArray(threads) || !threads.length || threads.some(i => !Number.isInteger(i) || i < 0 || i >= event.open_threads.length))) {
        throw new Error('Select valid original thread indices');
    }
    const continuity = JSON.parse(JSON.stringify(event.continuity || { v: 1 }));
    if (continuity.v !== 1) throw new Error('Unsupported continuity version');
    // Keep a displaced repair/extraction closure so Unmark is reversible.
    if (continuity.closed_threads?.origin !== 'user' && continuity.closed_threads) continuity.user_previous_closure = continuity.closed_threads;
    continuity.closed_threads = { threads, threads_digest: threadsDigest(event), how: String(how).slice(0, 200), origin: 'user', run: null, status: 'active' };
    await write(event, continuity);
}

export async function unmarkEventResolved(collectionKey, eventId, settings) {
    const { entry, write } = await continuityCollection(collectionKey, settings);
    const event = entry.events.get(eventId);
    if (event?.continuity?.closed_threads?.origin !== 'user') return;
    const continuity = JSON.parse(JSON.stringify(event.continuity));
    delete continuity.closed_threads;
    if (continuity.user_previous_closure) continuity.closed_threads = continuity.user_previous_closure;
    delete continuity.user_previous_closure;
    await write(event, continuity);
}

export async function removeResolutionLink(collectionKey, owner, link, settings) {
    const { entry, write } = await continuityCollection(collectionKey, settings);
    const event = entry.events.get(owner);
    if (!event?.continuity) return;
    const continuity = JSON.parse(JSON.stringify(event.continuity));
    continuity.resolves = (continuity.resolves || []).filter(candidate => JSON.stringify(candidate) !== JSON.stringify(link));
    await write(event, continuity);
}