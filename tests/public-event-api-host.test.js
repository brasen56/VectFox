import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
    settings: {},
    registry: vi.fn(),
    emit: vi.fn(),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: host.settings, getContext: () => ({ chat: [] }) }));
vi.mock('../../../../../script.js', () => ({ getCurrentChatId: () => 'chat', chat_metadata: {},
    eventSource: { on: vi.fn(), emit: host.emit }, event_types: {} }));
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
        vi.stubGlobal('window', {});
        vi.stubGlobal('document', { addEventListener: vi.fn() });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('reports loading before settings exist and uses the registry after initialization', async () => {
        const adapter = installPublicEventAPI();
        const early = window.VectFoxAPI.getStatus();
        expect(early).toMatchObject({ state: 'loading', ready: false, effective_collections: [] });
        expect(host.registry).not.toHaveBeenCalled();
        expect(host.settings.vectfox).toBeUndefined();
        expect(await window.VectFoxAPI.findEvents()).toMatchObject({ ok: false, error: { code: 'loading' } });

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