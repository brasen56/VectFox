/** Host integration for the Characters and NPC cards window. Kept separate so the window
 * itself can be tested without SillyTavern's modules.
 */
import { saveSettingsDebounced, getCurrentChatId } from '../../../../../script.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { mountCharacterCardsWindow } from './character-cards-window.js';

export async function openCharacterCardsWindow(settings) {
    const existing = document.getElementById('vectfox_character_cards_modal');
    if (existing) { existing.querySelector('.vf-cc')?.focus(); return; }
    const [{ getLockedCharacterCollections }, roster] = await Promise.all([
        import('../core/eventbase-workflow.js'), import('../core/character-roster.js'),
    ]);
    const modal = document.createElement('div');
    modal.id = 'vectfox_character_cards_modal';
    modal.className = 'vectfox-modal';
    // ST closes its drawers on mousedown/touchstart outside them (see styles/modals.css).
    for (const type of ['mousedown', 'touchstart']) modal.addEventListener(type, event => event.stopPropagation());
    const root = document.createElement('div');
    root.className = 'vectfox-modal-content';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Characters and NPC cards');
    root.tabIndex = -1;
    modal.append(root);
    document.body.append(modal);
    mountCharacterCardsWindow({ root, settings, collections: getLockedCharacterCollections(), deps: {
        ensureIndex: roster.ensureCharacterIndex,
        getRoster: roster.getCharacterRoster,
        ignoredTags: roster.getIgnoredCharacterTags,
        collectionId: roster.rosterCollectionId,
        invalidate: roster.invalidateCharacterIndex,
        chatId: () => getCurrentChatId(),
        readContext: () => JSON.stringify([getCurrentChatId(), (getContext()?.chat || []).map(m => [m.mes, m.swipe_id])]),
        save: () => {
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            $('#VectFox_eventbase_npc_state_enabled').prop('checked', !!settings.eventbase_npc_state_enabled);
        },
        confirm: text => globalThis.confirm(text),
        onClose: () => modal.remove(),
    } });
    root.focus();
}
