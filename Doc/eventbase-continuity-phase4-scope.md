# EventBase continuity: Phase 4 implementation scope

**Status:** Draft for review, revision 2, 2026-10-15. Nothing in this document is an implementation claim. Measured numbers are quoted from the parent scope or from earlier NPC card measurements; new figures, such as the cost in §5, are projections.
**Parent scope:** [eventbase-continuity-scope.md](eventbase-continuity-scope.md), Phase 4.
**Design background:** [eventbase-continuity-design.md](eventbase-continuity-design.md), especially §§3–5, 7.3 and 9.

Revision 2 changes:
- §3.1 states what the branch-eligibility gate means for existing collections, adds a source-chat prerequisite and a user-declared continuity fallback, and defines its terms.
- 4C now has a measurement gate before implementation, like 4D.
- §5 adds a projected cost, says how evidence for current state is selected, and adds a cast-allocator precondition to the state budget.
- The first implementation slice includes a visible editor for existing card facts.
- Each work package has an illustrative example.

## 1. Goal and boundaries

Give long-running stories a source-linked view of what is currently established, without replacing the historical event archive or repeatedly treating an old incident as the present relationship.

Phase 4 extends the Phase 1–3 implementation; it does not restart that work. Resolution links remain authoritative for thread closure, duplicate marks remain distinct from episode membership, and the slice-of-life profile remains opt-in. The Phase 2 live-collection precision/cost checks and Phase 3 real-model fixture measurements remain their own release gates. Fixes discovered during that validation should not require enabling Phase 4.

### Included

| Work package | Deliverable | Dependency |
|---|---|---|
| 4A | Stable subject IDs, alias migration and explicit continuity scope | Foundation for relationship state |
| 4B | Current relationship sections on NPC cards, user canon/pinning and reserved injection capacity | 4A |
| 4C | Evidence-linked episode grouping and atomic episode rendering, only if measurements justify it | Existing resolution links; 4A scope rules; a post-Phase-2 multi-record baseline |
| 4D | Optional exposure cooldown, only if measurements justify it | A post-Phase-2 exposure baseline; 4C episode IDs if 4C ships, otherwise event IDs |
| 4E | Optional continuity-only InlineSummary backfill | Separate source inventory/checkpoint; 4A scope rules for new facts |

These are independently reviewable increments, not one all-or-nothing release. Recommended implementation order: 4A → 4B. Measure before starting 4C, and evaluate 4D after 4C or after deciding against it. The parent scope deferred episodes because resolution links and duplicate marking may already cover the visible symptoms, so 4C has the same kind of measurement gate as 4D. 4E can be developed separately once its source and persistence contracts are settled.

### Not included

- A parallel relationship-state database or general-purpose derived store. Extend NPC cards for state and the event `continuity` namespace for episode annotations.
- Rewriting historical summaries, embeddings, importance or original `open_threads` during state/episode repair.
- Numeric affection/trust scores, automatic personality diagnosis, or treating affection/silence as resolution.
- Automatic full-history re-extraction, collection rebuilds, or permanent duplicate deletion.
- Automatic canon ingestion from character cards/lorebooks. Users explicitly author or copy a constraint in this increment.
- A general project/group-state engine. The first state UI supports relationship pairs; do not block future subject types in the identity contract.
- A promise that every generation model will obey the supplied continuity.

## 2. Existing implementation to build on

These are repository observations as of this draft, not new requirements already shipped:

| Area | Current foundation | Phase 4 change |
|---|---|---|
| Roster and aliases | `core/character-roster.js` builds a session-local index; names and aliases support grouping. Its collection helper strips backend prefixes. | Add durable subject identity; do not use stripped collection IDs alone as cross-backend durable keys. |
| NPC cards | `core/npc-cards.js` stores cited facts in `eventbase_npc_cards`, keys snapshots by collection set/name/aliases, bounds stored cards to 100, and gates facts by evidence digests. | Version and migrate card sections/identity; protect authored facts from cache eviction/reset. |
| Card refresh | Input batches are capped at 6,000 estimated tokens; read plans are capped at four batches; incremental refresh normally waits for five unread events. | Reuse the call caps and scheduling, and add targeted state invalidation and refresh. Do not reuse the history-spine sampling for state input (§5). Do not assume sampled history proves a complete relationship history. |
| Closure | `core/continuity.js` validates active links and evidence digests and produces remaining threads/outcomes. | Use this resolver rather than inventing a second closure system. |
| Budget | `core/eventbase-token-budget.js` shares a default 4,000 estimated-token envelope between topical and cast lanes. | Reserve state capacity inside that envelope, not in addition to it. |
| Summarizer Injection | `core/summarizer-injection.js` has a separate prompt slot and budget path. | Coordinate state ownership and preserve lifecycle rendering in summarizer-only configurations. |
| Chronology | `core/event-chronology.js` supplies ordering; the parent scope documents incompatible source positions across shared/slimmed chats. | Ordering is not proof of branch eligibility. Introduce an explicit eligibility contract before calling synthesized state current. |
| Repair | `core/continuity-repair.js`, `core/continuity-repair-service.js` and the repair UI provide proposals/checkpoints/review. | Reuse workflow patterns without mixing run types or overwriting existing resolution/duplicate annotations. |

## 3. Cross-cutting contracts and release gates

### 3.1 Scope and evidence eligibility

Resolve a scope before synthesis, cache lookup and injection. Its identity must include backend namespace, eligible locked collections, chat/branch identity, source-frame mapping and the active horizon/revision. A scope revision change invalidates dependent views and queued writes.

Terms used below:
- **Source frame:** a coordinate space in which message positions can be compared. Today the only frame is the collection ID (`castOrderKey` in `core/event-chronology.js`), so every chat file sharing a collection shares one frame.
- **Horizon:** the last source position in the active chat file that evidence may come from. The closest existing value is the vectorization tip, which is recorded per chat UUID, not per chat file.
- **Scope revision:** a value that changes whenever any input to the scope identity changes, such as a rewind, branch switch, lock change, alias change or backend switch.

**What this means for existing collections.** Events do not currently record which chat file produced them. Collections are keyed on `chat_metadata.integrity`, and sibling chat files share it. Under the rules below, almost every existing event is therefore ambiguous legacy evidence. On the measured 5,537-event collection, automatic verified current state would be empty. That is the expected result of this gate, not an edge case.

Two pieces of work follow from this:
- **Prerequisite (outside Phase 4).** A separate change, uncommitted as of this revision, records the source chat file (`getCurrentChatId()`) on newly extracted events as the payload field `source_chat_id`. Events extracted before it remain ambiguous. It changes no retrieval or injection behaviour, so it can land before Phase 4 and accumulate usable evidence in the meantime.
- **User-declared continuity (fallback).** A per-collection, opt-in, labelled setting in which the user declares that the chat files sharing this collection are one linear story. This fits collections whose sibling files are slimmed continuations rather than divergent branches. State derived under it is labelled "user-declared continuity", never "verified". It cannot detect a sibling file that has actually diverged, because the user is asserting that none has. Rewinds, lock changes and alias changes still invalidate scope as usual.

Rules:

- Source positions are comparable only inside a verified source frame. InlineSummary-expanded positions must retain their mapping to source identity.
- A sibling archive is not automatically the active branch merely because it is locked to the chat. Including it in current-state synthesis requires an explicit continuity relationship and a usable horizon mapping.
- Story dates and ingestion timestamps can assist ordering; neither proves that evidence belongs to the active branch.
- Ambiguous legacy evidence remains available as history. Exclude it from verified current state and show why; do not quietly treat it as current or infer a horizon from unrelated message counts.
- Rewind, branch switch, lock change, alias change and backend switch must invalidate the affected scope. In-flight responses must be rechecked before persistence and injection.

**Release gate:** demonstrate no future/sibling-state leak in fixtures. If the available host metadata cannot support that guarantee, ship only user-declared continuity or authored state for that case, and label the limitation. Do not weaken the gate by reusing the existing unrestricted historical ordering.

### 3.2 Evidence and authorship

- Generated facts carry collection/backend-qualified event refs, digests of every field offered to the model, subject refs, origin and an as-of source reference.
- A citation existing is necessary, not proof that its text supports the assertion. Validate structure automatically and measure semantic precision by review.
- Changed, missing or newly ineligible evidence gates out the affected generated fact immediately, including dependencies on a resolving event or annotation. Other valid facts remain usable.
- User-authored constraints/corrections are explicitly labelled and need no fabricated event refs. They remain scoped even without citations.
- Missing metadata means unknown, not resolved. Superseded state does not erase the historical event.

### 3.3 Compatibility, persistence and reversibility

Use separately versioned derived contracts without changing extraction coverage semantics. Existing Phase 1–3 `continuity.v === 1` readers must continue to recognize links and duplicate marks; do not simply bump that value and make them disappear. Choose additive subrecords or a tested reader/writer migration before implementing episode fields.

Generated state lives with NPC cards; episode annotations live on event payloads. A small subject registry and authored sections are acceptable within that design, not a second synthesized-state store. Generated cache eviction and **Reset NPC cards** must never silently delete user canon. Pin deletion/reset needs a separate explicit action.

Export/import must preserve versions, scope, authored facts and qualified refs, or explicitly report that a derived record cannot be restored. Audit both single- and multi-collection export: the parent scope identifies a fixed-field multi-collection path that drops `continuity`. An unresolved export hole blocks claiming portable Phase 4 state/episodes. Imports with remapped event IDs must remap citations or mark them unverified, never silently attach them to different events.

Writes remain single-writer unless concurrency control is added. Re-read and merge annotations, verify the frozen input revision, and refuse stale writes. Review/apply/undo is scoped by feature and run ID; undo must not clobber subsequent user edits or unrelated Phase 2 work. Show a conflict for review when safe reversal is impossible.

## 4. 4A — Stable subjects and alias migration

The examples in §§4–8 are illustrative, in the style of the three-character fixture chat. They are not records from the measured collection.

**Example:** the roster groups "Hiro" and "Hiro-kun" as one subject. The user later renames the group to "Hiroshi", and the subject ID stays the same, so the Alex–Hiro pair state is untouched. A new NPC who is also called Hiro gets a separate subject, and stays separate unless the user confirms a merge in the preview.

### Scope

1. Introduce opaque stable IDs for roster subjects within an explicitly identified continuity. Display-name changes do not change identity.
2. Identify a relationship by the canonical ordering of its two subject IDs plus continuity scope. Directional facts may carry an explicit subject/object; do not create two competing copies of a symmetric pair state.
3. Map existing alias groups to subjects with a preview. Ambiguous groups require user confirmation; automatic name normalization alone must not merge people.
4. Renames retain IDs. Merges select a surviving ID and migrate refs with an audit record. Conflicting pins/facts remain reviewable, not last-write-wins.
5. Splits require explicit reassignment of aliases and affected facts. Ambiguous facts become unverified until reassigned; do not copy every fact onto both subjects.
6. Migrate old NPC-card keys conservatively. Reuse only facts whose subjects, scope and evidence can be verified; otherwise rebuild the generated portion. Retain the pre-migration record until success.

### Acceptance

- Rename leaves pair identity intact; two similarly named people remain separate.
- Alias merge/split cannot transfer one pair's state to another without confirmation.
- Identical event/collection names on different backends cannot collide.
- Migration is idempotent and preserves user-authored content; an interrupted migration is recoverable.

## 5. 4B — Relationship state, canon and budget

**Example:** Alex borrowed money from Hiro and they argued about it. A later scene settles the argument, but the loan is not repaid. The Alex–Hiro section then holds two generated facts:
- "Reconciled after the argument about the loan", citing the argument and the reconciliation.
- "The loan is still unpaid", citing the argument, with no resolver.

The user also adds authored canon: "Alex and Hiro share the loft." If the reconciliation event is later edited, only the first fact is withheld. The unpaid loan and the canon line still render.

### Card model and synthesis

Extend the existing card with separately labelled historical facts, current relationship sections keyed by pair, and authored canon/corrections. Exact field names are implementation choices; minimum fact fields are stable fact ID, pair/subject refs, text, origin, source refs/digests for generated facts, as-of reference, validity and pinned status.

- Track concrete status, agreements, boundaries, routines, responsibilities, commitments and unresolved concerns. No broad temperament claims inferred from an argument.
- Keep MC–A, MC–B and A–B separate. First UI: choose a pair of roster subjects, rather than assuming the player has a reliable inferred subject ID.
- For symmetric pair sections, use one canonical owner in the existing card map and reference it from other card views. Avoid duplicate synthesis/storage of the same pair state; ownership migration must preserve authored content.
- Use the existing provider/rate gate and bounded card refresh machinery. Share its per-turn allowance rather than adding an uncapped pair-call loop. Preview/dry-run performs no generation.
- Supply validated lifecycle context and a bounded pair-specific evidence selection. Show sampled/incomplete evidence explicitly. Initial builds may not have enough evidence to establish a current fact.
- Anchor state evidence on recency, not on the history spine. `selectHistorySpine` takes the first and last events, then events that are persistent or at importance ≥ 7. Since 96% of events in the measured collection are persistent, a large pair's sample would be dominated by old high-importance crises, which is the bias Phase 4 is meant to correct. In priority order, select:
  1. The most recent eligible pair events, up to the budget share.
  2. The resolver outcomes of anything still open, regardless of age.
  3. The cited sources of existing state facts that are being revalidated.
  4. Older history, only if budget remains, and labelled as older.
- New eligible evidence affecting a pair, changed support, or a changed resolution link makes that pair due for refresh; invalid facts are withheld without waiting for the normal five-event threshold.
- Revalidate scope/digests after a background response. If evidence changed, discard the stale result and queue a later refresh rather than replacing a newer edit.

### Projected cost

The current NPC card costs, measured on a 2,000-event NPC (2026-10-04): a first build of 4 calls and about 25K tokens, then about 1 call and 0.5–0.7K tokens per update, made once 5 events are unread.

Pair state multiplies those calls. The number of pairs grows as n(n−1)/2 across subjects in play: three leads make 3 lead pairs, and each NPC in a scene adds a pair with every lead present. In the measured collection, the leads appear in nearly every event, so lead-pair evidence is effectively the whole collection and every first build hits its cap.

Projection, not a measurement: if each pair gets its own read plan at the current cap, the first build for 3 lead pairs is up to 12 calls and about 75K tokens, on top of the existing per-character cards. Steady state adds about 1 call per pair for every 5 new pair events. If pair plans instead count against the owning card's 4-call cap, the first build needs no extra calls, but each card reads less evidence. This choice is decision 5 in §10. Show the estimate for the enabled pairs before the first build, and record estimate against actual.

### User controls

Provide an editor reachable from the roster/NPC-card UI: inspect sources/as-of status, correct, pin/unpin, remove and rebuild generated facts. A correction creates user-authored state; preserve provenance instead of presenting it as model-supported text.

Pinning blocks automatic overwrite/removal, not scope/evidence validation. If a generated fact is pinned, preserve its text on source invalidation but mark it unverified and withhold it as verified current state. The user can explicitly convert it to authored canon. Conflicting evidence creates a review item; it does not silently change the pin or conceal the conflict.

### Injection and budgeting

1. Resolve relevant pair sections from the in-play cast and explicit recall intent.
2. Reserve a configurable state allowance inside the shared EventBase envelope before topical/cast history. **Proposed experiment:** 350 estimated tokens total; compare 250/350/500 before selecting a default. This is not 350 tokens per pair. **Precondition:** first confirm how the cast allocator divides the cast budget (default 700) among characters with cards. An earlier, unconfirmed review observation suggested that when two or more card characters are in play, the "fits whole" check uses the full event-history cost rather than the card's cost, so a card near its 350-token size can lose to an equal-share slice. Settle that before adding a third reserve to the same envelope.
3. Charge headings, citations, warnings and wrappers. Return unused state capacity to history. Include whole facts or omit them; never truncate away qualification or provenance.
4. Fair-share among relevant pairs; canon constraints precede generated facts. A zero/insufficient budget must remain within the envelope and report omitted constraints rather than claim all canon was supplied.
5. State is enabled explicitly for the first release. Do not silently enable background card calls for users with NPC cards disabled. If historical card generation is disabled, authored constraints may still render when state injection is enabled.
6. Give the combined prompt one state owner per generation. When ordinary/Agent and Summarizer Injection both run, inject the block once. Summarizer-only use must work under its own configured budget, with characters/tokens accounted for in that route's units. Do not pretend its separate character cap is the shared token envelope.

All supported formats and compact fallbacks retain the distinction between canon, current supported facts and historical incidents.

### Acceptance

- Partial emotional repair does not close an unpaid debt or alter another pair.
- Missing/edited sources invalidate only dependent generated assertions.
- Pinned authored constraints survive refresh, reset, eviction, migration and export/import.
- Conflicting evidence appears in review/debug; synthesis cannot turn scene anger into immutable personality.
- Zero/tiny budgets do not overflow, produce dangling fact fragments or duplicate state blocks.
- Dry-run shows the exact state text, sources, eligibility decisions and budget omissions without calls or writes.

## 6. 4C — Episode grouping

**Example:** the loan argument was extracted as five records: Alex's side, Hiro's side, the argument itself, its aftermath, and a re-extraction copy. The copy stays duplicate-marked. The other four form one episode, whose outcome is the partial reconciliation. Ordinary injection shows the episode once, with that outcome. Asking "what did Hiro say that night?" can still retrieve the individual records. A later argument about chores is a different episode, even though it involves the same pair.

### Before starting

Apply Phase 2 resolution links and duplicate marks to the measured collection. Then dry-run the same five representative scenes used for the parent scope's verification. Count how often two or more distinct, non-duplicate records of one incident are injected in the same prompt, and whether any of them shows the incident without its outcome. Implement 4C only if this shows a material problem. Otherwise record the result and leave episodes deferred.

### Scope

- Group records of the same incident, not every disagreement involving the same people. Candidate selection narrows by eligible scope, source overlap/proximity and subject/topic evidence; a model or user must establish nontrivial membership. No automatic connected-component grouping from shared characters alone.
- Duplicate copies remain duplicate-marked. Distinct perspectives/stages of an incident remain archived and individually recallable.
- Store stable episode IDs and evidence-digested membership in the event `continuity` namespace. Reuse the existing resolver for consequence closure; membership alone neither resolves threads nor makes a record a duplicate.
- Consequence views distinguish active, resolved and unknown. New evidence can explicitly reopen an identified consequence; an unrelated new argument creates a different episode.
- Inventory/estimate, bounded proposal generation, preview, accept/reject, resume and undo follow the repair workflow. Exact grouping thresholds/costs must be measured, not copied from duplicate detection.

**Persistence decision before coding:** prefer a deterministic canonical member holding the compact episode descriptor, with qualified membership refs on other members. Freeze ownership per episode; specify repair/re-homing for deletion and export/import. If the descriptor is missing or inconsistent, fall back to existing per-event lifecycle rendering, not a fabricated episode. Do not place large episode bodies on every vector result or create fake historical events as storage anchors.

### Selection/rendering

Select/render the incident once across topical and cast lanes while preserving individual members for explicit detailed recall. Fetch required eligible outcome dependencies independently of top-K/similarity/importance selection. Budget the episode with its outcomes atomically: use a cited compact form or omit the episode, never expose just a confrontation because the outcome did not fit.

Integrate ordinary retrieval (including native-Qdrant postprocessing), Agent Mode, cast history, NPC-card evidence, Summarizer Injection and every supported output format. Summarizer recent-N selection must deduplicate episode views without falsely counting one grouped display as N newly stored events. Missing membership must not break Phase 1–3 rendering.

### Acceptance

- Five records of one incident yield one ordinary history view; member events remain inspectable.
- Two separate arguments between the same pair do not merge; a proposal never becomes active merely by being generated.
- Partial closure remains partial, and invalidated resolver evidence removes the claimed closure.
- A low-ranked outcome survives dependency fetching and tiny-budget fallback.
- Applying twice is a no-op; interrupted membership writes reconcile safely; undo preserves unrelated annotations.
- Anchor deletion, partial export and conflicting membership degrade visibly without losing the archive.

## 7. 4D — Measured, optional exposure cooldown

**Example:** Alex and Derek argued over a broken window, and the incident was fully resolved when Derek paid for it. In calm scenes it still gets injected every few turns. With cooldown on, it is skipped for the configured interval after each time it actually reaches the prompt. It returns at once if the user asks about the window, or if a new event involves it. The unpaid loan from §5 is an active consequence, so cooldown never applies to it.

First record a post-Phase-2 baseline of repeated **actually injected** historical incidents over representative scenes. Downranking and contextualization may already be sufficient. Implement only if this still shows a material repetition problem.

- Default off; no extra LLM calls. Configure a bounded message/turn interval after measurement, not an untested default in this draft.
- Key exposure by chat/branch, episode ID (event ID if 4C is not built) and relevant evidence revision. Advance only when the final real prompt includes the episode. Retrieval candidates, failed/cancelled prompt assembly and dry-runs do not count. Retries of the same committed generation are idempotent.
- Apply to routine historical reminders, not current state, pinned constraints or active consequences. Explicit recall and new relevant evidence bypass it.
- Use one decision across history routes; do not let a cast/summarizer lane reintroduce the same cooled episode. In Summarizer Injection, preserve any existing coverage/ghosting safety contract: if withholding history would remove required replacement context, bypass cooldown and record that reason.
- Rewind/branch switch resets or isolates the exposure ledger. Bound retained entries and provide reset/debug controls. Reuse generic conditional-activation patterns only if their lifecycle matches actual EventBase injection; they are not automatically equivalent.

**Acceptance:** repeated ordinary exposure decreases versus baseline, explicit recall and open-consequence coverage do not regress, and dry-run/rewind/retry cannot accidentally consume cooldown.

## 8. 4E — Selective InlineSummary continuity backfill

**Example:** messages 1–300 were already collapsed by InlineSummary when EventBase extracted them, so extraction saw only the summary. The summary mentions that Alex and Hiro started a Sunday dinner routine, but no event records it. Backfill recovers the original messages from the nested expansion and proposes a "Sunday dinners" routine event that cites them. The event is stored only after the user accepts it. Where the originals are missing, the range is listed as summary-only, and no proposal claims to cite raw messages from it.

### Scope and workflow

1. Inventory selected ranges using `core/ils-expander.js`. Report recovered originals, nested expansions, missing refs and summary-only spans. Preserve source identity/digests; expanded indices alone are not stable identity.
2. Freeze recoverable input and show windows, model, maximum calls and approximate tokens before running. Missing originals are a reported limitation, not permission to claim raw-history recovery.
3. Run a bounded continuity-focused extraction pass for omitted routines, agreements, preferences, commitments and explicit outcomes. Respect language, custom-prompt precedence and provider settings; clearly show the effective backfill prompt/profile. Do not silently replace a custom prompt.
4. Compare proposals with existing events and prior backfill outputs using qualified source identity and content. Similarity is a candidate signal, not proof two changed agreements are duplicates.
5. Preview each proposal and its recovered source. Accept/reject before storage. Store accepted new historical facts as normal source-backed events with backfill provenance, embeddings and minimum-store validation; store derived links using the existing continuity contract. Do not synthesize fake historical events from a user state correction.
6. Reuse existing backend insertion/validation paths through a backfill-specific entry point that does **not** advance normal ingestion coverage. Refresh affected roster/card views after accepted writes.

Use an independent versioned backfill run/checkpoint and source-digest ledger, not the normal fingerprints, markers, vectorization tips or Phase 2 repair cursor. Persist bounded proposals/checkpoints on a metadata-capable backend following the repair approach; settle the durable manifest location and anchor-loss recovery before implementation. Settings may hold a small locator, not raw recovered history.

Pause after a batch, resume, cancel, idempotent apply and run-scoped undo are required. Preallocate stable output IDs so an interrupted insert can be reconciled with the backend before replay. If a backfill-created event later acquires user edits or external dependencies, undo must preserve it and report a conflict instead of cascading destructive deletion. Restrict undo deletions to demonstrably unchanged records owned by the run.

### Acceptance

- Available nested originals yield cited proposals; missing refs are listed and never reconstructed from imagination.
- Rerunning/applying twice does not duplicate events, including after an interrupted insert/checkpoint write.
- Normal coverage maps/tips are byte-for-byte unchanged; regular auto-sync neither skips new source nor repeats covered windows because of backfill.
- Source edits or a changed source mapping require re-inventory; stale proposals cannot apply.
- Concurrent normal ingestion is rechecked for duplicates before apply; use a single writer or serialize conflicting writes.
- Estimate versus actual calls/tokens is recorded; live-model work remains opt-in and rate-limited at repair priority.

## 9. Implementation map and validation

Keep deterministic identity, evidence and formatting logic host-independent where practical, following existing unit-test patterns. New module names are not prescribed.

| Work | Likely integration points | Regression tests to extend |
|---|---|---|
| Subjects/scope | `core/character-roster.js`, collection identity helpers, roster UI | Roster/alias fixtures plus new identity/migration tests |
| State/canon | `core/npc-cards.js`, `core/npc-card-llm.js`, `core/eventbase-workflow.js`, settings/UI | `tests/npc-cards.test.js`, state/pinning/scope tests |
| Budgets/routes | `core/eventbase-token-budget.js`, `core/eventbase-injection.js`, retrieval/Agent and Summarizer paths | `tests/eventbase-token-budget.test.js`, injection-order/debug tests, route parity tests |
| Episodes | `core/continuity.js`, repair service/UI, metadata/export paths | `tests/continuity.test.js`, repair tests, episode grouping/reconciliation tests |
| Cooldown | Final prompt commit lifecycle, route coordination, retrieval debug | Exposure/retry/rewind tests; no-write dry-run assertions |
| Backfill | `core/ils-expander.js`, EventBase store/workflow, repair patterns | Source recovery, idempotent insert, restart/undo and coverage-invariance tests |

### Automated gate

Run `npm test` and targeted Vitest files during each increment. Cover ordinary and group chats; dated/undated events; shared collections with different coordinate frames; scope changes while calls are pending; backend namespace collisions; alias merge/split; missing/edited/deleted sources; all injection formats; tiny budgets; and proposal/apply/resume/undo/export/import paths.

Verify Qdrant and Standard with the metadata-capable plugin separately. Native Vectra must retain a clear unsupported state for metadata-dependent operations rather than silently lose annotations. No new runtime library is required by this scope.

### Live-model and collection gate

Use the existing three-character fixture concepts plus routines, boundaries and business responsibilities. Compare against the same Phase 2–3 baseline and settings, not an unrepaired collection with unrelated tuning changes.

- Review at least 50 generated relationship assertions and 50 proposed episode memberships when enough samples exist. **Proposed launch target:** at least 90% supported/correct for each; false pair merges, scope leaks and overwritten pins are blocking defects regardless of aggregate precision.
- Require zero observed future/sibling-state leaks, dangling resolved-conflict views, uncited generated facts accepted by the validator, and budget overflows in the defined regression fixtures.
- Before 4C, measure multi-record injection of one incident after Phase 2 (§6). If 4C ships, rerun the same scenes afterward.
- Measure repeated episode exposure and explicit-recall coverage before/after cooldown, if implemented.
- Measure source recovery, useful new facts, duplicate insertions and coverage invariance for backfill.
- Log provider calls, input/output tokens, latency, refresh frequency and settings-store growth. Set final defaults only after these results; fixture success is not proof of universal generation behavior.

Diagnostics should explain scope exclusions, subject identity, cited evidence, inactive facts, pin conflicts, episode membership, required outcomes, cooldown bypass/suppression and exact per-route budget use.

## 10. Decisions to settle before implementation

The following are proposed defaults or unresolved design gates, not decisions already made by the parent scope:

1. **Scope source:** which host identifiers and source mappings can prove branch/horizon eligibility, and what explicit archive-continuity control is needed? Without new metadata, existing events cannot pass the gate, and automatic verified state is empty for the measured collection (§3.1). Confirm `source_chat_id` as the source-chat field recorded on new events, and decide the exact behaviour and labelling of user-declared continuity. This blocks automatic current-state release.
2. **Subject persistence:** registry location, merge/split audit and import remapping. Keep it small and scoped; no new parallel generated-state store.
3. **Authored data lifetime:** card ownership, eviction/reset exclusions and export packaging. Pins cannot be treated as disposable generated cache.
4. **State budget:** confirm the cast allocator's handling of multiple card characters first (§5). Then test a 350-token total reserve against 250/500; decide enabled-by-default behavior only after evaluation. Initial implementation is opt-in.
5. **Pair ownership/scheduling:** deterministic canonical ownership in the card map and fair refresh within existing call caps, including player/NPC and NPC/NPC pairs. Decide whether a pair's read plan has its own 4-call cap or counts against its owning card's cap (projected costs in §5).
6. **Episodes:** first, whether the post-Phase-2 measurement (§6) justifies them at all. If it does: descriptor ownership/re-homing, additive payload versioning, write reconciliation and export completeness.
7. **Cooldown:** decide whether the measured repetition justifies shipping it at all, then choose the interval and commit lifecycle.
8. **Backfill:** durable checkpoint/proposal location, explicit prompt precedence, source identity, accepted-event insertion and conflict-safe undo. Do not reuse ordinary extraction coverage.

**Suggested first implementation slice:** 4A plus the versioned 4B card contract and pin-preserving migration, with scope/rewind tests first. Include the 4B editor for the facts existing NPC cards already hold: inspect sources, pin, correct and remove. That gives the slice a visible result the co-author can judge. It also exercises the authored-data contract, because pins and corrections must survive reset, eviction and migration before any pair state exists. Then add pair state and budgeted state injection. Episodes, cooldown and backfill should not be prerequisites for validating that slice.