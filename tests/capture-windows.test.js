import { describe, it, expect } from 'vitest';
import { selectCaptureWindows } from '../core/capture-windows.js';

const ref = index => ({ ref: `source:${index}`, source_chat_id: 'chat', host_id: index,
    expanded_index: index, stored_fingerprint: `fp:${index}` });
const event = index => ({ event_ref: `event:${index}`, source_window_start: index,
    event_type: 'dialogue_significant', source_refs: [ref(index)] });
describe('Targeted candidate scenes', () => {
    it('orders small chained overlaps without losing citations', () => {
        const count = 3;
        const events = Array.from({ length: count }, (_, index) => ({
            ...event(index), source_refs: [ref(index), ref(index + 1)],
        }));
        const windows = selectCaptureWindows(events);
        expect(windows).toHaveLength(1);
        expect(windows[0].source_refs.map(source => source.expanded_index))
            .toEqual(Array.from({ length: Math.min(40, count + 1) }, (_, index) => index));
        expect(windows[0].truncated).toBe(count + 1 > 40);
        expect(windows[0].event_refs).toHaveLength(count);
    });
    it('splits long overlap chains before selecting, preserving late revelations', () => {
        const events = Array.from({ length: 100 }, (_, index) => ({
            ...event(index), event_type: index === 99 ? 'revelation' : 'routine',
            importance: index === 99 ? 3 : 0, source_refs: [ref(index), ref(index + 1)],
        }));
        const windows = selectCaptureWindows(events);
        expect(windows).toHaveLength(4);
        expect(windows.flatMap(window => window.source_refs)).toHaveLength(101);
        expect(windows.at(-1).source_refs.map(source => source.expanded_index)).toContain(100);
        expect(windows.at(-1).event_refs).toContain('event:99');
        expect(windows[0].event_refs).not.toContain('event:99');
        for (const window of windows) {
            expect(window.source_refs.length).toBeLessThanOrEqual(40);
            for (const citation of window.event_refs) {
                const cited = events.find(event => event.event_ref === citation);
                expect(cited.source_refs.some(source => window.source_refs.some(ref => ref.ref === source.ref))).toBe(true);
            }
        }
    });
    it('merges overlapping event scenes, retaining event citations', () => {
        const first = event(0), second = { ...event(1), source_refs: [ref(0), ref(1)] };
        const windows = selectCaptureWindows([first, second]);
        expect(windows).toHaveLength(1);
        expect(windows[0].event_refs.sort()).toEqual(['event:0', 'event:1']);
        expect(windows[0].source_refs).toHaveLength(2);
    });
    it('samples temporal strata instead of spending the budget on the densest early scene', () => {
        const windows = selectCaptureWindows(Array.from({ length: 100 }, (_, index) => event(index)));
        expect(windows).toHaveLength(4);
        expect(windows.map(window => window.ranking.temporal_position)).toEqual([0, 25, 50, 75]);
    });
    it('bounds messages even when a merged scene is large', () => {
        const windows = selectCaptureWindows([{ ...event(0), source_refs: Array.from({ length: 100 }, (_, i) => ref(i)) }]);
        expect(windows[0].source_refs).toHaveLength(30);
        expect(windows.flatMap(window => window.source_refs)).toHaveLength(100);
        expect(windows[0].truncated).toBe(true);
    });
});