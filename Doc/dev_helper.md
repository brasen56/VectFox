# Dev Helper

## 1) Extraction Level Location
Extraction levels are defined in: `core/keyword-boost.js`

Exact export name:
`EXTRACTION_LEVELS`

```javascript
export const EXTRACTION_LEVELS = {
    off: {
        label: 'Off',
        description: 'No auto-extraction, only WI trigger keys',
        enabled: false,
    },
    minimal: {
        label: 'Minimal',
        description: 'First 1500 chars, max 5 keywords',
        enabled: true,
        headerSize: 1500,
        minFrequency: 1,
        maxKeywords: 5,
    },
    balanced: {
        label: 'Balanced',
        description: 'First 5000 chars, max 12 keywords',
        enabled: true,
        headerSize: 5000,
        minFrequency: 1,
        maxKeywords: 12,
    },
    aggressive: {
        label: 'Aggressive',
        description: 'Full text scan, max 15 keywords',
        enabled: true,
        headerSize: null, // null = full text
        minFrequency: 1,
        maxKeywords: 15,
    },
};
```

## 2) Default Summarizer Token/Timeout Constants
Located in: `core/summarizer.js`

Exact constant names:
- `DEFAULT_MAX_TOKENS`
- `DEFAULT_TIMEOUT_MS`

## 3) Group Batch Message Settings
Located in: `core/summarizer.js`

Exact variable names used in grouped summarize flow:
- `groupMaxTokens`
- `groupTimeoutMs`

Notes:
- `groupMaxTokens` is computed from per-item budget and count, capped at 8192.
- `groupTimeoutMs` is computed as base timeout + per-item scaling, capped at 180000 ms.

## 4) Collection Active State — Two Separate Controls

There are **two independent toggles** for collection activity. They store data in different fields and must be checked separately.

### A) Card Pause/Resume Button (`enabled` flag)
- **UI:** Play/pause icon button on each collection card in the Database Browser
- **Writes:** `setCollectionEnabled(registryKey, false)` → stores `{ enabled: false }` under `extension_settings.vecthareplus.collections[registryKey]`
- **Key format:** `collection.registryKey || collection.id` — for EventBase collections registered via `eventbase-store.js`, this is the **plain collection ID** (no `backend:source:` prefix) because `registerCollection(collectionId)` is called with the raw ID
- **Read:** `isCollectionEnabled(collectionId)` in `core/collection-metadata.js` line 318
- **Default:** `true` (enabled) when no metadata exists

### B) "Active for current chat" Checkbox (lock system)
- **UI:** Checkbox in the Collection Settings panel (gear icon → "Active for current chat")
- **Writes:** `setCollectionLock(collectionId, chatId)` / `removeCollectionLock(collectionId, chatId)` → stores chat IDs in `{ lockedToChatIds: [...] }` under the **plain collection ID** entry in metadata
- **Key format:** Plain collection ID (`state.collectionId` which is `collection.id`, not `collection.registryKey`)
- **Read:** `isCollectionLockedToChat(collectionId, chatId)` in `core/collection-metadata.js` line 626
- **Gating logic:** Only applies when `lockedToChatIds` exists as an own property in stored metadata (meaning the user has saved the settings panel at least once). If the key is absent, the collection is unrestricted by default.

### Where EventBase Retrieval Checks Both
File: `core/eventbase-workflow.js`, function `runEventBaseRetrieval`

```javascript
// Gate A: card pause toggle
const disabledKey = candidateKeys.find(key => key && !isCollectionEnabled(key));
if (disabledKey) return;

// Gate B: "Active for current chat" checkbox
const storedMeta = extension_settings?.vecthareplus?.collections?.[collectionId];
if (storedMeta && Object.prototype.hasOwnProperty.call(storedMeta, 'lockedToChatIds')) {
    if (!isCollectionLockedToChat(collectionId, currentChatId)) return;
}
```

### Key files
- `core/collection-metadata.js` — `isCollectionEnabled`, `setCollectionEnabled`, `isCollectionLockedToChat`, `setCollectionLock`, `removeCollectionLock`, `getCollectionLocks`
- `ui/database-browser.js` line ~1055 — card toggle handler (`vecthare-action-toggle`)
- `ui/database-browser.js` function `saveActivation` — "Active for current chat" save handler
- `ui/database-browser.js` function `openActivationEditor` — reads lock state to populate checkbox

---

## 5) EventBase Window Dedup — chat_metadata Fingerprint Cache

### Problem with old approach
`isWindowAlreadyExtracted` used a semantic DB query (`queryCollection(..., 50, ...)`) to check if a window was already extracted. This was:
- Capped at 50 results → missed already-extracted windows if >50 events in DB
- Slow — requires embedding a dummy query + ANN search on every window

### Current approach (O(1), no DB query)
Window fingerprints are stored in `extension_settings.vecthareplus.eventbase_extracted_windows[chatUUID]` as a flat string array. Using `extension_settings` (not `chat_metadata`) ensures they survive page reloads — `saveSettingsDebounced()` is called after each window so the cache is immediately persisted.

- **Fingerprint format:** sorted source hashes joined by comma, e.g. `"123,456,789"`
- **On extraction:** `markWindowExtracted(sourceHashes, uuid)` appends the fingerprint (called in `eventbase-workflow.js` after successful insert)
- **On dedup check:** `isWindowAlreadyExtracted(sourceHashes, ...)` does `array.includes(fingerprint)` — synchronous, instant
- **Why NOT chat_metadata:** `chat_metadata` is only saved to disk when ST saves the chat (e.g. when a message is generated). Stopping mid-vectorization and reloading Chrome would lose all fingerprints written during that run.

### Key files
- `core/eventbase-store.js` — `isWindowAlreadyExtracted`, `markWindowExtracted`, `EXTRACTED_WINDOWS_KEY`
- `core/eventbase-workflow.js` — calls `markWindowExtracted(sourceHashes)` after `insertEvents` succeeds

### Migration note
Windows extracted before this fix have no fingerprint in cache. First run after update will attempt to re-insert them — Qdrant silently overwrites same hash-keyed points (no duplicates). All future runs use the cache correctly.

---

## 6) GUI Settings — EventBase Relevance

Two settings in the VectHare settings panel that look similar to EventBase internals:

| Setting | EventBase relevant? | What it actually does |
|---|---|---|
| **Insert Batch Size** (default 50) | **No** | Controls chunks-per-API-call during chunk vectorization. EventBase inserts tiny batches (2–10 events per window) so this has no meaningful effect on EventBase. |
| **Dedup Depth** (default 50 messages) | **Yes** | Used in `eventbase-retrieval.js` as `settings.deduplication_depth`. Filters out retrieved events whose source window falls within the last N messages of the current chat — avoids injecting content already visible in context. 0 = disabled. |

---

## 7) Similharity Plugin Speedup (Simultaneous Embedding Requests)
Plugin file changed: `../similharity/index.js`

What we changed:
- In `getVectorsForSource(...)`, API/network providers now run embedding calls in parallel using `Promise.all(...)`.
- Parallel provider set:
  - `openai`
  - `togetherai`
  - `mistral`
  - `electronhub`
  - `openrouter`
  - `nomicai`
  - `cohere`
- Local GPU providers remain sequential to avoid contention/queueing/OOM behavior:
  - `transformers`
  - `ollama`
  - `llamacpp`
  - `koboldcpp`

Why this speeds up:
- Before: one request embedding N items sequentially, total about N x T.
- After (API providers): N requests fired concurrently inside one batch, total about T (subject to upstream limits).

Related client-side behavior (VectHare):
- In `core/core-vector-api.js`, local GPU sources default to small batch behavior unless user explicitly overrides `insert_batch_size`.

---

## 8) Module Integration Analysis — EventBase Compatibility

Analysis of whether non-EventBase modules should be integrated into the EventBase pipeline.

### temporal-decay.js — NOT compatible

**Module:** [`core/temporal-decay.js`](core/temporal-decay.js)
**Decision:** ❌ Do not add to EventBase.

`applyDecayToResults` checks `chunk.metadata.source === 'chat'` and `chunk.metadata.messageId`. EventBase [`EventBase`](core/eventbase-schema.js) events do not carry `source: 'chat'` or a `messageId` field — they use `source_window_end`. Every event would be skipped with `decayApplied: false`.

Additionally, EventBase already has its own `_recencyBonus` — an exponential decay term computed from `source_window_end` and `chatLength` — baked into the 4-weight re-ranker formula in [`eventbase-store.js`](core/eventbase-store.js). Applying `temporal-decay.js` would be redundant and silently do nothing.

### hybrid-search.js — NOT compatible

**Module:** [`core/hybrid-search.js`](core/hybrid-search.js)
**Decision:** ❌ Do not add to EventBase.

`hybridSearch()` takes a `collectionId` and queries it with both vector + BM25/text fusion. It operates at the backend/collection layer directly — it queries the collection and returns `{ hashes, metadata }` like a raw backend call, completely bypassing [`queryEvents()`](core/eventbase-store.js) and the EventBase store layer.

Plugging it in would require duplicating the store resolution logic (collection ID mapping, schema-aware hydration, score normalization). It would also fail to populate EventBase-specific fields (`score`, `importance`, etc.) correctly. The keyword boost already added to the retrieval pipeline covers the "term frequency matters" use case without this plumbing complexity.

### Summary table

| Module | Add to EventBase? | Reason |
|---|---|---|
| [`temporal-decay.js`](core/temporal-decay.js) | No | Already covered by `_recencyBonus` in the 4-weight formula; `applyDecayToResults` would silently skip all events due to missing `source: 'chat'` / `messageId` fields |
| [`hybrid-search.js`](core/hybrid-search.js) | No | Operates at the backend/collection layer, bypasses EventBase store; keyword boost (just added) already covers term-frequency relevance |

---

## 9) EventBase Settings Impact Table

After wiring EventBase to use hydrant native hybrid search, these settings affect EventBase as follows:

| Setting | Affects EventBase? | Notes |
|---|---|---|
| `hybrid_search_enabled` | Yes | Directly toggles hybrid retrieval for EventBase. When enabled, EventBase uses hybrid search; when disabled, it falls back to pure vector search plus simple keyword boost. |
| `hybrid_fusion_method` (`rrf` / `weighted`) | Yes | Controls the fusion strategy used by EventBase when hybrid search is enabled. |
| `prefer_native_backend_hybrid` | Yes | If enabled and the backend supports native hybrid (for example Qdrant / Milvus), EventBase uses the backend-native hybrid path. |
| `bm25_k1`, `bm25_b` | Yes | Used by the client-side BM25 fallback when native hybrid is unavailable. |
| `hybrid_vector_weight`, `hybrid_text_weight` | Yes | Used only when fusion method is `weighted`. |
| `hybrid_rrf_k` | Yes | Used only when fusion method is `rrf`. |
| `keyword_scoring_method` (`keyword`, `bm25`, `hybrid`) | No | This setting affects the main chat chunk pipeline, not EventBase. EventBase is controlled by `hybrid_search_enabled` instead. |
| `keyword_extraction_level`, `keyword_boost_base_weight` | Only when hybrid is disabled | These affect the fallback `applyKeywordBoost()` path when EventBase hybrid search is off. |
| `deduplication_depth` | Yes | Used by EventBase context deduplication to suppress events that are already visible in the recent chat window. |
| `eventbase_retrieval_top_k`, `eventbase_retrieval_min_importance`, EventBase rerank weights | Yes | Still active for both hybrid and non-hybrid EventBase retrieval. |

### Key takeaway
- Use `hybrid_search_enabled`, `hybrid_fusion_method`, and `prefer_native_backend_hybrid` to control EventBase hybrid retrieval.
- `keyword_scoring_method` does **not** control EventBase.
- If hybrid is disabled, EventBase falls back to its original pure-vector-plus-keyword-boost path.
