import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), engines: [] }));
vi.mock('../core/continuity-repair-service.js', () => ({
    createContinuityRepair: mocks.create,
    repairConfiguration: (settings, override) => ({ provider: override.provider || settings.chat_provider || 'openrouter',
        model: override.model || settings.chat_model || '', url: override.url || settings.chat_vllm_url || '' }),
}));
vi.mock('../core/character-roster.js', () => ({ rosterCollectionId: key => key }));
vi.mock('../core/eventbase-workflow.js', () => ({ getLockedCharacterCollections: () => [{ registryKey: 'collection', collectionId: 'collection' }] }));

// The panel needs only chainable element operations; no browser or new dependency is required.
let elements, host;
class Element {
    constructor(tag) { this.tag = tag; this.value = ''; this.nodes = []; this.handlers = {}; elements.push(this); }
    text(value) { this.label = value; return this; }
    val(value) { if (value === undefined) return this.value; this.value = value; return this; }
    appendTo(parent) {
        parent.nodes.push(this);
        if (this.tag.startsWith('<option') && parent.nodes.length === 1) parent.value = this.value;
        return this;
    }
    append() { if (this.tag.startsWith('<select')) this.value = 'conflicts'; return this; }
    on(event, handler) { this.handlers[event] = handler; return this; }
    children() { return this.nodes; }
    empty() { this.nodes = []; return this; }
    css() { return this; }
    attr() { return this; }
    prop() { return this; }
    show() { return this; }
    hide() { return this; }
}

beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); elements = []; host = new Element('host'); mocks.engines = [];
    vi.stubGlobal('$', value => value instanceof Element ? value : value.startsWith('#') ? host : new Element(value));
    vi.stubGlobal('toastr', { error: vi.fn(), info: vi.fn(), warning: vi.fn() });
    vi.stubGlobal('BroadcastChannel', undefined);
    mocks.create.mockImplementation(async (key, settings, override) => {
        const engine = { model: `${override.provider}/${override.model}`, endpoint: override.url,
            events: new Map(), refreshEvents: vi.fn(), plan: () => [], start: vi.fn(), resume: vi.fn(), pause: vi.fn() };
        mocks.engines.push(engine); return engine;
    });
});
afterEach(() => vi.unstubAllGlobals());
const click = label => {
    const element = elements.find(item => item.label === label && item.handlers.click);
    return element.handlers.click.call(element);
};
const input = label => elements.find(item => item.label === `${label} `).nodes[0];

describe('continuity repair configuration controls', () => {
    it('shows the engine\'s reason when a new run cannot start yet, and starts once it can', async () => {
        const { openContinuityRepair } = await import('../ui/continuity-repair.js');
        await openContinuityRepair({ chat_model: 'A' });
        await click('Inventory and estimate (no LLM)');
        const engine = mocks.engines[0];
        engine.start.mockRejectedValueOnce(new Error('Review the previous run\'s remaining proposals, or undo it, before starting another'));
        await click('Start');
        expect(engine.resume).not.toHaveBeenCalled();
        expect(toastr.error).toHaveBeenCalledWith(expect.stringContaining('undo'), 'Continuity repair');
        await click('Start');
        expect(engine.resume).toHaveBeenCalled();
    });
    it.each(['Model override (optional)', 'Provider override (openrouter or vllm; optional)', 'vLLM URL override (optional)'])
        ('requires a fresh estimate after changing %s', async label => {
            const { openContinuityRepair } = await import('../ui/continuity-repair.js');
            await openContinuityRepair({ chat_model: 'A', chat_provider: 'vllm', chat_vllm_url: 'http://old' });
            await click('Inventory and estimate (no LLM)');
            input(label).val(label.startsWith('Model') ? 'B' : label.startsWith('Provider') ? 'openrouter' : 'http://new');
            await click('Start');
            expect(mocks.engines[0].start).not.toHaveBeenCalled();
            expect(toastr.error).toHaveBeenCalledWith(expect.stringContaining('estimate'), 'Continuity repair');
            await click('Inventory and estimate (no LLM)');
            expect(mocks.create).toHaveBeenCalledTimes(2);
            await click('Start');
            expect(mocks.engines[1].start).toHaveBeenCalled();
            expect(mocks.engines[1].resume).toHaveBeenCalled();
        });
});