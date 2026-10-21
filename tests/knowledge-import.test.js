import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../../extensions.js', () => ({ extension_settings: {}, getContext: () => ({}) }));
vi.mock('../../../../../script.js', () => ({ getRequestHeaders: vi.fn(), saveSettingsDebounced: vi.fn() }));
vi.mock('../../../../utils.js', () => ({ getStringHash: () => 1 }));
vi.mock('../core/core-vector-api.js', () => ({ getSavedHashes: vi.fn(), insertVectorItems: vi.fn(), purgeVectorIndex: vi.fn() }));
vi.mock('../core/collection-metadata.js', () => ({ getCollectionMeta: vi.fn(), setCollectionMeta: vi.fn(),
    getChunkMetadata: vi.fn(), saveChunkMetadata: vi.fn(), getAllChunkMetadata: vi.fn(), clearCollectionLock: vi.fn(), getEffectiveScope: vi.fn() }));
vi.mock('../core/collection-loader.js', () => ({ registerCollection: vi.fn(), getCollectionRegistry: vi.fn() }));
vi.mock('../core/providers.js', () => ({ getModelFromSettings: () => 'model' }));
vi.mock('../core/sparse-vector-encoder.js', () => ({ encodeSparseVector: vi.fn() }));
vi.mock('../ui/progress-tracker.js', () => ({ progressTracker: { show: vi.fn(), updateProgress: vi.fn(),
    updateCurrentItem: vi.fn(), complete: vi.fn(), hide: vi.fn() } }));
vi.mock('../core/log.js', () => ({ log: new Proxy({}, { get: () => vi.fn() }) }));
import { validateImportData, importCollection, importMultipleCollections } from '../core/collection-export.js';
import { insertVectorItems, purgeVectorIndex } from '../core/core-vector-api.js';

const data = knowledge => ({ version: '1.0', collection: { id: 'vf_eventbase_qdrant_test' }, chunks: [{ hash: 1,
    text: '[other] Delivery.', metadata: { eventbase: true, source_messages: [{}], ...(knowledge === undefined ? {} : { knowledge }) } }] });
describe('knowledge import validation', () => {
    it('accepts legacy history without adding attribution', () => {
        const exported = data();
        expect(validateImportData(exported).valid).toBe(true);
        expect(exported.chunks[0].metadata.knowledge).toBeUndefined();
    });
    it('preserves valid acquisitions and uncertainty through JSON round trips', () => {
        const exported = data({ v: 1, presence: [], acquisitions: [{ character: 'Ranger', claim: 'The queen fled.',
            basis: 'rumor', epistemic_status: 'rumor', uncertainty: 'Unconfirmed.',
            evidence: [{ source_index: 0, quote: 'Ranger heard a rumor.' }] }] });
        const imported = JSON.parse(JSON.stringify(exported));
        expect(validateImportData(imported).valid).toBe(true);
        expect(imported).toEqual(exported);
    });
    it('refuses invalid versions in preview, single import and silent bulk import before writes', async () => {
        vi.clearAllMocks();
        const exported = data({ v: 99, presence: [], acquisitions: [] });
        expect(validateImportData(exported).valid).toBe(false);
        await expect(importCollection(exported, {})).rejects.toThrow('Invalid event knowledge');
        const bulk = await importMultipleCollections({ collections: [exported] }, {});
        expect(bulk.failed).toBe(1);
        expect(bulk.imported).toBe(0);
        expect(purgeVectorIndex).not.toHaveBeenCalled();
        expect(insertVectorItems).not.toHaveBeenCalled();
    });
    it('refuses missing provenance and rumor promoted to fact', () => {
        const raw = { v: 1, presence: [], acquisitions: [{ character: 'Ranger', claim: 'The queen fled.',
            basis: 'rumor', epistemic_status: 'fact', uncertainty: '', evidence: [{ source_index: 0, quote: 'Rumor.' }] }] };
        expect(validateImportData(data(raw)).valid).toBe(false);
        raw.acquisitions[0].epistemic_status = 'rumor';
        const exported = data(raw);
        delete exported.chunks[0].metadata.source_messages;
        expect(validateImportData(exported).valid).toBe(false);
    });
});