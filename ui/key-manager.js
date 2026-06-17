/**
 * ============================================================================
 * VectFox KEY MANAGER
 * ============================================================================
 * Multi-key management modal for VectFox's OWN isolated key store.
 *
 * Post-2026-06-17: this NO LONGER touches ST's secret_state. It reads and
 * mutates VectFox's per-provider key arrays in extension_settings.vectfox
 * (see core/api-keys.js — listVectFoxKeys / addVectFoxKey / activateVectFoxKey
 * / renameVectFoxKey / deleteVectFoxKey). That keeps VectFox's keys fully
 * isolated from the main chat's Connection Profile: switching the active key
 * here changes ONLY what VectFox uses, and switching the ST main-chat profile
 * does not change VectFox.
 *
 * Provider is 'openrouter' or 'custom' (the same aliases the VectFox inputs
 * use). The stored value is the real key; it is masked before display so the
 * full secret is never rendered into the DOM.
 *
 * Features:
 *   - List all saved keys for a provider with labels + masked values
 *   - Switch (activate) which key VectFox uses — one click, no re-paste
 *   - Add new keys with custom labels (e.g. "Work key", "Free tier")
 *   - Rename / delete individual keys
 *
 * @author Kritblade
 * ============================================================================
 */

import {
    listVectFoxKeys,
    addVectFoxKey,
    activateVectFoxKey,
    renameVectFoxKey,
    deleteVectFoxKey,
} from '../core/api-keys.js';
import { log } from '../core/log.js';

/** Escape text for safe interpolation into the list markup (labels are user-typed). */
function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Mask a real key value for display — last 4 chars, never the full secret. */
function maskValue(v) {
    const s = String(v ?? '');
    if (s.length <= 4) return '*'.repeat(s.length || 4);
    return '*'.repeat(Math.min(s.length - 4, 8)) + s.slice(-4);
}

/**
 * Opens the multi-key manager modal for a given VectFox provider.
 *
 * @param {object} opts
 * @param {string} opts.provider - 'openrouter' | 'custom'
 * @param {string} opts.title - Modal title (e.g. "Manage OpenRouter API Keys")
 * @param {Function} [opts.onChanged] - Callback invoked after any mutation
 *   (add/activate/delete/rename). Use to refresh placeholder displays etc.
 * @param {string} [opts.hint] - Optional hint text shown in the footer
 */
export async function openKeyManager({ provider, title, onChanged, hint }) {
    // Remove any pre-existing modal (defensive — shouldn't stack)
    $('#vectfox_key_manager_overlay').remove();

    const overlay = $(`
        <div id="vectfox_key_manager_overlay" class="vectfox-key-manager-overlay">
            <div class="vectfox-key-manager-modal">
                <div class="vectfox-key-manager-header">
                    <h3><i class="fa-solid fa-key"></i> ${escapeHtml(title)}</h3>
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
                        ${hint || '<i class="fa-solid fa-info-circle"></i> The <b>active</b> key (●) is the one VectFox uses. These keys are <b>VectFox-only</b> — they do not affect your main chat connection.'}
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
    const renderList = () => {
        const keys = listVectFoxKeys(provider);
        const $list = overlay.find('.vectfox-key-manager-list');

        if (keys.length === 0) {
            $list.html('<div class="vectfox-key-manager-empty"><i class="fa-solid fa-key" style="opacity:0.3; font-size:2em;"></i><br>No keys saved yet. Add one below.</div>');
            return;
        }

        const items = keys.map(key => {
            const isActive = !!key.active;
            const label = escapeHtml(key.label || '(no label)');
            const value = escapeHtml(maskValue(key.value));
            const id = escapeHtml(key.id);
            return $(`
                <div class="vectfox-key-manager-item ${isActive ? 'vectfox-key-manager-item-active' : ''}" data-id="${id}">
                    <div class="vectfox-key-manager-item-info">
                        <span class="vectfox-key-manager-item-status" title="${isActive ? 'Active key' : 'Inactive'}">${isActive ? '●' : '○'}</span>
                        <span class="vectfox-key-manager-item-label">${label}</span>
                        <span class="vectfox-key-manager-item-value">${value}</span>
                    </div>
                    <div class="vectfox-key-manager-item-actions">
                        ${isActive ? '<span class="vectfox-key-manager-active-badge">Active</span>' : `<button class="menu_button vectfox-km-activate" data-id="${id}" title="Make this the active key"><i class="fa-solid fa-check"></i> Activate</button>`}
                        <button class="menu_button vectfox-km-rename" data-id="${id}" title="Rename this key"><i class="fa-solid fa-pen"></i></button>
                        <button class="menu_button_red vectfox-km-delete" data-id="${id}" title="Delete this key"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            `);
        });
        $list.empty().append(items);
    };

    // ── Event delegation for list item buttons ──────────────────────
    overlay.find('.vectfox-key-manager-list').on('click', function(e) {
        const $btn = $(e.target).closest('button');
        if (!$btn.length) return;
        const id = $btn.data('id');
        if (!id) return;

        if ($btn.hasClass('vectfox-km-activate')) {
            try {
                activateVectFoxKey(provider, id);
                renderList();
                onChanged?.();
                toastr.success('Switched to selected key (VectFox only)');
            } catch (err) {
                log.error('[VectFox KeyManager] activate failed:', err);
                toastr.error('Failed to switch key');
            }
        } else if ($btn.hasClass('vectfox-km-rename')) {
            const key = listVectFoxKeys(provider).find(k => k.id === id);
            const currentLabel = key?.label || '';
            const newLabel = prompt('Enter new label for this key:', currentLabel);
            if (newLabel !== null && newLabel.trim()) {
                try {
                    renameVectFoxKey(provider, id, newLabel.trim());
                    renderList();
                    onChanged?.();
                    toastr.success('Key renamed');
                } catch (err) {
                    log.error('[VectFox KeyManager] rename failed:', err);
                    toastr.error('Failed to rename key');
                }
            }
        } else if ($btn.hasClass('vectfox-km-delete')) {
            const key = listVectFoxKeys(provider).find(k => k.id === id);
            const label = key?.label || '(no label)';
            if (!confirm(`Delete key "${label}"?\n\nThis cannot be undone.`)) return;
            try {
                deleteVectFoxKey(provider, id);
                renderList();
                onChanged?.();
                toastr.success('Key deleted');
            } catch (err) {
                log.error('[VectFox KeyManager] delete failed:', err);
                toastr.error('Failed to delete key');
            }
        }
    });

    // ── Add key handler ─────────────────────────────────────────────
    const handleAdd = () => {
        const $valueInput = overlay.find('.vectfox-key-manager-add-value');
        const $labelInput = overlay.find('.vectfox-key-manager-add-label-input');
        const value = String($valueInput.val()).trim();
        const label = String($labelInput.val()).trim();

        if (!value) {
            toastr.warning('Enter a key value first');
            $valueInput.focus();
            return;
        }

        try {
            // addVectFoxKey dedupes by value and makes the entry active.
            addVectFoxKey(provider, value, label || undefined);
            $valueInput.val('');
            $labelInput.val('');
            renderList();
            onChanged?.();
            toastr.success(label ? `Key "${label}" added and set as active` : 'Key added and set as active');
        } catch (err) {
            log.error('[VectFox KeyManager] add failed:', err);
            toastr.error('Failed to add key');
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
    renderList();
}
