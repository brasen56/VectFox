/**
 * ============================================================================
 * VectFox KEY MANAGER
 * ============================================================================
 * Multi-key management modal for ST secret slots. Mirrors SillyTavern's
 * native openKeyManagerDialog pattern but styled for VectFox and wired
 * into VectFox's API key inputs.
 *
 * SillyTavern natively stores multiple keys per SECRET_KEYS slot as an
 * array of { id, value, label, active }. writeSecret() ADDS a key (making
 * it active), rotateSecret() switches which one is active, deleteSecret()
 * removes one, renameSecret() changes its label. VectFox's paste-to-save
 * inputs call writeSecret on every paste — so users accumulate keys but
 * had no UI to see or switch between them. This module closes that gap.
 *
 * Features:
 *   - List all saved keys for a slot with their labels and masked values
 *   - Switch (rotate) which key is active — one click, no re-paste needed
 *   - Add new keys with custom labels (e.g. "Work key", "Free tier")
 *   - Rename existing keys
 *   - Delete individual keys
 *
 * Works with any SECRET_KEYS enum slot (OpenRouter, Custom, VLLM, etc.).
 * Custom (non-enum) slots like 'api_key_qdrant' are NOT surfaced by ST's
 * getSecretState, so the manager can't display them client-side — those
 * inputs keep the legacy single-key behavior.
 *
 * @author Kritblade
 * ============================================================================
 */

import {
    SECRET_KEYS,
    secret_state,
    writeSecret,
    deleteSecret,
    rotateSecret,
    renameSecret,
    readSecretState,
} from '../../../../secrets.js';
import { log } from '../core/log.js';

/**
 * Get the list of saved secrets for a slot from the current secret_state.
 * @param {string} slot - Secret slot key (e.g. SECRET_KEYS.OPENROUTER)
 * @returns {Array<{id: string, value: string, label: string, active: boolean}>}
 */
export function getSecretList(slot) {
    const entries = secret_state?.[slot];
    if (!Array.isArray(entries)) return [];
    return entries;
}

/**
 * Get the count of saved keys for a slot.
 * @param {string} slot
 * @returns {number}
 */
export function getSecretCount(slot) {
    return getSecretList(slot).length;
}

/**
 * Get the active secret's label for display purposes.
 * @param {string} slot
 * @returns {string} label, or '' if none active / no label
 */
export function getActiveSecretLabel(slot) {
    const list = getSecretList(slot);
    const active = list.find(s => s.active) || list[0];
    return active?.label || '';
}

/**
 * Check whether a slot has multiple saved keys (useful for UI hints).
 * @param {string} slot
 * @returns {boolean}
 */
export function hasMultipleKeys(slot) {
    return getSecretCount(slot) > 1;
}

/**
 * Opens the multi-key manager modal for a given secret slot.
 *
 * @param {object} opts
 * @param {string} opts.slot - Secret slot (must be a SECRET_KEYS enum value
 *   so secret_state surfaces it client-side)
 * @param {string} opts.title - Modal title (e.g. "Manage OpenRouter API Keys")
 * @param {Function} [opts.onChanged] - Callback invoked after any mutation
 *   (add/rotate/delete/rename). Use to refresh placeholder displays etc.
 * @param {string} [opts.hint] - Optional hint text shown in the footer
 */
export async function openKeyManager({ slot, title, onChanged, hint }) {
    // Remove any pre-existing modal (defensive — shouldn't stack)
    $('#vectfox_key_manager_overlay').remove();

    const overlay = $(`
        <div id="vectfox_key_manager_overlay" class="vectfox-key-manager-overlay">
            <div class="vectfox-key-manager-modal">
                <div class="vectfox-key-manager-header">
                    <h3><i class="fa-solid fa-key"></i> ${title}</h3>
                    <button class="vectfox-key-manager-close" type="button" title="Close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vectfox-key-manager-body">
                    <div class="vectfox-key-manager-list-container">
                        <div class="vectfox-key-manager-list"></div>
                    </div>
                    <div class="vectfox-key-manager-add-section">
                        <small class="vectfox-key-manager-section-label"><i class="fa-solid fa-plus-circle"></i> Add a new key</small>
                        <input type="password" class="vectfox-input vectfox-key-manager-add-value" placeholder="Paste new key value..." autocomplete="off" />
                        <input type="text" class="vectfox-input vectfox-key-manager-add-label-input" placeholder="Label (optional) — e.g. 'Work key', 'Free tier'" />
                        <button class="vectfox-btn-primary vectfox-key-manager-add-btn" type="button">
                            <i class="fa-solid fa-plus"></i> Add Key
                        </button>
                    </div>
                </div>
                <div class="vectfox-key-manager-footer">
                    <small class="vectfox-key-manager-hint">
                        ${hint || '<i class="fa-solid fa-info-circle"></i> The <b>active</b> key (●) is used for all VectFox API calls. Saving a new key via the input field also adds it here.'}
                    </small>
                    <button class="vectfox-btn-secondary vectfox-key-manager-done-btn" type="button">Close</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(overlay);

    // ── Close handlers ──────────────────────────────────────────────
    const close = () => {
        overlay.remove();
        $(document).off('keydown.vectfox_key_manager');
    };
    overlay.find('.vectfox-key-manager-close').on('click', close);
    overlay.find('.vectfox-key-manager-done-btn').on('click', close);
    overlay.on('click', function(e) {
        if (e.target === this) close();
    });
    $(document).on('keydown.vectfox_key_manager', function(e) {
        if (e.key === 'Escape') close();
    });

    // ── Render the key list ─────────────────────────────────────────
    const renderList = async () => {
        // Refresh from server so we see the latest state after mutations
        await readSecretState();
        const secrets = getSecretList(slot);
        const $list = overlay.find('.vectfox-key-manager-list');

        if (secrets.length === 0) {
            $list.html('<div class="vectfox-key-manager-empty"><i class="fa-solid fa-key" style="opacity:0.3; font-size:2em;"></i><br>No keys saved yet. Add one below.</div>');
            return;
        }

        const items = secrets.map(secret => {
            const isActive = !!secret.active;
            const label = secret.label || '(no label)';
            const value = secret.value || '******';
            return $(`
                <div class="vectfox-key-manager-item ${isActive ? 'vectfox-key-manager-item-active' : ''}" data-id="${secret.id}">
                    <div class="vectfox-key-manager-item-info">
                        <span class="vectfox-key-manager-item-status" title="${isActive ? 'Active key' : 'Inactive'}">${isActive ? '●' : '○'}</span>
                        <span class="vectfox-key-manager-item-label">${label}</span>
                        <span class="vectfox-key-manager-item-value">${value}</span>
                    </div>
                    <div class="vectfox-key-manager-item-actions">
                        ${isActive ? '<span class="vectfox-key-manager-active-badge">Active</span>' : `<button class="menu_button vectfox-km-activate" data-id="${secret.id}" title="Make this the active key"><i class="fa-solid fa-check"></i> Activate</button>`}
                        <button class="menu_button vectfox-km-rename" data-id="${secret.id}" title="Rename this key"><i class="fa-solid fa-pen"></i></button>
                        <button class="menu_button_red vectfox-km-delete" data-id="${secret.id}" title="Delete this key"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            `);
        });
        $list.empty().append(items);
    };

    // ── Event delegation for list item buttons ──────────────────────
    overlay.find('.vectfox-key-manager-list').on('click', async function(e) {
        const $btn = $(e.target).closest('button');
        if (!$btn.length) return;
        const id = $btn.data('id');
        if (!id) return;

        if ($btn.hasClass('vectfox-km-activate')) {
            $btn.prop('disabled', true);
            try {
                await rotateSecret(slot, id);
                await renderList();
                onChanged?.();
                toastr.success('Switched to selected key');
            } catch (err) {
                log.error('[VectFox KeyManager] rotateSecret failed:', err);
                toastr.error('Failed to switch key');
            } finally {
                $btn.prop('disabled', false);
            }
        } else if ($btn.hasClass('vectfox-km-rename')) {
            const secrets = getSecretList(slot);
            const secret = secrets.find(s => s.id === id);
            const currentLabel = secret?.label || '';
            const newLabel = prompt('Enter new label for this key:', currentLabel);
            if (newLabel !== null && newLabel.trim()) {
                try {
                    await renameSecret(slot, id, newLabel.trim());
                    await renderList();
                    onChanged?.();
                    toastr.success('Key renamed');
                } catch (err) {
                    log.error('[VectFox KeyManager] renameSecret failed:', err);
                    toastr.error('Failed to rename key');
                }
            }
        } else if ($btn.hasClass('vectfox-km-delete')) {
            const secrets = getSecretList(slot);
            const secret = secrets.find(s => s.id === id);
            const label = secret?.label || '(no label)';
            if (!confirm(`Delete key "${label}"?\n\nThis cannot be undone.`)) return;
            try {
                await deleteSecret(slot, id);
                await renderList();
                onChanged?.();
                toastr.success('Key deleted');
            } catch (err) {
                log.error('[VectFox KeyManager] deleteSecret failed:', err);
                toastr.error('Failed to delete key');
            }
        }
    });

    // ── Add key handler ─────────────────────────────────────────────
    const handleAdd = async () => {
        const $valueInput = overlay.find('.vectfox-key-manager-add-value');
        const $labelInput = overlay.find('.vectfox-key-manager-add-label-input');
        const value = String($valueInput.val()).trim();
        const label = String($labelInput.val()).trim();

        if (!value) {
            toastr.warning('Enter a key value first');
            $valueInput.focus();
            return;
        }

        const $addBtn = overlay.find('.vectfox-key-manager-add-btn');
        $addBtn.prop('disabled', true);
        try {
            // writeSecret adds a new entry and makes it active
            await writeSecret(slot, value, label || undefined);
            $valueInput.val('');
            $labelInput.val('');
            await renderList();
            onChanged?.();
            toastr.success(label ? `Key "${label}" added and set as active` : 'Key added and set as active');
        } catch (err) {
            log.error('[VectFox KeyManager] writeSecret failed:', err);
            toastr.error('Failed to add key');
        } finally {
            $addBtn.prop('disabled', false);
        }
    };

    overlay.find('.vectfox-key-manager-add-btn').on('click', handleAdd);
    overlay.find('.vectfox-key-manager-add-value').on('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
    });
    overlay.find('.vectfox-key-manager-add-label-input').on('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
    });

    // Initial render
    await renderList();
}