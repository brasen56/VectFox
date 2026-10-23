# Phase 4B implementation notes — 2026-10-22

## Shipped in this increment

- EventBase **NPC cards** browser and roster **Inspect card** actions. Browsing
  reads the existing index; it never calls a model or enables generation.
- Text-only fact/source inspection, legacy read-only states, stable-subject editing,
  Save/Cancel, before/after JSON diff, stale-save rejection, add/correct, pin/unpin,
  suppress/restore and explicitly confirmed authored-fact deletion.
- Version-4 subject cards in the existing card map. Generated history is separate
  from authored facts, protected pins, durable suppression identities and audit.
  Corrections are authored, with empty model-source refs; the audit retains the
  replaced assertion. No event or vector record is edited/deleted by the editor.
- Protected cards survive reset and generated-cache eviction. An in-flight history
  response merges around authored edits; reset, identity changes and evidence
  changes discard stale results. Migrated version-3 envelopes remain recoverable.
- Canonical pair ownership (lexicographically first subject ID), explicit pair
  selection, recency-first bounded evidence plans, pair-specific source digests,
  eligibility checks and one-step provider calls through the existing card queue.
  History consumes its owner's allowance first; pair steps do not add an extra
  per-owner call. Pair scheduling rotates the oldest due pair. Dry-run never queues.
- Opt-in state reserve, initially 350 estimated tokens **total**, inside the shared
  retrieval envelope. Whole facts, canon priority, round-robin pairs, exact omission
  and exclusion diagnostics. Unused reserve returns to history. The cast allocator
  now uses compact-card cost for its fits-whole decision.
- Summarizer is the sole state owner when enabled; retrieval/Agent omit their state
  block. Summarizer-only authored state works from the ready roster without model
  calls, under its separate character cap. If the whole historical summarizer block
  cannot coexist with state, it is omitted rather than truncated.
- Collection exports include a versioned protected-card/subject package; the card
  browser also offers JSON export/import. Exact-scope, nonconflicting cards restore;
  remapped backend/persona/collection packages and local conflicts are retained in
  `eventbase_npc_card_imports` for review, never silently reassigned/overwritten.

## Important release limitations

This is **not full automatic current-state release**. As documented in Phase 4A,
the current host integration does not prove source-frame/branch horizons. Runtime
contexts deliberately provide no inferred frames. Therefore automatic pair evidence
is ineligible and pair model calls/current generated assertions remain gated off.
Authored canon is explicit per-backend/per-collection user input, not evidence of
branch-safe automatic inference. Changing chats does not automatically create a new
authored continuity; do not use one collection's authored canon for divergent stories.

The host-independent synthesis API and tests accept explicit scope frames. Wiring
real, trustworthy host mappings is still necessary before enabling those calls.
The queue must receive a live scope/snapshot reader; chat length is not a substitute.
There is no uncapped pair-generation toggle or manual bypass in the UI.

Further scope items still requiring follow-up:

- Model precision/cost evaluation, 250/350/500 reserve comparison and per-pair
  preflight estimates/actual usage UI before the first live automatic build.
- Fair scheduling between a continuously due historical card and its pair plans.
  A pair's initial bounded selection currently uses one 6,000-estimated-token batch,
  not an incremental four-batch history plan.
- Explicit fact reassignment/ownership reconciliation UI after subject merge/split.
  Affected protected facts are retained and withheld as unverified; they are not
  automatically copied or transferred. Cross-scope imports likewise need review.
- Semantic paraphrase suppression is not promised. Stable exact fact identities are
  suppressed; exact-text reintroductions with changed citations are review items.
- Browser search changes rebuild the view; use Save or Cancel before changing the
  subject/collection filter. Pending/failed-refresh browser indicators and a rich
  merge editor are not yet provided (historical turn diagnostics retain status).
- The inspector's state preview is all subjects in the selected continuity, not
  a claim of exact scene selection. Retrieval dry-run diagnostics show the actual
  scene text/budget. Summarizer state diagnostics are returned from its run function.
- No live SillyTavern, Qdrant/Standard metadata-plugin, native Vectra, group-chat,
  real-model precision or end-to-end export-restoration verification was performed.
  The editor does not require backend annotation writes; metadata-dependent pair
  operations must remain unavailable where source inventory is unsupported.

## Follow-up: story-so-far declaration (2026-10-22)

This makes the §3.1 user-declared continuity fallback work for collections whose
history has no usable source provenance. The motivating collection has 5,771 events:
only 143 carry `source_chat_id`, and the text behind about 5,300 of them is no longer
in any chat file on disk.

- **Control:** roster review has a **Story so far** box with **Declare story so far**,
  **Update to include everything stored now** and **Remove declaration**.
  Declaring records the newest ingestion time (`created_at`, falling back to
  `inserted_at`) among the collection's non-duplicate events. The setting is
  `eventbase_story_so_far`, keyed per backend and collection:
  `{ v: 1, cutoff, eventCount, declaredAt, revision }`.
- **Eligibility:** `continuityEvidenceEligibility` admits any event in that locked
  collection whose ingestion time is at or before the cutoff. These events are
  labelled `user-declared continuity` (`basis: 'story_so_far'`), never `verified`.
  Positions and source chat files are not consulted, because the user asserts the
  whole set precedes now. Locked-collection and backend checks still apply.
- **Later events:** events stored after the cutoff are rejected as
  `after_declared_story_so_far` unless a real per-file frame admits them, and that
  frame wiring is still unbuilt. Events with no ingestion time are rejected as
  `unknown_ingestion_time`. A later rewind or branch can therefore never enter the
  declared set without an explicit **Update**.
- **Invalidation:** the declaration (cutoff and revision) is part of the scope key,
  the editor revision, the queued-work identity and the public API signature.
  Declaring, updating or removing it discards in-flight pair results and rejects
  stale card saves. After removal, generated pair facts that relied on it are
  withheld at injection (`source_or_scope_changed`). Authored canon is unaffected.
- **Portability:** the protected-card package carries the declaration. An
  exact-scope import restores it only when no local declaration exists.
- **Cost:** when relationship state is enabled, the declare confirmation warns that
  pair model calls can start. There is still no per-pair preflight estimate; see
  the limitations above.
- **Dry run on the motivating collection** (read-only): 0 of 5,572 non-duplicate
  events were eligible before declaring. 5,571 were eligible after; the remaining
  one has no ingestion time.

This settles the labelling half of §10 decision 1 for the no-provenance case,
pending co-author review. The host-provenance frame for events stored after the
cutoff is still open.

Validation: `npx vitest run`: 79 files, 1,592 tests passed (7 new, in
`tests/continuity-subjects.test.js` and `tests/npc-card-state.test.js`). The roster
review UI has not been exercised in live SillyTavern.

## Validation

Automated fixtures cover durable edits/suppression/reset, stale saves, source text
safety, authored correction provenance, protected export/import conflicts, pending
refresh reconciliation, source-change rejection, pair ownership, recency selection,
future/sibling/ambiguous scope exclusions, invalid citations, selective invalidation,
tiny/zero/shared budgets, separate summarizer character caps and cast-card allocation.

Final validation: `npm test -- --reporter=dot` — **79 files, 1,585 tests passed**
(19 new tests). `node --check` passed for all changed runtime JavaScript modules;
`git diff --check` reported no whitespace errors (only existing CRLF policy warnings).
Live-model and
collection acceptance gates remain separate; unit tests are not evidence of model
assertion precision or real backend restoration.