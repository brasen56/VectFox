import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    extension_settings: { vectfox: {} },
    secret_state: {},
    writeSecret: vi.fn(),
    save: vi.fn(),
    saveDebounced: vi.fn(),
    pluginAvailable: vi.fn(),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: state.extension_settings }));
vi.mock('../../../../secrets.js', () => ({
    SECRET_KEYS: { OPENROUTER: 'api_key_openrouter', CUSTOM: 'api_key_custom', VLLM: 'api_key_vllm' },
    secret_state: state.secret_state,
    writeSecret: state.writeSecret,
}));
vi.mock('../../../../../script.js', () => ({ saveSettings: state.save, saveSettingsDebounced: state.saveDebounced }));
vi.mock('../core/collection-loader.js', () => ({ checkPluginAvailable: state.pluginAvailable }));
vi.mock('../core/log.js', () => ({ log: new Proxy({}, { get: () => vi.fn() }) }));

import {
    addVectFoxKey, activateVectFoxKey, renameVectFoxKey, deleteVectFoxKey,
    listVectFoxKeys, getVectFoxKeyCount, getActiveVectFoxKeyLabel,
    getVectFoxOpenRouterApiKey, getVectFoxCustomApiKey,
    getOpenRouterApiKey, getCustomApiKey, maskVectFoxApiKey, migrateLegacyApiKeys,
} from '../core/api-keys.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.extension_settings.vectfox = {};
    for (const key of Object.keys(state.secret_state)) delete state.secret_state[key];
    state.pluginAvailable.mockResolvedValue(false);
    state.save.mockResolvedValue(undefined);
});

describe('VectFox-owned multi-key store', () => {
    it('adds, switches, renames and deletes keys without touching ST secrets', () => {
        state.secret_state.api_key_openrouter = [{ value: '***main', active: true, id: 'main' }];
        const shared = structuredClone(state.secret_state);
        const first = addVectFoxKey('openrouter', ' vf-key-first ', 'Personal');
        const second = addVectFoxKey('openrouter', 'vf-key-second', 'Work');
        addVectFoxKey('custom', 'custom-key');
        expect(getVectFoxKeyCount('openrouter')).toBe(2);
        expect(getVectFoxOpenRouterApiKey()).toBe('vf-key-second');
        expect(getVectFoxCustomApiKey()).toBe('custom-key');
        activateVectFoxKey('openrouter', first);
        renameVectFoxKey('openrouter', first, ' Renamed ');
        expect(getActiveVectFoxKeyLabel('openrouter')).toBe('Renamed');
        expect(getVectFoxOpenRouterApiKey()).toBe('vf-key-first');
        deleteVectFoxKey('openrouter', first);
        expect(listVectFoxKeys('openrouter')).toEqual([{ id: second, value: 'vf-key-second', label: 'Work', active: true }]);
        deleteVectFoxKey('openrouter', second);
        expect(getVectFoxOpenRouterApiKey()).toBe('');
        expect(state.secret_state).toEqual(shared);
        expect(state.writeSecret).not.toHaveBeenCalled();
        expect(state.saveDebounced).toHaveBeenCalled();
    });

    it('deduplicates pasted keys and reactivates the existing entry', () => {
        const first = addVectFoxKey('openrouter', 'first-key', 'First');
        addVectFoxKey('openrouter', 'second-key');
        expect(addVectFoxKey('openrouter', ' first-key ', ' Updated ')).toBe(first);
        expect(getVectFoxKeyCount('openrouter')).toBe(2);
        expect(getActiveVectFoxKeyLabel('openrouter')).toBe('Updated');
        expect(listVectFoxKeys('openrouter').filter(key => key.active)).toHaveLength(1);
    });

    it('reads the live store even when a caller holds an old settings snapshot', () => {
        const stale = { vectfox_openrouter_keys: [] };
        addVectFoxKey('openrouter', 'live-key');
        expect(getVectFoxOpenRouterApiKey(stale)).toBe('live-key');
        state.secret_state.api_key_openrouter = '***new-main-profile';
        expect(getVectFoxOpenRouterApiKey(stale)).toBe('live-key');
    });

    it('preserves array identity across mutations for UI settings writebacks', () => {
        const settings = { vectfox_openrouter_keys: listVectFoxKeys('openrouter') };
        const id = addVectFoxKey('openrouter', 'key-one');
        addVectFoxKey('openrouter', 'key-two');
        deleteVectFoxKey('openrouter', id);
        Object.assign(state.extension_settings.vectfox, settings);
        expect(getVectFoxOpenRouterApiKey()).toBe('key-two');
    });

    it('seeds an old isolated single key and does not revive it after deletion', async () => {
        state.extension_settings.vectfox.vectfox_custom_api_key = 'old-isolated-key';
        const [entry] = listVectFoxKeys('custom');
        expect(entry.value).toBe('old-isolated-key');
        deleteVectFoxKey('custom', entry.id);
        await migrateLegacyApiKeys();
        expect(getVectFoxCustomApiKey()).toBe('');
        expect(state.extension_settings.vectfox.vectfox_custom_api_key).toBeUndefined();
    });

    it('uses masked presence for existing callers and falls back to shared slots', () => {
        state.secret_state.api_key_openrouter = [{ value: '***main', active: true }];
        state.secret_state.api_key_custom = { value: '***custom' };
        expect(getOpenRouterApiKey()).toBe('***main');
        expect(getCustomApiKey()).toBe('***custom');
        addVectFoxKey('openrouter', 'vf-key-1234');
        expect(getOpenRouterApiKey()).toBe('*******1234');
        expect(getOpenRouterApiKey()).not.toContain('vf-key');
    });

    it.each(['unsupported', '__proto__'])('rejects unsupported provider %s without persisting', provider => {
        expect(() => addVectFoxKey(provider, 'key')).toThrow(/Unsupported/);
        expect(state.saveDebounced).not.toHaveBeenCalled();
    });

    it('ignores empty keys and unknown IDs', () => {
        expect(addVectFoxKey('openrouter', ' ')).toBeNull();
        expect(activateVectFoxKey('openrouter', 'missing')).toBe(false);
        expect(renameVectFoxKey('openrouter', 'missing', 'Name')).toBe(false);
        expect(deleteVectFoxKey('openrouter', 'missing')).toBe(false);
        expect(state.saveDebounced).not.toHaveBeenCalled();
    });

    it.each(['x', 'abcd', 'abcdef'])('masks keys including short secrets: %s', value => {
        expect(maskVectFoxApiKey(value)).not.toBe(value);
        expect(maskVectFoxApiKey(value)).toMatch(/^\*+/);
    });
});

describe('legacy key migration', () => {
    it('preserves every distinct legacy key without writing any main-chat slots', async () => {
        Object.assign(state.extension_settings.vectfox, {
            summarize_openrouter_api_key: 'summarize-key',
            agentic_retrieval_openrouter_api_key: 'agent-key',
            openrouter_api_key: 'summarize-key',
            summarize_vllm_api_key: 'custom-one',
            vllm_api_key: 'custom-two',
        });
        state.secret_state.api_key_openrouter = '***main';
        await migrateLegacyApiKeys();
        expect(listVectFoxKeys('openrouter').map(key => key.value)).toEqual(['summarize-key', 'agent-key']);
        expect(listVectFoxKeys('custom').map(key => key.value)).toEqual(['custom-one', 'custom-two']);
        expect(getVectFoxOpenRouterApiKey()).toBe('summarize-key');
        expect(state.extension_settings.vectfox.summarize_openrouter_api_key).toBeUndefined();
        expect(state.secret_state.api_key_openrouter).toBe('***main');
        expect(state.writeSecret).not.toHaveBeenCalled();
        expect(state.save).toHaveBeenCalledTimes(1);
        await migrateLegacyApiKeys();
        expect(state.save).toHaveBeenCalledTimes(1);
        expect(getVectFoxKeyCount('openrouter')).toBe(2);
    });

    it('keeps an existing active selection when importing a legacy key', async () => {
        addVectFoxKey('custom', 'existing-one');
        addVectFoxKey('custom', 'existing-two');
        state.extension_settings.vectfox.vllm_api_key = 'legacy-custom';
        await migrateLegacyApiKeys();
        expect(getVectFoxCustomApiKey()).toBe('existing-two');
        expect(getVectFoxKeyCount('custom')).toBe(3);
        expect(listVectFoxKeys('custom').filter(key => key.active)).toHaveLength(1);
    });

    it('never copies a masked shared key into the isolated store', async () => {
        state.secret_state.api_key_openrouter = '***main';
        await migrateLegacyApiKeys();
        expect(listVectFoxKeys('openrouter')).toEqual([]);
        expect(getOpenRouterApiKey()).toBe('***main');
        expect(state.save).not.toHaveBeenCalled();
    });

    it('keeps Qdrant plaintext when the optional plugin cannot migrate it', async () => {
        state.extension_settings.vectfox.qdrant_api_key = 'qdrant-key';
        await migrateLegacyApiKeys();
        expect(state.extension_settings.vectfox.qdrant_api_key).toBe('qdrant-key');
        expect(state.writeSecret).not.toHaveBeenCalled();
    });
});
