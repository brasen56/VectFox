# VectFox fork — documented changes vs upstream (KritBlade/VectFox)

*Compiled 2026-10-22 by diffing this fork against the upstream repository and reading every changed file, commit, test, and design doc. The fork's work was never tracked as it was done; this document reconstructs it so it can be discussed, reviewed, or contributed upstream.*

> **Shareable version:** `Doc/fork-summary-for-upstream.md` is a condensed summary drafted for the original developer. It **omits the merged_world_tracker (MWT) / Knowledge Growth integration surface** — the public event API, candidate capture windows, per-event `source_messages` provenance, and fact-knowledge attribution (schema v1.4 `knowledge`) — per the decision that this private, highly specific integration should not be passed on. Sections §3.18, §3.12, §3.13 (source provenance half), and §3.8–3.9 below are therefore internal-only context. Ask the Story is VectFox-owned and standalone, so it stays in the summary.

---

## Contents

1. [Fork lineage and how this was reconstructed](#1-fork-lineage-and-how-this-was-reconstructed)
2. [The EventBase continuity project (umbrella)](#2-the-eventbase-continuity-project-umbrella)
3. [Feature-by-feature changes](#3-feature-by-feature-changes)
4. [New settings reference](#4-new-settings-reference)
5. [Behavior changes vs upstream defaults (consolidated)](#5-behavior-changes-vs-upstream-defaults-consolidated)
6. [Old fork lineage: what survived the August rebuild](#6-old-fork-lineage-what-survived-the-august-rebuild)
7. [Upstream progress since the fork (3.6.9–3.6.13) and overlap](#7-upstream-progress-since-the-fork-3693613-and-overlap)
8. [Design docs written alongside the code](#8-design-docs-written-alongside-the-code)
9. [Known gaps, caveats, and rough edges](#9-known-gaps-caveats-and-rough-edges)
- [Appendix A: complete commit list](#appendix-a-complete-commit-list-41-commits)
- [Appendix B: new files by area](#appendix-b-new-files-by-area)

---

## 1. Fork lineage and how this was reconstructed

| Reference point | Commit | Date | Notes |
|---|---|---|---|
| Upstream fork base | `886a014` | 2026-08 | upstream **v3.6.8** ("Merge Dev into main: vitest 3.2.7 …"); the merge-base of this fork and upstream |
| Fork HEAD (branch `merged`) | `f5fbdff` | 2026-10-22 | all work documented here |
| Upstream today | `690d386` | fetched 2026-10-22 | upstream **v3.6.13**; the `VectFox-original/` folder in this workspace is this tree (minus 7 test files) |
| Old fork branch base | `776b938` | 2026-06-02 | the fork originally started here (pre-3.6.x); see §6 |

**The fork's history has two eras:**

1. **The old fork (June–July 2026).** ~30 commits on the branch `fix/eventbase-persona-rename-split`, based on upstream `776b938` (June 2). This work was never published.
2. **The rebuild (Aug 10, 2026).** The repo was recreated fresh on upstream 3.6.8 (`886a014`), and selected old-fork work was **re-ported** (commits `c1508a6`, `49e069e`, `95fa03e`, `aef2e4d`, `c7bd68a`, each crediting the old commit hashes). Everything after that (Oct 2–22, 36 commits) is new feature work on branch `merged`.

Because of the rebuild, the git history *understates* the total effort — the re-ported lines carry August dates but June/July authorship. The diff `886a014..HEAD` is nonetheless complete: it contains every difference between this extension and upstream 3.6.8.

**Scale:** 41 commits · 121 files changed · **+15,971 / −989** lines · 82 new files (27 in `core/`, 8 in `ui/`, 36 tests, 10 design docs, 1 diagnostic) · 39 modified files · 0 deletions. `manifest.json` was never touched — the fork still identifies as v3.6.8 (see §9).

Local branches `main` / `origin/main` (`52aca0d`, "similharity version check…") are an older side lineage and are **not** the integration branch; `merged` is.

---

## 2. The EventBase continuity project (umbrella)

The single largest thread of work (Oct 3–15) is a project documented across four design docs (§8): long-running RPs over-weight old dramatic events — conflicts stay retrievable forever, `open_threads` are never closed, and every injection route replays them as *current*. The project separates **"historical importance" from "present applicability"** using a small derived `continuity` payload written onto events (never touching archive text, embeddings, or extraction coverage), rendered uniformly into every memory route.

It shipped in phases:

- **Phase 1 — derived continuity**: resolution links, shared renderer, resolved-event downranking, resolution-aware extraction (`0d4e731`)
- **Phase 2 — repair**: an LLM-assisted pass that retrofits continuity links onto existing collections (`b3728b5`, `69fbe5e`)
- **Phase 3A/3B — retrieval recall**: the `Doc/retrieval-recall-plan.md` planner/pool/filter rework (`cdf71c8`, `b92534b`, `6f0b4a9`)
- **Phase 4 — relationship states on NPC cards**: fully scoped in `Doc/eventbase-continuity-phase4-scope.md` but **not implemented**

Supporting vocabulary used below: **scene cast** (characters detected in play), **cast lane** (per-character history injection), **leads** (roster groups above an event-share threshold), **spine** (first/last/important/widest-gap history sampling — deliberately *not* relevance-based).

---

## 3. Feature-by-feature changes

Each entry: what it is, what the user sees, how it works, and where the evidence lives. Baseline = upstream 3.6.8.

### 3.1 Character roster and alias management

A session-local index of every stored EventBase event, grouped into alias-aware character groups. Drives extraction hints, the cast lane, NPC cards, and public-API subject resolution.

- **User-visible:** EventBase tab → "Character roster and aliases" → *Review / Refresh roster* opens per-collection group lists: event counts, share %, Lead/Ambiguous/Manual badges, stored spellings. Users can rename, merge, split, restore automatic grouping, and **ignore tags** (reversible exclusions, restored individually or all at once). Overrides and ignored tags persist per collection in settings — stored events are never touched.
- **How:** `ensureCharacterIndex` lazily lists all chunks (capped pages, mid-build mutations, hashes-only failures handled) into `slimEvent` projections; `buildCharacterRoster` groups exact stored spellings by normalized name (honorific stripping, NFKC), auto-merges only unambiguous short→long containment (never CJK or shared surnames), honors manual overrides. Lead detection: share ≥ 0.25 and ≥ 20 events. Insert/delete lifecycle hooks update the index incrementally.
- **Files:** new `core/character-roster.js`, `ui/character-roster-review.js`; modified `eventbase-workflow.js`, `eventbase-store.js`, `core-vector-api.js`, `prompts-i18n.js`, `index.js`, `ui-manager.js`.
- **Commits:** `d444bda` (roster + prompts), `bcde259` (ignored tags), `b3728b5` (duplicate exclusion). **Tests:** `tests/character-roster.test.js` (28), `tests/character-roster-integration.test.js`.

### 3.2 Scene-cast detection and the cast history lane

A second, character-driven retrieval lane independent of topic — the fix for "the NPC lawyer forgot drafting the LLC because retrieval is purely topical." **No per-turn database query**; it reads the in-memory roster index.

- **User-visible:** settings under "Scene-cast history": sticky messages (30), max characters (3), cast token budget (700 est. tokens). Injected after the main event block, e.g. `Known history with Howard Brennan (oldest → newest): - [June 3, 2026] Drafted and filed…`. Zero budget or zero characters disables the lane.
- **How:** `core/scene-cast.js` `detectSceneCast` unions two signals (excluding lead groups): text matches of roster names/aliases over the last N messages after reasoning/game-block stripping (`core/scene-cast-matcher.js`, Unicode word boundaries, honorific stripping, literal CJK), and the Agent Mode planner's `characters_any` — remembered with message index in bounded session memory (20 chats, invalidated by chat-prefix fingerprints, never written by dry-runs). `formatCastHistoryDetailed` allocates budget smallest-history-first; oversized histories use spine sampling; shared events are claimed once; main-injected and visible-context events are excluded; rendering is chronological by story date.
- **Commits:** `c8e42c9`, `5720117`. **Files:** new `core/scene-cast.js`, `scene-cast-matcher.js`, `scene-cast-settings.js`; modified `core/eventbase-injection.js` (+271). **Tests:** `tests/scene-cast.test.js` (incl. the Brennan LLC regression fixture).

### 3.3 Shared EventBase token budget and budgeted injection

Upstream's injection was unbounded ("Top-K controls payload size"). The fork replaces it with one estimated-token envelope (default 4000) shared between the topical lane and the cast lane.

- **User-visible:** "Token budget" setting (4000; 0 disables injection). Dry-run reports per-lane token use and budget cuts. Events that no longer fit in full detail become atomic one-line "Compact recalled events" entries — never a mid-record slice.
- **How:** `formatBudgetedEventBase` (`core/eventbase-token-budget.js`) reserves wrapper overhead, gives the cast lane its reserve, renders main, renders cast against the actual main selection, then rebuilds main with unused cast capacity. Token estimation is conservative (ASCII/4, non-ASCII/1).
- **Commits:** `2fbc872`, `c8e42c9`. **Tests:** `tests/eventbase-token-budget.test.js` (13).

### 3.4 LLM-written NPC cards

Opt-in per-character history cards whose every fact must cite event IDs, refreshed incrementally in the background and injected inside the cast budget.

- **User-visible:** "LLM-written NPC cards for long histories" (default **off**), min events 30, card tokens 350, "Reset NPC cards". Injected as `Known history with {name} (NPC card):` plus "Newer events not yet in the card" source lines. Dry-run shows per-character status (`ready/building/stale/not_built/below_min/retry_wait`) and why each card was or wasn't injected.
- **How:** cards keyed by lock-union collections + name + aliases, stored (max 100) in settings. Each fact carries `source_ids`; a 32-bit FNV-1a digest is computed over *exactly what the model sees*, so unrelated field changes never force regeneration and edited evidence gates out only the affected facts. `advanceNpcCard` plans ≤ 4 batches of ≤ 6000 est. tokens; longer unread histories are spine-sampled and marked considered. `validateNpcFacts` rejects uncited or invented facts. Generation goes through the summarizer provider at rate-label `npc-card`, with exponential backoff (1–30 min) and a serial per-retrieval queue. Injection filters facts individually against eligible/visible events rather than dropping whole cards.
- **Commits:** `2fbc872`, `5def52c` (per-fact gating + quota priority), `16a5ffb` (diagnostics). **Files:** new `core/npc-cards.js`, `core/npc-card-llm.js`. **Tests:** `tests/npc-cards.test.js` (18).

### 3.5 Derived continuity: resolution links, downranking, open-issue context

A derived `continuity` payload on events records resolution links and duplicate marks; a shared resolver re-renders every memory route; fully-resolved conflicts are downranked; new extractions can close listed open issues.

- **User-visible:** settings "Resolved score factor" (0.85; 1 disables) and "Open issues per window" (6), plus an "Open-issue context: on/off" status line. Every injection route now shows `open_threads_at_the_time` (threads *remaining after later closure* — a time-relative projection) and a `resolution` line. Agent Mode planner candidates can be tagged `[resolved]`.
- **How:** `core/continuity.js` is the heart — `getContinuityView` validates each link (status, eligible collections, threads-digest match) and yields remaining/closed threads and resolutions; `selectOpenIssues` picks ≤ 6 unresolved interpersonal issues sharing a scene character with the window, ordered by *story time* (with misdated-outlier quarantine). In retrieval, `_finalScore` is multiplied by the downrank factor (re-applied after cross-encoder rerank), and active duplicates are dropped at the importance filter. Backend: Qdrant (or Standard+Similharity) payload PATCHes only; native Vectra reports "Continuity unsupported".
- **Commits:** `0d4e731` (main), `b3728b5` (digest hardening), `6f0b4a9` (recall bypass, §3.15). **Files:** new `core/continuity.js`. **Tests:** `tests/continuity.test.js` (13), `tests/continuity-extraction.test.js`.

### 3.6 Continuity repair (of existing collections)

A bounded, resumable, metadata-only LLM pass that links stored conflicts to their resolutions and marks re-extraction duplicates — with preview/accept/reject and per-run undo.

- **User-visible:** EventBase tab → *Review and repair memory*. Collection picker; scope (Conflicts-only at importance ≥ 6 / every open-threaded event / Duplicates-only, no LLM); character-pair and message-range narrowing; provider/model/vLLM-URL overrides; a mandatory **"Inventory and estimate (no LLM)"** gate before Start; live status (conflicts/calls/tokens/model/skips); paginated 20-per-page proposal review showing thread text and judge "how" notes; accept/reject per item or all; pause/resume/cancel; **Undo run** by run ID. The Database Browser's event detail panel gains manual controls (`ui/continuity-controls.js`): Mark resolved (all/selected threads + outcome text), Unmark, "Show what resolves this", Remove link. A BroadcastChannel lease warns about second-tab writers.
- **How:** `ContinuityRepair` (`core/continuity-repair.js`) freezes scope + candidate digests in a run manifest stored on the lexically-first event's payload; settings keep a small checkpoint. Candidates: later same-character events within 7 story-days / 300 messages at cosine ≥ 0.6 (top 5). The judge batches 4 conflicts per call with short `C#/R#` refs and an explicit per-language "how" rule; proposals write immediately as `status: "proposed"`. Duplicate marking (no LLM): overlapping windows at cosine ≥ 0.92. The service layer (`core/continuity-repair-service.js`) fetches stored vectors via the export path (no re-embedding), re-reads/merges before every write, refuses stale digests, and routes calls through the rate gate at label `repair`.
- **Commits:** `b3728b5`, `69fbe5e`. **Files:** new `core/continuity-repair.js`, `core/continuity-repair-service.js`, `ui/continuity-repair.js`, `ui/continuity-controls.js`, `Doc/continuity-repair-tester-guide.md`. **Tests:** `tests/continuity-repair.test.js` (33), `tests/continuity-repair-service.test.js` (10), `tests/continuity-repair-ui.test.js`.

### 3.7 Event chronology module

New shared module (`core/event-chronology.js`, commit `b3728b5`): `castOrderKey`/`compareCastChronology` (total order: story time → collection frame → source position → id, aware that message numbering isn't comparable across sibling chats), `plausibleStoryTimeRange` (IQR-based outlier bounds — a misdated 2024 event in a year-2000 story reads as undated; needs ≥ 10 dated events), `compareRecencyDesc`, and `followWithin` (7-story-day / 300-message look-ahead). Consumed by continuity, repair, injection (cast lane, NPC cards, open issues).

### 3.8 Fact-specific knowledge attribution — EventBase schema v1.4

Events can now carry a structured "who knows what, and how do they know it" attribution object, validated against quoted narrative evidence.

- **User-visible:** checkbox **"Capture fact-specific character knowledge"** (default **on**). New events store an optional `knowledge` object; the chunk visualizer and public API expose `knowledge_status: recorded | unknown | invalid`. Old events need no migration — absence means "unknown attribution," not "nobody knows."
- **How:** `KNOWLEDGE_PROMPT` (`core/event-knowledge.js`) is injected into every built-in extraction prompt, instructing the model to return `knowledge: {v:1, presence[…], acquisitions[…]}`. Each message in the excerpt is labeled `[S0]`, `[S1]`…; `source_index` in evidence is an ordinal into the event's `source_messages` provenance array (§3.12). `validateKnowledge()` is the single shared validator used by generation (invalid entries dropped, event kept), storage, both import paths (throws before any write), and API reads. Evidence quotes are substring-checked against cleaned narrative text (reasoning/game-system blocks stripped, Unicode/whitespace normalized) — fabricated or out-of-window quotes are rejected. Enums: presence `present|mentioned|absent`; basis `witnessed|told|document|rumor|institutional_access|other`; epistemic `fact|belief|rumor`. Bounds: 64 presence / 64 acquisition entries, 16 evidence per entry, char caps.
- **Schema:** `EVENTBASE_SCHEMA_VERSION` 1.3 → **1.4** — adds `knowledge`, plus ingestion-side `source_messages` and `source_chat_id`. The constant is a float stamp, never compared or ordered; no forced re-extraction.
- **Commits:** `f11b703` (v1.4), `e9cf0f5` (validation hardening). **Tests:** `tests/event-knowledge.test.js` (sealed-letter, mention-only, off-screen known/unknown, lie, rumor, partial disclosure fixtures), `tests/knowledge-import.test.js`.

### 3.9 Knowledge capture toggle

Turning the §3.8 checkbox off removes the `FACT-SPECIFIC KNOWLEDGE` section from all built-in prompt variants (6 languages × 2 profiles) and strips any `knowledge` the model still returns. Custom prompts are never rewritten — they must opt into the contract themselves; a UI status line says so. Commit `68f8e4e`; tests in `tests/continuity-extraction.test.js`.

### 3.10 Extraction profiles (story / slice-of-life)

A second built-in extraction profile that preserves "quiet continuity" facts instead of only dramatic story changes.

- **User-visible:** "Built-in extraction profile" select — *Story changes* (default) or *Slice of life — quiet continuity*. An inline status shows the effective profile (`custom` when a nonblank custom prompt exists — custom always wins and is never overwritten). No provenance of which profile created a stored event; changing profile affects future extraction only.
- **How:** `core/eventbase-extraction-settings.js` resolves the profile (unknown values fall back to `story`). In `prompts-i18n.js` the slice profile replaces the intro, the three gates (Future-Continuity / Recall / New-or-Changed — one event per new or changed fact, never per repetition), and the importance preamble (quiet facts score 3–5). Logged per extraction lifecycle and shown in dry-run diagnostics.
- **Caveat:** the store floor (`eventbase_min_importance`, default 3) discards quiet facts if raised above 3.
- **Commits:** `b6e846f`. **Files:** new `core/eventbase-extraction-settings.js`, `diagnostics/extraction-profile-benchmark.js`, `Doc/extraction-profile-validation.md`. **Tests:** `tests/eventbase-extraction-profile.test.js`, `tests/eventbase-extraction-profile-ui.test.js`.

### 3.11 Extraction prompt rewrite: significance gates + new placeholders

- **Significance gates (re-port `aef2e4d` of old-fork `3c3ca18`):** the baseline "one-week test" was replaced with three explicit gates — story-change ("could you delete this scene and nothing reads differently?"), retrieval-value, and a daily-routine filter (class/meals/chores/scheduled-future things are never events; a change *during* a routine is extracted, not the routine) — plus "name a concrete lasting consequence before scoring importance." **This changes extraction results for every user of the default prompt: fewer routine events.**
- **New prompt context:** `{{knownCharacters}}` (grouped roster with aliases; "prefer these names, don't invent events from this list") and `{{openIssues}}` (window-local open continuity issues with refs like `I1: [message 10, importance 7]`). A new rule lets the model return `resolves:[{ref, threads, how}]`; `mapResolutionRefs` converts that into an event's `continuity` link and deletes the raw field. Issue context is disabled for native backends without metadata support and for custom prompts lacking `{{openIssues}}`.
- **Truncation guard:** a new `_assertComplete` fails the window when `finishReason` is `length`/`max_tokens` — previously truncated JSON was salvaged; now "No partial events saved," with actionable advice.
- **Commits:** `aef2e4d`, `d444bda`, `0d4e731`/`b3728b5`. **Files:** `core/prompts-i18n.js`, `core/eventbase-extractor.js`, `core/eventbase-schema.js`.

### 3.12 Candidate capture windows (targeted growth)

Deterministic selection of up to 4 chat "scenes" (≤ 120 messages total) around the most significant stored events, exposed to external scripts (§3.18). `selectCaptureWindows` (`core/capture-windows.js`) groups events sharing source refs into scenes, splits long overlap chains into ≤ 40-message slices *before* ranking, scores each slice (dramatic event types +3, importance × 0.3), allocates one window per temporal stratum, and pages via `offset`. Commits `a6bf746`, `1bdcf78`, `e9cf0f5`. Tests: `tests/capture-windows.test.js`.

### 3.13 Source provenance: `source_messages` and `source_chat_id`

- `core/event-sources.js` (new): every event now persists a `source_messages` array — expanded index, host `id`/`extra.mesid`, `send_date`, `legacy_hash`, `raw_content_hash` (`djb2-raw-v1`), and a `sha256-narrative-v1` fingerprint of the cleaned, NFKC-normalized narrative. `resolveEventSources` runs a verification ladder (host identity → stored fingerprint + send_date dedup → legacy hash) and **never verifies without a SHA-256 match**. On non-secure origins without WebCrypto, fingerprints are `null` and the API reports `fingerprinting_unavailable` rather than substituting a weak hash. Commit `226c944`, caching `f5fbdff`.
- `source_chat_id`: `runEventBaseIngestion` stamps the originating chat file name on every event (payload-only), read in the same synchronous step as the message snapshot so a mid-run chat switch can't mislabel events. Shown as "Source chat" in the chunk visualizer. Commit `000cd94`; tests `tests/eventbase-source-chat-capture.test.js` (incl. the chat-switch race).

### 3.14 Story-time recency

Opt-in alternative to message-index recency decay, keyed to the narrative clock so ranking survives Inline-Summary collapse (which permanently distorts index coordinates).

- **User-visible:** "Recency Source" dropdown — `index` (default) or `story_time`. The lifecycle log reports the resolved "now," its source, half-life in story-days, and dated-candidate count.
- **How:** `core/story-time.js` parses ISO, "3:45 PM, June 12, 2026," month-name, and day-first forms (UTC throughout; fantasy calendars deliberately return null). "Now" = max(first parseable timestamp in recent messages, max candidate DateTime); half-life = 20% of the candidate-set span (floor 1 story-day); the bonus is exponential decay 0–1, degrading to neutral 0.5 when undatable. Injection re-renders stored `DateTime` in the same human-readable convention (no weekday — RP dates are invented).
- **Behavior note:** while `story_time` is active, native Qdrant rerank is suppressed (its formula's recency term is hardwired to index coordinates) — explained in a lifecycle log.
- **Commit:** `95fa03e` (re-port of old-fork `08cc4f3` + `4abaafe`). **Tests:** `tests/story-time.test.js`, `tests/eventbase-retrieval.test.js`.

### 3.15 Recall plan Phase 3A/3B: candidate pool, filter hygiene, per-query scopes, planner deadline

The agentic-retrieval rework from `Doc/retrieval-recall-plan.md`.

- **New settings:** "Retrieval Candidate Pool" (`eventbase_retrieval_overfetch`, default 40, range 1–200) replaces the hardcoded `top_k × 2` at all three overfetch sites; "Apply planner importance cutoff (legacy)" (`agentic_importance_hard_filter`, default **false**) opts back into the old hard `importance_gte` filter.
- **Filter hygiene:** `_validatePlannerFilters` strips lead alias groups from `characters_any` (leads matched nearly every event, neutralizing the OR filter), expands remaining NPC names to all roster aliases, and keeps unknown names. New `core/search-filter-support.js` provides `filtersReachBackend`; unsupported paths (BM25/client-side, native hybrid off) now **warn once per session** and run unfiltered instead of silently no-opping.
- **Per-query scopes:** planner queries may now be objects `{query, characters_any}` owning their own scope (legacy strings inherit the global filter list); dedup is by text *and* scope; fanout hits carry `_plannerQueryIndices`; identity merging unions provenance; the final trim reserves each query's best surviving hit before filling by score; the agentic merge pool uses the pre-search's post-dedup **pre-trim** pool instead of its trimmed top-K.
- **Planner deadline:** the planner LLM call goes through the rate limiter with a deadline — a planner that cannot start with ≥ half its timeout remaining is dropped unsent and retrieval falls back to pre-search.
- **Explicit recall:** the planner may return `recall_past_event: true` with zero valid queries; retrieval then re-runs over `recallCandidates` (a new pool retaining importance-eligible inputs *before* scoring and dedup, because dedup may have discarded a resolved event in favor of its unresolved neighbor) and disables the resolved-downrank for that pass.
- **Commits:** `cdf71c8` (3A), `b92534b` (per-query scopes), `6f0b4a9` (recall). **Files:** new `core/eventbase-retrieval-settings.js`, `core/search-filter-support.js`; heavily modified `core/agentic-retrieval.js`. **Tests:** `tests/retrieval-recall-settings.test.js`, `tests/agentic-retrieval-debug.test.js`, `tests/planner-query-schema.test.js`, `tests/agentic-recall.test.js`.

### 3.16 Retrieval diagnostics (candidate outcome tracking)

The dry-run query tester shows a **"Considered but cut (N)"** list — each cut candidate with its terminal outcome (failed importance filter / suppressed by dedup / removed by context dedup / cut at trim / cut by shared token budget) plus a snippet — a per-planner-query summary (hits, unique hits, survivors, failures, per-query character scope), and an "In play with zero events injected" line that catches characters no query ever asked about. New diagnostics-only module `core/eventbase-retrieval-debug.js`; plain text, never HTML. Commits `768714e`, `5720117`, `b92534b`. Tests: `tests/eventbase-retrieval-debug.test.js`, `tests/eventbase-dry-run-debug.test.js`; UI in `ui/search-debug.js`.

### 3.17 Qdrant empty-sparse guard + dense-only session fallback

Re-port `49e069e` (old-fork `ccf09a2`): insertion no longer attaches a sparse vector when encoding yields zero terms (empty `{indices:[],values:[]}` could wedge Qdrant's sparse index with internal "OffsetZero" panics). On query, sparse-unsupported errors (`text_sparse`, `not existing vector name`, `offsetzero`) mark the collection in a session-scoped set; hybrid queries then skip straight to dense instead of re-triggering the panic. Transient timeouts/504s deliberately do *not* disable hybrid. Since `cdf71c8` a `warnUnsupportedFilters()` toast fires when planner filters were silently dropped. Import path also skips empty sparse vectors (§3.19). Tests: `tests/qdrant-filter-fallback.test.js`.

### 3.18 Public event API (`window.VectFoxAPI` v1)

A versioned, **read-only** interop surface for other extensions/scripts: query stored events, verify their original chat messages, and enumerate capture-window scene candidates. No generation, persistence, or injection side effects.

- **Surface:** frozen global installed at module load. `getStatus()` → version, state, `effective_collections`, and `capabilities` per feature (knowledge, history per-collection backend support, semantic_search, question_research policy, source_resolution, candidate_windows; `cross_chat_source_resolution` explicitly `false` — current-chat-only in v1). `findEvents({mode: 'history'|'question', question ≤ 4000, subjects ≤ 20, match, types, scope, limit 1–500, history_selection: 'prefix'|'representative'})`. `resolveSources({sources, scope_token})` → per-ref `verified|changed|missing|unresolved` with reasons (`narrative_changed`, `raw_content_changed`, `ambiguous_duplicate`, …). `findCandidateWindows({…, max_windows 1–4, offset, retain_sources})` — §3.12.
- **How:** host-free core (`core/public-event-api.js`) with injected dependencies; SillyTavern adapter (`core/public-event-api-host.js`) builds state snapshots and emits `vectfox:api-status-changed` on the ST event bus and `document` when chat/settings/collections change. All reads are guarded by **scope tokens** — a signature hash of relevant state; any change invalidates tokens and mid-read calls return `stale_scope`. Reads paginate `listChunks` (500/page, 10k-record cap, 30 s bounded reads; a partially-read collection is never published as complete). Question mode adds bounded dense retrieval merged with metadata scans plus automatic subject detection from the question via the roster (ambiguous names → `ambiguous_subject` error with candidates). Events return full stored fields plus `event_ref` (`vf1:<collection_key>:<event_id>`), `source_refs`, `continuity_view`, and the knowledge block; both `collection_id` and backend-qualified `collection_key` so identical IDs on different backends stay distinct.
- **Commits:** `226c944` (initial), `e3905ff` (representative history — fair allocation across collections, then even sampling including both ends), `a6bf746`/`1bdcf78`/`e9cf0f5` (candidate windows + offset paging), `4e03de9`/`f5fbdff` (diagnostics, caching, status refresh). **Tests:** `tests/public-event-api.test.js` (~60 cases), `tests/public-event-api-host.test.js`. **Doc:** `Doc/public-event-api.md`.

### 3.19 `getEventsSince` interop + import dedup restore (re-ports)

- `getEventsSince(chatUUID, marker, settings)` (`core/eventbase-store.js`) — a simpler versioned read API for external consumers: Qdrant-only, inclusive lower bound on `source_window_end`, returns a whole-collection `tip` (`max+1`, so a boundary window is never skipped); degrades to empty on failure. The pre-existing `vectfox:eventbase-synced` ST event now carries `chatUUID` + `tip` in its detail payload so subscribers can pull deltas (subscribers that ignored detail are unaffected).
- `restoreEventBaseDedupStateFromChunks` (wired into `importCollection`) rebuilds window-fingerprint cache, auto-sync marker, and vectorization tip from imported chunks — prevents the post-import full re-extraction flood.
- Commit `c7bd68a` (re-ports old-fork `13eb988`, `76c9a1c`, `b6f3625`). **Tests:** `tests/eventbase-store-interop.test.js` (428 lines).
- Related: `insertEvents` now stamps `inserted_at` (epoch ms — a monotonic recency anchor that survives ILS flattening; scoring-only, injection whitelists fields).

### 3.20 Ask the Story

A manual, opt-in Q&A panel that answers natural-language questions about stored events with a single LLM call and evidence-cited, validated output.

- **User-visible:** "Ask the Story" button beside Debug Query (requires enabling `ask_story_enabled`, default **off**). Shows the configured Core chat model, a scope selector (Current chat / Selected collections 1–20), a ≤ 4000-char question. Results render claims with expandable citations (stored summary, DateTime/scene_time, cause/result) and verified original-message snapshots; coverage/exclusion diagnostics shown; everything rendered as text (no HTML). Scope changes or closing abort in-flight work.
- **How:** `core/story-research.js` `askStory` → `findEvents({mode:'question'})` (semantic + lexical, ignores injection settings) → `selectStoryEvents` (lexical scoring, ≤ ¼ budget reserved for semantic anchors, broad-question chronological spine sampling, adjacent same-chat topical expansion, unresolved-thread boost) → evidence packed to ≤ 40 records / 24,000 chars → one prompt (strict anti-inference instructions — "an earlier co-mention does not establish a meeting" — with untrusted-data framing) → `core/story-answer-llm.js` (one call through the shared rate limiter, 2048 output tokens, temp 0.2, JSON mode) → `validateStoryAnswer` enforces `{status: answered|partial|no_evidence, claims ≤ 20 × 600 chars, 1–8 refs each drawn only from supplied evidence, gap}`; malformed/uncited output is rejected but evidence is still returned. Cited `source_refs` are then resolved for verification status.
- **Commits:** `260c0bd`, `d0e569b`, `4e03de9`, `f5fbdff`. **Files:** new `ui/ask-story.js`, `ui/ask-story.css`, `core/story-research.js`, `core/story-answer-llm.js`. **Tests:** `tests/story-research.test.js`, `tests/story-answer-llm.test.js`, `tests/ask-story-ui.test.js`. **Doc:** `Doc/ask-the-story.md`.

### 3.21 InlineSummary (ILS) support

EventBase now operates on the *original* messages hidden behind InlineSummary compaction, so coordinates, hashes, and auto-sync progress stay stable when the visible chat is flattened. **Unconditional** — the old fork's `expand_ils_summaries` toggle is gone. No settings.

- **How:** `core/ils-expander.js` (new, host-agnostic) expands `message.extra.ILS_Data.OriginalMessages` or ref-style originals from `chat_metadata.ILS_Originals[Ref]`, recursing into nested summaries (max depth 64, cycle-safe); dangling refs keep the summary so content is never dropped. Wired into `synchronizeChat`, `vectorizeAll`, `stampAutoSyncMarker`, `getChatAutoSyncStatus`, and ghosting (a collapsed summary counts as covered only when *every* original beneath it is below the tip). Logs report "N summary message(s) recovered M originals (visible → effective)"; the Vectorize Content cost estimate uses expanded counts.
- **Behavior note:** auto-sync coordinates now live in ILS-expanded space — this is the root fix for the old "call flood"/"vectorizing ahead forever" bugs.
- **Commit:** `c1508a6` (re-implements old-fork `cb158ec`, `44f555a`, `7414bd5`, `9b19397`, `c8b5ff0`, `d820527`). **Tests:** `tests/ils-expander.test.js` (10), ghosting tests in `tests/summarizer-injection.test.js`.

### 3.22 Auto-sync: manual start point, verified restart, shrink recovery

- **Manual start point:** "Auto-sync start point (message index)" input + *Set start point* button in the Auto-sync panel (shown only when a chat is loaded). Keeps existing events; toasts the aligned marker; status hint shows saved marker and effective chat length. The marker floors to a window boundary (an exact-tail "from now on" choice stays intact).
- **Verified restart:** a pending re-check (`eventbase_autosync_recheck_from`) disables the tip-based positional fast-forward and forces each window to be matched against **stored** source-hash fingerprints — because older versions cached position-skipped windows as fingerprints, which cannot prove extraction. The re-check retires only after a full walk; a failed verification keeps it pending. The manual marker survives window-size changes (re-aligned).
- **Shrink recovery:** when the effective coordinate space shrinks (ILS flattening, deletions, branches), `repairAutoSyncCoordinatesAfterShrink` backs the restart point over the last two committed windows and rebases the session tip (fingerprint dedup makes unchanged windows cheap). `ensureVectorizationTip` became a per-chat-file verification: the first read after the open chat file changes re-probes `listChunks` and corrects the persisted tip to `max(source_window_end)+1` — branches/checkpoints share one UUID but not one length.
- **Status semantics rewritten:** the old single "latest turn pending settle" became three structured fields — "N msgs pending settle," "N msgs awaiting a full window," "next window at N msgs."
- **Commits:** `37898e6`, `5fa4805`, `ed1f78c`, `c00ce78`. **Files:** new `core/autosync-coordinates.js`; modified `core/eventbase-store.js`, `core/eventbase-workflow.js`, `core/chat-vectorization.js`. **Tests:** `tests/autosync-coordinates.test.js`, `tests/eventbase-autosync-restart.test.js` (16). **Docs:** the vectorization-tip section of `Doc/collection_helper.md` was rewritten to match.

### 3.23 Summary recovery from embed text (Qdrant `summary: null`)

When the Qdrant plugin stores `summary: null` in the payload, readers fall back to parsing the summary out of the stored embed text. Touch-points: `getEventsSince`, `buildSummarizerInjection`, the character roster. Commit `d8ec717`; tests in `tests/eventbase-store-interop.test.js`, `tests/character-roster.test.js`.

### 3.24 VectFox key manager (isolated API keys)

VectFox keeps its own multi-key store per provider (`vectfox_openrouter_keys` / `vectfox_custom_keys`: arrays of `{id,label,value,active}` in extension settings), fully decoupled from SillyTavern's secrets.

- **User-visible:** each key input gains a "Manage Keys (N)" button (modal: add/activate/rename/delete, masked values). Paste-to-save inputs append + activate. "Clear" buttons now delete only the active VectFox key. Placeholders show "Active: label — ****abcd (VectFox only)" or fall back to "ST shared key: …". Keys are **plaintext in settings.json** (a hint warns they appear in settings backups). The vLLM model picker fetches `{base}/models` directly from the browser with the isolated key (CORS required) when present, else via ST's proxy.
- **How:** `core/api-keys.js` reworked (~485 lines changed): dedupe-by-value, exactly-one-active normalization, first-promoted on delete, lazy seeding from the legacy single-string field. `migrateLegacyApiKeys` no longer writes to `SECRET_KEYS.OPENROUTER/CUSTOM/VLLM` — every distinct legacy plaintext key is imported into the arrays; masked shared values are never copied. With no isolated key, LLM calls fall back to ST's proxy. Embedding auth unchanged (server-side).
- **Behavior change (explicit):** VectFox keys no longer affect, or respond to, the main chat's Connection Profile.
- **Commits:** `0163bd2` (re-implements old-fork `a7fbc33`, `d213d00`, `3aafd65`, `d41e676`). **Files:** new `ui/key-manager.js`, `ui/key-manager.css`, `ui/key-settings.js`. **Tests:** `tests/api-keys.test.js` (12).

### 3.25 Generation rate limiter → priority queue

The shared sliding-window throttle was rebuilt as a priority queue: `agent (2) > extraction (1) > npc-card (0) > repair (−1)`. Background labels never take a window's last slot; deadline drops (`GenerationQueueTimeoutError` for expired requests) and AbortSignal support; requests don't hold the queue while awaiting responses; `0 calls` remains passthrough. Callers: agentic planner (deadline = half its timeout), EventBase extraction, NPC cards, continuity repair, Ask the Story. Settings unchanged (`generation_rate_limit_calls` default 0 = off, interval 60 s). Commits `5def52c`, `b3728b5`, `260c0bd` (richer re-port of old-fork `ce9d15f`'s intent). Tests: `tests/generation-rate-limiter.test.js` (9).

### 3.26 Cross-encoder reranker

Optional external second-pass reranking of EventBase retrieval candidates (adapted from OpenVault's reranker client). Settings block "Cross-encoder reranker": enable (**off** by default), API URL (base or full `/rerank`), optional key/model, max documents (2–200, default 50), timeout (1–60 s, default 10 s). `core/cross-encoder-reranker.js` POSTs `{query, documents, top_n}` with strict URL validation, requires explicit integer indices in the response, applies timeout + abort, re-applies the continuity resolved-downrank on batch-normalized scores, and appends unsent events in original order. Failures warn once and keep original order; diagnostics never echo URLs/keys. Applied just before the coverage trim in both the main and Agent-Mode deferred paths. Commits `0163bd2`, `0565092`. Tests: `tests/cross-encoder-reranker.test.js` (9).

### 3.27 LLM call plumbing

`postChatCompletion` (`core/llm-provider-call.js`) now calls providers **directly** with the isolated key (OpenRouter with `HTTP-Referer`/`X-Title` attribution headers; custom endpoints via version-aware URL building — explicit `/chat/completions` kept verbatim, any `/vN` segment preserved so e.g. Z.ai `/v4` works, bare base gets `/v1/chat/completions`; this re-ports old-fork `3badf0c`), and only uses ST's proxy when no isolated key is saved. Timeout via manual `AbortController` (works without `AbortSignal.any`), combined with caller signal cancellation; `LlmCallError` gained `finishReason`; auth failures on the direct path surface as errors. Also: `stripReasoningBlocks(text, {allowEmpty})` option so evidence validation never restores reasoning content as narrative; `collection-export.js` export metadata now preserves all fields (legacy whitelist dropped) and imports validate knowledge + skip empty sparse vectors; `core-vector-api.js` gains `querySemanticCollection()` and `supportsCollectionFilters()`; **bug fix** in `index.js`: the migrated `embedding_provider` is now copied back into live settings after `migration_embedding_source_key` (previously the first upgraded session ran on the default `transformers`, risking a wrong vector dimension against an existing collection).

---

## 4. New settings reference

All defaults as written in `index.js` / bound in `ui-manager.js` (lazy `??=` migration materializes some only when the settings UI renders).

| Group | Setting | Default |
|---|---|---|
| Injection | `eventbase_token_budget` | 4000 (0 disables) |
| Scene cast | `eventbase_cast_sticky_messages` / `_max_characters` / `_token_budget` | 30 / 3 / 700 |
| NPC cards | `eventbase_npc_cards_enabled` / `eventbase_npc_card_min_events` / `eventbase_npc_card_tokens` (storage: `eventbase_npc_cards`) | false / 30 / 350 |
| Continuity | `eventbase_resolved_downrank` / `eventbase_open_issues_max` | 0.85 / 6 |
| Roster | `eventbase_lead_share_threshold` / `eventbase_lead_min_events` / `eventbase_known_characters_limit` / `eventbase_known_characters_max_chars` / `eventbase_character_alias_overrides` / `eventbase_character_ignored_tags` | 0.25 / 20 / 40 / 4000 / {} / {} |
| Extraction | `eventbase_extraction_profile` / `eventbase_capture_knowledge` | `story` / **true** |
| Retrieval | `eventbase_retrieval_overfetch` / `eventbase_recency_source` / `agentic_importance_hard_filter` | 40 / `index` / **false** |
| Cross-encoder | `eventbase_cross_encoder_enabled` / `_api_url` / `_api_key` / `_model` / `_max_documents` / `_timeout_ms` | false / '' / '' / '' / 50 / 10000 |
| Auto-sync | `eventbase_autosync_start_marker` / `eventbase_autosync_recheck_from` | — / {} |
| Ask the Story | `ask_story_enabled` | **false** |

---

## 5. Behavior changes vs upstream defaults (consolidated)

For reviewing/upstreaming: these change behavior for users who change *nothing*.

1. **Built-in extraction prompt rewritten** (significance gates, routine filter, `{{knownCharacters}}`/`{{openIssues}}`, knowledge section) — fewer routine events, different "Reset to Default" text per CJK mode, larger prompts.
2. **Knowledge capture defaults ON** — richer but more expensive extraction; a truncation guard now hard-fails token-capped windows that previously produced salvaged partial events.
3. **Injection is budget-capped** (4000 est. tokens) — upstream had no cap; overflow events become one-line compact entries.
4. **Injected field renamed:** `open_threads` → `open_threads_at_the_time` (remaining threads), plus a `resolution` line; `DateTime` rendered human-readable ("3:45 PM, June 12, 2026") instead of raw ISO.
5. **Resolved events downranked by 0.85 by default** once continuity data exists (1.0 disables).
6. **Agentic importance filtering is soft by default** — the planner's `importance_gte` no longer excludes events unless "legacy" is re-enabled; importance only re-weights.
7. **Planner filters are transformed** (lead groups stripped, NPC aliases expanded) and **warn-and-drop on unsupported paths** instead of silently no-opping; the candidate pool defaults to 40 instead of `top_k × 2`; final trim is coverage-aware.
8. **API keys leave ST's secret store** — VectFox stops writing `SECRET_KEYS.OPENROUTER/CUSTOM/VLLM`; keys live (plaintext) in extension settings and no longer couple to the main chat's Connection Profile; ST's shared key remains a fallback.
9. **ILS expansion is unconditional** — auto-sync coordinates, ghosting, and backfill cost estimates all move to expanded-history space.
10. **Auto-sync status semantics/wording changed** (settle-pending / awaiting-window / next-window-at) and the persisted tip is re-verified per chat file (branches/checkpoints).
11. **Import path stricter:** invalid knowledge metadata fails import; empty sparse vectors are skipped (storage-format change on re-import); EventBase imports restore local dedup state.
12. **`vectfox:eventbase-synced` now carries a detail payload** (`chatUUID`, `tip`) — additive for existing subscribers.
13. **Story-time recency suppresses native Qdrant rerank** while enabled (log explains why).
14. **Summaries are recovered from embed text** when the Qdrant payload stores `summary: null` — changes what readers see for affected collections.
15. **First-session `embedding_provider` migration fix** alters upgraded-session behavior (correctly).
16. **`queryCollection` drops `*_any`/importance filters with a console warning** on backends that can't apply them (previously passed through).

---

## 6. Old fork lineage: what survived the August rebuild

The old fork (branch `fix/eventbase-persona-rename-split`, base `776b938` 2026-06-02) held 30 commits from June–July 2026. When the repo was rebuilt on 3.6.8 in August, most were re-ported (often redesigned); four items were **not**:

| Old commit | Subject | Status in current HEAD |
|---|---|---|
| **`1594d19`** | **Resolve EventBase write target from registry to prevent persona-rename splits** | **NOT in HEAD.** No write-target registry; `insertEvents` still falls back to a persona-handle-embedded collection ID, and the workflow's ownership gate (`isOwn` on creatorHandle) means an **unlocked persona rename still splits events into a fresh collection**. Read-side mitigations only (UUID-suffix matching, lock ranking). |
| `7e282c3` | Scan `extension_prompts` keys for `_pos` prefix | **NOT in HEAD** — `chat-vectorization.js` still has the hardcoded 10-iteration clear loop (> 10 position tags leak). |
| `c9551ee` | `registerCollection` should use stripped collection ID | **NOT in HEAD** — registry-key-form input can double-prefix. |
| `6011f74` | Sync Chat anti-flood confirm dialog | PARTIAL — "Sync Chat" is now a shortcut into the Vectorize Content modal (dedup + window-size warnings there); the explicit confirm is gone. |
| `dd2141b` | Dead-code cleanup + Qdrant `listChunks` multitenancy filter | PARTIAL — the multitenancy `content_type` filter is still absent. |
| `b067922` | Marker reset for shrunken chats | PARTIAL — superseded by the richer automatic `repairAutoSyncCoordinatesAfterShrink` (two windows back instead of tail-minus-one). |
| Everything else (26 commits) | ILS compat/ref-summaries/nested/estimates, marker coordinate system, status-in-extraction-coordinates, anti-flood/recovery plumbing, empty-sparse guard, dedup restore, key save/multikey/isolation (×4), openai-compatible URL normalization, tip fast-forward guard, auto-sync unlock fix, getEventsSince, significance gates, story-time, rate throttle | RE-PORTED (verified in code; the richer re-designs are §3.14, §3.17, §3.19, §3.21–§3.27) |

The lost `1594d19` matters most — see §7 for why upstream's own 3.6.12 work now overlaps it.

---

## 7. Upstream progress since the fork (3.6.9–3.6.13) and overlap

Upstream shipped five releases after the fork base, fetched here as `upstream/main` = `690d386`:

| Release | Highlights |
|---|---|
| 3.6.9 | Strip MVU engine state and UI-scaffolding tags before vectorizing (`text-cleaning.js`, `world-info-integration.js`) |
| 3.6.10 | VectFox blocks no longer break the provider's prompt cache |
| 3.6.11 | Switching VectFox off now stops all of its runtime work (master switch, `feature-gate.js`, interceptor); database browser logs through the central helper |
| 3.6.12 | **Branched and checkpoint chats can fork their EventBase from the parent** — new `eventbase-fork.js`, `eventbase-fork-core.js`, `eventbase-message-hash.js`, write-target tests |
| 3.6.13 | Renamed collections keep their name; exports keep collection settings |

**21 files were changed on both sides** (conflict hotspots when merging): `index.js`, `core/chat-vectorization.js`, `core/collection-export.js`, `core/eventbase-extractor.js`, `core/eventbase-store.js`, `core/eventbase-workflow.js`, `core/llm-provider-call.js`, `core/prompts-i18n.js`, `core/summarizer-injection.js`, `core/text-cleaning.js`, `ui/ui-manager.js`, `ui/content-vectorizer.js`, `README.md`, `.gitignore`, `Doc/collection_helper.md`, `Doc/dev_helper.md`, and five shared test files.

Points worth deciding deliberately in any merge/contribution conversation:

- **Collection identity / write targeting:** upstream 3.6.12 built a message-hash + fork/write-target mechanism for branched chats — the same problem space as the old fork's lost `1594d19` (persona-rename splits). Upstream has now shipped *a* solution; the fork's read-side mitigations (UUID-suffix matching, lock ranking) coexist with it, but the fork should rebase onto upstream's mechanism rather than resurrect the old registry.
- **`text-cleaning.js`:** upstream's MVU/UI-scaffolding stripping and the fork's `evidenceNarrative`/`allowEmpty` changes touch the same file; they are compatible in intent but will conflict textually.
- **Master switch vs background work:** upstream's "switching off stops all runtime work" needs to be verified against the fork's background NPC-card generation and repair queue after a merge.
- **Prompt cache fix (3.6.10)** touches injection formatting that the fork rewrote (budgeted injection, cast lane) — verify the cache-stability technique still applies.

---

## 8. Design docs written alongside the code

| Doc | What it covers |
|---|---|
| `Doc/eventbase-continuity-design.md` | The continuity problem statement and Phase-1 design (resolution links, renderer, downrank) |
| `Doc/eventbase-continuity-scope.md` | Phase-1 scope, illustrated with measurements from a real 5,537-event collection (96% of events `should_persist`) |
| `Doc/eventbase-continuity-phase4-scope.md` | Phase 4 (relationship states on NPC cards, episodes, cooldown, backfill) — scoped, **not implemented** |
| `Doc/retrieval-recall-plan.md` | The recall plan (Phases 0a/0b, 2, 3A/3B, 4) motivated by the "NPC lawyer forgot the LLC" failure |
| `Doc/event-knowledge.md` | Fact-specific knowledge attribution contract (schema v1.4) |
| `Doc/extraction-profile-validation.md` | Extraction-profile validation plan — the real-model benchmark table is still all "Pending" |
| `Doc/public-event-api.md` | `VectFoxAPI` v1 contract |
| `Doc/ask-the-story.md` | Ask the Story feature guide |
| `Doc/continuity-repair-tester-guide.md` | Manual testing guide for continuity repair |
| `Doc/vectfox-mwt-phases-revised.md` | Revised multi-window-token phase plan tying the above together |

---

## 9. Known gaps, caveats, and rough edges

- **Phase 4 is unimplemented** despite a full 300-line scope doc; the docs deliberately over-specify relative to what shipped.
- **Real-model validation is pending:** every cell of the extraction-profile benchmark's "required before release" table is "Pending" (mocked tests are explicitly noted as not evidence of extraction quality).
- **`manifest.json` untouched** — still v3.6.8, `auto_update: true`, upstream homePage. If published or shared, ST's updater would offer to overwrite the fork with upstream; a version-scheme decision is needed.
- **Plaintext key storage** in `settings.json` (deliberate trade-off, warned in-UI, but a real change from upstream's secret-store model).
- **Old-fork fixes lost in the rebuild** (§6): persona-rename write-target registry, the 10-tag clear loop, the stripped-ID registry key, the multitenancy `listChunks` filter.
- **Continuity-repair run manifest** lives on the lexically-first event's payload — deleting that event mid-run breaks resume (documented limitation, fragile anchor).
- **Slice-of-life profile** is built by regex surgery over the composed per-language prompts — brittle if the story template's section headers shift.
- **`KNOWLEDGE_PROMPT` is English-only** even in CJK modes (deliberate: fixed schema keys/enums; values in excerpt language).
- **`selectCaptureWindows` hard-codes budgets** (40/window, 120 total) and its dramatic-type boost list, duplicating the API `limits` object.
- **`open_threads_at_the_time` is a time-relative projection** (threads remaining after later closure), not the archive's original list — intentional, but subtle for reviewers.
- Upstream's test files for 3.6.13 features (autosync-status, fork-core, write-target, interceptor-master-switch) are absent from the `VectFox-original/` snapshot — the snapshot is otherwise upstream 3.6.13.

---

## Appendix A: complete commit list (41 commits)

Oldest first. "re-port" commits re-import work from the pre-rebuild fork lineage (§6).

```
c1508a6 2026-08-10 feat: enhance InlineSummary support and auto-sync recovery mechanisms
49e069e 2026-08-10 fix: re-port empty-sparse guard + dense-only retrieval guard (fork ccf09a2)
95fa03e 2026-08-10 feat: re-port story-time recency for EventBase retrieval (fork 08cc4f3 + 4abaafe)
aef2e4d 2026-08-10 feat: re-port significance gates for event extraction (fork 3c3ca18)
c7bd68a 2026-08-10 feat: re-port getEventsSince interop + import dedup restore (fork 13eb988, 76c9a1c, b6f3625)
768714e 2026-10-02 feat: Enhance EventBase retrieval diagnostics and candidate outcome tracking
d444bda 2026-10-03 feat: Enhance character roster management and extraction prompts
3d278e0 2026-10-03 chore: Update .gitignore (temp_bug_list.md)
bcde259 2026-10-03 feat: Implement character tag ignoring functionality with reversible exclusions
c8e42c9 2026-10-03 feat: Enhance scene cast functionality and history management
5720117 2026-10-03 feat: Enhance diagnostics for scene cast and event injection, including cap-excluded characters
cdf71c8 2026-10-03 feat: Implement Phase 3A of EventBase recall plan with enhanced retrieval settings
b92534b 2026-10-03 feat: Refactor agentic retrieval to support per-query character scopes and improve query validation
2fbc872 2026-10-04 feat: Implement shared EventBase token budget and NPC card generation
5def52c 2026-10-04 feat: Gate NPC card facts individually and prioritize the shared generation quota
37898e6 2026-10-04 feat: Implement manual auto-sync start point feature with validation and UI integration
5fa4805 2026-10-04 feat: Enhance auto-sync functionality with manual start point handling and re-check logic
0163bd2 2026-10-04 feat: add VectFox key manager for isolated API key handling
0565092 2026-10-04 feat: enhance cross-encoder functionality with improved error handling and diagnostics
16a5ffb 2026-10-04 feat: enhance NPC card diagnostics with detailed injection outcomes and status reporting
d8ec717 2026-10-04 feat: recover summaries from embed text when Qdrant payload stores summary as null
ed1f78c 2026-10-10 feat: enhance auto-sync functionality with manual restart verification and stored source hash checks
c00ce78 2026-10-10 feat: enhance auto-sync functionality with improved coverage verification and UI status updates
0d4e731 2026-10-12 feat: implement derived continuity features and scene character matching
6f0b4a9 2026-10-12 feat: enhance event retrieval with explicit recall and improved candidate handling
b3728b5 2026-10-13 feat: Add tests and UI components for continuity repair functionality
69fbe5e 2026-10-14 feat: add continuity repair tester guide and enhance scope handling in UI
d310cb5 2026-10-14 feat: enhance language handling for judge notes and update related functionality
b6e846f 2026-10-14 feat: introduce extraction profiles for eventbase with UI and diagnostics updates
000cd94 2026-10-15 feat: Capture source chat identity in event ingestion
226c944 2026-10-18 feat: Implement public event API with event retrieval and source resolution
260c0bd 2026-10-18 feat: Implement Ask Story feature with UI and backend integration
d0e569b 2026-10-18 feat: Enhance Ask the Story functionality with semantic retrieval and collection selection
4e03de9 2026-10-19 feat: Enhance error handling and diagnostics in story answering and event API
e3905ff 2026-10-19 feat: Implement representative history selection for event retrieval
a6bf746 2026-10-19 feat: Implement candidate window selection and API integration for targeted growth
1bdcf78 2026-10-20 feat: Enhance candidate window selection and API integration for improved event handling
f11b703 2026-10-21 feat: Implement fact-specific knowledge attribution in EventBase schema v1.4
e9cf0f5 2026-10-21 feat: Enhance candidate window selection with offset support and improve event knowledge validation
68f8e4e 2026-10-21 feat: Implement knowledge capture toggle and enhance extraction prompt handling
f5fbdff 2026-10-22 fix: Address integration review follow-ups for the public event API
```

## Appendix B: new files by area

**core/ (27):** `autosync-coordinates.js`, `capture-windows.js`, `character-roster.js`, `continuity.js`, `continuity-repair.js`, `continuity-repair-service.js`, `cross-encoder-reranker.js`, `cross-encoder-settings.js`, `event-chronology.js`, `event-knowledge.js`, `event-sources.js`, `eventbase-extraction-settings.js`, `eventbase-retrieval-debug.js`, `eventbase-retrieval-settings.js`, `eventbase-token-budget.js`, `ils-expander.js`, `npc-card-llm.js`, `npc-cards.js`, `public-event-api.js`, `public-event-api-host.js`, `scene-cast.js`, `scene-cast-matcher.js`, `scene-cast-settings.js`, `search-filter-support.js`, `story-answer-llm.js`, `story-research.js`, `story-time.js`

**ui/ (8):** `ask-story.js`, `ask-story.css`, `character-roster-review.js`, `continuity-controls.js`, `continuity-repair.js`, `key-manager.js`, `key-manager.css`, `key-settings.js`

**diagnostics/ (1):** `extraction-profile-benchmark.js` · **Doc/ (10):** see §8 · **tests/ (36):** one or more suites per feature above

**Modified (39):** `index.js`, `ui/ui-manager.js` (699 lines), `core/prompts-i18n.js`, `core/eventbase-injection.js`, `core/eventbase-store.js`, `core/eventbase-workflow.js`, `core/eventbase-retrieval.js`, `core/eventbase-extractor.js`, `core/eventbase-schema.js`, `core/agentic-retrieval.js`, `core/api-keys.js`, `core/generation-rate-limiter.js`, `core/llm-provider-call.js`, `core/chat-vectorization.js`, `core/summarizer-injection.js`, `core/summarizer.js`, `core/text-cleaning.js`, `core/hybrid-search.js`, `core/core-vector-api.js`, `core/collection-export.js`, `core/retrieval-budget.js`, `backends/qdrant.js`, `backends/standard.js`, `ui/search-debug.js`, `ui/chunk-visualizer.js`, `ui/content-vectorizer.js`, `vectfox.css`, `README.md`, `.gitignore`, `Doc/collection_helper.md`, `Doc/dev_helper.md`, plus 8 modified test files.
