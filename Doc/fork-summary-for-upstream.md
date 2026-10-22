# VectFox fork — feature summary

*This fork has been in private use for several months on top of upstream v3.6.8 and was never tracked as it grew. This is a summary of what it now does differently, written up in response to the interest in closing `open_threads`. Everything listed here ships with test coverage, and each section notes the settings involved. A small amount of additional work (an interop surface built around a private integration with another extension) is deliberately not covered here.*

---

## 1. Derived continuity — closing `open_threads` (the headline)

The core problem: events with `open_threads` stay open forever. Nothing ever closes them, conflicts from thirty turns ago are replayed as *current* in every injection, and long-running stories accumulate resolved dramatic events that keep crowding out recent quiet history — while `should_persist` does almost nothing to demote them (in the collection this was measured on, 96% of events were marked `should_persist`).

The fork's answer separates **historical importance** from **present applicability** with a small *derived* `continuity` payload written onto events. "Derived" is the important word: it is computed from events that already exist, stored as payload metadata, and **never touches archive text, embeddings, or extraction coverage** — no re-extraction, no re-embedding, and it can be removed without a trace.

**What closes a thread — three ways:**

1. **Automatically at extraction time.** The extraction prompt now receives window-local context of open issues (`{{openIssues}}`, ≤ 6, ordered by *story time*, limited to issues sharing a character with the current window) with references like `I1: [message 10, importance 7]`. A new prompt rule lets the model attach `resolves: [{ref, threads, how}]` to any event; that is mapped into a durable `continuity` link on the resolving event pointing back at the event that opened the thread. Old custom prompts keep working unchanged (the issue context simply stays off).
2. **Continuity repair — a bounded, resumable LLM pass over existing collections** (see §2). This is the answer for the events that were extracted *before* any of this existed.
3. **Manually.** The Database Browser's event detail panel gained controls: *Mark resolved* (all or selected threads, with an outcome note), *Unmark*, *Show what resolves this*, and *Remove link*.

**What changes once a thread is closed:**

- **Injection renders time-relative truth.** The `open_threads` field became `open_threads_at_the_time` — it now lists only the threads that were *still open when the event happened*, plus a `resolution: …` line on the resolving event, and the block header says the threads were open at event time. A model reading old context no longer sees a long-resolved conflict as live.
- **Retrieval demotes resolved conflicts.** A `resolved score factor` (default **0.85**, 1.0 disables) multiplies the final score of fully-resolved events — re-applied *after* optional cross-encoder reranking, so a reranker can't resurrect them. Re-extraction duplicates are marked and excluded outright.
- **Explicit recall still wins.** Agent Mode's planner can return `recall_past_event: true`, which re-runs retrieval over a pre-dedup candidate pool with the downrank disabled for that pass — asking "what happened with the LLC?" beats the ranking, by design.

**Mechanics worth knowing:** each link stores a `threads_digest` and is re-validated on every read (status, both events still in eligible collections, valid thread indices) — stale or cross-collection links silently render as unresolved rather than lying. Ordering throughout uses a shared **event-chronology** module that sorts by *story time*, not message position (message numbering isn't comparable across sibling chat files anyway), with IQR-based quarantine of misdated outliers. Backends: works via payload updates on Qdrant and Standard(+Similharity); native Vectra reports "Continuity unsupported" rather than pretending.

Settings: `eventbase_resolved_downrank` (0.85), `eventbase_open_issues_max` (6). Modules: `core/continuity.js`, `core/event-chronology.js`. Tests: `tests/continuity.test.js` (13), `tests/continuity-extraction.test.js`.

## 2. Continuity repair — retrofitting closure onto existing collections

The hard part of the `open_threads` complaint is the backlog: collections with hundreds of already-extracted events. Repair is a metadata-only LLM pass that links stored conflicts to their resolutions and marks duplicate re-extractions — with human review on everything.

**Flow:** EventBase tab → *Review and repair memory* → pick a collection and scope (**Conflicts only** at importance ≥ 6, **every open-threaded event**, or **duplicates only** — the last needs no LLM at all), optionally narrow by character pair and message range, optionally override the provider/model — then a mandatory **"Inventory and estimate (no LLM)"** step shows the call/token cost before anything runs. The run can be paused, resumed, and cancelled; every proposal is reviewed in a paginated list (thread *text*, judge's "how" note) and accepted/rejected individually or in bulk; each run can be **undone by run ID**.

**How it stays safe:** candidates are later same-character events within 7 story-days / 300 messages at cosine ≥ 0.6 (top 5 per conflict) — proposed by a judge that batches 4 conflicts per call with an explicit per-language instruction to write "how" notes in one language. Duplicate marking is pure similarity (overlap at cosine ≥ 0.92), no LLM. Stored vectors are read through the existing export path (no re-embedding), writes re-read and merge before every commit, stale candidate digests are refused, all calls go through the shared rate limiter at the lowest priority, and a BroadcastChannel lease warns if a second tab tries to write. The run manifest is checkpointed, so an interrupted run resumes.

Modules: `core/continuity-repair.js`, `core/continuity-repair-service.js`, `ui/continuity-repair.js`, `ui/continuity-controls.js`. Tests: 33 + 10 + UI suite. A manual tester guide exists (`Doc/continuity-repair-tester-guide.md`).

## 3. Character-aware retrieval (the continuity support structure)

- **Character roster.** A session-local index of all stored events, grouped into alias-aware character groups (auto-merging only unambiguous short→long name containment; never across CJK or shared surnames). A review UI shows per-collection groups with event counts and Lead/Ambiguous badges and supports rename, merge, split, and reversible per-tag ignoring — overrides live in settings and never touch stored events. The roster feeds extraction prompts ("prefer these names"), the cast lane, and subject resolution.
- **Scene-cast detection + cast history lane.** A second retrieval lane keyed to *who is in the scene*, independent of topic — built specifically so a recurring NPC remembers shared history even when the current exchange isn't topically related to it (the motivating case: a lawyer NPC forgetting the LLC they drafted). It reads the in-memory roster index (no per-turn database query) and injects a compact per-character history block (`Known history with … (oldest → newest)`). Settings: sticky messages (30), max characters (3), cast token budget (700).
- **Shared token budget.** Injection is capped by one estimated-token envelope (default 4000) shared between the topical lane and the cast lane. Events that no longer fit whole become atomic one-line "Compact recalled events" entries — never mid-record slices.
- **LLM-written NPC cards** (opt-in, off by default). For characters with long histories (default ≥ 30 events), an LLM writes a card whose **every fact must cite event IDs**; cards refresh incrementally in the background (digest-stable — unrelated field changes never trigger regeneration), and injection gates each fact individually against still-eligible events. Failures back off exponentially; everything reports status in the dry-run diagnostics.

Modules: `core/character-roster.js`, `core/scene-cast*.js`, `core/eventbase-token-budget.js`, `core/npc-cards.js`. Tests: roster 28+integration, scene-cast (incl. the regression fixture), token budget 13, NPC cards 18.

## 4. Retrieval quality ("recall plan")

Motivated by concrete recall misses and reworked in documented phases:

- **Importance filtering is now soft by default** — the planner's `importance_gte` no longer *excludes* events (importance only re-weights), unless a "legacy" checkbox re-enables the hard cutoff. A configurable **candidate pool** (default 40, was hardcoded `top_k × 2`) feeds the merge stage.
- **Planner filter hygiene.** Lead characters' alias groups are stripped from character filters (they matched nearly everything and neutralized the filter), remaining names expand to roster aliases, and paths that can't apply filters natively **warn once and run unfiltered** instead of silently no-opping.
- **Per-query character scopes.** Each planner query can own its own `characters_any` scope; dedup, merge, and the final trim are coverage-aware (each query's best surviving hit is reserved before filling by score).
- **Planner deadline.** A planner call that can't start with half its timeout remaining is dropped unsent, with fallback to the pre-search — a slow rate-limited planner no longer eats the retrieval budget.
- **Story-time recency** (opt-in). Recency decay keyed to the narrative clock (`DateTime`) instead of message index, so ranking survives summary-compaction flattening; half-life is 20% of the candidate-set span. While active, native Qdrant rerank is suppressed (its recency term is index-based) and logged.
- **Retrieval diagnostics.** The dry-run tester shows every candidate that was *considered but cut* with its terminal outcome (failed importance / deduped / context-deduped / cut at trim / cut by budget), a per-planner-query summary, and characters in play that ended with zero injected events.
- **Optional cross-encoder reranker** (off by default): an external rerank API as a second scoring pass just before the coverage trim, with strict URL validation, timeout/abort handling, and never reordering on failure.

## 5. Extraction quality

- **Significance gates** replace the "one-week test" in the default prompt: a story-change gate ("could you delete this scene and nothing reads differently?"), a retrieval-value gate, and a daily-routine filter (routines are never events; *changes during* a routine are) — plus "name a concrete lasting consequence before scoring importance." Net effect: far fewer noise events.
- **Extraction profiles.** A second built-in profile, *Slice of life — quiet continuity*, keeps quiet facts (score 3–5) instead of only dramatic changes — for RP styles where the small stuff is the story. Custom prompts always win and are never overwritten.
- **Prompt context.** `{{knownCharacters}}` injects the roster into extraction ("prefer these names, don't invent events from this list"); `{{openIssues}}` powers §1.
- **Truncation guard.** A window whose generation hit the token cap now fails loudly ("No partial events saved") with actionable advice, instead of salvaging a half-JSON event list.

## 6. Reliability & robustness

- **InlineSummary (ILS) compatibility.** EventBase operates on the *original* messages behind summary compaction — expansion is recursive (nested summaries, ref-style originals from chat metadata, cycle-safe, nothing dropped). This is the root fix for the "vectorization runs ahead forever / call flood" class of bugs: auto-sync coordinates, ghosting, and dedup all live in expanded space. (Replaces the old workaround era entirely.)
- **Auto-sync: manual start point + verified restart.** Users can set a message index to resume from; a pending "re-check" disables positional fast-forward until every window has been matched against **stored** source hashes — position-skipped windows can't masquerade as extracted ones. Coordinate shrinkage (flattening, deletions, branches) is repaired automatically, and the persisted tip is re-verified per chat file (branches share a UUID but not a length).
- **Qdrant hardening.** Empty sparse vectors are never inserted (they can wedge Qdrant's sparse index); collections that reject sparse hybrid fail over to a session-cached dense-only path instead of panicking per query. Summaries are recovered from embed text when the payload stores `summary: null`.
- **Generation rate limiter → priority queue.** Interactive calls (agent) > extraction > background NPC cards > repair; background work never takes a window's last slot; deadline-drop and AbortSignal support.
- **Isolated API keys** (optional). VectFox can keep its own multi-key store per provider ("Manage Keys"), decoupled from SillyTavern's shared secrets — the main chat's Connection Profile and VectFox no longer fight over one key. Falls back to the shared ST key when unused. (Keys are plaintext in settings — deliberate, warned in-UI.)
- **LLM call plumbing.** Direct provider calls with attribution headers, version-aware endpoint URL building (any `/vN` preserved), manual AbortController timeouts, and honest auth-failure errors.
- Smaller fixes: the migrated embedding provider is now correctly copied back on first upgraded session; `vectfox:eventbase-synced` carries a `tip` payload so other scripts can pull deltas cheaply.

## 7. Smaller user-facing addition

- **Ask the Story** (off by default). A Q&A panel that answers natural-language questions ("How did Alex meet Ranger?") from stored events with one LLM call — claims rendered with expandable citations into the stored events and their original messages, strict anti-inference validation (every claim must cite supplied evidence), coverage/exclusion notes, and no injection into the RP context.

---

*Scale of the delta: ~120 files, ~16,000 added lines, every feature above with dedicated vitest suites. Full file-level detail, commit list, and settings reference available on request.*
