/** Browser integration: backend routing, tiny settings checkpoints and shared generation quota. */
import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { ensureCharacterIndex, getCharacterRoster, rosterCollectionId, rosterCollectionKey, upsertCharacterEvents } from './character-roster.js';
import { resolveBackendForCollection } from './collection-ids.js';
import { getBackend, getBackendForCollection } from '../backends/backend-manager.js';
import { fetchChunksWithVectors } from './collection-export.js';
import { postChatCompletion, parseJsonArrayFromLlm, resolveModelParameterStyle } from './llm-provider-call.js';
import { generationRateLimiter, generationRateLimitSettings } from './generation-rate-limiter.js';
import { ContinuityRepair, repairLanguageMode } from './continuity-repair.js';
import { threadsDigest, continuityActionSnapshot } from './continuity.js';

const collectionOperations = new Map();
const eventWrites = new Map();

/** One-runtime check/PATCH/cache transaction. Other tabs need backend conditional writes. */
async function serializeEventWrite(key, operation) {
    const previous = eventWrites.get(key) || Promise.resolve();
    const pending = previous.then(operation);
    const tail = pending.catch(() => {});
    eventWrites.set(key, tail);
    try { return await pending; }
    finally { if (eventWrites.get(key) === tail) eventWrites.delete(key); }
}

export async function continuityCollection(collectionKey, settings) {
    collectionKey = rosterCollectionKey(collectionKey, settings);
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
    const write = (event, continuity, expected = null) => serializeEventWrite(JSON.stringify([collectionKey, event.event_id]), async () => {
        const latest = (await currentEntry()).events.get(event.event_id);
        assertReviewedEvent(latest, expected);
        if (!latest || latest.hash !== event.hash || threadsDigest(latest) !== threadsDigest(event)
            || JSON.stringify(latest.continuity) !== JSON.stringify(event.continuity)) {
            throw new Error('Event changed before continuity write. Refresh and review the current inventory before trying again.');
        }
        // Metadata PATCH changes no text, vector, archive fields or extraction bookkeeping.
        const result = await backend.updateChunkMetadata(id, event.hash, { continuity }, settings);
        if (result?.success === false) throw new Error(result.error || 'Continuity write failed');
        const current = (await currentEntry()).events.get(event.event_id);
        if (current) upsertCharacterEvents(collectionKey, [{ hash: current.hash, metadata: { ...current, continuity } }], settings);
    });
    return { id, key: collectionKey, entry, backend, write, currentEntry };
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
    if (!collectionOperations.has(context.key)) collectionOperations.set(context.key, { tail: Promise.resolve() });
    const effectiveModel = `${provider}/${model}`;
    const engine = new ContinuityRepair({ events: context.entry.events, vectors,
        operations: collectionOperations.get(context.key),
        groups: getCharacterRoster([context.key], settings).groups, write: context.write, model: effectiveModel, endpoint: url,
        language: repairLanguageMode(settings),
        refresh: async () => {
            const events = (await context.currentEntry()).events;
            if (events.size !== vectorHashes.size || [...events.values()].some(event => vectorHashes.get(event.event_id) !== String(event.hash))) {
                // Missing or stale exported vectors are excluded, never paired with edited text.
                await loadVectors(events);
            }
            return { events, vectors, groups: getCharacterRoster([context.key], settings).groups };
        },
        checkpoint: state => {
            settings.eventbase_continuity_repair ??= {};
            if (state) settings.eventbase_continuity_repair[context.id] = JSON.parse(JSON.stringify(state));
            else delete settings.eventbase_continuity_repair[context.id];
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
    engine.restoreState(settings.eventbase_continuity_repair?.[context.id]);
    return engine;
}

function assertReviewedEvent(event, expected) {
    if (expected && (!event || JSON.stringify(continuityActionSnapshot(event)) !== JSON.stringify(expected))) {
        throw new Error('Event changed since review. Refresh and review the current evidence before trying again.');
    }
}

export async function markEventResolved(collectionKey, eventId, settings, threads = 'all', how = 'Marked resolved by the user.', expected = null) {
    const { entry, write } = await continuityCollection(collectionKey, settings);
    const event = entry.events.get(eventId);
    assertReviewedEvent(event, expected);
    if (!event) throw new Error('Event is no longer in the collection');
    if (threads !== 'all' && (!Array.isArray(threads) || !threads.length || threads.some(i => !Number.isInteger(i) || i < 0 || i >= event.open_threads.length))) {
        throw new Error('Select valid original thread indices');
    }
    const continuity = JSON.parse(JSON.stringify(event.continuity || { v: 1 }));
    if (continuity.v !== 1) throw new Error('Unsupported continuity version');
    const digest = threadsDigest(event);
    const current = continuity.closed_threads;
    // Successive marks accumulate. Only a closure that still applies contributes indices.
    const priorUser = current?.origin === 'user' && current.status === 'active' && current.threads_digest === digest ? current.threads : null;
    const merged = threads === 'all' || priorUser === 'all' ? 'all'
        : [...new Set([...(Array.isArray(priorUser) ? priorUser : []), ...threads])].sort((a, b) => a - b);
    // A displaced repair/extraction closure stays in force underneath (getContinuityView
    // applies it) and comes back as the closure on Unmark.
    if (current?.origin !== 'user' && current) continuity.user_previous_closure = current;
    continuity.closed_threads = { threads: merged, threads_digest: digest, how: String(how).slice(0, 200), origin: 'user', run: null, status: 'active' };
    await write(event, continuity, expected);
}

export async function unmarkEventResolved(collectionKey, eventId, settings, threads = 'all', expected = null) {
    const { entry, write } = await continuityCollection(collectionKey, settings);
    const event = entry.events.get(eventId);
    assertReviewedEvent(event, expected);
    if (event?.continuity?.closed_threads?.origin !== 'user') return;
    const continuity = JSON.parse(JSON.stringify(event.continuity));
    if (continuity.v !== 1) throw new Error('Unsupported continuity version');
    if (threads !== 'all') {
        if (!Array.isArray(threads) || !threads.length || threads.some(i => !Number.isInteger(i) || i < 0 || i >= event.open_threads.length)) {
            throw new Error('Select valid original thread indices');
        }
        const mark = continuity.closed_threads;
        // Never revalidate stale/inactive marks by giving them a fresh digest.
        if (mark.status !== 'active' || mark.threads_digest !== threadsDigest(event)) return;
        const indices = mark.threads === 'all' ? event.open_threads.map((_, i) => i) : mark.threads;
        if (!Array.isArray(indices) || indices.some(i => !Number.isInteger(i) || i < 0 || i >= event.open_threads.length)) {
            throw new Error('Invalid stored user thread indices');
        }
        const remaining = indices.filter(i => !threads.includes(i));
        if (remaining.length) {
            continuity.closed_threads.threads = remaining;
            await write(event, continuity, expected);
            return;
        }
    }
    delete continuity.closed_threads;
    if (continuity.user_previous_closure) continuity.closed_threads = continuity.user_previous_closure;
    delete continuity.user_previous_closure;
    await write(event, continuity, expected);
}

/** Whole extraction/repair self-closure only; user marks and external links survive. */
export async function reopenEventSelfClosure(collectionKey, eventId, settings, expected = null) {
    const { entry, write } = await continuityCollection(collectionKey, settings);
    const event = entry.events.get(eventId);
    assertReviewedEvent(event, expected);
    if (!event) throw new Error('Event is no longer in the collection');
    const continuity = JSON.parse(JSON.stringify(event.continuity || { v: 1 }));
    if (continuity.v !== 1) throw new Error('Unsupported continuity version');
    const key = continuity.closed_threads?.origin === 'user' ? 'user_previous_closure' : 'closed_threads';
    if (!['repair', 'extraction'].includes(continuity[key]?.origin)) return;
    delete continuity[key];
    await write(event, continuity, expected);
}

export async function removeResolutionLink(collectionKey, owner, link, settings, expected = null) {
    const { entry, write } = await continuityCollection(collectionKey, settings);
    const event = entry.events.get(owner);
    assertReviewedEvent(event, expected);
    if (!event?.continuity) return;
    const continuity = JSON.parse(JSON.stringify(event.continuity));
    continuity.resolves = (continuity.resolves || []).filter(candidate => JSON.stringify(candidate) !== JSON.stringify(link));
    await write(event, continuity, expected);
}