# EventBase continuity: Phase 4G — Open Threads panel and thread revival

**Status:** Draft for review, revision 2, 2026-11-07. Nothing in this document is
an implementation claim. Cost figures for existing paths are quoted from shipped
code and earlier phase documents; projections are marked as such.
Revision 2 adds a measured baseline from the reference collection (§2.1), a
defect in the manual-mark write path, now fixed ahead of 4G (§5.1), and ties
4G-1 to the metadata-only roster load (§3).
**Parent scope:** [eventbase-continuity-scope.md](eventbase-continuity-scope.md),
Phase 4 program (4A–4F). 4G extends that program and depends only on the shipped
Phase 1–3 resolution-link implementation; it does not depend on 4C–4F.
**Design background:** [eventbase-continuity-design.md](eventbase-continuity-design.md)
§§3–5 (closure authority, resolution links, digests); [ask-the-story.md](ask-the-story.md)
(research bounds that motivate the division of labor in §6).

## 1. Goal and boundaries

Long-running stories accumulate unresolved questions, promises and debts in the
event archive, and closure machinery (extraction links, repair runs, manual
marks) resolves them. Nothing shows the user which threads are still open. The
model may revisit a thread only if it wins a relevance slot or falls inside the
recent-N recap; the user has no view at all, so old threads are forgotten by
accident rather than by decision.

4G gives the user a source-linked view of remaining threads, staged actions on
them, and — behind its own gate — an explicit "revive this thread" path into the
prompt. Derived continuity only: never rewrite archive fields or embedding text.

### Included

| Work package | Deliverable | Dependency |
|---|---|---|
| 4G-1 | Read-only Open Threads panel: deterministic enumeration of remaining threads with staleness, importance, cast and citations | Existing closure resolver (`getContinuityView`); no other dependency |
| 4G-2 | Manual closure actions inside the panel (mark resolved, unmark, remove link) | 4G-1; existing write APIs in `core/continuity-repair-service.js`, including the merge fix (§5.1) |
| 4G-3 | Per-thread resolution suggestion: run the existing repair judge for one selected event's conflicts | 4G-1; existing repair pipeline (`core/continuity-repair.js`) |
| 4G-4 (gated) | Pinned threads: user-designated threads kept in front of the model; optional thread-count badge | 4G-1; mechanism decision in §7; storage contract |
| Optional | Ask the Story canned question chip ("outstanding obligations") | Existing Ask workflow only; no 4G dependency |

Independently reviewable increments. Recommended order: 4G-1 → 4G-2, then
evaluate 4G-3 and 4G-4. 4G-1 is the first implementation slice and adds no
writes, no generation calls and no new public API surface.

### Not included

- A second closure system. All closure verdicts, including the panel's actions,
  flow through the `continuity` namespace and `getContinuityView` validation.
- Rewriting historical summaries, embeddings, importance or original
  `open_threads`. Closure continues to live in links and marks only.
- Thread enumeration through Ask the Story question mode (§6). Research answers
  stay interpretive; status stays deterministic.
- Automatic pinning, LLM-chosen pins, or pins derived from retrieval scores.
  Pins are user decisions in 4G-4.
- Cross-chat or alternate-branch thread merging. The panel enumerates the
  collections the user selected, and says so.
- A new public event API mode in 4G-1. The panel reads through internal
  services, as the repair window does; API exposure is a separate decision.

## 2. Existing implementation to build on

Repository observations as of this draft, not new requirements:

| Area | Current foundation | 4G change |
|---|---|---|
| Closure authority | `getContinuityView` (core/continuity.js) validates active links and digests and yields `remainingThreads`/`closedThreads`/`fullyResolved` across extraction, repair and user origins. | Use this resolver for enumeration; add no parallel notion of "open". |
| Enumeration | `repairScope` (core/continuity-repair.js) already filters events to those with remaining threads, excluding active duplicates, with character/importance/position filters. | Reuse the predicate with `scope: 'all'`; drop the interpersonal/importance default filter for the panel's unfiltered view. |
| Manual closure | `markEventResolved`/`unmarkEventResolved`/`removeResolutionLink` (core/continuity-repair-service.js) write digest-checked `closed_threads` with `origin: 'user'`. Successive marks accumulate. A displaced extraction or repair closure is kept in `user_previous_closure` and stays in force under the mark (§5.1). There is no control that reopens an extraction or repair self-closure on its own; only undoing its whole run does. | 4G-2 calls these as they are now. A per-closure reopen is an open item for 4G-2 (§5). |
| Auto-closure | The repair window's judge scans conflicts with a look-ahead of 7 story days / 300 messages (`REPAIR_LOOKAHEAD`) and applies reviewed links. | 4G-3 narrows the run to one event's conflicts; same judge, same review gate. |
| Prompt paths | `{{openIssues}}` (≤ `eventbase_open_issues_max`, default 6; ~600-token budget; scene-cast filtered) is substituted into the **extraction** prompt so the extractor can emit `resolves` links. Remaining threads reach the roleplay prompt only via retrieval ranking (resolved events downranked) and the summarizer's recent-N recap (`open_threads_at_the_time`). | 4G-4 adds an explicit user-pinned path; §7 decides which prompt side. |
| Windows | Action buttons in the extensions panel open windows (`openAskStoryPanel`, `openContinuityRepair`, `ui-manager.js`); the repair window loads and indexes full collections (`continuityIndex`). | 4G-1 follows the same action-button + window pattern, but loads through the roster index, not the repair engine (§3 Bounds). |
| Roster index | `ensureCharacterIndex` (core/character-roster.js) holds slim event metadata including `open_threads`, `continuity` and a prebuilt `resolvedBy`. `warmCharacterRoster` builds it for every locked collection at startup and on each chat change. | 4G-1 reads this index; for the active collection it is already in memory. |
| Thread-aware research | `core/story-research.js` already biases questions matching unresolved/outstanding/thread wording toward remaining thread state inside Ask the Story's bounded research. | Optional canned chip reuses this; no new research mode. |

### 2.1 Measured baseline (reference collection, 2026-11-07)

Read-only measurement of the reference Qdrant collection
(`vf_eventbase_qdrant_alex_hiro_assistant_769776cf-…`), after the repair runs.
Payloads were exported without vectors. Each record was rebuilt the way
`slimEvent` builds it, so `threadsDigest` matches, and then classified with the
shipped `getContinuityView`, `isActiveDuplicate` and `openThreadIndices`. These
are observations about one long story, not defaults.

| Measure | Value |
|---|---|
| Events / events carrying `open_threads` / threads | 6,039 / 5,154 / 10,134 |
| Threads on active duplicates (excluded) | 381 on 180 events |
| Closed threads | 8,611. Resolutions by origin: repair 10,523, extraction 8, user 5. No inactive links. |
| **Remaining threads (panel rows)** | **1,142 on 927 events** |
| Remaining, importance ≥ 6 / ≥ 8 | 739 / 278 |
| Remaining under the repair default filter (interpersonal, importance ≥ 6) | 353 on 310 events |
| Remaining, by age before the latest story date | ≤ 7 days 222 · 8–30 days 145 · 31–60 days 342 · > 60 days 421 · undated 12 |

What this means for 4G:

- **Volume is panel-sized.** The October census figure (9,649 threads, none
  closed; [scope](eventbase-continuity-scope.md)) predates repair. After repair
  the unfiltered list is about a thousand rows. Paging and the importance
  filter are enough; no new reduction mechanism is required for 4G-1.
- **The list is mostly what 4G exists to show.** 763 of 1,142 remaining threads
  (67%) come from events more than 30 story days older than the latest event.
- **Copies are rare.** A thread has no identity across events, so the same open
  question restated by an overlapping window is a second row. This was measured
  by embedding every remaining thread with the collection's own embedding model
  (local bge-m3) and comparing each one with the other remaining threads that
  share a character. Sampled pairs were then judged by hand:
  - At cosine ≥ 0.9, 12 of 12 sampled pairs were true copies. 88 threads have
    a neighbour this close, and for 61 of them the neighbour is on the same
    story day.
  - At 0.85–0.9, about 2 of 12 were true copies. The rest were similar phrasing
    about different matters.
  - Collapsing at ≥ 0.9 shortens the list from 1,142 to 1,094 rows.
  - Normalized-text matching alone, which needs no embeddings, removes about 20
    rows.
  - Word-overlap (Jaccard) grouping is unusable here. It merges threads by
    stock phrasing ("How will this affect their relationship going forward?"),
    not by subject.

  Copy grouping is therefore optional polish and stays out of 4G-1. Semantic
  grouping would need embedding requests, which 4G-1 excludes.
- **The panel inherits repair's verdicts.** 85% of threads are closed, almost
  all by repair. The accuracy of those closures was not sampled. An
  over-eager closure removes a thread from the panel, which is the
  silent-death failure 4G is meant to expose. See the closed-thread audit view
  in §4.
- **The manual-mark defect affected a third of the listed events.** 293 of the
  927 listed events (32%) carry a partial repair self-closure. Before the §5.1
  fix, marking any remaining thread on one of them reopened that event's
  repair-closed threads: 316 threads in total.

## 3. Enumeration semantics (4G-1)

A thread is a member of `(event_id, index)` pairs where the event has
`open_threads[index]`, is not an active duplicate, and `getContinuityView`
reports the index as remaining. This is exactly `openThreadIndices` plus the
duplicate guard; the panel's list is a rendering of that set, never a re-derivation.

Each listed thread shows:

- Thread text and the origin event's summary, importance, `event_type`, cast,
  locations and keywords (already on the event record).
- A citation into the collection and event, deep-linking to the existing
  database-browser event view where the continuity controls already render.
- **Staleness**, computed from what the event reliably carries: story time via
  `plausibleStoryTimeRange`/`storyTimeMs` when dated; `source_window_end`
  position otherwise; ingestion time as a last resort. Message positions are
  not globally comparable across sibling or slimmed chat files in one
  collection (see the note on `selectOpenIssues`), so story time is the primary
  ordering and message position is presented as approximate. Staleness is the
  age of the event that states the thread. That is a fair proxy only because
  restated copies are rare (§2.1). If copy grouping is added later, a group's
  staleness is that of its newest member, not its oldest.
- Resolution status of sibling threads on the same event (partially closed
  events remain listed with only their remaining indices).

Default ordering: oldest first by story chronology (`compareChronology`),
tie-broken by importance descending. Filters: by cast group (roster aliases),
by importance threshold, by collection scope. Sorting and filtering are
client-side over the indexed collection; no retrieval, ranking or generation
calls are made.

**Scope.** The panel opens on the current chat's active EventBase collection
(`resolveActiveEventBaseCollection`) and may add selected event collections, as
the Ask the Story panel does. Mixed-scope lists label each row's collection.
Cross-collection enumeration does not merge threads: the same underlying story
thread stored in two collections appears twice until duplicates are marked.

**Bounds.** Enumeration is metadata-only. It reads the roster index
(`ensureCharacterIndex`), not the repair engine:

- For the active collection, the index is already warm (§2), so opening the
  panel makes no backend request.
- An added collection that is not locked costs one paged `listChunks` metadata
  scan.
- 4G-1 must not load through `createContinuityRepair`, which exports every
  vector (`fetchChunksWithVectors`) and fails on an incomplete inventory.
- 4G-1 must not load through `continuityCollection` either. It returns a
  `write` closure, and it rejects backends without metadata writes, which a
  read-only view does not need.
- Build the resolver input once per load, in the shape `continuityIndex`
  returns (an `events` array, an `eventById` map and `resolvedBy`). Passing the
  roster's `events` map directly makes `getContinuityView` copy every event and
  scan linearly for each verdict.

The Ask the Story metadata-scan limits (10,000 records, 20 collections) are the
ceiling for any multi-collection expansion. Rendering is incremental
(virtualized or paginated). The measured unfiltered list is about 1,100 rows
(§2.1).

## 4. Panel deliverable (4G-1)

- An action button beside the existing actions ("Open Threads"), opening a
  window following the ask-story/repair window patterns (own CSS, no popup for
  long lists, cancellable loads).
- A summary line: N remaining threads across M events, in the selected scope,
  computed at load; a refresh control re-enumerates. No background watching in
  4G-1 — the list refreshes on open and on demand, and says when it was computed.
- Grouping by event, with per-event remaining-thread rows; per-thread filters
  and ordering as in §3.
- Read-only. No closure controls, no pins, no writes, no generation calls, no
  embedding requests. Closing the panel changes nothing.
- A **closed-thread audit view** (a toggle, off by default) lists closed
  threads with their resolution origin, the resolving event's summary and the
  `how` note, from the same `getContinuityView` result. It is read-only. Since
  repair settles most threads (§2.1), this is how a user notices an over-eager
  closure. Removing a link stays in the database browser until 4G-2.

## 5. Actions (4G-2, 4G-3)

4G-2 adds per-event controls identical to the database-browser continuity
controls: mark all/selected threads resolved with an optional outcome, unmark
(only `origin: 'user'` marks are unmarkable, as today), and removal of
individual resolution links. Writes go through `markEventResolved` and friends,
with the merge fix in §5.1. The panel re-renders the affected rows from a fresh
`getContinuityView`. An extraction-origin or repair-origin closure is visible
and link-removable but not silently unmarkable — same rules as the existing
controls.

**Open item for 4G-2:** reopening a self-closure, i.e. an extraction or repair
closure stored in the event's own `closed_threads`. "Remove link" covers only
`resolves` links stored on other events. Before §5.1, a partial user mark
displaced a self-closure and so reopened it, by accident. That path is gone, so
today the only way to reopen one is to undo its whole repair run. The
closed-thread audit view (§4) will surface wrong self-closures, so 4G-2 needs a
per-event control. One option: "Reopen", which removes that closure (or the
`user_previous_closure` beneath a user mark), digest-checked, through the same
`write`.

4G-3 adds "Suggest resolution" on an event: run the existing repair judge over
that event's conflicts only (same look-ahead, same JSON contract, same paid
-call accounting), then present the proposal in the existing review flow before
anything is applied. One event, one batch; no bulk "suggest all" in this
package.

### 5.1 Prerequisite defect: manual marks replaced instead of merging (fixed)

**Status:** fixed ahead of 4G-1, in `core/continuity-repair-service.js` and
`core/continuity.js`, with unit tests. The defect also affected the
database-browser controls (`ui/continuity-controls.js`), which call the same
function.

**The defect.** `markEventResolved` built a new `closed_threads` from only the
requested indices and overwrote the event's existing one. `getContinuityView`
applied only `closed_threads`; it never read `user_previous_closure`.

- **Earlier user mark lost.** Mark thread 0, then mark thread 2, and the result
  was `closed_threads = {threads: [2], origin: 'user'}`. Thread 0 reopened. The
  displaced closure was user-origin, so it was not kept in
  `user_previous_closure` and nothing could restore it.
- **Repair or extraction self-closure hidden.** Repair self-closed threads 0
  and 1, then the user marked thread 2. The repair closure moved into
  `user_previous_closure`, where it had no effect, so threads 0 and 1 reopened
  until the user pressed Unmark.
- **Unaffected:** closures that come from another event's `resolves` links,
  because they live on the resolver.

In the database browser this was easy to miss, because a user usually marks an
event once, with every thread visible. The panel lists one row per thread, which
makes marking threads one at a time the normal path. On the reference
collection, 32% of the events the panel would list carry a partial repair
self-closure (§2.1).

**The fix as implemented:**

1. **User marks accumulate.** The new `closed_threads.threads` is the union of
   the requested indices and the current user closure's indices. The current
   user closure counts only while it still applies (`status: 'active'`,
   matching `threads_digest`). `'all'` on either side yields `'all'`. `how`
   keeps the newest note; per-thread notes are out of scope.
2. **A user mark never reopens anything.** A displaced extraction or repair
   closure is still saved in `user_previous_closure`, as before. The change is
   that `getContinuityView` now applies it as well, with the same validation
   as any closure: an inactive or digest-mismatched one closes nothing and is
   reported in `inactiveLinks`. As a result:
   - Unmark restores it as the event's closure, unchanged from before.
   - Undoing its repair run deletes it, as `undoOperation` already did. That
     reopens exactly that run's threads and leaves the user's own marks closed.
3. **Why repair's indices are not merged into the user closure.** The first
   draft of this contract (earlier in revision 2) copied them in. Undo by run
   would then no longer reopen those threads, because they would carry
   `origin: 'user'`. Keeping the two closures separate preserves both the
   origin of every verdict and per-run undo.
4. **Unchanged:** `unmarkEventResolved` still removes the whole user closure.
   4G-2 decides whether to add a per-thread form. Reopening a self-closure is a
   separate open item (§5).
5. **No schema or version change.** On the reference collection, all five
   stored user marks are `'all'`, so no stored verdict changes. One visible
   effect: where a mark sits over a displaced closure, the event's rendered
   resolution now also includes that closure's `how` note.

## 6. Ask the Story: division of labor

Ask the Story is bounded sampling research (≤200 candidates, ≤40 evidence
records, ≤20 claims, one answer call). Used as the thread tracker it can
silently miss threads — a missing result means no evidence was found, not that
none exists — and it would spend an LLM call paraphrasing closure status that
`getContinuityView` already knows exactly.

- **Enumeration and status: deterministic panel.** The panel is the authority
  for "what is still open".
- **Interpretation: Ask the Story.** "Why does Leon owe Aria?", "what has
  happened with the gauntlet since?" stay research questions with citations.
- The optional canned chip prefills an outstanding-obligations question and
  relies on the existing thread bias in `story-research.js`. It is a
  convenience, clearly labeled as sampled research, never the tracker.

## 7. Pinned threads (4G-4, gated)

4G-1–4G-3 make state visible and closable; nothing yet revives a thread the
user wants back in play. A pin is the user's explicit decision, stored as
`(collection, event_id, indices, threads_digest)` so a stale pin is detectable
when the event or its threads change; a pin auto-clears when its indices close.
Two candidate mechanisms, decision deferred to review:

1. **Extraction-side:** pinned threads are always included in the
   `selectOpenIssues` lines, bypassing the scene-cast filter and the cap
   (default 6) but still inside the ~600-token budget. Effect: the extractor
   keeps the thread in view and can close it when the story settles it. It does
   not remind the roleplay model.
2. **Generation-side:** pinned events are force-included in the EventBase
   injection lane, reserving capacity inside the existing token budget, not in
   addition to it. Effect: the roleplay model sees the thread next turn
   regardless of relevance scores. This is the literal "bring it back up".

These compose: pin-to-extraction is cheap and safe; pin-to-generation changes
prompt composition and needs the budget reservation settled first. 4G-4 ships
whichever the review picks, with the other as a follow-up; both share the pin
storage contract and staleness rules. An optional badge (open-thread count,
following the floating token badge pattern) is a companion surface, not a gate.

**Open decisions for review:** pin storage location (extension settings vs
per-chat metadata keyed by chat UUID); generation-side budget reservation size;
whether pins survive collection switches; badge placement.

## 8. Costs and limits

- 4G-1–4G-2: no generation, no embeddings, no vector export. For the active
  collection, enumeration reads the roster index already warmed on chat change.
  Added collections cost one metadata scan each. 4G-2's writes are single
  metadata PATCHes, as in the database browser.
- 4G-3: one judge batch per explicit user action, under the shared generation
  rate limiter and the existing repair failure accounting
  (`REPAIR_MAX_BATCH_FAILURES`).
- 4G-4 extraction-side: no new calls; prompt budget already exists.
  Generation-side: projected to consume reserved injection tokens every turn
  while pinned — bounded by the number of pins, itself capped (suggested: 3).
- Enumeration reflects only stored events. Threads never extracted, extraction
  gaps, and sampling windows are invisible to the panel; the summary line says
  the list is derived from the archive, not the whole story.
- Enumeration also reflects closure verdicts as stored. A thread closed in error
  by repair, extraction or a user is absent from the open list and visible only
  in the closed-thread audit view (§4).

## 9. Acceptance checks

- 4G-1 is provably read-only: no write API on any code path it can reach, no
  settings mutation, no generation or embedding requests while open. It imports
  nothing from `core/continuity-repair-service.js` and makes no vector request.
- Opening 4G-1 on the active collection with a warm roster issues no backend
  request.
- Merge fix (§5.1). The first four checks are covered by unit tests in
  `tests/continuity-repair-service.test.js`, `tests/continuity.test.js` and
  `tests/continuity-repair.test.js`:
  - Two successive partial marks leave both sets of threads closed.
  - A mark on an event with an active repair or extraction self-closure keeps
    those threads closed. Unmark restores the original closure.
  - Undoing that repair run reopens only its threads, and the user's marks stay
    closed.
  - An inactive or digest-mismatched prior closure contributes no indices.
  - The database-browser controls show the same results. They call the same
    function; this has not been checked by hand in the browser.
- For every event shown, the panel's remaining/closed verdict matches
  `getContinuityView` for that event, including partially closed events and
  digest-invalidated links (shown as open, with the inactive-link reason).
- A thread marked resolved from the panel disappears from the list, and no
  other thread of that event reappears. Unmarking restores it. Neither action
  changes any archive field of the event
  (`open_threads`, summary, embeddings unchanged; closure only in `continuity`).
- Ordering matches `compareChronology` on dated events; undated events sort by
  position and are labeled approximate.
- Scope switching re-enumerates and labels mixed-scope rows; switching scope or
  closing the panel drops pending renders.
- 4G-3 proposals reach the user through the existing review flow; nothing is
  applied without review; one batch per action.
- 4G-4 pins: a pin whose indices close disappears from the pin list; a pin on a
  changed event (digest mismatch) is surfaced as stale, not silently kept.

## 10. Suggested first slice

4G-1 as specified: action button, window, deterministic enumeration with
staleness and citations, current-chat scope, read-only. It exercises the
enumeration predicate and the staleness computation end-to-end, ships no write
paths, and leaves every action package reviewable on top of a stable view.

The §5.1 merge fix did not depend on 4G-1. It corrected a defect the database
browser already had, so it was implemented first as its own small change,
with its acceptance checks from §9.
