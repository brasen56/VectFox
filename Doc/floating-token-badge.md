# VectFox Floating Token Badge — Implementation Plan

## Goal

Add an **optional floating badge showing how many tokens VectFox contributes to the narrator's context for each generation**, with a per-slot breakdown available on click. A primary use case is helping users compare injection formats (DenseText vs Summary vs JSONArray) and fine-tune retrieval/injection settings against their context budget.

**Recommended first-release scope:**
- Disabled by default.
- Counts VectFox's final injected text, including formatting and wrappers.
- Updates automatically each generation; shows the **last measured turn**.
- Does not alter retrieval, injection, or narration behavior.
- Presents tokenizer-based counts without promising exact provider billing.

Example:

```text
🦊 ~1,248 tokens
```

---

## Key design decisions

These were validated against the code on 2026-11-01; file/line references are informational anchors and may drift. The stable contract is the **tag prefix**, not the line numbers.

### 1. Measure from the shared `extension_prompts` registry — do not instrument injection paths

Every VectFox injection — all slots, all code paths — lands in SillyTavern's shared `extension_prompts` registry via `setExtensionPrompt`, under tags prefixed `3_vectfox` (`core/constants.js:18`). The accounting service therefore does not need hooks inside `chat-vectorization.js`, `eventbase-workflow.js`, `summarizer-injection.js`, or `world-info-integration.js`. It snapshots `extension_prompts`, filters keys by the tag prefix, and reads each entry's `.value` (plus `.position`/`.depth` for the breakdown).

Consequences:
- **Zero changes to injection code paths** → no risk of changing narration behavior.
- Counts are **wrapper- and substitution-inclusive by construction**: we read the literal final text that was set for the prompt.
- Dry runs never write to the registry (`chat-vectorization.js` guards injection with `if (!dryRun)`), so they **cannot pollute the badge** with no extra work.
- Category falls out of the tag suffix, so accounting is a pure function over a plain object — unit-testable with a mock counter.
- **Guard:** filter strictly by prefix (`3_vectfox`) so other extensions' prompts in the registry are never counted.

Slot inventory (verified):

| Tag | Category | Written by |
|---|---|---|
| `3_vectfox` | ChunkBase — main injection | `core/chat-vectorization.js` |
| `3_vectfox_pos{N}` | ChunkBase — position groups | `core/chat-vectorization.js` (tag built at ~line 1237) |
| `3_vectfox_eventbase` | EventBase retrieval | `core/eventbase-workflow.js:45` |
| `3_vectfox_summarizer` | Summarizer injection (incl. bundled NPC state) | `core/summarizer-injection.js:32` |
| `3_vectfox_lorebook` | Separate lorebook injection | `core/constants.js:21`, injected from `core/world-info-integration.js` |

### 2. Measure when generation ends (`GENERATION_ENDED`), not mid-flight

The hard part of a mid-flight design is finding a moment when every injection path has settled: the lorebook path runs from a `GENERATION_STARTED` handler (`core/world-info-integration.js:810`) while everything else runs inside the `vectfox_rearrangeChat` interceptor (manifest `generate_interceptor`), and their relative ordering must be verified per host version.

We sidestep that entirely: `extension_prompts` **persists after generation** and is only cleared at the start of the next run (`core/chat-vectorization.js` ~1301–1310). Reading the registry when `GENERATION_ENDED` fires is, by definition, after every live injection path has settled — including the lorebook handler, regardless of its ordering relative to the interceptor.

- "Last `GENERATION_ENDED` wins" gives natural swipe/regeneration semantics.
- Snapshot is a synchronous, cheap object copy; tokenization is async afterward.
- The `Preparing…`/`Counting…` user-visible states from earlier drafts collapse: tokenization happens post-generation and is transient.

Known acceptable caveats:
- **Quiet generations** exit before the clearing step (`chat-vectorization.js` ~1296), leaving the previous live turn's slots intact. A recount is idempotent (same value), so the badge keeps showing the last live turn — correct for "last measured turn" semantics. No special handling required.
- **Aborted generations** still fire `GENERATION_ENDED`; count anyway — those injections were real for that attempt.
- A path that resolves *after* prompt assembly would be counted on the badge for the turn where its text actually lands. This is the main source of imprecision covered by the accuracy label.

### 3. Fix the position-tag cleanup cap as part of this work

The stale-slot cleanup loop is `for (let i = 0; i < 10; i++)`, clearing only `3_vectfox_pos0`–`_pos9` (`core/chat-vectorization.js` ~1304–1308). Position groups are keyed by position+depth across collections, so more than 10 distinct combos is reachable for power users — leaving **stale injections in the prompt** (a live bug independent of the badge) and in the badge count. Replace the fixed range with an iteration over `Object.keys(extension_prompts)` filtered by the `_pos` prefix, and add a regression test. The badge must not hide this; the fix makes it moot.

---

## Phase 1 — Define the measurement contract

**Objective:** Decide precisely what the badge measures before adding UI.

**Status:** Implemented as a host-independent contract in `core/context-token-contract.js`,
with coverage in `tests/context-token-contract.test.js`. This phase does not enable
measurement, install listeners, add a setting/UI, or change injection behavior.

### Tasks

1. Define the measurement as:

   > Tokens in VectFox-owned prompt text present in `extension_prompts` (tag prefix `3_vectfox`) when the generation ended.

   This is not necessarily the exact marginal increase in the final provider request: subsequent prompt processing, truncation, and message formatting may affect that.

2. Confirm every registry key with the prefix maps to exactly one category (table above). Treat unknown suffixed tags as a new category rather than silently dropping them.

3. Keep these out of the total:
   - Embedding requests.
   - Summarization/extraction requests.
   - Agent planner calls.
   - Ordinary chat history.
   - Native World Info not directly injected by VectFox.
   - Other extensions' entries in `extension_prompts` (prefix filter).

4. Keep ghosting savings separate. Do not silently subtract wiped history from the injection total. (A future "ghosted messages: −N tokens" informational line is a natural follow-up, out of scope here.)

5. Display states (simplified — no mid-generation progress states):

   | State | Display |
   |---|---|
   | Extension disabled | `VectFox: Disabled` |
   | No measured turn (fresh chat) | `VectFox: —` |
   | Measurement available | `VectFox: ~1,248 tokens` |
   | No injected content | `VectFox: 0 tokens` |
   | Measurement failed | `VectFox: Count unavailable` |

   Notes:
   - "Disabled" is driven directly by the master-switch setting, not by counting. (When the switch is off, the clearing step still runs before the master-switch early exit, so the registry is empty — showing a bare `0` would be misleading.)
   - An internal transient "measuring" state may exist but does not need distinct user-facing text.

### Acceptance criteria

- Each registry key with the prefix maps to exactly one category.
- Counting boundaries and exclusions are documented.
- Zero content and failed measurement are distinguishable.

### Agreed contract for subsequent phases

- **Ownership and categories:** `classifyContextTokenTag(tag)` returns one category
  descriptor for every key starting literally with `3_vectfox`, or `null` for an
  unrelated key. Exact main and numeric `_pos{N}` tags roll up to `chunkbase`;
  exact `_eventbase`, `_summarizer`, and `_lorebook` tags map to their respective
  categories. Position-group labels retain the group number without a group cap.
  Every unknown prefixed key uses its full tag as a distinct category ID and a
  fallback label. For example, `_eventbase_extra` is not EventBase, and malformed
  `_pos` suffixes are not position groups. Ownership is a literal prefix test:
  even `3_vectfox2` is retained as unknown; `other_3_vectfox` is excluded.
- **Measurement boundary:** synchronously capture the registry at
  `GENERATION_ENDED`, then count its literal final `.value` strings with a
  tokenizer. Include all stored formatting, headings, XML wrappers, and any
  substitutions already present in those strings; do not reformat, substitute,
  or reconstruct them from retrieval/debug data. Count each non-empty slot once,
  even when two slots contain identical text. Skip the empty string, not
  whitespace-only text. Position and depth are breakdown metadata, not text.
- **Total convention:** add the individual block counts. Do not tokenize a
  concatenation and imply equivalence, subtract ghosted history, or include
  auxiliary model requests, ordinary history, native World Info, or unrelated
  registry entries. A lorebook's text injected under a ChunkBase tag belongs to
  ChunkBase; only the separate lorebook tag belongs to the lorebook category.
  Bundled NPC state stays in the summarizer slot, without a second count.
- **Accuracy and privacy:** label nonzero totals with `~`, record the tokenizer
  identity in the eventual result, and explain that this is last-measured-turn
  context contribution, not exact provider-request growth or monetary cost.
  Subsequent processing/truncation may differ. Never silently substitute a
  character heuristic. Keep raw prompt text transient; do not persist or log it.
- **States:** `CONTEXT_TOKEN_DISPLAY` defines the five labels above; `{total}` is
  a formatting placeholder, not rendered text. The master switch takes precedence
  over measurement state. A fresh/reset chat is unmeasured, not zero. Only a
  successful complete measurement can report zero (including a successful empty
  snapshot). A missing/rejected tokenizer or partial/invalid count must use
  `Count unavailable`, never a fabricated zero or a partial total presented as
  complete. No separate user-facing counting state is required.
- **Scope:** the badge remains opt-in and disabled by default when its preference
  is added in Phase 4. Tokenization is Phase 2; lifecycle/staleness handling and
  the existing position-slot cleanup bug are Phase 3. This contract does not
  alter prompts, narration, or generation flow.

---

## Phase 2 — Implement an isolated accounting service

**Objective:** Build and test measurement logic independently of the badge.

**Status:** Implemented in `core/context-token-accounting.js` and the lazy host
adapter `core/context-token-host.js`, covered by `tests/context-token-accounting.test.js`.
No lifecycle listeners, preferences, UI, or injection changes are installed.

### Implemented API and host verification

- `snapshotContextTokenPrompts(registry)` synchronously copies owned values and
  numeric position/depth metadata. `countContextTokens(snapshot, { chatId,
  generationId, tokenizer })` also copies before its first await. Capture the
  snapshot **before** awaiting `createContextTokenHostPort()` in Phase 3.
- The tokenizer port is `{ identity: { id, key, name, model? }, count(text) }`.
  The counter receives only the literal block string, including whitespace.
- Results include `status`, `total`, `perCategory`, `slots`, tokenizer identity,
  accuracy text, and `countingConvention: 'sum-of-blocks'`. Failures have a null
  total; failed categories have null counts. `partialTotal` and `partial` expose
  diagnostics without presenting a partial measurement as a complete total.
  Slots carry fixed error codes, never raw exceptions or prompt values.
- Verified against upstream SillyTavern **release** source on 2026-11-01:
  `public/scripts/tokenizers.js` and `src/endpoints/tokenizers.js`.
  `getTokensAsync` is not exported. `getTokenCountAsync` can silently estimate
  counts, so the adapter uses `getFriendlyTokenizerName` / `getTokenizerModel`
  for selection and asynchronous requests to the host's tokenizer endpoints.
  Local responses require nonempty integer token IDs; empty-ID heuristic
  fallbacks are rejected. Remote tokenizer APIs may return a count without IDs.
- The adapter freezes tokenizer/model/connection selection per measurement,
  uses host request headers, and aborts requests after 15 seconds. Missing host
  APIs, explicit estimation, unknown tokenizers, or unavailable configuration
  return a null port. It adds no dependencies and does not modify host caches.
- Only the upstream release interface was verified; no local SillyTavern install
  was available for live integration testing. Host/server-side fallback models
  and remote tokenizer accuracy remain subject to the approximation note.

Validation: `npx vitest run tests/context-token-contract.test.js tests/context-token-accounting.test.js`
and `npm test`.

### Proposed file

`core/context-token-accounting.js` (repo-relative; all paths below likewise)

### Tasks

- Expose a pure function over a snapshot: `{ [tag]: { value, position, depth } }` → structured result. No host imports inside the counting/aggregation logic; the tokenizer is injected as a port so unit tests can pass a mock counter.
- Host adapter (separate module or clearly separated section) obtains SillyTavern's tokenizer. The codebase currently has **no** tokenizer usage; the import follows the same depth as existing `script.js` imports, e.g. `import { getTokensAsync } from '../../../../../scripts/tokenizers.js'`. Verify availability and behavior in the supported host version before relying on it.
- SillyTavern selects a tokenizer based on the active API/model. **Record the tokenizer identity in the result** and surface it in the badge breakdown's accuracy note — a GPT-2-style count against a different model's BPE is exactly where the `~` comes from.
- Skip empty values; count each non-empty slot once; include XML tags, headings, and wrappers (automatic — we read final text).
- Return structured results containing:
  - Chat identity and generation identifier.
  - Measurement status (ok / failed / unavailable-tokenizer).
  - Total, per-category counts, and the per-slot array (tag, friendly label, position, depth, count) for the breakdown.
  - Tokenizer identity / accuracy label.
  - Any partial or unavailable result.

**Counting convention:** sum counts of individual injected blocks. Document this convention; separately tokenized blocks are not guaranteed to equal tokenizing a concatenated final prompt.

### Acceptance criteria

- No characters-to-tokens heuristic is silently presented as a tokenizer result.
- Errors never become a misleading zero.
- No prompt text is persisted or logged (the snapshot is counted and dropped).
- No new third-party tokenizer dependency is required.

---

## Phase 3 — Connect accounting to the generation lifecycle

**Objective:** Measure the correct turn without stale or incomplete results.

**Status:** Implemented (2026-11-01). `core/context-token-lifecycle.js` owns
the testable event lifecycle, synchronous snapshots, monotonic generation IDs,
chat/toggle/disposal invalidation, and nonfatal result publication. `index.js`
installs it once and refreshes its gate immediately on master-switch changes.
Measurement is opt-in through `show_token_badge: false`; no checkbox or badge
is added until phase 4. The exported `contextTokenLifecycle` provides
`getState()`, `subscribe(listener)` (returns an unsubscribe function), and
`refreshEnabled()`. Phase 4 should render the current state on subscription and
call `refreshEnabled()` immediately after updating the badge preference. States
are `disabled`, `unmeasured`, `available`, and `unavailable`; only `available`
contains a successful total, including zero. Published results retain no prompt
text. `dispose()` removes host listeners and invalidates pending results.

The `_pos` cleanup now iterates registry keys without a numeric cap. Coverage is
in `tests/context-token-lifecycle.test.js` and the position-cleanup cases in
`tests/eventbase-source-chat-capture.test.js` (26 groups, including `_pos999`,
early exits, master-off, quiet, and dry-run behavior). Validation: 113 focused
tests passed; the full suite passed with 84 files / 1,743 tests. Live
SillyTavern validation remains a manual follow-up.

### Files

- `index.js` — `GENERATION_ENDED` listener, staleness guards, badge enable/disable wiring.
- `core/chat-vectorization.js` — **only** the `_pos` cleanup fix (Design decision 3). No other injection-path changes.

`core/world-info-integration.js`, `core/eventbase-workflow.js`, and `core/summarizer-injection.js` are **not modified**.

### Tasks

1. On `GENERATION_ENDED`:
   - Increment a monotonic generation counter; capture it plus the current chat identity.
   - Synchronously snapshot the `3_vectfox`-prefixed entries of `extension_prompts`.
   - Kick off async tokenization; when it resolves, apply the result only if the counter, chat identity, and badge-enabled flag are all unchanged.
2. On `CHAT_CHANGED`: reset the badge to "no measured turn" and discard any in-flight result.
3. When the badge is disabled (setting off or master switch off): skip all measurement work (gate at handler entry) and invalidate pending results.
4. Handle explicitly:
   - Early exits, empty retrieval, and quiet generations (idempotent recount — see Design decision 2; no code needed beyond awareness).
   - Dry runs (cannot touch the registry; nothing to do).
   - Regenerations and swipes (last `GENERATION_ENDED` wins).
   - Aborted generations (count them).
   - Retrieval failures/timeouts during the turn (snapshot still reflects whatever was injected).
5. Fix the `_pos` cleanup cap: iterate registry keys by `${EXTENSION_PROMPT_TAG}_pos` prefix instead of the `i < 10` loop (`core/chat-vectorization.js` ~1304–1308). Add a regression test with >10 position groups.
6. Keep accounting nonfatal: any error in the measurement path must never throw into generation or the UI beyond setting the "Count unavailable" state.

### Acceptance criteria

- All injection categories belong to the same turn.
- Dry runs and quiet generations do not replace the live badge result with anything wrong.
- Late results cannot overwrite a newer state.
- Turning the badge off skips measurement work.
- Narration and prompt contents are unchanged by any accounting failure.
- No more than zero stale `_pos` slots after a run with >10 position groups.

---

## Phase 4 — Add the floating badge and preference

**Objective:** Present the measurement unobtrusively.

### Proposed files

- `ui/context-token-badge.js`
- `ui/context-token-badge.css`

### Existing files to update

- `index.js`
- `ui/ui-manager.js`
- `vectfox.css` (only if shared tokens are needed)

### Tasks

- Add a saved `show_token_badge` setting, defaulting to `false`.
- Add a "Show floating token badge" checkbox.
- Create a compact, theme-compatible badge near the chat input.
- Provide a click- and keyboard-accessible breakdown with:
  - Per-slot rows: friendly category label, slot tag, position/depth, token count. (Per-slot granularity is what makes DenseText-vs-Summary-vs-JSONArray A/B comparisons actionable.)
  - Per-category subtotals and the total.
  - "Last measured turn" label.
  - Accuracy note: tokenizer identity, sum-of-blocks convention, "context contribution — not monetary cost".
- Support keyboard interaction and touch; do not rely on hover alone.
- Ensure initialization cannot create duplicate badges or listeners.
- Clean up pending updates and UI listeners when disabled.

**Defer dragging and saved positioning until a later release** unless the fixed placement proves unsuitable.

### Acceptance criteria

- Preference persists across reloads.
- Badge does not cover chat/send controls on desktop or mobile.
- Toggle changes take effect immediately.
- Breakdown is accessible without a mouse.

---

## Phase 5 — Automated tests and regression validation

**Objective:** Prove both measurement correctness and isolation from narration.

### Proposed tests

- `tests/context-token-accounting.test.js`
- `tests/context-token-badge.test.js`
- `tests/context-token-lifecycle.test.js`

Use the existing **Vitest** setup, host-module mocks, and per-file **jsdom** pattern for UI tests.

### Required coverage

- **Accounting** (largely parameterizable over tag snapshots): every slot kind; unknown-suffix tags; empty values skipped; wrapper-inclusive counting; tokenizer rejection or unavailable API → failure status, never zero; per-category rollup; breakdown totals matching the declared sum-of-blocks convention; mock counter receives values only (no persistence).
- **Lifecycle**: quiet generation recount is idempotent; chat change during counting discards; older generation resolving after a newer one is discarded; toggle-off during counting; aborted generation still counts; disabled extension performs no measurement; duplicate initialization is harmless; `_pos` cleanup regression (>10 position groups).
- **Badge UI**: each display state; breakdown contents and keyboard access; toggle takes effect immediately.

### Validation commands

Run from the repo root:

```bash
npx vitest run tests/context-token-accounting.test.js tests/context-token-badge.test.js tests/context-token-lifecycle.test.js
npm test
```

Then manually validate in SillyTavern with ChunkBase-only, EventBase-only, summarizer-only, lorebook-only, and combined configurations, including a >10-position-group setup. Record any unrelated baseline test failures separately.

### Acceptance criteria

- New tests pass.
- No new regression failures.
- Badge failures do not change prompt contents or stop generation.

### Automated validation completed — 2026-11-01

- Extended the existing accounting, lifecycle, and jsdom badge suites with 23 tests; no production code or dependencies changed.
- Accounting now explicitly exercises wrapper-inclusive final values for every slot kind and an unknown suffix, non-additive mock tokenization (sum individual blocks, never concatenate), and text-free, serializable results with tokenizer metadata restricted to known scalar fields.
- Lifecycle regressions cover stale tokenizer loads resolving or rejecting after a newer generation, retaining the previous measured total while counting, frozen prompt registries, and later generation listeners continuing despite tokenizer or subscriber failures. Existing tests cover quiet/aborted generations, chat changes, toggles, disabled measurement, duplicate initialization, and cancellation.
- Badge regressions cover isolated source subtotals, keyboard focus/disclosure preservation across updates, and real lifecycle/accounting failures producing "Count unavailable" without changing prompts or leaking private text.
- Extended the host-mocked `rearrangeChat` cleanup regression in `tests/eventbase-source-chat-capture.test.js`: all 26 stale position tags (including `_pos999`) are emptied before early exits, then accounting excludes those empty blocks while preserving the separate EventBase block. Quiet and dry-run prompt-preservation tests remain in that suite.

Validation results:

| Check | Result |
|---|---|
| Full suite before changes (`npm test`) | 85 files, 1,768 tests passed; no baseline failures |
| Three phase-5 suites (command above) | 3 files, 123 tests passed |
| Phase-5 suites plus contract and source-chat/cleanup suites | 5 files, 161 tests passed |
| Full suite after changes (`npm test`) | 85 files, 1,791 tests passed; no new failures |
| `git diff --check` | Passed |

**Manual host validation remains pending.** Mocked host tests and jsdom do not prove real tokenizer endpoint compatibility, native Enter/Space disclosure activation, or desktop/mobile layout. In SillyTavern, test ChunkBase-only, EventBase-only, summarizer-only, lorebook-only, combined, and >10-position-group configurations. Verify the displayed slot/category sums, next-turn stale-group cleanup, quiet/aborted generations, chat switching, immediate preference/master toggles, keyboard/touch access, reload persistence, and unobstructed chat/send controls. With an unavailable tokenizer, confirm generation still completes with unchanged injection text and the badge reports "Count unavailable", not zero.

---

## Phase 6 — Documentation and polish

### Tasks

- Document the setting, counted sources, exclusions, and accuracy limitations.
- Explain that this measures context contribution — not monetary cost.
- Audit the debug trace field `totalTokens` (`core/chat-vectorization.js` ~1661), which currently receives `injection.text.length` (a character count).
  - **Findings (2026-11-01):** no code in the repo reads this trace field. The debug UI reads `debugData.injection.charCount` instead (`ui/search-debug.js` ~758, ~795), which already exists and is correctly named (`chat-vectorization.js` ~1654). The only residual risk is a generic trace-payload renderer displaying raw fields — check how `addTrace` payloads are rendered in `search-debug.js`.
  - Rename the trace field to `charCount` (or drop it as redundant with `debugData.injection.charCount`) after that check.
- Confirm no raw prompt content is stored or logged by the new feature.

### Acceptance criteria

- UI and documentation use consistent terminology.
- No character count is presented as tokens.
- The feature remains opt-in and adds no dependencies.
