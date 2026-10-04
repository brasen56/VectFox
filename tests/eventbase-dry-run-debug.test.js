import { describe, it, expect, vi, beforeEach } from 'vitest';

// Isolate the workflow from SillyTavern, as in eventbase-settle-lag.test.js.
vi.mock('../../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(), extension_prompts: {}, getCurrentChatId: () => 'chat',
    substituteParams: text => text, chat_metadata: {},
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: {}, getContext: () => ({ chat: [] }) }));
vi.mock('../core/collection-ids.js', () => ({
    getChatUUID: () => 'uuid', parseRegistryKey: key => ({ collectionId: key.split(':')[1] }),
    COLLECTION_PREFIXES: { VECTFOX_EVENTBASE: 'VectFox_eventbase_', VECTFOX_ARCHIVE_EVENT: 'VectFox_archiveevent_' },
    buildRegistryKey: vi.fn(),
}));
vi.mock('../core/collection-loader.js', () => ({ getCollectionRegistry: vi.fn() }));
vi.mock('../core/core-vector-api.js', () => ({ queryCollection: vi.fn(), getSavedHashes: vi.fn() }));
vi.mock('../core/constants.js', () => ({ EXTENSION_PROMPT_TAG: '3_vectfox' }));
vi.mock('../core/eventbase-schema.js', () => ({ EventBaseFatalError: class {}, EventBaseExtractionError: class {}, parseEmbedText: () => ({}) }));
vi.mock('../core/eventbase-extractor.js', () => ({ extractEvents: vi.fn() }));
vi.mock('../core/npc-card-llm.js', () => ({ completeNpcCard: vi.fn() }));
vi.mock('../core/generation-rate-limiter.js', () => ({ generationRateLimiter: {}, generationRateLimitSettings: {} }));
vi.mock('../core/eventbase-store.js', () => ({
    insertEvents: vi.fn(), isWindowAlreadyExtracted: vi.fn(), markWindowExtracted: vi.fn(),
    clearExtractionCachesForChat: vi.fn(), buildEventBaseCollectionId: vi.fn(), isLastWindowExtracted: vi.fn(),
    setVectorizationTip: vi.fn(), getVectorizationTip: vi.fn(), ensureVectorizationTip: vi.fn(),
    shouldUseTipFallback: vi.fn(), resolveActiveEventBaseCollection: vi.fn(), repairAutoSyncCoordinatesAfterShrink: vi.fn(),
}));
vi.mock('../core/eventbase-retrieval.js', () => ({ retrieveEvents: vi.fn() }));
vi.mock('../core/agentic-retrieval.js', () => ({ retrieveEventsWithAgent: vi.fn() }));
vi.mock('../core/eventbase-injection.js', async importOriginal => ({ ...await importOriginal(), formatEventsForInjectionDetailed: vi.fn() }));
vi.mock('../core/text-cleaning.js', () => ({ stripReasoningBlocks: text => text, stripGameSystemBlocks: text => text }));
vi.mock('../core/collection-metadata.js', () => ({
    isCollectionEnabled: () => true, isCollectionActiveForContextAnyKey: () => true,
    setCollectionLock: vi.fn(), setCollectionMeta: vi.fn(),
}));
vi.mock('../ui/progress-tracker.js', () => ({ progressTracker: {} }));
vi.mock('../core/log.js', () => ({ log: {
    lifecycle: vi.fn(), verbose: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn(), enabled: () => false,
} }));
vi.mock('../core/ils-expander.js', () => ({ prepareMessagesForEventBase: messages => ({ messages }) }));

import { runEventBaseRetrieval } from '../core/eventbase-workflow.js';
import { getCollectionRegistry } from '../core/collection-loader.js';
import { retrieveEvents } from '../core/eventbase-retrieval.js';
import { retrieveEventsWithAgent } from '../core/agentic-retrieval.js';
import { formatEventsForInjectionDetailed } from '../core/eventbase-injection.js';
import { setExtensionPrompt } from '../../../../../script.js';
import { ensureCharacterIndex, invalidateCharacterIndex } from '../core/character-roster.js';
import { formatRetrievalDiagnostics } from '../core/eventbase-retrieval-debug.js';
import { log } from '../core/log.js';

const params = { chat: [], searchText: 'scene', settings: {}, dryRun: true, testMessage: 'scene' };
const debug = {
    candidateOutcomes: { event: { outcome: 'injected', summary: 'memory' } },
    plannerQuerySummary: [{ queryText: 'scene', hitsReturned: 1, uniqueHits: 1, survivedCount: 1 }],
};

beforeEach(() => {
    vi.clearAllMocks();
    invalidateCharacterIndex('VectFox_eventbase_uuid');
    getCollectionRegistry.mockReturnValue(['qdrant:VectFox_eventbase_uuid']);
    retrieveEvents.mockResolvedValue({ events: [{ event_id: 'event' }], debug });
    retrieveEventsWithAgent.mockResolvedValue({ events: [{ event_id: 'event' }], debug });
    formatEventsForInjectionDetailed.mockReturnValue({ text: 'memory', includedCount: 1 });
});

describe('EventBase dry-run diagnostic contract', () => {
    it.each([false, true])('reports cap-excluded characters and their signals (Agent Mode=%s)', async agentic => {
        const events = [
            { event_id: 'ann', summary: 'Ann opened the shop.', characters: ['Ann'] },
            { event_id: 'llc', summary: 'Filed the LLC.', characters: ['Brennan', 'Howard Brennan'] },
        ];
        await ensureCharacterIndex('VectFox_eventbase_uuid', {}, async () => ({ listChunks: async () => ({
            items: events.map(event => ({ hash: event.event_id, metadata: event })),
        }) }));
        retrieveEvents.mockResolvedValue({ events: [], debug: {} });
        retrieveEventsWithAgent.mockResolvedValue({ events: [], debug: { plannerCharacters: ['Brennan'] } });
        const result = await runEventBaseRetrieval({ ...params, chat: [{ mes: 'Brennan', is_user: true }], testMessage: 'Ann',
            settings: { agentic_retrieval_enabled: agentic, eventbase_cast_max_characters: 1 } });
        expect(result.debug.sceneCast.map(c => c.name)).toEqual(['Ann']);
        expect(result.debug.inPlayCharacters.map(c => c.name)).toEqual(['Ann', 'Howard Brennan']);
        const signals = agentic ? ['text', 'planner'] : ['text'];
        expect(result.debug.zeroInjectionCharacters).toEqual([{ name: 'Howard Brennan', signals }]);
        expect(result.injectionText).toContain('Known history with Ann');
        expect(result.injectionText).not.toContain('Known history with Howard Brennan');
        expect(formatRetrievalDiagnostics(result.debug).castText).toContain(`Howard Brennan (${signals.join(' + ')})`);
        expect(log.lifecycle).toHaveBeenCalledWith(expect.stringContaining(`Howard Brennan (${signals.join(' + ')})`));
        expect(setExtensionPrompt).not.toHaveBeenCalled();
    });

    it.each([0, 1])('preserves no-query misses when maximum characters is %s', async maxCharacters => {
        await ensureCharacterIndex('VectFox_eventbase_uuid', {}, async () => ({ listChunks: async () => ({ items: [{ hash: 'llc', metadata: {
            event_id: 'llc', summary: 'Filed the LLC.', characters: ['Brennan'],
        } }] }) }));
        retrieveEvents.mockResolvedValue({ events: [], debug: {} });
        const result = await runEventBaseRetrieval({ ...params, testMessage: 'Brennan',
            settings: { eventbase_cast_max_characters: maxCharacters, eventbase_cast_token_budget: 0 } });
        expect(result.injectionText).toBeNull();
        expect(result.debug.candidateOutcomes).toEqual({});
        expect(result.debug.zeroInjectionCharacters).toEqual([{ name: 'Brennan', signals: ['text'] }]);
        const diagnosticText = formatRetrievalDiagnostics(result.debug).castText;
        expect(diagnosticText).toContain('In play with zero events injected: Brennan (text).');
        expect(diagnosticText).toContain('Shared EventBase budget: 0/4000 estimated tokens.');
        expect(setExtensionPrompt).not.toHaveBeenCalled();
    });

    it('does not count an unformatted main result as injected character coverage', async () => {
        const event = { event_id: 'llc', summary: 'Filed the LLC.', characters: ['Brennan'] };
        await ensureCharacterIndex('VectFox_eventbase_uuid', {}, async () => ({ listChunks: async () => ({
            items: [{ hash: 'llc', metadata: event }],
        }) }));
        retrieveEvents.mockResolvedValue({ events: [event], debug: {} });
        formatEventsForInjectionDetailed.mockReturnValue({ text: '', includedCount: 0 });
        const result = await runEventBaseRetrieval({ ...params, testMessage: 'Brennan', settings: { eventbase_cast_max_characters: 0 } });
        expect(result.injectionText).toBeNull();
        expect(result.debug.finalInjectedEventIds).toEqual([]);
        expect(result.debug.zeroInjectionCharacters).toEqual([{ name: 'Brennan', signals: ['text'] }]);
    });

    it.each([false, true])('recalls the LLC via cast history even with an empty main lane (Agent Mode=%s)', async agentic => {
        const event = { event_id: 'llc', summary: 'Drafted and filed the LLC formation and operating agreement.',
            characters: ['Howard Brennan'], DateTime: '2026-06-03', importance: 1, source_window_end: 1 };
        await ensureCharacterIndex('VectFox_eventbase_uuid', {}, async () => ({ listChunks: async () => ({ items: [{ hash: 'llc', metadata: event }] }) }));
        const mainDebug = { candidateOutcomes: { llc: { outcome: 'failed_importance_filter', summary: event.summary } },
            plannerQuerySummary: [{ queryText: 'LLC', hitsReturned: 1, uniqueHits: 1, survivedCount: 0 }] };
        retrieveEvents.mockResolvedValue({ events: [], debug: mainDebug });
        retrieveEventsWithAgent.mockResolvedValue({ events: [], debug: { ...mainDebug, plannerCharacters: ['Howard Brennan'] } });
        const result = await runEventBaseRetrieval({ ...params, testMessage: 'We visit Howard Brennan about the wire payment.',
            settings: { agentic_retrieval_enabled: agentic } });
        expect(result.injectionText).toContain('Known history with Howard Brennan');
        expect(result.injectionText).toContain('[June 3, 2026] Drafted and filed the LLC');
        expect(result.eventCount).toBe(1);
        expect(result.debug.zeroInjectionCharacters).toEqual([]);
        expect(result.debug.candidateOutcomes.llc.outcome).toBe('failed_importance_filter');
        expect(result.debug.finalInjectedEventIds).toEqual(['llc']);
        expect(result.debug.castInjectedEventIds).toEqual(['llc']);
        const diagnostics = formatRetrievalDiagnostics(result.debug);
        expect(diagnostics.cutCount).toBe(0);
        expect(diagnostics.cutText).not.toContain('failed importance filter');
        expect(diagnostics.castText).toContain('Rescued by cast history: llc');
        expect(diagnostics.queryText).toContain('0 injected in main lane');
        expect(setExtensionPrompt).not.toHaveBeenCalled();
    });

    it('appends cast history after the main block inside the global wrapper', async () => {
        await ensureCharacterIndex('VectFox_eventbase_uuid', {}, async () => ({ listChunks: async () => ({ items: [{ hash: 'llc', metadata: {
            event_id: 'llc', summary: 'Filed the LLC.', characters: ['Brennan'],
        } }] }) }));
        const result = await runEventBaseRetrieval({ ...params, testMessage: 'Brennan', settings: { rag_context: 'Background', rag_xml_tag: 'memory' } });
        expect(result.injectionText).toMatch(/^<memory>\nBackground\n\nmemory\n\nKnown history with Brennan/);
        expect(result.eventCount).toBe(2);
        expect(result.injectionText).toMatch(/<\/memory>$/);
    });

    it.each([false, true])('carries outcomes and query summaries (Agent Mode=%s) without injecting', async agentic => {
        const result = await runEventBaseRetrieval({ ...params, settings: { agentic_retrieval_enabled: agentic } });
        expect(result).toMatchObject({ injectionText: 'memory', eventCount: 1, debug });
        expect(setExtensionPrompt).not.toHaveBeenCalled();
    });

    it('preserves diagnostics when all candidates were cut', async () => {
        const cutDebug = { candidateOutcomes: { event: { outcome: 'failed_importance_filter' } } };
        retrieveEvents.mockResolvedValue({ events: [], debug: cutDebug });
        const result = await runEventBaseRetrieval(params);
        expect(result).toMatchObject({ injectionText: null, eventCount: 0,
            debug: { ...cutDebug, plannerQuerySummary: [] } });
        expect(setExtensionPrompt).not.toHaveBeenCalled();
    });

    it('preserves diagnostics on the empty-format return path', async () => {
        formatEventsForInjectionDetailed.mockReturnValue({ text: '', includedCount: 0 });
        expect(await runEventBaseRetrieval(params)).toMatchObject({ injectionText: null, eventCount: 0, debug });
        expect(setExtensionPrompt).not.toHaveBeenCalled();
    });

    it('provides empty diagnostics when no collections are locked', async () => {
        getCollectionRegistry.mockReturnValue([]);
        expect(await runEventBaseRetrieval(params)).toMatchObject({ injectionText: null, eventCount: 0,
            debug: { candidateOutcomes: {}, plannerQuerySummary: [] } });
        expect(retrieveEvents).not.toHaveBeenCalled();
        expect(setExtensionPrompt).not.toHaveBeenCalled();
    });

    it('explains why enabled reranking never runs without an active collection', async () => {
        getCollectionRegistry.mockReturnValue([]);
        const result = await runEventBaseRetrieval({ ...params, settings: { eventbase_cross_encoder_enabled: true } });
        expect(result.debug.crossEncoder).toMatchObject({ enabled: true, used: false, documentsSent: 0,
            skippedReason: 'no enabled EventBase collections are locked to this chat' });
        expect(formatRetrievalDiagnostics(result.debug).castText).toContain('Cross-encoder: skipped');
        expect(log.lifecycle).toHaveBeenCalledWith(expect.stringContaining('[EventBase cross-encoder] Skipped:'));
        expect(retrieveEvents).not.toHaveBeenCalled();
        expect(setExtensionPrompt).not.toHaveBeenCalled();
    });
});
