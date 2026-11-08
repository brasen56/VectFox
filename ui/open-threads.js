/** Host integration. Manual writes load lazily after an explicit action. */
import { ensureCharacterIndex } from '../core/character-roster.js';
import { mountOpenThreadsWindow } from './open-threads-window.js';
import { getCurrentChatId } from '../../../../../script.js';

export async function openOpenThreads(settings) {
    const existing = document.getElementById('vectfox_open_threads_modal');
    if (existing) { existing.querySelector('[role="dialog"]')?.focus(); return; }
    const { resolveActiveEventBaseCollection } = await import('../core/eventbase-store.js');
    // A second click while the host module loaded must not create a second window.
    if (document.getElementById('vectfox_open_threads_modal')) return;
    const active = resolveActiveEventBaseCollection(settings);
    const status = () => window.VectFoxAPI?.getStatus();
    const available = status()?.available_collections || status()?.effective_collections || [];
    const modal = document.createElement('div');
    modal.id = 'vectfox_open_threads_modal'; modal.className = 'vectfox-modal';
    for (const type of ['mousedown', 'touchstart']) modal.addEventListener(type, event => event.stopPropagation());
    const root = document.createElement('div'); root.className = 'vectfox-modal-content'; modal.append(root);
    const previousFocus = document.activeElement;
    document.body.append(modal);
    mountOpenThreadsWindow({ root, settings, activeCollection: active?.registryKey || active?.collectionId,
        collections: available.map(c => c.registryKey || c.collectionId), deps: {
            ensureIndex: ensureCharacterIndex,
            continuityAction: async (name, collection, eventId, args) => {
                const service = await import('../core/continuity-repair-service.js');
                if (name === 'removeResolutionLink') return service.removeResolutionLink(collection, args[0], args[1], settings);
                if (!['markEventResolved', 'unmarkEventResolved', 'reopenEventSelfClosure'].includes(name)) throw new Error('Unknown continuity action');
                return service[name](collection, eventId, settings, ...args);
            },
            contextKey: () => JSON.stringify([getCurrentChatId(), resolveActiveEventBaseCollection(settings),
                (status()?.available_collections || []).map(c => c.registryKey || c.collectionId)]),
            openEvent: async (collection, eventId) => {
                const { openDatabaseEvent } = await import('./database-browser.js');
                await openDatabaseEvent(collection, eventId);
            },
            onClose: () => { modal.remove(); previousFocus?.focus(); },
        } });
    root.focus();
}