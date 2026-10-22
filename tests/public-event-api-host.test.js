import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    settings: {},
    registry: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: host.settings, getContext: () => ({ chat: [] }) }));
vi.mock('../../../../../script.js', () => ({ getCurrentChatId: () => 'chat', chat_metadata: {},
    eventSource: { on: host.on, emit: host.emit }, event_types: { SETTINGS_UPDATED: 'settings_updated' } }));
vi.mock('../core/collection-loader.js', () => ({ getCollectionRegistry: host.registry }));
vi.mock('../core/collection-metadata.js', () => ({ isCollectionEnabled: () => true, isCollectionActiveForContextAnyKey: () => true }));
vi.mock('../backends/backend-manager.js', () => ({ getBackend: vi.fn(), getBackendForCollection: vi.fn() }));
vi.mock('../core/log.js', () => ({ log: {} }));
vi.mock('../../../../utils.js', () => ({ uuidv4: () => 'test' }));
import { installPublicEventAPI } from '../core/public-event-api-host.js';

describe('public event API host initialization', () => {
    beforeEach(() => {
        delete host.settings.vectfox;
        host.registry.mockReset().mockImplementation(() => host.settings.vectfox.vectfox_collection_registry || []);
        host.emit.mockClear();
        host.on.mockClear();
        vi.stubGlobal('window', {});
        vi.stubGlobal('document', { addEventListener: vi.fn() });
    });
    afterEach(() => vi.unstubAllGlobals());

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