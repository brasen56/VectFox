// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mountContinuityRepairWindow } from '../ui/continuity-repair-window.js';
import { ContinuityRepair } from '../core/continuity-repair.js';

let root, mounted, engine, deps;
const button = label => [...root.querySelectorAll('button')].find(node => node.textContent === label);
const click = async label => {
    const node = button(label);
    expect(node, label).toBeTruthy();
    expect(node.disabled, label).toBe(false);
    node.click();
    await vi.waitFor(() => expect(button('Load saved runs (no LLM)').disabled).toBe(false));
};
const input = label => root.querySelector(`[aria-label="${label}"]`);
const change = (label, value, event = 'change') => { input(label).value = value; input(label).dispatchEvent(new Event(event)); };
const fixture = () => new Map([
    ['conflict', { event_id: 'conflict', summary: 'Alex owes money', characters: ['Alex', 'Derek'], open_threads: ['Unpaid debt'],
        source_window_start: 1, source_window_end: 10, continuity: { v: 1, repair_runs: [{ run: 'old', model: 'test/A', status: 'running', plan: [] }],
            closed_threads: { run: 'old', status: 'proposed', threads: [0], how: 'Old explanation' } } }],
    ['resolution', { event_id: 'resolution', summary: '<img src=x onerror=alert(1)> Alex repays Derek', characters: ['Alex'],
        source_window_start: 20, source_window_end: 30, continuity: { v: 1, repair_runs: [{ run: 'new', model: 'test/A', status: 'complete' }],
            resolves: [{ run: 'new', status: 'proposed', event_id: 'conflict', threads: [0], how: 'The debt was paid' }] } }],
]);
beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', undefined);
    root = document.createElement('div'); document.body.append(root);
    engine = new ContinuityRepair({ events: fixture(), vectors: new Map(), model: 'test/A', write: vi.fn(async () => {}),
        checkpoint: vi.fn(), complete: vi.fn() });
    engine.state = { run: 'new', status: 'complete', cursor: 1, counts: { calls: 1, inputTokens: 30 }, model: 'test/A' };
    vi.spyOn(engine, 'plan').mockReturnValue([]);
    deps = { create: vi.fn(async () => engine), collectionId: key => key,
        configuration: (settings, override) => ({ provider: override.provider || 'test', model: override.model || 'A', url: override.url || '' }),
        confirm: vi.fn(() => true), onClose: vi.fn() };
    mounted = mountContinuityRepairWindow({ root, settings: {}, collections: [{ registryKey: 'collection', collectionId: 'collection' }], deps });
});
afterEach(() => { mounted.close(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe('repair review window', () => {
    it('loads without model calls, shows evidence safely and reviews the selected historical run', async () => {
        expect(deps.create).not.toHaveBeenCalled();
        await click('Load saved runs (no LLM)');
        expect(engine.complete).not.toHaveBeenCalled();
        expect(root.querySelector('img')).toBeNull();
        expect(root.querySelector('.vf-cr-detail').textContent).toContain('Unpaid debt');
        expect(root.querySelector('.vf-cr-detail').textContent).toContain('The debt was paid');
        change('Repair run', 'old');
        expect(root.querySelector('.vf-cr-detail').textContent).toContain('Old explanation');
        await click('Reject proposal');
        expect(engine.pendingProposals('old')).toHaveLength(0);
        expect(engine.pendingProposals('new')).toHaveLength(1);
    });
    it('filters by status and searchable evidence and accepts an individual proposal', async () => {
        await click('Load saved runs (no LLM)');
        change('Search proposals', 'nonexistent', 'input');
        expect(root.querySelectorAll('.vf-cr-row')).toHaveLength(0);
        change('Search proposals', 'Derek', 'input');
        expect(root.querySelectorAll('.vf-cr-row')).toHaveLength(1);
        // Use a duplicate proposal so the real engine does not require thread digests.
        engine.events.get('resolution').continuity.resolves = [];
        engine.events.get('resolution').continuity.duplicate_of = { run: 'new', status: 'proposed', event_id: 'conflict' };
        change('Search proposals', '', 'input');
        // The earlier event's own closure is not on the duplicate owner.
        await click('Accept proposal');
        expect(root.querySelectorAll('.vf-cr-row')).toHaveLength(0);
        change('Proposal status', 'active');
        expect(root.querySelectorAll('.vf-cr-row')).toHaveLength(1);
        expect(root.querySelector('.vf-cr-detail').textContent).toContain('Accepted');
    });
    it('stops interrupted records and only clears them after pending proposals are rejected', async () => {
        await click('Load saved runs (no LLM)'); change('Repair run', 'old');
        expect(input('Repair run').selectedOptions[0].textContent).toContain('Interrupted — not running');
        expect(button('Clear empty run record').disabled).toBe(true);
        await click('Stop interrupted run');
        expect(button('Clear empty run record').disabled).toBe(true);
        await click('Reject all pending');
        await click('Clear empty run record');
        expect(engine.listRuns().some(run => run.run === 'old')).toBe(false);
        expect(engine.events.size).toBe(2);
        expect(engine.pendingProposals('new')).toHaveLength(1);
    });
    it.each(['Model override (optional)', 'Provider override (openrouter or vllm; optional)', 'vLLM URL override (optional)'])
        ('requires a new estimate after changing %s', async label => {
            await click('Inventory and estimate (no LLM)');
            const start = vi.spyOn(engine, 'start');
            input(label).value = 'changed';
            await click('Start');
            expect(start).not.toHaveBeenCalled();
            expect(root.querySelector('[role="status"]').textContent).toContain('estimate');
        });
    it('names the estimated scope and disables importance outside conflicts', async () => {
        await click('Inventory and estimate (no LLM)');
        expect(root.textContent).toContain('Conflicts only (importance ≥ 6): 0 to judge');
        change('Scope', 'all');
        expect(input('Minimum importance').disabled).toBe(true);
        await click('Inventory and estimate (no LLM)');
        expect(root.textContent).toContain('Every event with open threads: 0 to judge');
        change('Scope', 'conflicts'); expect(input('Minimum importance').disabled).toBe(false);
    });
    it('reports the engine reason when Start is blocked', async () => {
        await click('Inventory and estimate (no LLM)');
        await click('Start');
        expect(root.querySelector('[role="status"]').textContent).toContain('remaining proposals');
    });
    it('paginates large runs without rendering the whole collection', async () => {
        for (let i = 0; i < 110; i++) engine.events.set(`extra${i}`, { event_id: `extra${i}`, summary: `Extra ${i}`, continuity: {
            v: 1, closed_threads: { run: 'new', status: 'proposed', threads: 'all' } } });
        await click('Load saved runs (no LLM)');
        expect(root.querySelectorAll('.vf-cr-row')).toHaveLength(50);
        await click('Next'); expect(root.querySelectorAll('.vf-cr-row')).toHaveLength(50);
        await click('Next'); expect(root.querySelectorAll('.vf-cr-row')).toHaveLength(11);
    });
    it('pauses on Escape and closes once', () => {
        const pause = vi.spyOn(engine, 'pause');
        root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(deps.onClose).toHaveBeenCalledOnce();
        expect(pause).not.toHaveBeenCalled(); // No engine was loaded.
    });
    it('keeps Pause available while a run is awaiting its current batch', async () => {
        await click('Load saved runs (no LLM)');
        engine.state.status = 'paused';
        let finish;
        vi.spyOn(engine, 'resume').mockImplementation(() => {
            engine.running = true;
            return new Promise(resolve => { finish = () => { engine.running = false; resolve(); }; });
        });
        // Reload to refresh the available run actions after changing the fixture state.
        await click('Load saved runs (no LLM)');
        button('Resume current run').click();
        expect(engine.running).toBe(true);
        expect(button('Pause').disabled).toBe(false);
        expect(button('Accept all pending').disabled).toBe(true);
        button('Pause').click();
        expect(engine.stop).toBe(true);
        finish();
        await vi.waitFor(() => expect(button('Load saved runs (no LLM)').disabled).toBe(false));
    });
});