import { beforeEach, describe, expect, it, vi } from 'vitest';

// The two live-chat ingestion callers must name the chat FILE their message
// snapshot came from. Sibling chat files share one chat UUID, and the user can
// switch chats while the callers await, so the id is read in the same
// synchronous step as the snapshot — never earlier, never after.
const fixture = vi.hoisted(() => ({ chatId: 'Branch A', chat: [], onAwait: null }));
const switchChat = to => { fixture.chatId = to; fixture.chat = [{ mes: `${to} message`, name: 'AI' }]; };

vi.mock('../../../../../script.js', () => ({
    getCurrentChatId: () => fixture.chatId, is_send_press: false, setExtensionPrompt: vi.fn(),
    substituteParams: text => text, chat_metadata: {}, extension_prompts: {}, getRequestHeaders: vi.fn(),
}));
vi.mock('../../../../extensions.js', () => ({ extension_settings: {}, getContext: () => ({ chat: fixture.chat }) }));
vi.mock('../../../../utils.js', () => ({ getStringHash: vi.fn() }));
vi.mock('../core/chunking.js', () => ({ isUnitStrategy: () => false }));
vi.mock('../core/keyword-boost.js', () => ({ extractChatKeywords: vi.fn(), extractBM25Keywords: vi.fn() }));
vi.mock('../core/text-cleaning.js', () => ({ cleanText: text => text }));
vi.mock('../core/core-vector-api.js', () => ({
    getSavedHashes: vi.fn(), insertVectorItems: vi.fn(), queryCollection: vi.fn(),
    queryActiveCollections: vi.fn(), deleteVectorItems: vi.fn(),
}));
vi.mock('../backends/backend-manager.js', () => ({
    // The health check is the await vectorizeAll makes before reading the chat.
    isBackendAvailable: vi.fn(async () => { fixture.onAwait?.(); return true; }),
}));
vi.mock('../core/summarizer.js', () => ({ summarizeText: vi.fn() }));
vi.mock('../core/collection-loader.js', () => ({
    registerCollection: vi.fn(), getCollectionRegistry: () => [], isCollectionEmpty: vi.fn(),
}));
vi.mock('../core/collection-metadata.js', () => ({
    isCollectionEnabled: () => true, filterActiveCollections: vi.fn(), setCollectionLock: vi.fn(),
    getChunkMetadata: vi.fn(), getCollectionMeta: vi.fn(), isCollectionAutoSyncEnabled: () => true,
}));
vi.mock('../ui/progress-tracker.js', () => ({ progressTracker: { complete: vi.fn(), addError: vi.fn() } }));
vi.mock('../core/conditional-activation.js', () => ({
    buildSearchContext: vi.fn(), filterChunksByConditions: vi.fn(), processChunkLinks: vi.fn(),
}));
vi.mock('../ui/search-debug.js', () => ({
    createDebugData: vi.fn(), setLastSearchDebug: vi.fn(), addTrace: vi.fn(), recordChunkFate: vi.fn(),
}));
vi.mock('../core/bounded-retrieval.js', () => ({ runBoundedRetrieval: vi.fn() }));
vi.mock('../core/retrieval-budget.js', () => ({ resolveEventBaseRetrievalTimeoutMs: vi.fn() }));
vi.mock('../core/log.js', () => ({
    log: { lifecycle: vi.fn(), verbose: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), enabled: () => false },
}));
vi.mock('../core/feature-gate.js', () => ({ isVectFoxEnabled: () => true }));
vi.mock('../core/ils-expander.js', () => ({
    prepareMessagesForEventBase: messages => ({ messages: [...messages], stats: { summariesFound: 0 }, visibleCount: messages.length }),
}));
vi.mock('../core/collection-ids.js', () => ({
    getChatUUID: () => 'shared-integrity-uuid', COLLECTION_PREFIXES: {}, INTERNAL_COLLECTION_IDS: {},
    parseCollectionId: vi.fn(), parseRegistryKey: vi.fn(), getRegistryBackend: () => 'qdrant',
}));
vi.mock('../core/eventbase-store.js', () => ({
    findEventBaseCollectionsForChat: () => [],
    // Synchronous step between auto-sync's early chat-id read and its snapshot.
    resolveActiveEventBaseCollection: () => {
        fixture.onAwait?.();
        return { collectionId: 'vf_eventbase_qdrant_shared', registryKey: 'qdrant:vf_eventbase_qdrant_shared' };
    },
}));
vi.mock('../core/eventbase-workflow.js', () => ({
    runEventBaseIngestion: vi.fn(async () => ({ eventsExtracted: 0, windowsProcessed: 0, windowsSkipped: 0 })),
    countUnfinishedWindows: () => 0,
    getAutoSyncWindowSize: () => 2,
}));
vi.mock('../core/model-config-notifier.js', () => ({
    isInvalidModelConfigError: () => false, notifyInvalidModel: vi.fn(), pauseAutoSyncForChat: vi.fn(),
}));

import { synchronizeChat, vectorizeAll } from '../core/chat-vectorization.js';
import { runEventBaseIngestion } from '../core/eventbase-workflow.js';

const ingestionArgs = () => runEventBaseIngestion.mock.calls[0][0];

beforeEach(() => {
    vi.clearAllMocks();
    switchChat('Branch A');
    fixture.onAwait = null;
    globalThis.toastr = { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() };
});

describe.each([
    ['vectorizeAll', () => vectorizeAll({ vector_backend: 'qdrant' }, 4)],
    ['synchronizeChat (auto-sync)', () => synchronizeChat({ vector_backend: 'qdrant' })],
])('%s source chat capture', (_name, start) => {
    it('passes the open chat file alongside its messages', async () => {
        await start();
        expect(ingestionArgs()).toMatchObject({ sourceChatId: 'Branch A', messages: [{ mes: 'Branch A message' }] });
    });

    it('names the chat the snapshot came from when the user switches before it is taken', async () => {
        fixture.onAwait = () => switchChat('Branch B');
        await start();
        expect(ingestionArgs()).toMatchObject({ sourceChatId: 'Branch B', messages: [{ mes: 'Branch B message' }] });
    });
});
