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