/** Key inputs and manager controls shared by Core and AgentMode settings. */
import { extension_settings } from '../../../../extensions.js';
import {
    addVectFoxKey, listVectFoxKeys, deleteVectFoxKey,
    getVectFoxKeyCount, getActiveVectFoxKeyValue, getActiveVectFoxKeyLabel,
    getOpenRouterApiKey, getCustomApiKey, maskVectFoxApiKey,
} from '../core/api-keys.js';
import { openKeyManager } from './key-manager.js';
import { log } from '../core/log.js';

const PROVIDERS = {
    openrouter: {
        label: 'OpenRouter',
        event: 'vectfox:openrouter-key-changed',
        sharedPresence: getOpenRouterApiKey,
        inputs: ['#VectFox_openrouter_apikey', '#VectFox_summarize_openrouter_apikey', '#VectFox_agentic_openrouter_apikey'],
    },
    custom: {
        label: 'vLLM / Custom OpenAI-compatible',
        event: 'vectfox:vllm-key-changed',
        sharedPresence: getCustomApiKey,
        inputs: ['#VectFox_vllm_api_key', '#VectFox_summarize_vllm_apikey', '#VectFox_agentic_vllm_apikey'],
    },
};

export function bindVectFoxKeySettings(settings) {
    $(document).off('.vectfoxKeys');
    for (const [provider, config] of Object.entries(PROVIDERS)) {
        // UI handlers write the runtime settings snapshot back to the canonical
        // object. Keep its arrays pointing to the same live store after seeding.
        settings[`vectfox_${provider}_keys`] = listVectFoxKeys(provider);
        const refresh = () => {
            const value = getActiveVectFoxKeyValue(provider);
            const label = getActiveVectFoxKeyLabel(provider);
            const shared = value ? '' : config.sharedPresence();
            const placeholder = value
                ? `Active: ${label} — ${maskVectFoxApiKey(value)} (VectFox only)`
                : shared
                    ? `ST shared key: ${shared} — paste a key to isolate VectFox`
                    : `Paste ${config.label} key (VectFox only)`;
            for (const selector of config.inputs) $(selector).attr('placeholder', placeholder);
            const count = getVectFoxKeyCount(provider);
            const buttons = $(`.vectfox-key-manager-trigger[data-key-manager-slot="${provider}"]`);
            buttons.find('.vectfox-key-count-badge').text(count);
            buttons.toggleClass('vectfox-key-manager-trigger-multi', count > 1);
        };
        $(document).on(`${config.event}.vectfoxKeys`, refresh);

        for (const selector of config.inputs) {
            const input = $(selector);
            if (!input.length) continue;
            input.attr('autocomplete', 'off').off('.vectfoxKeys');
            const save = () => {
                const value = String(input.val() || '').trim();
                if (!value) return;
                try {
                    addVectFoxKey(provider, value);
                    input.val('');
                    $(document).trigger(config.event);
                    toastr.success(`${config.label} key saved and activated (VectFox only)`);
                } catch (error) {
                    log.error('[VectFox] Isolated API key save failed:', error);
                    toastr.error('Failed to save API key — see console');
                }
            };
            input.on('change.vectfoxKeys', save)
                .on('keydown.vectfoxKeys', event => {
                    if (event.key === 'Enter') { event.preventDefault(); save(); }
                })
                .on('paste.vectfoxKeys', () => setTimeout(save, 0));

            if (!input.next('.vectfox-key-manager-trigger').length) {
                input.after(`<button type="button" class="vectfox-key-manager-trigger menu_button" data-key-manager-slot="${provider}">
                    <i class="fa-solid fa-key"></i> Manage Keys <span class="vectfox-key-count-badge">0</span>
                </button>`);
            }
            const clearSelector = `${selector}_clear`;
            $(clearSelector).text('Clear active VectFox key').off('.vectfoxKeys').on('click.vectfoxKeys', () => {
                const keys = listVectFoxKeys(provider);
                const active = keys.find(key => key.active) || keys[0];
                if (!active) {
                    toastr.info('No VectFox key is saved. Shared SillyTavern keys are managed in SillyTavern.');
                    return;
                }
                if (!confirm(`Delete the active VectFox ${config.label} key "${active.label}"?\n\nThis cannot be undone.`)) return;
                deleteVectFoxKey(provider, active.id);
                $(document).trigger(config.event);
                toastr.info('Active VectFox key deleted.');
            });

            if (!input.parent().find('.vectfox-key-storage-hint').length) {
                const embeddingInput = selector === config.inputs[0];
                input.parent().append(`<small class="VectFox_hint vectfox-key-storage-hint">${embeddingInput
                    ? 'The manager controls VectFox LLM keys. Embedding requests use SillyTavern’s server-side credentials. '
                    : ''}VectFox keys are saved in extension settings and may appear in settings backups/exports. Custom endpoints must allow browser CORS.</small>`);
            }
        }
        refresh();
    }

    $('#VectFox_settings').off('click.vectfoxKeys', '.vectfox-key-manager-trigger')
        .on('click.vectfoxKeys', '.vectfox-key-manager-trigger', function(event) {
            event.preventDefault();
            const provider = $(this).data('key-manager-slot');
            const config = PROVIDERS[provider];
            if (!config) return;
            openKeyManager({
                provider,
                title: `Manage ${config.label} API Keys (VectFox only)`,
                onChanged: () => {
                    settings[`vectfox_${provider}_keys`] = extension_settings.vectfox[`vectfox_${provider}_keys`];
                    $(document).trigger(config.event);
                },
            });
        });
}
