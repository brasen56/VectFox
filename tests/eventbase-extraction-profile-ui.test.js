import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { getEventBaseExtractionPrompt } from '../core/prompts-i18n.js';
import { effectiveExtractionProfile, resolveExtractionProfile } from '../core/eventbase-extraction-settings.js';

// Execute the real binding section without loading unrelated SillyTavern UI modules.
const source = readFileSync(new URL('../ui/ui-manager.js', import.meta.url), 'utf8');
const bindings = source.slice(source.indexOf('    // The "default" is now localized'), source.indexOf('    // ── End EventBase settings'))
    .replace(/await import\('[^']+'\)/g, 'deps');
const bind = new Function('$', 'settings', 'extension_settings', 'saveSettingsDebounced', 'toastr',
    'resolveExtractionProfile', 'effectiveExtractionProfile', 'deps', bindings);

function setup(settings) {
    const elements = new Map();
    class Element {
        constructor() { this.value = ''; this.handlers = {}; this.nodes = []; }
        val(value) { if (value === undefined) return this.value; this.value = value; return this; }
        text(value) { this.label = value; return this; }
        append(...nodes) { this.nodes.push(...nodes); return this; }
        on(event, handler) { this.handlers[event] = handler; return this; }
    }
    const $ = selector => {
        if (selector instanceof Element) return selector;
        if (selector.startsWith('<')) return new Element();
        if (!elements.has(selector)) elements.set(selector, new Element());
        return elements.get(selector);
    };
    const saved = { vectfox: {} }, save = vi.fn(), popup = vi.fn();
    bind($, settings, saved, save, { success: vi.fn() }, resolveExtractionProfile, effectiveExtractionProfile,
        { getEventBaseExtractionPrompt, checkPluginAvailable: async () => true, callGenericPopup: popup, POPUP_TYPE: { TEXT: 1 } });
    return { $, saved, save, popup };
}

describe('extraction profile settings controls', () => {
    it('keeps the built-in preview consistent with knowledge capture without rewriting custom prompts', async () => {
        const settings = { eventbase_capture_knowledge: false, vector_backend: 'qdrant' };
        const { $ } = setup(settings);
        await Promise.resolve();
        expect($('#VectFox_eventbase_custom_prompt').val()).not.toContain('FACT-SPECIFIC KNOWLEDGE');
        settings.eventbase_capture_knowledge = true;
        await $('#VectFox_eventbase_capture_knowledge').handlers['change.eventbasePromptSync']();
        expect($('#VectFox_eventbase_custom_prompt').val()).toContain('FACT-SPECIFIC KNOWLEDGE');
        settings.eventbase_custom_prompt = 'CUSTOM {{text}}';
        $('#VectFox_eventbase_custom_prompt').val(settings.eventbase_custom_prompt);
        settings.eventbase_capture_knowledge = false;
        await $('#VectFox_eventbase_capture_knowledge').handlers['change.eventbasePromptSync']();
        expect($('#VectFox_eventbase_custom_prompt').val()).toBe('CUSTOM {{text}}');
    });

    it('updates built-in previews, persists the profile, and resets to the selected language/profile', async () => {
        const settings = { cjk_tokenizer_mode: 'jieba_tw', vector_backend: 'qdrant' };
        const { $, saved, save } = setup(settings);
        await Promise.resolve();
        expect($('#VectFox_eventbase_custom_prompt').val()).toBe(getEventBaseExtractionPrompt('jieba_tw'));
        const selector = $('#VectFox_eventbase_extraction_profile');
        selector.val('slice_of_life'); await selector.handlers.change.call(selector);
        expect(saved.vectfox.eventbase_extraction_profile).toBe('slice_of_life');
        expect(save).toHaveBeenCalled();
        expect($('#VectFox_eventbase_custom_prompt').val()).toBe(getEventBaseExtractionPrompt('jieba_tw', 'slice_of_life'));
        const editor = $('#VectFox_eventbase_custom_prompt');
        editor.val('CUSTOM {{text}}'); editor.handlers.input.call(editor);
        expect($('#VectFox_eventbase_extraction_profile_status').label).toContain('custom');
        const reset = $('#VectFox_eventbase_prompt_reset');
        await reset.handlers.click.call(reset);
        expect(settings.eventbase_custom_prompt).toBe('');
        expect(editor.val()).toBe(getEventBaseExtractionPrompt('jieba_tw', 'slice_of_life'));
    });
    it('never overwrites custom prompts on profile/language changes and compares against the selected default', async () => {
        const settings = { cjk_tokenizer_mode: 'intl', eventbase_custom_prompt: 'CUSTOM {{text}}', vector_backend: 'qdrant' };
        const { $, popup } = setup(settings);
        const selector = $('#VectFox_eventbase_extraction_profile');
        selector.val('slice_of_life'); await selector.handlers.change.call(selector);
        const language = $('#VectFox_cjk_tokenizer_mode');
        language.val('korean'); await language.handlers['change.eventbasePromptSync'].call(language);
        expect(settings.eventbase_custom_prompt).toBe('CUSTOM {{text}}');
        expect($('#VectFox_eventbase_custom_prompt').val()).toBe('CUSTOM {{text}}');
        await $('#VectFox_eventbase_prompt_compare').handlers.click();
        const panel = popup.mock.calls[0][0];
        expect(panel.nodes.some(node => node.value === 'CUSTOM {{text}}')).toBe(true);
        expect(panel.nodes.some(node => node.value === getEventBaseExtractionPrompt('intl', 'slice_of_life'))).toBe(true);
    });
});