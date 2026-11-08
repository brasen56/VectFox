import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const mocks = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock('../../../../extensions.js', () => ({ extension_settings: { vectfox: {} } }));
vi.mock('../../../../../script.js', () => ({ saveSettingsDebounced: vi.fn() }));
vi.mock('../core/collection-ids.js', () => ({ resolveBackendForCollection: () => ({ backend: 'qdrant' }) }));
vi.mock('../backends/backend-manager.js', () => ({ getBackendForCollection: async () => ({ updateChunkMetadata: mocks.patch }), getBackend: vi.fn() }));
vi.mock('../core/collection-export.js', () => ({ fetchChunksWithVectors: vi.fn() }));
vi.mock('../core/llm-provider-call.js', () => ({ postChatCompletion: vi.fn(), parseJsonArrayFromLlm: vi.fn(), resolveModelParameterStyle: vi.fn() }));
vi.mock('../core/generation-rate-limiter.js', () => ({ generationRateLimiter: {}, generationRateLimitSettings: vi.fn() }));
vi.mock('../core/log.js', () => ({ log: { warn: vi.fn() } }));

import { ensureCharacterIndex, invalidateCharacterIndex, upsertCharacterEvents } from '../core/character-roster.js';
import * as service from '../core/continuity-repair-service.js';
import { threadsDigest } from '../core/continuity.js';
import { mountContinuityControls } from '../ui/continuity-controls.js';
import { mountOpenThreadsWindow } from '../ui/open-threads-window.js';

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
let handle;
let dom;
beforeEach(() => {
    dom = new JSDOM('<!doctype html><body></body>');
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('MutationObserver', dom.window.MutationObserver);
});
afterEach(() => {
    handle?.close(); handle = null;
    document.body.replaceChildren(); vi.unstubAllGlobals(); vi.clearAllMocks();
    invalidateCharacterIndex('reviewed');
    dom.window.close();
});

describe.each(['panel', 'database browser'])('%s reviewed-state preconditions', caller => {
    it.each(['mark', 'unmark', 'reopen'])('rejects stale %s controls without a metadata PATCH', async action => {
        const event = { event_id: 'e', summary: 'Original evidence', open_threads: ['Debt', 'Promise'] };
        if (action !== 'mark') event.continuity = { v: 1, closed_threads: { threads: [0],
            threads_digest: threadsDigest(event), origin: action === 'unmark' ? 'user' : 'repair', status: 'active' } };
        invalidateCharacterIndex('reviewed');
        await ensureCharacterIndex('reviewed', {}, async () => ({ listChunks: async () => ({ items: [{ hash: 1, metadata: event }] }) }));
        const root = document.createElement('div'); document.body.append(root);
        const error = vi.fn();
        vi.stubGlobal('toastr', { error });
        vi.stubGlobal('$', markup => {
            const node = document.createElement(markup.match(/<([a-z0-9]+)/i)[1]);
            return { text(value) { node.textContent = value; return this; }, appendTo(host) { host[0].append(node); return this; } };
        });
        if (caller === 'database browser') {
            await mountContinuityControls({ 0: root, empty: () => root.replaceChildren() }, 'reviewed', 'e', {});
        } else {
            handle = mountOpenThreadsWindow({ root, settings: {}, collections: ['reviewed'], activeCollection: 'reviewed', deps: {
                ensureIndex: ensureCharacterIndex, onClose: () => root.remove(),
                continuityAction: (name, collection, id, args, expected) => name === 'markEventResolved'
                    ? service.markEventResolved(collection, id, {}, ...args, expected)
                    : name === 'unmarkEventResolved' ? service.unmarkEventResolved(collection, id, {}, args[0], expected)
                        : service.reopenEventSelfClosure(collection, id, {}, expected),
            } });
            await settle();
        }
        expect(root.textContent).toContain('Debt');
        root.querySelector('[aria-label="Select thread 0"]').checked = true;
        upsertCharacterEvents('reviewed', [{ hash: 2, metadata: { ...event, summary: 'Replacement evidence', open_threads: ['Unrelated replacement'] } }]);
        const label = action === 'mark' ? 'Mark selected threads resolved' : action === 'unmark' ? 'Unmark selected threads' : 'Reopen self-closure';
        [...root.querySelectorAll('button')].find(node => node.textContent === label).click();
        await settle();
        expect(mocks.patch).not.toHaveBeenCalled();
        if (caller === 'database browser') expect(error).toHaveBeenCalledWith(expect.stringContaining('Refresh and review'), 'Continuity');
        else expect(root.textContent).toContain('Refresh and review');
    });
});