# EventBase recall plan

Status: Phases 0a, 0b, 1, 2, 3A, and 3B implemented; Phase 4 shared budget and NPC cards implemented. Remaining Phase 4 items are proposals. Revision 2, 2026-10-02 (incorporates co-author review; changes listed at the end).

## Problem

In long chats (thousands of EventBase entries in Qdrant, top-K 10), an NPC's history only surfaces when the current message happens to name it. Useful background is stored and findable, but nothing asks for it.

### The case that made it concrete

The two leads visit their lawyer, Howard Brennan, who set up their LLC. In the scene he no longer "remembers" drafting and filing the LLC formation and operating agreement. He has about 20 events in the collection, including that one.

Setup: Qdrant backend, Agent Mode on, `eventbase_recency_source = 'story_time'`, planner chat depth 10, top-K 10.

What we observed:

| Check | Result |
|---|---|
| Dry-run with the original message | LLC event not injected |
| Dry-run with "LLC formation" added to the message | LLC event injected, and the planner queried for it |
| Character name across his events | Stored as both "Brennan" and "Howard Brennan" |
| Planner queries (original message) | Four queries, all about the contract dispute and wire payment; none about the LLC |
| Planner `characters_any` | Both leads, Howard Brennan, and one other NPC |
| Planner `importance_gte` | 5 |
| Merge log | `10 pre-search + 80 agentic = 90 total → 10 after rerank/dedup/trim` |

### Root causes

1. **Retrieval is topical only.** Pre-search embeds the current message and recent context. The planner prompt makes the current user message the primary driver and recent chat background ([prompts-i18n.js:31](../core/prompts-i18n.js)). Neither asks "who is in the scene, and what is our history with them?"
2. **The character filter is neutralized by the leads.** `characters_any` is an OR across names ([dev_helper.md](dev_helper.md), "Planner-emitted filter application"). Listing the leads matches nearly every event.
3. **Names are stored inconsistently.** A filter on one spelling misses events stored under the other.
4. **One filter set applies to every planner query** ([agentic-retrieval.js:221](../core/agentic-retrieval.js)), so no query is actually scoped to its subject.
5. **`importance_gte` is a hard cutoff.** A routine paperwork event scored below the floor is excluded from every agentic query.
6. **The candidate pool is small and partly discarded.** Overfetch is `top_k * 2` in three places ([eventbase-retrieval.js:370](../core/eventbase-retrieval.js), [agentic-retrieval.js:198](../core/agentic-retrieval.js), [eventbase-workflow.js:1150](../core/eventbase-workflow.js)). The agentic merge receives pre-search's trimmed final 10, not its candidates ([agentic-retrieval.js:263](../core/agentic-retrieval.js)). All four planner queries hit the 20 cap.
7. **The final trim is one global sort.** Nothing guarantees each planner query's best hit a slot, and the only diversity rule is the same-type / same-cast / within-N-messages dedup.

A wider pool alone would not have fixed the Brennan case: it would return more contract and wire events. Causes 1 to 3 are the ones that matter for it.

## Design

Add a second lane that is driven by who is in play, not by what is being said, and fix the planner's filters so they scope queries the way they were meant to.

### Phase 0: Trace where candidates are cut, and what was never asked

Small, and it verifies every later phase. It ships in two parts.

**0a, before anything else:**
- `retrieveEvents` records a per-candidate outcome in `debug`: reached pool, failed importance filter, suppressed by dedup, removed by context dedup, cut at trim, injected. Key by `event_id` with a short summary snippet.
- A per-planner-query summary: hits returned, and how many survived into the final injection.
- The dry-run return value carries both, and the query tester ([search-debug.js:1625](../ui/search-debug.js)) shows a collapsed "considered but cut" list.

**0b, once the roster exists (Phase 1):**
- A summary line listing characters in play that have zero events in the final injection (main block plus cast block), and which signal detected each one.
- Per-candidate outcomes can only explain events that reached a stage. The Brennan miss was that no query asked at all, and this line is what catches that.

**0b implementation notes (2026-10-03):**
- Diagnostics inspect all detected non-lead alias groups before the cast injection cap, including when maximum characters is zero. The cap and token budget still control only cast injection; the sticky lookback still controls detection.
- Coverage is evaluated against actual main-block and cast-block events together. Shared events cover every associated group; events excluded as already visible in chat do not count as injected.
- Dry-run debug exposes `inPlayCharacters` (uncapped), `sceneCast` (capped), and `zeroInjectionCharacters` with text/planner signals. The query tester renders the summary as plain text, and lifecycle logs report misses. Pending roster indexes report a warm-up notice rather than a misleading “none”.

### Phase 1: Character roster, aliases, and event index

New module, `core/character-roster.js`.

- **Build.** Page through each collection with `listChunks` (the call `getEventsSince` uses, [eventbase-store.js:246](../core/eventbase-store.js); it takes `offset` and `limit`, no filter). For every event keep a slim record: `event_id`, summary line, `DateTime`, `scene_time`, `importance`, `should_persist`, `event_type`, `source_window_end`, `characters`.
- **Keyed by collection, not chat.** A chat can lock different EventBase collections over time (branches, cross-chat locks, archives). The index is cached per collection ID. The chat's view is the union over the collections locked at that moment, resolved at retrieval time with the same gathering the workflow already does, so a lock change needs no invalidation.
- **Lifecycle.** Held in memory for the session, built lazily and off the turn path. Updated in `insertEvents`, pruned in `deleteEventByHash`, dropped when a collection is cleared or re-extracted. Until a collection's index is ready, the cast block is skipped for that turn.
- **Aliases.** Group automatically when a name's tokens are a subset of exactly one longer name ("Brennan" → "Howard Brennan"), after stripping honorifics. Ambiguous matches stay ungrouped and are flagged. The user can merge, split, and rename groups in a review list in the EventBase tab; manual choices override the automatic rule and are persisted.
- **Counts are per alias group.** An event counts once for a group even when it lists two of the group's spellings.
- **Leads are alias groups.** A group is a lead when its share of events exceeds a threshold (proposed `eventbase_lead_share_threshold`, default 0.25), with a minimum event count before anyone qualifies. This is load-bearing: if share were computed per raw spelling, a lead stored as "Kai" and "Kai Tanaka" could miss the threshold under both, stay in `characters_any`, and root cause 2 would survive every later phase.
- **Extraction.** Pass the roster to the extraction prompt through a new `{{knownCharacters}}` placeholder ([eventbase-extractor.js:308](../core/eventbase-extractor.js)), rendered grouped so the model learns the spellings are one person: `Howard Brennan (also: Brennan)`. Custom prompts without the placeholder are unaffected. Cap the list by event count and recency to bound prompt growth.
- Stored events are not rewritten. Alias expansion happens at read time.

**Phase 1 implementation notes (2026-10-03):**
- Index builds use 500-item pages, route each collection to its own backend, and coalesce concurrent builds. Writes/deletes during a build are replayed after the paged snapshot; invalidation prevents stale builds from restoring a dropped index.
- Startup, chat changes, ingestion, and retrieval schedule nonblocking warm-up. Reads expose `ready` and `pendingCollections`; a future cast lane must check these before using the roster. Live and archive-event lock gathering is shared with the workflow.
- Generic insert/delete/purge and Database Browser text/metadata edits also update or invalidate the index. Fresh extraction invalidates the chat's collection indexes. Backend writes outside VectFox remain unobservable until a reload or invalidation.
- Lead eligibility requires at least `eventbase_lead_min_events` distinct events in the collection union (default 20); the share must strictly exceed `eventbase_lead_share_threshold` (default 0.25). Both settings are editable in the EventBase tab.
- The EventBase tab's **Review / Refresh roster** list works per locked collection. Save names, merge selected groups, split selected groups into stored spellings, or restore automatic grouping. Saving freezes the reviewed groups as explicit overrides. If locked collections contain conflicting overrides, the first collection in workflow order wins for an overlapping spelling.
- **Ignore selected tags** reversibly excludes the selected groups' exact stored spellings from that collection's roster and `{{knownCharacters}}` hints. **Ignored tags** lists exclusions with individual and bulk restore controls. Exclusions persist per collection in `eventbase_character_ignored_tags`, also apply to later indexed events, and do not rewrite Qdrant entries or change ordinary event retrieval. Restoring automatic grouping leaves ignored tags in place. An ignored tag in one collection can still appear through another locked collection where it has not been ignored.
- Extraction's grouped list is sorted by event count, then latest source-window position. Defaults cap it at 40 groups and 4000 characters (`eventbase_known_characters_limit`, `eventbase_known_characters_max_chars`). Built-in prompts in all language modes use the placeholder; custom prompts without it remain unchanged.
- Phase 0b and the actual cast-history injection remain deferred to Phase 2, where the detection signals and cast block are introduced. Phase 1 does not change planner filters or retrieval selection.

### Phase 2: Scene-cast history block

This is the phase that fixes the Brennan case.

**Who is in play.** Two signals, unioned, with leads excluded:

1. **Text match with a long lookback.** Match roster names and aliases against the last N non-system messages (proposed `eventbase_cast_sticky_messages`, default 30), after the existing reasoning and game-block stripping. A character stays in play for N messages after their last mention. This is recomputed from the chat each turn, so it needs no stored state and survives reloads, swipes, edits, and branches. It is the primary signal: deterministic, and it works with Agent Mode off.
2. **The planner's `characters_any`** in Agent Mode, after lead stripping and alias expansion. The planner already works out who the scene involves, including characters referred to by role or pronoun, and that work is already paid for. Its detections are remembered with their message index so they persist for the same N messages. A dry-run does not write to that memory.

Rank by most recent mention and cap the count (proposed `eventbase_cast_max_characters`, default 3).

**Where the history comes from.** The Phase 1 event index, with no per-turn Qdrant query. This replaces the filtered `queryCollection` fetch in revision 1 and needs sign-off. Reasons:

- The history spine below needs a character's earliest and latest events. A top-K similarity query returns the most similar events, and `listChunks` has no filter, so neither can supply them.
- It removes the dependency on the native hybrid path. Filters only reach Qdrant when that path is active ([core-vector-api.js:1117](../core/core-vector-api.js)); otherwise a filtered fetch silently degrades into a generic top-K.
- It adds no query latency to the turn.
- The cost is the session-start scan and holding slim records in memory, roughly a megabyte for a few thousand events.

If the query-based fetch is preferred instead, it must hard-require the native hybrid path (skip the block and warn otherwise), run in parallel with the main retrieval, and carry an explicit per-character cap.

**Budget.** Proposed `eventbase_cast_token_budget`, default 700, allocated smallest history first: a character whose whole history fits gets all of it, and what remains is split among the others.

**Selection when a history does not fit.** A history spine, not relevance:

1. The earliest events (first appearance and foundations).
2. The most recent events.
3. The highest-importance and `should_persist` events.
4. Any remaining budget spread evenly across the story timeline.

Ranking by importance then relevance would re-import the topical bias this lane exists to escape. Limitation: for an event-rich minor character (say 195 events in a 230-token slice), a routine mid-history event can still be dropped. Phase 2 fully fixes the sparse case and partly fixes the rich one; per-NPC cards in Phase 4 are the answer for the rest.

**Assembly order.** The block is built after main-lane selection, because it needs the final event list for the exclusion below and the planner signal arrives with it. With no fetch, there is nothing to run in parallel.

**Injection.** A separate compact block after the main events, one line per event with its story time, oldest to newest:

```
Known history with Howard Brennan (oldest → newest):
- [June 3, 2026] Drafted and filed the LLC formation and operating agreement.
```

Built in [eventbase-injection.js](../core/eventbase-injection.js) from the existing summary and story-time helpers. Events already injected in full, or still visible within `deduplication_depth`, are left out.

**Why a block and not reserved slots.** A few reserved slots would go to the character's events that best match the current scene. In the Brennan case those are his contract events, and the LLC filing would still lose.

**Phase 2 implementation notes (2026-10-03):**
- The cast lane reads the ready locked-collection roster only; it adds no per-turn database query. If any locked index is pending, the lane skips that turn and the query tester reports the pending collections.
- `eventbase_cast_sticky_messages` (30), `eventbase_cast_max_characters` (3), and `eventbase_cast_token_budget` (700) are editable in the EventBase tab. Zero budget or maximum characters disables injection. The budget is a conservative estimate (ASCII characters / 4, non-ASCII characters / 1), including block headers and separators, not an exact model tokenizer count.
- Text detection uses cleaned non-system messages, Unicode name boundaries, aliases, and literal CJK names. Planner detections are unioned independently of whether backend filters are enabled; lead groups are excluded without changing Phase 3's backend filter behavior.
- Session-local planner memory is keyed by chat ID and UUID, ages by non-system message count, and validates the observed chat prefix so edits, swipes, and shrink do not preserve stale detections. It is bounded to 20 chats and is not persisted across reloads. Dry-runs neither write nor prune memory; a tester message is treated as a hypothetical additional message.
- Small histories are allocated first; larger histories retain earliest/latest events, persistent or high-importance (7+) events, then farthest timeline gaps. Lines are rendered chronologically by parseable story dates, with source-window order as the fallback. Shared events appear only once across cast blocks.
- Main-injected event IDs and already-visible current-chat source windows are excluded. Archive and cross-chat source windows are not compared with current-chat coordinates. The compact block follows the main block under the same global context/XML wrapper and can inject even when main retrieval is empty.
- Phase 0b is exposed in dry-run diagnostics and lifecycle logs: each in-play character with no event in either injection lane is listed with its text/planner signals, even when excluded by the cast cap.
- Automated regression fixtures verify the Brennan LLC miss with Agent Mode on and off. The real-chat dry-run remains a manual verification step.

### Phase 3: Planner and pool fixes

In rough order of effort:

## Phase 3A:
1. **Hybrid-path guard.** Planner filters are dropped with only a lifecycle-log warning when `hybrid_native_prefer` is false and the EventBase keyword method is `bm25` ([core-vector-api.js:1141](../core/core-vector-api.js)), and Agent Mode's gate only checks for the Qdrant backend. Add one shared check for "filters will reach the backend"; when it fails, warn visibly once and stop emitting filters.
2. **Filter hygiene.** In `_validatePlannerFilters` ([agentic-retrieval.js:480](../core/agentic-retrieval.js)), strip lead alias groups from `characters_any` and expand the rest to all aliases. If nothing is left, send no character filter.
3. **Soft importance floor.** Stop sending `importance_gte` as a hard filter; importance already lowers the score in the re-rank. Keep a setting to restore the old behavior.
4. **Overfetch setting.** Replace the three `top_k * 2` sites with one helper and a setting (proposed `eventbase_retrieval_overfetch`, default 40).
5. **Full pool into the merge.** `retrieveEvents` also returns its post-dedup, pre-trim candidates; stage 5 merges those. The planner still sees only the top slice.

**Phase 3A implementation notes (2026-10-03):**
- A shared native-hybrid capability check guards both planner fanout and `queryCollection`, resolving each collection's actual backend. BM25 and client-side hybrid paths receive no planner filters and show one session warning. Native-hybrid failure followed by unfiltered client fallback also warns.
- Character filters use the current locked live-collection roster: lead alias groups are removed, NPC names expand to all stored aliases, and unknown names are retained. Pending indexes use the currently available groups without adding a per-turn database fetch.
- `agentic_importance_hard_filter` defaults to false and is editable in AgentMode. Enabling it restores the planner's hard `importance_gte` cutoff. The independent EventBase minimum-importance setting is unchanged.
- `eventbase_retrieval_overfetch` defaults to 40 candidates per collection/query, is editable in EventBase (1–200), and never reduces the pool below final Top-K. One resolver serves live, archive, and planner queries; lower-level search expansion is unchanged.
- `retrieveEvents` returns `candidates` after importance filtering, pairwise dedup, and context dedup, before final trim. Agent stage 5 merges this whole pool with planner hits without reintroducing rejected archive candidates. The planner prompt still sees only the top event slice.
- Unit regressions cover filter hygiene, soft/legacy importance, unsupported routing, once-only notification, overfetch validation, and pre-trim pool preservation. Live plugin name matching remains a manual verification step.

## Phase 3B:
6. **Per-query coverage.** Tag agentic hits with their query index. At the trim, take the best surviving hit from each planner query first, then fill by score.
7. **Per-query filters.** Change the planner schema so each query carries its own character list, accepting the old string form too. Last because it touches the planner prompt in all six language variants.

**Phase 3B implementation notes (2026-10-03):**
- New planner entries use `{ "query": "search text", "characters_any": ["subject"] }`. Object entries own their character scope: an empty, missing, or invalid list means no character filter and never inherits the global list. Legacy string entries still inherit `filters.characters_any`. Non-character filters remain shared across queries.
- Validation accepts mixed forms, enforces the existing 3–300 character text bounds and maximum query count, and deduplicates by normalized query text plus character scope. Identical text with different subjects remains separate. Each scope passes through Phase 3A's lead removal, alias expansion, filter toggle, soft importance behavior, and collection capability guard.
- Fanout hits carry internal query indices. Identity merging unions their provenance while retaining the highest-scoring copy. After importance filtering, pairwise dedup, and context dedup, the trim reserves each query's best surviving hit, then fills by score. Shared best hits use only one slot; if Top-K cannot fit all representatives, planner order wins. The selected output remains score-ordered for the existing injector's chronological assembly.
- Coverage never restores a rejected candidate. Queries with empty, failed, timed-out, or entirely filtered results reserve no slot. Candidate outcomes reflect the actual coverage-aware trim.
- All six prompt variants and their JSON examples use per-query character lists. Cast detection unions global and per-query names independently of backend filter enablement. Query diagnostics distinguish same-text queries by index; `agenticQueries` remains a string list for compatibility, with validated scopes in `agenticQueryFilters`.
- Unit regressions cover mixed/legacy forms, scope isolation, provenance union, shared slots, best-survivor selection, insufficient Top-K, accurate cut diagnostics, and valid examples in every language. Live planner/Qdrant verification remains manual.

### Phase 4: Shared budget and NPC cards; remaining proposals

- **Implemented: shared EventBase token budget.** `eventbase_token_budget` defaults to 4000 conservative estimated tokens and covers main events, cast history/cards, and context/XML wrappers. Zero suppresses this retrieval injection. Cast capacity remains bounded by `eventbase_cast_token_budget`; unused capacity is returned to the main lane. Full-detail main records are admitted in relevance order, with atomic compact summaries when full detail does not fit. Only admitted main events exclude cast evidence. Summarizer injection is a separate feature and is not covered by this envelope.
- **Implemented: LLM-written NPC cards.** Opt-in `eventbase_npc_cards_enabled` uses the existing Core summarization provider/model and shared generation rate limiter. The default eligibility threshold is 30 events; each card has a 350-estimated-token factual body. In-play eligible NPCs are updated in a serialized background queue, never by a per-turn awaited LLM call. Each retrieval queues at most one call per NPC, so at most `eventbase_cast_max_characters` card calls per turn. Dry-runs never generate or save cards.
  - OpenVault's stable bounded dossier and source-linked evidence pattern informed the design; its reflection/graph storage and UI are not imported or modified. OpenVault's profile is user-initiated and reads a capped input; VectFox's cards run automatically, so cost is bounded by the incremental model below rather than by the user.
  - Cost is independent of history length. A card is built from a read plan of at most 4 calls of about 6000 estimated input tokens each (`NPC_CARD_MAX_PLAN_BATCHES`, `NPC_CARD_BATCH_TOKENS`). If the unread history fits in that plan, every renderable event is read in chronological batches (roughly 400–500 events). A longer history is sampled with the history spine (earliest, latest, persistent/important, then widest gaps), and the events left out are still marked as considered, so they are never charged for again. After the first build, a card is updated from new events only, in one call per batch, once at least 5 are unread (`NPC_CARD_REFRESH_MIN_NEW_EVENTS`). An NPC returning after a long absence gets the same capped plan. Measured before this change, a full rebuild of a 2000-event NPC cost 20–30 calls (125K–190K input tokens) and ran again whenever a new event arrived.
  - Renderable means having a summary or text; records without either are never offered as evidence. Each generated fact must cite supplied source event IDs, and unknown or absent citations are rejected. A batch may cite only its own events and the card's retained citations. This validates provenance, not semantic truth or lossless coverage. Original events remain unchanged. The prompt states the length limit in characters derived from the validator's own estimate, so cards in non-Latin scripts are not silently truncated.
  - Cards persist in `eventbase_npc_cards` in extension settings, keyed by contributing collection union, character name and aliases; storage is capped at 100 cards. Each card stores its facts, a digest of every event it cites, and compact digest lists of the events it has considered and planned. Digests cover only the fields the model is shown. A fact is dropped as soon as an event it cites is edited or deleted, and the edited event is then read as new evidence; the rest of the card stays in use. Changing the provider, model or card budget does not trigger a rebuild; the card carries forward. Cards in the earlier signature format are rebuilt. "Reset NPC cards" in settings deletes all cards so they rebuild, as the remedy for drift.
  - A card with surviving facts is injected while it is behind. The unread events (new, or planned but not yet read) follow it as source lines under "Newer events not yet in the card", selected by the spine within the same slice and under the same exclusions. Cards with no surviving facts, invalid or oversized cards fall back to the history spine. Card evidence cannot bypass main-lane, visible-context or shared-cast exclusions. Failures log a warning and back off exponentially per card (1, 2, 4 … up to 30 minutes). A failed call loses only that batch, and retrieval continues without waiting. No calls are made while either the shared or the cast token budget is zero, and a queued call is skipped if cards were disabled in the meantime.
  - Query-tester diagnostics report estimated budget use, compact main IDs, budget cuts and injected card characters. Automated tests cover budget, wrapper, fallback, source validation, capped sampling of a 2000-event history, refresh only after enough new events, per-fact edit invalidation, legacy-format rebuild, pacing/disable guards and backoff. Live provider/Qdrant and browser UI verification remain manual.
  - Implemented (2026-10-04): injection gates individual facts against admitted main events and visible context, then rechecks them against earlier cast-history claims at allocation time. A fact survives only if **all** its citations remain eligible; citations are never stripped to retain a synthesized sentence. Rendering, token budgeting and evidence claims use only surviving facts (plus admitted unread source lines). If none survive or their rendered card does not fit, the eligible source-event spine is used. The cached card is not mutated by injection.
  - Implemented (2026-10-04): card calls retain the **shared** generation quota with extraction and the Agent Mode planner, but queued planner calls take priority over extraction, which takes priority over background cards. Equal-priority requests are FIFO. Dispatch waits for a shared sliding-window slot; priority does not bypass the quota, split provider capacity, or preempt already-dispatched calls. Provider responses do not hold the dispatch queue. With rate limiting disabled (the default), calls remain passthrough. Sustained foreground demand can delay background refreshes. When the limit allows more than one call per window, background cards never take the window's last slot, so a planner arriving just after a card does not wait a full interval. A card dispatched before a planner arrives is still not cancelled.
  - Implemented (2026-10-04): the outer EventBase retrieval bound allots the planner stage one planner timeout, so time spent waiting for a slot now comes out of the planner call's timeout. A planner that cannot start with at least half of that timeout remaining is dropped before sending (`GenerationQueueTimeoutError`, no quota charged), and Agent Mode falls back to pre-search with a log line naming the rate limit. Previously a queued planner could overrun the bound, losing the turn's whole EventBase injection, and still dispatch later ahead of extraction for a result nobody waited for. Requests without a deadline (extraction, cards) are unaffected. With rate limiting off there is no wait, so the planner keeps its full timeout.
- Story-day rollup records, stored as additional entries that link to their source events. Events are never replaced.
- **Implemented (2026-10-04): optional external cross-encoder reranker.** Adapted from OpenVault's external `/rerank` client, without importing or modifying OpenVault. Enable it in EventBase settings and configure an HTTP(S) base URL or full `/rerank` endpoint, optional bearer API key and provider model. It posts `{ query, documents, top_n, model? }`; `top_n` requests all submitted candidates. The endpoint must allow browser CORS access. No model runtime or dependencies are added: the external service supplies the cross-encoder model.
  - Disabled by default (`eventbase_cross_encoder_enabled`). `eventbase_cross_encoder_max_documents` defaults to 50, clamped to 2–200. The highest weighted-score surviving renderable candidates are submitted after importance, pairwise and visible-context dedup, before Top-K. Each document contains event type, characters and summary (text fallback); the query is the current user-message anchor, with retrieval search text as fallback. Omitted results and candidates beyond the cap remain in their original relative order after explicitly ranked results. No surviving candidate is discarded by the API client.
  - Agent Mode defers the pre-search cross-encoder pass until the final merge. Planner early exits finalize the surviving pre-search pool instead, so there is at most one external call per retrieval. Per-query coverage uses cross-encoder order for each query's best surviving hit and still reserves its slot before filling Top-K. The cast-history/NPC-card lane is unchanged. Original weighted scores remain unchanged; returned relevance scores are attached as `_crossEncoderScore`.
  - `eventbase_cross_encoder_timeout_ms` defaults to 10000, clamped to 1000–60000, and is added once to the outer EventBase budget. A bounded race includes response parsing and aborts fetch on expiry, even if the transport ignores cancellation. Configuration, network, HTTP and malformed-response failures preserve the original order and produce a session-deduplicated warning. Query-tester diagnostics show use/fallback, document count, duration and errors. Supported response forms are `results`/`data` or bare object rows with explicit document indices and finite scores, plus full-length numeric score arrays. Ambiguous, duplicate or out-of-range indices are rejected rather than guessed.
  - Fixed bare-base URL normalization: assigning an empty `URL.pathname` restored `/`, and appending `/rerank` then produced `//rerank` (404 on local llama-server). Build the path before assigning it, so `http://127.0.0.1:8081` and a full `/rerank` endpoint both reach `/rerank`. Lifecycle console logs now show request start/completion and skip reasons; Debug Query distinguishes skips (empty query, fewer than two surviving/renderable candidates, no active locked EventBase collections) from API failures.
  - Privacy: this opt-in call sends story/query text to the configured endpoint. The bearer key is stored in extension settings, not SillyTavern's server secret store, and may appear in settings exports. Request credentials are omitted and redirects rejected; error diagnostics exclude provider response bodies, endpoint URLs and keys. Automated client, pipeline and Agent Mode regressions pass. The corrected client was also verified against local llama-server with a bare base URL, and CORS preflight passed. The saved full `/rerank` workaround persisted after browser reload; the in-app browser blocked direct access to the reranker port, so full browser generation remains a manual check.
- Diversity selection beyond existing deduplication and per-query coverage remains a proposal.
- An LLM "memory brief" only if Phase 0 shows events being injected and still ignored. It adds a call that writes several hundred tokens every turn and can drop or distort facts, and it cannot recover anything retrieval never found.

## Verification

- **Regression case:** dry-run the original message, without the words "LLC formation". After Phase 2 the filing must appear in Brennan's history block, and the Phase 0b line must not list him.
- **Before Phase 3:** confirm how the Similharity plugin matches `characters_any`. Its source is not in this repo. Run a filtered query on "Brennan" and on "Howard Brennan" and compare the counts with the roster. Phase 2 no longer depends on this.
- **Unit tests** (vitest, `tests/`):
  - Alias grouping, including the shared-surname case.
  - Lead share computed across an alias group ("Kai" plus "Kai Tanaka"), and an event listing both spellings counted once.
  - Chat view as the union across locked collections.
  - Sticky detection over the lookback, and the planner signal union.
  - Smallest-first budget allocation and spine selection.
  - Filter stripping and alias expansion; the hybrid-path guard.
  - Per-query coverage at the trim.

## Risks and open questions

- **Shared surnames** can produce wrong alias merges. The unique-match rule and the review list are the guard.
- **Non-space-delimited scripts.** The token-subset rule does not transfer to CJK names; automatic grouping should be limited to space-delimited names until a rule for those is designed.
- **Role and pronoun references.** The text matcher cannot see "the lawyer". Stickiness covers a character once named, and the planner signal covers some of the rest. A character never named inside the lookback, with Agent Mode off, is still missed.
- **Scene changes.** Stickiness is a message count only. A character from a scene that ended 10 messages ago still takes budget until they age out or are displaced by the cap. Scene-change detection is not attempted in the first version.
- **"In play" means mentioned, not necessarily present.** A character being discussed in their absence gets a history block too. That is probably desirable, and the cap and budget bound it.
- **Where alias overrides are stored.** Per collection is the proposal, with the chat using the union of overrides from its locked collections. Per chat would lose them on a branch.
- **Index staleness.** Events edited or deleted outside the hooked paths would leave the in-memory index out of date until the next session. Every write path needs the hook.
- **`listChunks` paging.** The existing call asks for 10000 in one request; the index build should page.
- **Prompt cost.** The cast block adds up to its budget on every turn a minor character is in play. Chronological order keeps it stable between turns.

## Changes in revision 2

From the co-author review:

- Lead share is computed over alias groups, with distinct-event counting.
- Cast detection is sticky over a long lookback, and the planner's `characters_any` is a second signal.
- Over-budget selection is a history spine, with the rich-character limitation stated.
- A hybrid-path guard is added to Phase 3; the silent filter no-op is an existing bug for Agent Mode.
- Phase 0 gains the "in play with zero events injected" line.
- The roster is keyed by collection and unioned across locks.
- `{{knownCharacters}}` renders grouped; the assembly-order constraint is stated; a shared budget is added to Phase 4.

Consequence of the spine, not in the review: the cast lane reads from an in-memory event index in place of a filtered query. That makes the parallel-fetch and per-character-cap points moot for this lane, and resolves a conflict between running the fetch in parallel and using the planner's output as a detection signal.
