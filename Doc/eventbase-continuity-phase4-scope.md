# EventBase continuity: Phase 4 implementation scope

**Status:** Draft for review, revision 3, 2026-10-22. Nothing in this document is an implementation claim. Measured numbers are quoted from the parent scope or from earlier NPC card measurements; new figures, such as the cost in §5, are projections. Reports of duplicate volume below are user reports, not new collection measurements.
**Parent scope:** [eventbase-continuity-scope.md](eventbase-continuity-scope.md), Phase 4.
**Design background:** [eventbase-continuity-design.md](eventbase-continuity-design.md), especially §§3–5, 7.3 and 9.

Revision 3 changes:
- Adds 4F, an explicit, backup-gated purge of reviewed duplicate marks, taking up the deferred action in the parent scope's §2B.
- Expands 4B into a browsable NPC-card inspector/editor for existing historical facts as well as future pair state, with durable corrections and suppression.
- Adds purge/editor dependencies, acceptance checks and implementation decisions. Phase 4 remains unimplemented; this does not change the Phase 2–3 testing gates.

Revision 2 changes (retained):
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
| 4B | User-visible NPC-card browser/editor, durable corrections/canon/pinning, current relationship sections and reserved injection capacity | 4A for durable identity/migration and pair state; existing-card inspection can be developed first |
| 4C | Evidence-linked episode grouping and atomic episode rendering, only if measurements justify it | Existing resolution links; 4A scope rules; a post-Phase-2 multi-record baseline |
| 4D | Optional exposure cooldown, only if measurements justify it | A post-Phase-2 exposure baseline; 4C episode IDs if 4C ships, otherwise event IDs |
| 4E | Optional continuity-only InlineSummary backfill | Separate source inventory/checkpoint; 4A scope rules for new facts |
| 4F | Explicit purge of reviewed, active duplicate marks, with backup, dependency checks and resumable deletion | Phase 2 duplicate review; complete inventory and verified targeted deletion/backup contracts; no dependency on 4A–4E |

These are independently reviewable increments, not one all-or-nothing release. Recommended implementation order: 4A → 4B. Measure before starting 4C, and evaluate 4D after 4C or after deciding against it. The parent scope deferred episodes because resolution links and duplicate marking may already cover the visible symptoms, so 4C has the same kind of measurement gate as 4D. 4E can be developed separately once its source and persistence contracts are settled.

4F can be developed in parallel as a separate maintenance increment: users report hundreds of suspected duplicates, roughly 5% of their Qdrant entries. Validate that against each selected collection; do not treat 5% as a deletion target or lower duplicate thresholds to reach it. Marking already suppresses active duplicates from retrieval; purge reclaims stored records and is not a substitute for fixing repeated extraction/insertion. The existing-card inspector should likewise not wait for episode grouping, cooldown or backfill.

### Not included

- A parallel relationship-state database or general-purpose derived store. Extend NPC cards for state and the event `continuity` namespace for episode annotations.
- Rewriting historical summaries, embeddings, importance or original `open_threads` during state/episode repair.
- Numeric affection/trust scores, automatic personality diagnosis, or treating affection/silence as resolution.
- Automatic full-history re-extraction, collection rebuilds, or automatic/unreviewed duplicate deletion. Permanent deletion is included only through the explicit 4F workflow (§8A).
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
| Targeted deletion/export | `core/core-vector-api.js` exposes `deleteVectorItems` by hash; `backends/qdrant.js` also has whole-collection purge operations. `core/collection-export.js` provides vector-bearing inventory/export paths. | Prove exact event-to-stored-record mapping and backup completeness before 4F; never call whole-collection purge for duplicate cleanup. |

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

The examples in §§4–8A are illustrative, in the style of the three-character fixture chat. They are not records from the measured collection.

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

Provide an **NPC cards** browser reachable from the EventBase tab and an **Inspect card** action on roster subjects. This covers the historical facts existing cards already hold, not just future relationship sections. Proposed workflow:

1. **Browse without generation.** Search/filter by subject/name/alias and collection/continuity scope. List stored cards, last update, fact count and validity/refresh status. Distinguish no card, no eligible evidence, disabled generation, queued/failed refresh and unsupported legacy identity. Opening, filtering, inspecting and saving authored edits must make no model calls or trigger a rebuild. If cards are disabled, stored cards remain inspectable; explain that inspection does not enable injection or generation.
2. **Inspect a card.** Separate historical facts, current pair state and user canon. Show each fact's origin, pin, active/inactive status and reason, scope, as-of information when available, and source event refs with inspectable summaries. Mark absent/changed sources and sampled/incomplete coverage; historical cards are not proof of verified current state. Include an injection preview using the existing dry-run/budget rules, without calls or writes.
3. **Edit at fact granularity.** Add an explicitly user-authored fact/constraint, correct text, pin/unpin, suppress/remove, and restore a suppressed fact. Corrections retain the original generated text and provenance in an audit entry, but the replacement is user-authored, not a model-supported assertion with borrowed citations. Optional source refs are labelled as user-selected. Validate nonempty text and scope; display token cost and budget omissions rather than silently truncating or deleting authored text.
4. **Make removal durable.** Removing a generated fact creates a scoped suppression record so the next refresh cannot immediately resurrect it. Corrections suppress the replaced assertion as well. Use stable fact identity through migration/refresh; exact identity matching alone cannot promise to catch every paraphrase, so surface suspected reintroductions for review. Deleting authored canon has its own confirmation and must not delete source events. Removing a fact from the card never deletes a Qdrant entry; 4F is a different action.
5. **Save safely.** Offer Save/Cancel, show a before/after diff and persist only on Save. Bind edits to card/subject ID, scope and revision; reject stale saves after a branch, alias or background-refresh change with a reload/merge choice. Queued model responses must merge around authored facts, pins and suppressions rather than replace the saved card wholesale. Render fact/source text as untrusted text, not executable HTML.
6. **Rebuild deliberately.** Separate **Refresh/rebuild generated facts** from **Reset generated cache** and **Delete user-authored content**. Explain model cost before rebuilding and reuse the bounded call/rate gates. Refresh/reset/eviction must preserve authored edits, pins and suppressions. Define export/import for that authored layer before offering durable editing; the current disposable-card reset behavior is not a suitable lifetime contract.

An initial read-only inspector can ship before migration, but editing must wait for stable ownership and authored-data persistence. Generated facts may remain in the existing bounded cache; protected authored sections/suppressions need durable retention within the card design, not a second synthesized-state database.

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
- Users can find and inspect an existing historical card even before pair synthesis is implemented, including disabled/empty/stale states; browsing does not generate cards.
- Save/Cancel, add/correct/pin/suppress/restore, stale-save rejection and pending-refresh reconciliation work. A correction never gains fabricated model provenance, and suppressed facts do not immediately return on rebuild.
- Authored facts, pins and suppressions survive refresh, generated-cache reset, the 100-card cache limit, migration and export/import. Explicit authored deletion is separate from generated-cache reset.
- Source text is safely rendered; inspecting/editing a card neither edits historical events nor deletes backend records.

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

## 8A. 4F — Purge reviewed duplicates

**Example:** a collection has 10,000 EventBase records and users suspect 500 copies. A fresh inventory finds 470 active duplicate marks; 430 pass review and dependency checks, while 40 are blocked or deselected. Preview shows each copy beside its retained canonical, exports a verified recovery package, and asks to permanently delete exactly the 430 selected records. Those numbers are illustrative, not a target or a prediction for reported collections.

### Scope and safety boundary

Implement **Purge marked duplicates** as a separate action in **Review and repair memory**, scoped to one backend-qualified logical collection. This fulfills the parent scope's deferred §2B action. Do not reuse a whole-collection **Purge** button or its API. No automatic cleanup on startup, retrieval, repair acceptance or backfill; no bulk deletion based on a raw similarity search.

Only reviewed `continuity.v === 1` / `duplicate_of.status === "active"` records are candidates. Proposed/rejected marks, missing canonicals, self-links, cycles and duplicate chains are blocked. The canonical must still exist in the same qualified collection, remain non-duplicate, and never appear in the deletion set. Show the existing Phase 2 evidence (including source overlap and similarity when available); similarity ≥ 0.92 is a candidate rule, not proof that distinct perspectives or later similar incidents are expendable. Revalidation must catch changed copy/canonical content even though the existing duplicate mark does not itself store an evidence digest. Do not silently infer legacy branch identity from source-window overlap; ambiguous story scope requires review, and purge must not claim that it establishes branch eligibility.

### Workflow

1. **Inventory and preview, no model calls.** Read the complete collection, including payloads, vectors and stored deletion identifiers, with an explicit completeness check. The existing export inventory limit is 50,000 chunks; hitting a cap, incomplete pagination or missing required vectors/IDs blocks deletion rather than purging a partial sample. Show total records, marked/eligible/selected/blocked counts and percentages, reasons, and the exact collection/backend. Paginate/filter copy–canonical pairs with summaries, source windows and continuity annotations. Let users deselect any copy or return to duplicate review/unmark; preview defaults to no destructive action.
2. **Dependency audit.** Check incoming/outgoing resolution links, manual closures, duplicate refs, repair manifests/checkpoints, existing card citations, authored/pinned source refs and any shipped episode/state/backfill refs. Phase 2 already avoids marking events that own/receive continuity links, but repeat the check because dependencies may have changed since acceptance. First release blocks deletion of records with nontrivial continuity/manifest/authored dependencies; do not silently move links, rewrite citations to a similar canonical, re-home episodes or delete more records. Generated-cache-only citations may be invalidated through the normal missing-source path, with an affected-fact count in preview. Unknown dependency types fail closed. Reject plans selecting a repair manifest anchor; purge's own checkpoint must live outside its deletion set.
3. **Backup gate.** Before confirmation, create a downloadable, versioned recovery package for the exact selection: original text, full payload/metadata, dense and sparse/named vectors where present, stored IDs/hashes, backend/collection identity, embedding source/model/dimensions, and the copy–canonical plan with content revisions. Verify count/content completeness against the frozen selection and require explicit user acknowledgement that the package was saved. A download acknowledgement is not proof of filesystem durability; state that limitation. Existing generic exports are insufficient until full metadata/vector preservation is verified (§3.3). Do not claim a guaranteed one-click restore: validate the existing import path against this package and document any ID/vector remapping limitations before release. If faithful backup is unavailable, purge is unavailable; duplicate marking remains usable.
4. **Explicit confirmation.** Show “Permanently delete N marked duplicate records from [collection]; retain M canonical records.” Require the collection name and a destructive-action acknowledgement. State that Phase 2 **Undo repair** only removes annotations from surviving records and cannot undo purge. Neither completion nor cancellation deletes the recovery package. Do not advertise predicted disk savings from record count; measure storage effects separately.
5. **Freeze and revalidate.** Persist a separately versioned purge run/manifest containing exact qualified record identifiers, copy/canonical fingerprints, backup identity and per-record progress. Freeze the selection, not merely a filter to rerun later. Re-read marks, payloads, canonicals and dependencies before each bounded delete batch. Any change requires re-preview and renewed confirmation for affected records; newly arriving events are never added automatically. Serialize conflicting writes or enforce a single-writer maintenance window, including background extraction/repair. The existing cross-tab warning is not a database lock, and re-reading alone cannot close a concurrent-write race.
6. **Targeted, resumable deletion.** Use the existing targeted deletion abstraction only after proving its event-ID → hash/point mapping deletes exactly the selected copies, including Qdrant multitenancy/content-type isolation. If a hash can address a retained canonical or unrelated chunk, block the batch unless a precise record-ID endpoint is available. Verify deleted IDs are absent and retained canonicals still present before advancing the checkpoint. Pause/cancel stops future batches; completed deletions stay deleted. After a timeout/crash, reconcile exact IDs against the backend before retrying, so a repeated apply/resume is idempotent. Report confirmed deletions, blocked/remaining records and ambiguous failures separately; never equate a successful request with verified completion.
7. **Refresh and report.** Invalidate affected roster, retrieval/corpus statistics and generated card views using the normal deletion hooks. Withhold generated assertions whose sources vanished; preserve unrelated facts and authored data. Show a run report and recovery instructions. Normal extraction fingerprints, marker maps and vectorization tips remain byte-for-byte unchanged; retain coverage so ordinary auto-sync does not re-extract deleted copies merely because they are absent. Test that behavior and investigate recurring insertion duplicates separately rather than promising purge prevents them.

No LLM or embedding calls are required for inventory/review/delete; network I/O, vector download size, local memory and deletion latency still need measurement. Restoring into an incompatible embedding configuration may require re-embedding and is not part of that no-call claim. Keep large backup payloads out of extension settings; settings may hold a small checkpoint locator. Settle durable manifest ownership and retention before implementation.

### Acceptance

- With three copies of one incident, only selected active duplicates are removed; the canonical and distinct perspectives remain byte-for-byte unchanged. Missing/cyclic/chained/proposed marks and changed canonicals are blocked.
- Incoming/outgoing resolution links, manual closures, authored/pinned evidence, episode descriptors and manifest anchors block deletion. Unrelated links and authored content survive; generated-cache invalidation is visible and targeted.
- Incomplete/capped inventory, missing vectors, an unverifiable backup, ambiguous hash mapping, wrong backend or multitenancy scope, and concurrent/stale revisions cannot authorize deletion.
- Confirmation names the exact collection/count; cancel before execution deletes nothing. Partial completion, pause, timeout, crash/restart and repeated resume yield correct reconciled counts without expanding the plan.
- Backup round-trip on a disposable collection preserves selected payloads, identities and vectors or explicitly reports unsupported restoration before purge is enabled. Phase 2 Undo is never presented as purge recovery.
- No model/embedding calls occur during preview or purge, no collection-wide purge endpoint is used, coverage maps/tips remain unchanged, and normal auto-sync does not recreate the deleted copies solely due to cleanup.

## 9. Implementation map and validation

Keep deterministic identity, evidence and formatting logic host-independent where practical, following existing unit-test patterns. New module names are not prescribed.

| Work | Likely integration points | Regression tests to extend |
|---|---|---|
| Subjects/scope | `core/character-roster.js`, collection identity helpers, roster UI | Roster/alias fixtures plus new identity/migration tests |
| State/canon | `core/npc-cards.js`, `core/npc-card-llm.js`, `core/eventbase-workflow.js`, settings/UI | `tests/npc-cards.test.js`, state/pinning/scope tests |
| Card browser/editor | EventBase/roster UI, card contract and authored persistence, export/import | No-call browse/dry-run, safe rendering, Save/Cancel, suppression, reset/eviction, stale-edit/refresh and authored round-trip tests |
| Budgets/routes | `core/eventbase-token-budget.js`, `core/eventbase-injection.js`, retrieval/Agent and Summarizer paths | `tests/eventbase-token-budget.test.js`, injection-order/debug tests, route parity tests |
| Episodes | `core/continuity.js`, repair service/UI, metadata/export paths | `tests/continuity.test.js`, repair tests, episode grouping/reconciliation tests |
| Cooldown | Final prompt commit lifecycle, route coordination, retrieval debug | Exposure/retry/rewind tests; no-write dry-run assertions |
| Backfill | `core/ils-expander.js`, EventBase store/workflow, repair patterns | Source recovery, idempotent insert, restart/undo and coverage-invariance tests |
| Duplicate purge | `core/continuity-repair-service.js`, repair UI, `core/core-vector-api.js`, backend deletion and `core/collection-export.js` | Active-mark/dependency gates, exact-ID/multitenancy deletion, backup round-trip, partial failure/resume and coverage-invariance tests |

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
- Validate 4F first on disposable restored copies of representative collections. Review selected copy–canonical pairs, compare confirmed deletions with preview, verify all retained records/links and backup restoration, and record actual duplicate counts, I/O, memory and latency. Reports of hundreds/~5% are motivation, not validated prevalence or permission to delete.
- Exercise the card browser/editor manually with cards disabled, legacy/stale cards, a pending refresh, more than 100 generated cards, and save/reset/export/import; confirm authored edits and suppressions survive without surprise calls.
- Log provider calls, input/output tokens, latency, refresh frequency and settings-store growth. Set final defaults only after these results; fixture success is not proof of universal generation behavior.

Diagnostics should explain scope exclusions, subject identity, cited evidence, inactive facts, pin conflicts, suppressed/corrected assertions, editor revision conflicts, episode membership, required outcomes, cooldown bypass/suppression and exact per-route budget use. Purge reports additionally identify the frozen selection, backup, blocking dependencies and per-record reconciliation without dumping vectors into ordinary logs.

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
9. **Card editor:** stable fact/suppression identity, protected authored-section storage, audit retention, stale-save merge UX and export/import packaging. Read-only inspection can precede these decisions; durable editing cannot.
10. **Purge:** exact targeted-deletion identifiers and backend/multitenancy guarantees; complete vector-bearing backup and tested recovery; durable manifest location outside deleted records; dependency inventory and maintenance serialization. Initially block dependent records rather than implementing automatic reference migration. No trustworthy backup/precise deletion means no purge release.

**Suggested first implementation slice:** 4A plus the versioned 4B card contract and pin-preserving migration, with scope/rewind tests first. Include the 4B browser/editor for the facts existing NPC cards already hold: inspect sources, add, pin, correct, suppress and restore. That gives the slice a visible result the co-author can judge. It also exercises the authored-data contract, because pins, corrections and suppressions must survive reset, eviction and migration before any pair state exists. Then add pair state and budgeted state injection. Episodes, cooldown and backfill should not be prerequisites for validating that slice. In parallel, 4F can start with a no-delete inventory/dependency/backup preview; enable destructive execution only after its separate safety gates pass.