/** SillyTavern adapter; the integration core has no host imports. */
import { getContext, extension_settings } from '../../../../extensions.js';
import { getCurrentChatId, chat_metadata, eventSource, event_types } from '../../../../../script.js';
import { getCollectionRegistry } from './collection-loader.js';
import { parseRegistryKey, resolveBackendForCollection, COLLECTION_PREFIXES } from './collection-ids.js';
import { isCollectionEnabled, isCollectionActiveForContextAnyKey } from './collection-metadata.js';
import { getBackend, getBackendForCollection } from '../backends/backend-manager.js';
import { isVectFoxEnabled } from './feature-gate.js';
import { createPublicEventAPI } from './public-event-api.js';
import { getEventArchiveRevision } from './character-roster.js';

/** Copy only public host fields and ILS originals, including nested summaries. */
function publicMessage(message, depth = 0) {
    if (!message || depth > 64) return null;
    const ils = message.extra?.ILS_Data;
    return { id: message.id, name: message.name, mes: message.mes, hash: message.hash,
        is_user: message.is_user, is_system: message.is_system, send_date: message.send_date,
        swipe_id: message.swipe_id,
        extra: { mesid: message.extra?.mesid, ...(ils ? { ILS_Data: {
            Ref: ils.Ref,
            OriginalMessages: Array.isArray(ils.OriginalMessages) ? ils.OriginalMessages.map(m => publicMessage(m, depth + 1)) : undefined,
        } } : {}) } };
}

export function installPublicEventAPI() {
    let ready = false;
    const api = createPublicEventAPI({
        readState() {
            const settings = extension_settings.vectfox || {};
            const chatId = getCurrentChatId();
            // Installed before the settings initializer runs on fresh installs.
            const registry = extension_settings.vectfox ? getCollectionRegistry() : [];
            const availableCollections = registry.map(registryKey => ({ registryKey, ...parseRegistryKey(registryKey) }))
                .filter(c => [COLLECTION_PREFIXES.VECTFOX_EVENTBASE, COLLECTION_PREFIXES.VECTFOX_ARCHIVE_EVENT].some(p => c.collectionId.startsWith(p)))
                .filter(c => isCollectionEnabled(c.registryKey) && isCollectionEnabled(c.collectionId));
            const collections = availableCollections.filter(c => isCollectionActiveForContextAnyKey([c.registryKey, c.collectionId], { chatId }));
            return { ready, enabled: isVectFoxEnabled(settings), chatId, settings, collections, availableCollections,
                archiveRevision: getEventArchiveRevision(),
                chat: (getContext()?.chat || []).map(m => publicMessage(m)),
                chatMetadata: { ILS_Originals: Object.fromEntries(Object.entries(chat_metadata?.ILS_Originals || {})
                    .map(([key, messages]) => [key, Array.isArray(messages) ? messages.map(m => publicMessage(m)) : []])) } };
        },
        async loadBackend(collection, settings) {
            const resolved = resolveBackendForCollection(collection.registryKey);
            return resolved.backend ? getBackendForCollection(resolved.backend, settings) : getBackend(settings);
        },
        async querySemantic(collection, question, limit, settings) {
            const { querySemanticCollection } = await import('./core-vector-api.js');
            return querySemanticCollection(collection.registryKey, question, limit, settings);
        },
    });
    window.VectFoxAPI = Object.freeze({ version: api.version, getStatus: api.getStatus,
        findEvents: api.findEvents, resolveSources: api.resolveSources,
        findCandidateWindows: api.findCandidateWindows });
    const notify = () => {
        api.invalidate();
        void eventSource.emit('vectfox:api-status-changed', api.getStatus());
    };
    for (const name of ['CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED',
        'MESSAGE_SENT', 'MESSAGE_RECEIVED']) {
        if (event_types[name]) eventSource.on(event_types[name], notify);
    }
    // snapshot() detects relevant settings changes; unrelated saves keep handles valid.
    if (event_types.SETTINGS_UPDATED) eventSource.on(event_types.SETTINGS_UPDATED, () => {
        void eventSource.emit('vectfox:api-status-changed', api.getStatus());
    });
    for (const name of ['vectfox:collections-updated', 'vectfox:eventbase-synced']) document.addEventListener(name, notify);
    return { markReady() { ready = true; notify(); } };
}