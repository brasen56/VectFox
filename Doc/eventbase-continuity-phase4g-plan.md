# EventBase continuity: Phase 4G implementation plan

**Status:** Draft for co-author review, 2026-11-07. This is a requirements plan,
not a claim that the four work packages have been implemented.

**Source:** [Phase 4G thread tracker, revision 2](eventbase-continuity-phase4g-thread-tracker.md).
This companion reorganizes that draft by delivery phase. The tracker retains the
design rationale, measured baseline and prerequisite-fix history. Open decisions
below remain open; this plan does not silently settle them or expand the scope.

## 1. Outcome and delivery order

Give users a source-linked view of unresolved story threads, then add deliberate
closure actions, reviewed resolution suggestions and, behind a separate gate,
user-pinned prompt exposure.

| Phase | User-facing outcome | Depends on | Delivery boundary |
|---|---|---|---|
| **4G-1 — View** | See remaining threads and audit closed ones. | Shipped Phase 1–3 closure resolver and roster index. | Read-only; no model calls, writes or pins. |
| **4G-2 — Act** | Mark, unmark, remove resolution links and address wrong self-closures. | 4G-1 and the existing manual-write APIs, including the already-fixed merge defect. | Explicit user actions through continuity metadata only. |
| **4G-3 — Suggest** | Ask the repair judge for a resolution proposal for one event. | 4G-1 and the existing repair pipeline. | One event, one judge batch, review before apply. |
| **4G-4 — Pin (gated)** | Keep user-selected threads in an explicitly chosen prompt path. | 4G-1, a reviewed mechanism choice and an agreed storage contract. | No automatic pins; stay inside existing prompt budgets. |

Recommended sequence: **4G-1 → 4G-2**, then evaluate **4G-3** and **4G-4**
independently. Neither 4G-3 nor 4G-4 requires the other; the tracker lists 4G-1,
not 4G-2, as their panel dependency. Phase 4G does not depend on Phases 4C–4F.

## 2. Rules shared by every phase

- **One closure authority:** use `getContinuityView` and the existing
  `continuity` namespace. Do not invent a second definition of open or closed.
- **Preserve the archive:** never rewrite historical summaries, embeddings,
  importance or original `open_threads` to express closure. Closure changes live
  in continuity links and marks.
- **Make scope explicit:** enumerate selected collections and label mixed-scope
  rows. Do not merge cross-chat, alternate-branch or cross-collection threads.
- **State the limits:** the panel reports stored archive threads, not every
  unresolved matter in the story. Extraction gaps are invisible; incorrect
  stored closures require the closed-thread audit view to notice.
- **Keep research separate:** Ask the Story interprets sampled evidence; it is
  not the exhaustive thread-status view.

## 3. 4G-1 — Read-only Open Threads panel

### Purpose and dependencies

Deliver the first usable slice: a deterministic, source-linked list with
staleness, filters and a closed-thread audit view. Build on the existing resolver
and metadata roster, not the repair engine's collection-loading path.

### Requirements

1. **Entry point and window.** Add an **Open Threads** action beside the existing
   extension actions. Follow the Ask the Story/repair window pattern, with its
   own CSS, cancellable loads and a window rather than a popup for long lists.
2. **Exact enumeration.** Include an `(event_id, index)` only when the event has
   `open_threads[index]`, is not an active duplicate, and `getContinuityView`
   reports that index as remaining. Use `openThreadIndices` plus the duplicate
   guard. Reuse the repair enumeration predicate with `scope: 'all'`, without
   its default interpersonal/importance restriction. Partially closed events
   remain listed with only their remaining indices.
3. **Row contents and citations.** Group rows by event. Show thread text, origin
   event summary, importance, `event_type`, cast, locations, keywords and sibling
   thread resolution status. Cite the collection/event and deep-link to its
   existing database-browser event view.
4. **Staleness and ordering.** Prefer story time through
   `plausibleStoryTimeRange`/`storyTimeMs`; fall back to `source_window_end`, then
   ingestion time. Label message-position estimates approximate: positions are
   not globally comparable across sibling or slimmed chat files. Staleness is
   the age of the event stating the thread, not a separately tracked last mention.
   Sort oldest first using `compareChronology`, with importance descending for
   ties; undated events use position ordering with the approximate label.
5. **Filters and scope.** Filter client-side by cast group using roster aliases,
   importance threshold and collection scope. Open on the current chat's active
   EventBase collection via `resolveActiveEventBaseCollection`; allow selected
   additional event collections as Ask the Story does. Label each mixed-scope
   row's collection. Copies across collections remain separate unless marked
   duplicate through existing machinery.
6. **Summary and refresh.** Show N remaining threads across M events, selected
   scope and computation time, explicitly described as archive-derived. Enumerate
   on open and manual refresh only; no background watching in 4G-1. Drop pending
   renders when scope changes or the panel closes.
7. **Metadata-only loading.** Read `ensureCharacterIndex`. A warm active-collection
   roster must require no backend request. An added, unlocked collection costs
   one paged `listChunks` metadata scan. Build resolver input once per load with
   an `events` array, `eventById` map and `resolvedBy`; do not pass the roster's
   event map directly for every verdict.
8. **Loading and rendering bounds.** Apply the Ask the Story metadata-scan
   ceilings of 10,000 records and 20 collections to multi-collection expansion.
   Render incrementally through pagination or virtualization. The tracker's
   reference baseline is 1,142 remaining threads on 927 events, not a default or
   an acceptance fixture.
9. **Closed-thread audit.** Provide an off-by-default toggle showing closed
   threads, resolution origin, resolving-event summary and `how` note from the
   same resolver result. Surface digest-invalidated links as open with their
   inactive-link reason. This view is read-only; link removal remains in the
   database browser until 4G-2.
10. **Strict read-only boundary.** No closure controls, pins, settings mutation,
    generation, embedding, retrieval/ranking calls, vector requests or new public
    event API surface. Import nothing from `core/continuity-repair-service.js`.
    Do not load through `createContinuityRepair` (vector export) or
    `continuityCollection` (write closure and metadata-write capability gate).

### Completion checks

- Every remaining/closed verdict matches `getContinuityView`, including partial
  closures and invalidated digests.
- Opening against a warm active roster makes no backend request; opening,
  filtering, refreshing and closing cannot reach a write or model-call path.
- Chronology, approximate undated ordering, filters, citations, scope labels and
  cancellation behave as specified above.
- The summary and audit view make both archive incompleteness and stored closure
  verdicts visible without claiming whole-story coverage.

**Not in this phase:** actions, pins, semantic copy grouping or public API work.
Copy grouping is optional later polish; semantic grouping would violate 4G-1's
no-embedding boundary. If grouping is added later, group staleness uses the newest
member, not the oldest.

**Source coverage:** tracker §§2–4, 8–10.

## 4. 4G-2 — Manual closure and reopening controls

### Purpose and dependencies

Add explicit actions on top of 4G-1. Reuse `markEventResolved`,
`unmarkEventResolved` and `removeResolutionLink` in
`core/continuity-repair-service.js`, following the database-browser controls.

### Requirements

1. **Mark resolved.** Allow all or selected threads on an event to be marked
   resolved, with an optional outcome note. Successive partial user marks must
   accumulate rather than replace earlier marks.
2. **Unmark.** Support removal of user-origin marks under the existing rules.
   The current API removes the whole user closure, not one selected thread.
   Only user-origin closures are eligible for **Unmark**; do not silently apply
   that action to extraction/repair closures.
3. **Remove links.** Allow individual resolution links to be removed using the
   existing API. Distinguish a `resolves` link stored on another event from a
   self-closure stored in the event's own `closed_threads`.
4. **Address self-closure reopening.** Provide a per-event way to correct a wrong
   extraction/repair self-closure, including one retained beneath a user mark.
   The exact control/write contract must be settled before completing this
   phase; link removal alone does not cover it. Do not rely on the old partial-
   mark defect or require whole-run undo as the only correction path.
5. **Preserve closure provenance.** Keep displaced repair/extraction closures in
   `user_previous_closure`, separately validated, rather than copying their
   indices into a user mark. Unmark restores the prior closure; repair-run undo
   reopens only that run's threads while leaving user marks closed. Inactive or
   digest-mismatched closures contribute no indices.
6. **Write and refresh boundary.** Use the existing digest-checked continuity
   write path and metadata PATCH pattern. Re-render affected rows from a fresh
   `getContinuityView` after an action. Add no generation, embedding or vector
   export calls, and change no archive fields.

### Decisions to settle in this phase

- Whether to add per-thread unmarking beyond the current whole-user-closure API.
 - Per-thread unmarking — yes, add it in 4G-2 rather than deferring
- The precise self-closure reopening contract. The tracker's proposed option is
  a digest-checked **Reopen** action removing the self-closure, or the
  `user_previous_closure` beneath a user mark, through the same write mechanism.
  This is a proposal, not an already-agreed API.
   - Self-closure reopening — adopt the tracker's proposed digest-checked per-event Reopen, at whole-closure granularity, and don't attempt per-thread reopen.

### Completion checks

- Marking a remaining thread removes it without reopening its siblings; unmark
  restores the appropriate prior state. Summary, embeddings and `open_threads`
  remain unchanged.
- Two successive partial marks retain both sets of user-closed indices.
- A user mark over a repair/extraction self-closure preserves that closure;
  unmark restores it, and repair-run undo preserves the user's own marks.
- Inactive/digest-invalid prior closures close nothing. Database-browser controls
  and panel controls give the same results through the shared functions.
- The agreed reopening control corrects a self-closure through continuity
  metadata, rather than pretending that removing an external link covers it.

### Already-completed prerequisite, not new 4G work

Tracker §5.1 records the manual-mark merge fix as implemented ahead of 4G-1,
with unit tests in `tests/continuity-repair-service.test.js`,
`tests/continuity.test.js` and `tests/continuity-repair.test.js`. It preserves
accumulating user marks and displaced closure provenance without a schema/version
change. The newest `how` note wins; per-thread notes are out of scope. The tracker
does not claim a manual browser check of those controls. Preserve these regression
guarantees rather than scheduling the fix again.

**Source coverage:** tracker §§2, 5–5.1, 8–9.

## 5. 4G-3 — Reviewed resolution suggestion for one event

### Purpose and dependencies

Let a user investigate possible closure for a selected event without launching a
bulk repair. Depends on 4G-1 and the existing `core/continuity-repair.js` pipeline.

### Requirements

1. Add **Suggest resolution** on an event; judge only that event's conflicts.
2. Reuse the existing judge, JSON contract and `REPAIR_LOOKAHEAD` bounds of
   7 story days / 300 messages.
3. Run one judge batch per explicit action: one event, one batch. No bulk
   **Suggest all** in this package.
4. Use the shared generation rate limiter, paid-call accounting and existing
   repair failure accounting, including `REPAIR_MAX_BATCH_FAILURES`.
5. Present proposals through the existing review flow. Apply nothing without
   user review; do not create a second closure or proposal-application system.

### Completion checks

- The selected action is restricted to one event's conflicts and one batch with
  the existing look-ahead and accounting behavior.
- Proposals reach the established review flow; no automatic apply occurs.

**Source coverage:** tracker §§1–2, 5, 8–9.

## 6. 4G-4 — User-pinned threads (review-gated)

### Purpose and dependencies

Keep user-chosen threads visible to an explicitly selected model path. Depends
on 4G-1, a mechanism decision and a storage contract. Do not treat visibility in
the panel, extraction awareness and roleplay-model revival as the same outcome.

### Requirements common to either mechanism

1. Pins are explicit user decisions: no automatic, LLM-chosen or retrieval-score
   pinning.
2. Identify a pin with `(collection, event_id, indices, threads_digest)`.
   Detect event/thread changes through the digest and surface mismatches as
   stale rather than silently keeping them active.
3. Auto-clear a pin when its pinned indices close. Revalidate against the same
   closure authority used by the panel.
4. Bound pin count and token consumption. A cap of **3** is suggested in the
   tracker, not yet a settled requirement. Do not add capacity outside the
   existing prompt budget.

### Mechanism gate — review must choose what ships

| Candidate | Required behavior if chosen | Actual effect |
|---|---|---|
| **Extraction-side** | Always include pinned threads in `selectOpenIssues`, bypassing the scene-cast filter and normal count cap (default 6), but staying inside the approximately 600-token budget. No new calls. | Keeps threads visible to the extractor so it can emit closure links; does **not** remind the roleplay model. |
| **Generation-side** | Force pinned events into the EventBase injection lane regardless of relevance score, reserving capacity inside its existing token budget. | Makes the roleplay model see the thread next turn: the literal revival path. Reserved tokens are consumed while pins remain active. |

These mechanisms can compose, but the tracker defers the choice to review. Ship
the reviewed choice, with the other eligible for follow-up; do not assume both
are required for the first 4G-4 increment.

### Decisions required before implementation is complete

- Pin storage: extension settings or per-chat metadata keyed by chat UUID.
- Which prompt-side mechanism ships first; if generation-side, its reservation
  size and budget behavior.
- Whether pins survive collection switches.
- Final pin-count cap.
- Optional badge placement, only if the badge is included.

### Completion checks

- Closed pinned indices disappear from the pin list; changed-event digest
  mismatches are shown as stale.
- The reviewed storage, collection-switch and prompt-budget contracts are met.
- The chosen mechanism delivers its stated effect without implying that
  extraction-only pins revive a thread for the roleplay model.

**Optional companion:** an open-thread-count badge following the floating token
badge pattern. It is not a prerequisite or a gate for pins.

**Source coverage:** tracker §§1–2, 7–9.

## 7. Separate optional work and exclusions

- **Ask the Story chip:** optionally prefill an outstanding-obligations question
  using the existing workflow and `story-research.js` thread bias. Label it
  sampled research, never exhaustive status. It has no 4G dependency and is not
  required by any of the four packages.
- **Interpretive questions** such as why someone owes a debt stay in Ask the
  Story, with citations; deterministic enumeration stays in the panel.
- **Deferred/separate:** copy grouping, new public event API exposure,
  cross-chat/branch merging, automatic pins and rewriting archive content.

## 8. Review and handoff checklist

- [X] Agree on 4G-1 as the first independently reviewable, read-only increment.
- [ ] Review 4G-1 against its enumeration, audit, loading and cancellation checks.
- [ ] Settle 4G-2's self-closure reopening and optional per-thread unmark contract.
- [ ] Review 4G-2 controls against the already-fixed merge/undo regressions.
- [ ] Decide whether to proceed with the independently scoped 4G-3 judge action.
- [ ] Resolve the 4G-4 mechanism/storage/budget gate before shipping pins.
- [ ] Keep optional chips, badges and copy grouping out of mandatory phase gates.

For background evidence rather than implementation requirements, retain the
original tracker's §2.1 census, §5.1 defect history and §6 research rationale.