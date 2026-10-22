# Phase 4A implementation notes

Implemented foundation: backend-qualified stable subject registries, canonical pair
keys, explicit scope/evidence contracts, reviewed alias migration, audited reference
remapping, conservative card migration and identity-change queued-write rejection.

## Using roster review

The existing character roster review now includes **Preview stable subject
identities** and **Confirm and apply identities**. The initial continuity boundary is
one backend-qualified collection; locking two collections does not merge their
subjects. Exact stored aliases suggest existing IDs. Display names are not IDs.
Ambiguous groups require confirmation. Merges offer an explicit survivor selector.
Splits retire the prior ID and leave its references unverified, without duplicating
facts. The host-free reassignment API requires explicit reference ownership and
does not claim that assigning a subject verifies its evidence.

Use the existing alias controls to rename, merge or split groups, then preview and
apply identity changes. Registry revisions reject stale identity previews. Hidden
subjects are retained, not deleted. Audit and reference data live in extension
settings, outside the disposable NPC-card cache.

## Scope safety and limitations

`resolveContinuityScope` includes backend namespace, locked collections, chat/branch,
explicit source-frame mappings, horizons and revisions. Evidence eligibility rejects
legacy sources, unknown positions, future positions and unmapped siblings. Sibling
evidence requires both an explicit frame/horizon and user-declared continuity.
Declaration alone never makes unrelated message coordinates comparable.

The roster review exposes a backend-qualified per-collection declaration and labels
it **user-declared continuity**, not verified. There is deliberately no automatic
host mapping derived from chat length or vectorization tips. Historical retrieval
and existing historical NPC-card rendering retain their previous behavior. Future
Phase 4B synthesis/injection must use this scope contract and recheck scope after
awaits and before persistence/injection. This increment does **not** ship current
relationship synthesis or assert that existing historical output is branch-safe state.

Legacy card migration stores a version-3 recovery envelope under a subject key and
retains the complete original card. Generated facts are reused only when exact
subject binding is confirmed, source scope is eligible and existing evidence digests
match. The review UI has no verified source mapping, so its migrations conservatively
require rebuilding generated content. Repeating migration cannot overwrite later
destination edits. Recovery envelopes survive generated-card reset and cache limits;
they are not yet consumed by the historical version-2 renderer.

Existing collection export/import does not yet package the settings-owned registry
or migration envelopes. Portable Phase 4 state is therefore **not claimed**. The
versioned 4B authored-card editor, conflict UI, scoped pair-state scheduling and
budgeted injection remain separate work. The pre-existing session-local roster cache
still strips backend prefixes; durable identity does not use that cache key as its
namespace or accept it as evidence of cross-backend source provenance.

## Validation

Fixtures cover rename/pair stability, distinct similar names, merge confirmation and
survivor selection, split invalidation and reassignment, stale previews, exact alias
ownership, scope changes, future/sibling exclusion, declared-continuity labelling,
card recovery/idempotency and in-flight identity invalidation. No model calls or
backend event mutations are required for identity review or migration.

Validation run: `npm test` — 77 files, 1,566 tests passed. Live SillyTavern UI and
real-backend verification were not run in this workspace.