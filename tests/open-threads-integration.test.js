import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('Open Threads host wiring', () => {
    it('wires the action and stylesheet with lazy manual writes and no repair or query calls', () => {
        const manager = read('../ui/ui-manager.js');
        expect(manager).toContain('id="VectFox_open_threads"');
        expect(manager).toContain("import('./open-threads.js')");
        expect(read('../vectfox.css')).toContain("./ui/open-threads.css");
        for (const file of ['../core/open-threads.js', '../ui/open-threads-window.js', '../ui/continuity-actions.js']) {
            expect(read(file)).not.toMatch(/continuity-repair-service|createContinuityRepair|continuityCollection|findEvents\(|querySemantic|completeStoryAnswer/);
        }
        const host = read('../ui/open-threads.js');
        expect(host).not.toMatch(/^import .*continuity-repair-service/m);
        expect(host).not.toMatch(/createContinuityRepair|continuityCollection|findEvents\(|querySemantic|completeStoryAnswer/);
        expect(host).toContain("continuityAction: async (name, collection, eventId, args) => {");
        expect(host).toContain("await import('../core/continuity-repair-service.js')");
        expect(read('../ui/open-threads.js')).toContain('resolveActiveEventBaseCollection(settings)');
    });
    it('passes source-event identity through the browser to initial visualizer selection', () => {
        const browser = read('../ui/database-browser.js');
        expect(browser).toContain('export async function openDatabaseEvent(collectionKey, eventId)');
        expect(browser).toContain('await openChunkVisualizer(collection, eventId)');
        expect(browser).toContain('dbChunkCount, focusEventId');
        const visualizer = read('../ui/chunk-visualizer.js');
        const open = visualizer.slice(visualizer.indexOf('export function openVisualizer('));
        expect(open.slice(0, open.indexOf('function _loadAndRenderCollectionMetaFooter')))
            .toContain('chunk.metadata?.event_id === results.focusEventId');
    });
});