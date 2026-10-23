/** SillyTavern host for the bounded repair review window. */
import { createContinuityRepair, repairConfiguration } from '../core/continuity-repair-service.js';
import { rosterCollectionId } from '../core/character-roster.js';
import { mountContinuityRepairWindow } from './continuity-repair-window.js';

const sessions = new Map();

export async function openContinuityRepair(settings) {
    const existing = document.getElementById('vectfox_continuity_repair_modal');
    if (existing) { existing.querySelector('[role="dialog"]')?.focus(); return; }
    const { getLockedCharacterCollections } = await import('../core/eventbase-workflow.js');
    const modal = document.createElement('div');
    modal.id = 'vectfox_continuity_repair_modal';
    modal.className = 'vectfox-modal';
    for (const type of ['mousedown', 'touchstart']) modal.addEventListener(type, event => event.stopPropagation());
    const root = document.createElement('div');
    root.className = 'vectfox-modal-content';
    modal.append(root);
    const previousFocus = document.activeElement;
    document.body.append(modal);
    mountContinuityRepairWindow({ root, settings, collections: getLockedCharacterCollections(), sessions, deps: {
        create: createContinuityRepair,
        configuration: repairConfiguration,
        collectionId: rosterCollectionId,
        confirm: text => globalThis.confirm(text),
        onClose: () => { modal.remove(); previousFocus?.focus(); },
    } });
    root.focus();
}