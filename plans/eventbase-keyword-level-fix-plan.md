# EventBase Keyword-Level Fix Plan

Make the **Keyword Scoring Method**, **Enable Hybrid Search**, **Prefer Native Backend Hybrid**, and the EventBase keyword-level dropdown behave consistently and according to a single mental model across all three retrieval paths.

Scope is limited to the **EventBase chat retrieval** path (the only chat path now). Future supported backends are **Standard** (`backends/standard.js`) and **Qdrant** (`qdrant-backend.js`); LanceDB and Milvus will be removed eventually but should not be broken in this change.

---

## 1. Current behavior (traced)

| Case | Hybrid | Native | Code path | Keyword extraction |
|------|--------|--------|-----------|--------------------|
| 1 | OFF | n/a | [eventbase-retrieval.js:178](../core/eventbase-retrieval.js#L178) → `extractChatKeywords(boostText, { level, baseWeight })` | **Hardcoded cap = 8** — `extractChatKeywords` ignores `level` and falls back to its own `maxKeywords = 8` default ([keyword-boost.js:669](../core/keyword-boost.js#L669)) |
| 2 | ON | OFF | [hybrid-search.js:89](../core/hybrid-search.js#L89) `clientSideHybridSearch` → [hybrid-search.js:415](../core/hybrid-search.js#L415) `bm25Tokenize(query, …)` | **No cap** — entire query is tokenized; ignores GUI level entirely |
| 3 | ON | ON | [qdrant.js:736](../backends/qdrant.js#L736) → POSTs `searchText` to `/chunks/hybrid-query` → [similharity/index.js:54](../../similharity/index.js#L54) `extractQueryKeywords(text, 50)` | **50 CJK + 10 English overflow**, anchor + context split. Keyword level dropdown has no effect. |

Three different mental models. The dropdown the user clicks (`keyword_extraction_level`: minimal=5 / balanced=12 / aggressive=15) drives **none** of them at runtime in EventBase retrieval.

---

## 2. Desired behavior

Single mental model: **the GUI keyword-level dropdown must be authoritative whenever VectHare controls the keyword set; otherwise it must be hidden.**

| Case | Hybrid | Native | Keyword set comes from | Cap |
|------|--------|--------|------------------------|-----|
| 1 | OFF | n/a | `extractChatKeywords` driven by selected level | minimal=5 / balanced=12 / aggressive=15 |
| 2 | ON | OFF | Same VectHare keyword extractor, fed into BM25 side of fusion | Same as Case 1 |
| 3 | ON | ON | Server `extractQueryKeywords` (CJK pass → English pass) | Fixed 50 + 10 — dropdown hidden in GUI |

---

## 3. File-level change list

### 3.1 `core/keyword-boost.js` — make `extractChatKeywords` respect level

[keyword-boost.js:665-712](../core/keyword-boost.js#L665-L712) — `extractChatKeywords(text, options)`:

- Resolve `maxKeywords` from `options.level` via `EXTRACTION_LEVELS[level].maxKeywords` (5 / 12 / 15) when `options.level` is set.
- Existing `options.maxKeywords` override still wins (used by ad-hoc callers).
- Fall back to current default of 8 only when neither is provided (preserves callers like `extractChatKeywords(text)` with no options).
- If `level === 'off'` (config `enabled === false`), return `[]` immediately.

### 3.2 `core/eventbase-retrieval.js` — Case 1 path is now correct by transitivity

[eventbase-retrieval.js:176-178](../core/eventbase-retrieval.js#L176-L178) already passes `level` and `baseWeight`, so once 3.1 lands, Case 1 works. Verify that:

- Boost is still skipped when `useHybrid === true` (Case 2/3) — current logic at [eventbase-retrieval.js:181](../core/eventbase-retrieval.js#L181) is correct.
- Debug log on [line 189-191](../core/eventbase-retrieval.js#L189-L191) keeps printing extracted keywords so the user can confirm the cap took effect.

No structural changes needed beyond a comment update if desired.

### 3.3 `core/hybrid-search.js` — Case 2 path: replace `bm25Tokenize(query)` with level-driven keywords

[hybrid-search.js:415](../core/hybrid-search.js#L415) inside `performBM25Search`:

- Replace the unbounded `bm25Tokenize(query, { stem, removeStopWords, minLength: 2 })` with a level-driven extractor that produces the same surface form the BM25 scorer expects (lowercased token strings).
- Two implementation options:
  1. **Reuse `extractChatKeywords`** with the chosen level → `.map(kw => kw.text)`. Simplest and stays consistent with Case 1.
  2. **Reuse `bm25Tokenize`** then truncate by frequency to `EXTRACTION_LEVELS[level].maxKeywords`. Slightly more BM25-native but adds a second tokenization concept.
- **Recommended:** option 1. The two paths must produce the same set of keywords for the same query; sharing the extractor is the only way to guarantee that without ongoing drift.
- Threading: `performBM25Search` currently has no access to `settings`. It is called from `clientSideHybridSearch` which does (via outer scope). Pass `settings` through `performBM25Search`'s options arg ([hybrid-search.js:138-142](../core/hybrid-search.js#L138-L142)) so the level can be read.

### 3.4 `ui/ui-manager.js` — Case 3 GUI: hide level dropdown when native hybrid is active

The keyword-level dropdown lives in the **content vectorizer** UI ([content-vectorizer.js:866-905](../ui/content-vectorizer.js#L866-L905)) — that is the ingestion-side level selector, **not** the retrieval-side one. The retrieval-side level is `settings.keyword_extraction_level`, which is currently **not exposed** as a separate GUI control on the Core tab; it only exists in `extension_settings`.

Two options:

1. **Expose it.** Add a new dropdown next to "Keyword Scoring Method" on the Core tab (in [ui-manager.js:428-437](../ui/ui-manager.js#L428-L437) area), bound to `settings.keyword_extraction_level`, options off / minimal / balanced / aggressive, with the maxKeyword count shown in the label (5 / 12 / 15).
2. **Don't expose it.** Keep the setting hidden and only enforce the cap in code. Users who want a different level edit `extension_settings` directly.

**Recommended:** option 1. Otherwise users have no way to actually trigger Case 1's `aggressive`/`minimal` modes from the GUI.

Conditional visibility for Case 3:
- When `hybrid_search_enabled === true` **and** `hybrid_native_prefer === true` **and** the active backend reports `supportsHybridSearch()`, hide the new dropdown and show static explanatory text in its place:
  - "Native hybrid query keywords: up to 50 main keywords; if CJK fills the budget, up to 10 extra English keywords may be added."
- This piggybacks on the existing visibility wiring for `vecthare_hybrid_params` / `vecthare_hybrid_native_prefer`. Add a new sibling `<small>` element and toggle it from the same change handler that shows/hides hybrid params.

### 3.5 `core/chat-vectorization.js` — already correct, double-check

[chat-vectorization.js:1915-1919](../core/chat-vectorization.js#L1915-L1919) already passes `level` to `extractChatKeywords` for the legacy chat chunk path. Once 3.1 lands, this caller automatically gets the correct cap too. No change needed.

### 3.6 Backend cleanup — out of scope here

The "keep only `backends/standard.js` + `qdrant-backend.js`" cleanup is a larger separate change tracked in [remove_legacy.md](remove_legacy.md). This plan stays orthogonal to that — it must not break LanceDB / Milvus paths today, but does not need to ship cleanup of those files.

---

## 4. Behavior matrix after the fix

| User picks | Hybrid OFF | Hybrid ON, Native OFF | Hybrid ON, Native ON |
|------------|-----------|----------------------|----------------------|
| `off` | no keyword boost | client-side hybrid skipped, cosine-only | (dropdown hidden) — 50 + 10 |
| `minimal` | 5 keywords | 5 keywords on text side | (dropdown hidden) — 50 + 10 |
| `balanced` | 12 keywords | 12 keywords on text side | (dropdown hidden) — 50 + 10 |
| `aggressive` | 15 keywords | 15 keywords on text side | (dropdown hidden) — 50 + 10 |

---

## 5. Verification

Manual:

1. **Case 1** — Hybrid OFF, set level to `aggressive`. Look for the debug log line:
   `[VectHare Keyword Extraction] Extracted chat keywords: [...]` — it should now contain up to 15 entries (was 8).
2. **Case 2** — Hybrid ON, Native OFF (or pick a non-Qdrant backend). Look at the console: `[HybridSearch] Computing BM25 scores for N results…` followed by the new debug log showing the level-derived keyword list rather than full tokenized query.
3. **Case 3** — Hybrid ON, Native ON, Qdrant. Confirm the keyword-level dropdown is hidden in the GUI and the explanatory text is shown. Check the server log for `[Qdrant] extractQueryKeywords final → N tokens` (should be ≤ 60).

Automated (`tests/hybrid-search.test.js` already exists):

- Add a test that calls `clientSideHybridSearch` with a fake backend, settings `{ keyword_extraction_level: 'minimal' }`, and asserts the BM25 path saw at most 5 query terms.
- Add a test that calls `extractChatKeywords(text, { level: 'aggressive' })` and asserts up to 15 results — guards 3.1 from regressing.

---

## 6. Open questions

1. **"Keyword Scoring Method" dropdown** ([ui-manager.js:432-436](../ui/ui-manager.js#L432-L436), values `keyword` / `bm25` / `hybrid`) per [dev_helper.md:208](../Doc/dev_helper.md#L208) only affects the legacy chat-chunk pipeline, which EventBase has replaced. Does it still drive any current code path? If not, candidate to hide on the Core tab now and remove with the legacy cleanup. Confirm before touching.
2. **`maxKeywords` source for Case 3 explanatory text:** the 50 / 10 numbers are hardcoded in [similharity/index.js:54](../../similharity/index.js#L54) and [line 135](../../similharity/index.js#L135). If the user expects to tune these later, they should become server-config or query-param. For now, hardcode the same numbers in the GUI label and accept that the two stay in sync manually.
3. **Should `level === 'off'` in Case 2** disable the BM25 side of fusion entirely (degrading hybrid back to cosine-only) or fall back to a sensible default (e.g. `balanced`)? Disabling is more honest to the user's choice; falling back is more forgiving. Recommend: disable, log a warning explaining the consequence.
