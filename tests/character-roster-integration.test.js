import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCharacterRoster, ensureCharacterIndex, invalidateCharacterIndex } from '../core/character-roster.js';
import { insertEvents, deleteEventByHash, clearExtractionCachesForChat } from '../core/eventbase-store.js';

vi.mock('../../../../../script.js', () => ({ saveSettingsDebounced: vi.fn(), getRequestHeaders: vi.fn(), getCurrentChatId: () => 'chat', chat_metadata: {} }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} }, getContext: () => ({}) }));
vi.mock('../core/core-vector-api.js', () => ({
    insertVectorItems: vi.fn(), queryCollection: vi.fn(), deleteVectorItems: vi.fn(),
    getAdditionalArgs: vi.fn(async () => ({})), getSavedHashes: vi.fn(),
}));
vi.mock('../core/collection-loader.js', () => ({ registerCollection: vi.fn(), getCollectionRegistry: () => ['qdrant:vf_eventbase_qdrant_uuid'], getCollectionListing: vi.fn() }));
vi.mock('../core/collection-metadata.js', () => ({ getChatLockedCollections: () => ['qdrant:vf_eventbase_qdrant_uuid'], isCollectionActiveForContextAnyKey: () => true }));
vi.mock('../core/collection-ids.js', () => ({
    getChatUUID: () => 'uuid', buildEventBaseCollectionId: () => 'vf_eventbase_qdrant_uuid',
    getRegistryBackend: () => 'qdrant', getBackendFromCollectionId: () => 'qdrant',
    COLLECTION_PREFIXES: { VECTFOX_EVENTBASE: 'vf_eventbase_' },
    parseRegistryKey: key => ({ backend: 'qdrant', collectionId: key.replace('qdrant:', '') }),
    buildChatSearchPatterns: () => [], matchesPatterns: () => false,
}));
vi.mock('../core/log.js', () => ({ log: { enabled: () => false, lifecycle: vi.fn(), verbose: vi.fn(), warn: vi.fn(), trace: vi.fn() } }));
vi.mock('../core/ils-expander.js', () => ({ prepareMessagesForEventBase: messages => ({ messages }) }));

import { insertVectorItems, deleteVectorItems } from '../core/core-vector-api.js';
const id = 'vf_eventbase_qdrant_uuid';
const settings = { vector_backend: 'qdrant' };
const event = { event_id: 'evt1', chat_uuid: 'uuid', summary: 'Filed the LLC.', characters: ['Howard Brennan'], importance: 4, source_window_end: 8, event_type: 'other' };

describe('EventBase roster lifecycle hooks', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        insertVectorItems.mockResolvedValue(undefined);
        deleteVectorItems.mockResolvedValue(undefined);
        invalidateCharacterIndex(id);
        await ensureCharacterIndex(id, settings, async () => ({ listChunks: async () => ({ items: [] }) }));
    });

    it('updates the index only after successful insert, and prunes by the stored numeric hash', async () => {
        await insertEvents([event], settings);
        const hash = insertVectorItems.mock.calls[0][1][0].hash;
        expect(getCharacterRoster([id]).events[0].summary).toBe('Filed the LLC.');
        await deleteEventByHash(hash, settings, 'uuid');
        expect(getCharacterRoster([id]).totalEvents).toBe(0);
    });

    it('does not index a failed write or prune a failed delete', async () => {
        insertVectorItems.mockRejectedValueOnce(new Error('write failed'));
        await expect(insertEvents([event], settings)).rejects.toThrow('write failed');
        expect(getCharacterRoster([id]).totalEvents).toBe(0);
        await insertEvents([event], settings);
        deleteVectorItems.mockRejectedValueOnce(new Error('delete failed'));
        await expect(deleteEventByHash(getCharacterRoster([id]).events[0].hash, settings, 'uuid')).rejects.toThrow('delete failed');
        expect(getCharacterRoster([id]).totalEvents).toBe(1);
    });

    it('drops the collection index when fresh extraction caches are cleared', async () => {
        await insertEvents([event], settings);
        clearExtractionCachesForChat('uuid');
        expect(getCharacterRoster([id]).ready).toBe(false);
    });
});