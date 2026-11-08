import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { findCollectionByIdentity } from '../core/collection-storage.js';

// Execute the actual UI entry point with host/modal dependencies supplied at its boundary.
const source = readFileSync(new URL('../ui/database-browser.js', import.meta.url), 'utf8');
const entryPoint = source.match(/export async function openDatabaseEvent\(collectionKey, eventId\) \{[\s\S]*?\n\}/)[0];
const createNavigation = new Function('browserState', 'openDatabaseBrowser', 'openChunkVisualizer', 'findCollectionByIdentity',
    `${entryPoint.replace('export ', '')}; return openDatabaseEvent;`);

describe('database source-event navigation', () => {
    it.each([['standard', 'vectra'], ['vectra', 'standard']])('opens %s evidence in a discovered %s archive', async (requested, discovered) => {
        const target = { id: 'archive', backend: discovered, registryKey: `${discovered}:archive` };
        const state = { collections: [], settings: {} };
        const open = vi.fn(async () => { state.collections = [{ id: 'archive', backend: 'qdrant' }, target]; });
        const visualize = vi.fn();
        await createNavigation(state, open, visualize, findCollectionByIdentity)(`${requested}:archive`, 'event-7');
        expect(open).toHaveBeenCalledOnce();
        expect(visualize).toHaveBeenCalledWith(target, 'event-7');
    });

    it('uses registry identity and never navigates a Standard citation to Qdrant', async () => {
        const target = { id: 'archive', registryKey: 'qdrant:archive', backend: 'qdrant' };
        const visualize = vi.fn();
        const navigate = createNavigation({ collections: [target], settings: {} }, vi.fn(), visualize, findCollectionByIdentity);
        await expect(navigate('standard:archive', 'e')).rejects.toThrow('Collection unavailable');
        expect(visualize).not.toHaveBeenCalled();
        await navigate('qdrant:archive', 'e');
        expect(visualize).toHaveBeenCalledWith(target, 'e');
    });
});