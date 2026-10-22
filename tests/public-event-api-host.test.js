import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    settings: {},
    registry: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    chat: [],
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: host.settings, getContext: () => ({ chat: host.chat }) }));
vi.mock('../../../../../script.js', () => ({ getCurrentChatId: () => 'chat', chat_metadata: {},
    eventSource: { on: host.on, emit: host.emit }, event_types: { SETTINGS_UPDATED: 'settings_updated', MESSAGE_EDITED: 'message_edited' } }));
vi.mock('../core/collection-loader.js', () => ({ getCollectionRegistry: host.registry }));
vi.mock('../core/collection-metadata.js', () => ({ isCollectionEnabled: () => true, isCollectionActiveForContextAnyKey: () => true }));
vi.mock('../backends/backend-manager.js', () => ({ getBackend: vi.fn(), getBackendForCollection: vi.fn() }));
vi.mock('../core/log.js', () => ({ log: {} }));
vi.mock('../../../../utils.js', () => ({ uuidv4: () => 'test' }));
import { installPublicEventAPI } from '../core/public-event-api-host.js';
import { chat_metadata } from '../../../../../script.js';

describe('public event API host initialization', () => {
    beforeEach(() => {
        delete host.settings.vectfox;
        host.registry.mockReset().mockImplementation(() => host.settings.vectfox.vectfox_collection_registry || []);
        host.emit.mockClear();
        host.on.mockClear();
        host.chat = [];
        vi.stubGlobal('window', {});
        vi.stubGlobal('document', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('reuses the public chat snapshot until a host message event invalidates it', () => {
        host.settings.vectfox = {};
        const readText = vi.fn(() => 'Long original message');
        host.chat = [{ name: 'Alex', get mes() { return readText(); } }];
        installPublicEventAPI().markReady();
        const token = window.VectFoxAPI.getStatus().scope_token;
        const reads = readText.mock.calls.length;
        window.VectFoxAPI.getStatus();
        window.VectFoxAPI.getStatus();
        expect(readText).toHaveBeenCalledTimes(reads);
        host.on.mock.calls.find(([name]) => name === 'message_edited')[1]();
        expect(readText.mock.calls.length).toBeGreaterThan(reads);
        const editedToken = window.VectFoxAPI.getStatus().scope_token;
        expect(editedToken).not.toBe(token);
        host.chat.push({ name: 'Alex', mes: 'New message' });
        expect(window.VectFoxAPI.getStatus().scope_token).not.toBe(editedToken);
        expect(document.dispatchEvent).toHaveBeenCalled();
    });

    it('notices host changes that fire no event', () => {
        host.settings.vectfox = {};
        host.chat = [{ name: 'Alex', mes: 'First' }, { name: 'Ranger', mes: 'Second' }];
        installPublicEventAPI().markReady();
        const token = window.VectFoxAPI.getStatus().scope_token;
        expect(window.VectFoxAPI.getStatus().scope_token).toBe(token);
        // /hide flips is_system in place without emitting anything.
        host.chat[0].is_system = true;
        const hidden = window.VectFoxAPI.getStatus().scope_token;
        expect(hidden).not.toBe(token);
        expect(window.VectFoxAPI.getStatus().scope_token).toBe(hidden);
        // A one-message InlineSummary collapse swaps the object at the same length.
        host.chat[1] = { name: 'Ranger', mes: 'Summary', extra: { ILS_Data: { Ref: 'r1' } } };
        const collapsed = window.VectFoxAPI.getStatus().scope_token;
        expect(collapsed).not.toBe(hidden);
        chat_metadata.ILS_Originals = { r1: [{ name: 'Ranger', mes: 'Second' }] };
        expect(window.VectFoxAPI.getStatus().scope_token).not.toBe(collapsed);
        delete chat_metadata.ILS_Originals;
    });

    it('keeps scope tokens on unrelated settings saves but tracks relevant changes', () => {
        host.settings.vectfox = {};
        installPublicEventAPI().markReady();
        const token = window.VectFoxAPI.getStatus().scope_token;
        const save = host.on.mock.calls.find(([name]) => name === 'settings_updated')[1];
        host.settings.vectfox.eventbase_capture_knowledge = false;
        save();
        expect(window.VectFoxAPI.getStatus().scope_token).toBe(token);
        host.settings.vectfox.eventbase_character_alias_overrides = { events: [{ name: 'Alex', aliases: ['Al'] }] };
        save();
        expect(window.VectFoxAPI.getStatus().scope_token).not.toBe(token);
    });

    it('reports loading before settings exist and uses the registry after initialization', async () => {
        const adapter = installPublicEventAPI();
        const early = window.VectFoxAPI.getStatus();
        expect(early).toMatchObject({ state: 'loading', ready: false, effective_collections: [] });
        expect(host.registry).not.toHaveBeenCalled();
        expect(host.settings.vectfox).toBeUndefined();
        expect(await window.VectFoxAPI.findEvents()).toMatchObject({ ok: false, error: { code: 'loading' } });
        expect(window.VectFoxAPI.findCandidateWindows).toBeTypeOf('function');
        expect(await window.VectFoxAPI.findCandidateWindows()).toMatchObject({ ok: false, error: { code: 'loading' } });

        host.settings.vectfox = { vectfox_collection_registry: ['qdrant:vf_eventbase_test'] };
        adapter.markReady();
        const ready = window.VectFoxAPI.getStatus();
        expect(ready).toMatchObject({ state: 'ready', ready: true,
            effective_collections: [{ collectionId: 'vf_eventbase_test', registryKey: 'qdrant:vf_eventbase_test' }] });
        expect(ready.scope_token).not.toBe(early.scope_token);
        expect(host.registry).toHaveBeenCalled();
        expect(host.emit).toHaveBeenCalledWith('vectfox:api-status-changed', ready);
    });
});