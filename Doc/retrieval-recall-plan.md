# EventBase recall plan

Status: Phase 0a and Phase 1 implemented; later phases remain proposals. Revision 2, 2026-10-02 (incorporates co-author review; changes listed at the end).

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

### Phase 3: Planner and pool fixes

In rough order of effort:

1. **Hybrid-path guard.** Planner filters are dropped with only a lifecycle-log warning when `hybrid_native_prefer` is false and the EventBase keyword method is `bm25` ([core-vector-api.js:1141](../core/core-vector-api.js)), and Agent Mode's gate only checks for the Qdrant backend. Add one shared check for "filters will reach the backend"; when it fails, warn visibly once and stop emitting filters.
2. **Filter hygiene.** In `_validatePlannerFilters` ([agentic-retrieval.js:480](../core/agentic-retrieval.js)), strip lead alias groups from `characters_any` and expand the rest to all aliases. If nothing is left, send no character filter.
3. **Soft importance floor.** Stop sending `importance_gte` as a hard filter; importance already lowers the score in the re-rank. Keep a setting to restore the old behavior.
4. **Overfetch setting.** Replace the three `top_k * 2` sites with one helper and a setting (proposed `eventbase_retrieval_overfetch`, default 40).
5. **Full pool into the merge.** `retrieveEvents` also returns its post-dedup, pre-trim candidates; stage 5 merges those. The planner still sees only the top slice.
6. **Per-query coverage.** Tag agentic hits with their query index. At the trim, take the best surviving hit from each planner query first, then fill by score.
7. **Per-query filters.** Change the planner schema so each query carries its own character list, accepting the old string form too. Last because it touches the planner prompt in all six language variants.

### Phase 4: Later

- **A shared EventBase token budget.** The main block is deliberately unbounded today ([eventbase-injection.js](../core/eventbase-injection.js): "no hard character budget"), and the cast block adds up to 700 tokens on top. A single budget with a compact tier for lower-ranked main events would cover both.
- LLM-written per-NPC cards, refreshed when that character gets new events. These supersede the spine for characters with long histories.
- Story-day rollup records, stored as additional entries that link to their source events. Events are never replaced.
- A cross-encoder reranker and diversity selection over the wider pool.
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
