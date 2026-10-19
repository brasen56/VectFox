import { describe, it, expect } from 'vitest';
import { selectCaptureWindows } from '../core/capture-windows.js';

const ref = index => ({ ref: `source:${index}`, source_chat_id: 'chat', host_id: index,
    expanded_index: index, stored_fingerprint: `fp:${index}` });
const event = index => ({ event_ref: `event:${index}`, source_window_start: index,
    event_type: 'dialogue_significant', source_refs: [ref(index)] });
describe('Targeted candidate scenes', () => {
    it.each([3, 50])('orders chained overlaps before truncating (%i events)', count => {
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
        expect(windows[0].source_refs).toHaveLength(40);
        expect(windows[0].truncated).toBe(true);
    });
});