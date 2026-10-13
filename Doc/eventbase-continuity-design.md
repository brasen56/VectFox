# EventBase continuity and existing-memory repair

**Status:** Design proposal for co-author review; these features are not implemented.  
**Date:** October 12, 2026  
**Scope:** Long-running roleplay, especially slice of life, relationships, college, and business stories. Qdrant is the first repair target.

## Proposal at a glance

EventBase can turn isolated arguments into an apparent relationship pattern: extraction preserves dramatic changes, retrieval repeatedly surfaces them, and generation continues the conflict. Recording reconciliation does not necessarily solve this because retrieval can return an argument without its outcome.

The proposed change separates historical events from current continuity. Preserve the original archive, add evidence-linked relationship states and incident outcomes, and use those records consistently whenever memory enters the prompt. Existing collections receive a separate repair pass over stored events; users do not need to delete their collection or restart extraction.

Recommended first release:

1. Editable, evidence-linked relationship states with a reserved injection budget.
2. Incident grouping and explicit links between conflicts and their resolutions.
3. A resumable repair workflow for existing Qdrant collections.
4. Shared handling across ordinary retrieval, Agent Mode, cast history, NPC cards, and Summarizer Injection.

A slice-of-life extraction profile follows to prevent future omissions. Lowering importance and persistence weights is an immediate mitigation, not a complete repair.

## 1. Problem and evidence in the current implementation

Consider a main character and two NPCs in a long relationship story. Most scenes show affection, cooperation, classes, and work on a shared business. A few scenes contain arguments. If memory retains those arguments more readily than ordinary companionship, the injected history exaggerates conflict. A model may then portray the relationship and even character personalities around that distorted sample.

This is a plausible feedback loop supported by the pipeline's design; its frequency and effect on generation still need evaluation with representative chats.

| Current behavior | Implication | Code reference |
|---|---|---|
| The built-in extractor requires story changes and explicitly excludes many everyday routines and inconsequential playful interactions. | Stable companionship and useful ordinary continuity can be underrepresented. | [Extraction prompt](../core/prompts-i18n.js) |
| Retrieval boosts importance and `should_persist`, in addition to relevance and recency. Default weights are 0.55 relevance, 0.20 importance, 0.15 persistence, and 0.10 recency. | Historically significant incidents can remain competitive after their temporary consequences end. | [Retrieval](../core/eventbase-retrieval.js), [defaults](../index.js) |
| Records contain `result` and `open_threads`, but no structured cross-event resolution lifecycle. | An earlier open concern can be injected without the later evidence that closes it. | [Event schema](../core/eventbase-schema.js) |
| Cast history selects a history spine that favors persistent and important events; NPC cards synthesize from that evidence. | Fixing topical retrieval alone can leave another route for the same distorted history. | [Injection and history selection](../core/eventbase-injection.js), [NPC cards](../core/npc-cards.js) |
| Summarizer Injection selects the most recent N events rather than applying the ordinary retrieval weights. | Changing those weights does not change which events this route selects. | [Summarizer Injection](../core/summarizer-injection.js) |
| Ingestion fingerprints and position-based coverage skip processed windows. | A new extraction prompt does not automatically repair stored events or recover previously omitted information. | [Workflow](../core/eventbase-workflow.js), [store](../core/eventbase-store.js) |

The distinction to preserve is: **an argument may remain important history while its resentment, uncertainty, or obligation is no longer current.** Historical importance and present applicability are separate properties.

## 2. Goals and boundaries

The design should:

- Preserve truthful historical recall, including difficult events and their lasting consequences.
- Represent what is currently established about relationships, commitments, routines, and projects.
- Prevent resolved conflicts from repeatedly appearing as current concerns during ordinary continuation.
- Protect user-defined canon from inferred personality changes.
- Repair existing memory without clearing extraction fingerprints, resetting auto-sync, or re-embedding every event.
- Remain usable with chats of 1,000+ messages and InlineSummary compaction.
- Make generated conclusions inspectable, editable, reversible, and scoped to the correct story.

This is not a sentiment filter. Negative events can be essential; positive scenes do not automatically resolve conflicts. Do not manufacture a happy relationship, erase abuse or betrayal, or infer that a concern ended because several messages passed without mentioning it.

## 3. Memory model

Use three complementary records:

| Record | Purpose | Update behavior |
|---|---|---|
| Historical event | What happened at a particular point in the story. | Preserve original text and source identity during repair. |
| Episode / consequence annotation | Which records describe one incident, which consequences remain active, and what explicitly resolved them. | Derived from cited evidence; can be corrected or withdrawn. |
| Current continuity state | What is presently established about a subject. | Update only the affected facts when supported by newer evidence or a user edit. |

### 3.1 Current relationship states

For a main character and two NPCs, maintain separate states for MC–NPC A, MC–NPC B, and NPC A–NPC B. A disagreement in one relationship should not automatically spread to the other two. Group commitments may additionally use a group subject.

Track concrete facts rather than a single numeric trust or affection score. Examples include relationship status, agreed boundaries, shared routines, business responsibilities, commitments, and specific unresolved concerns.

Illustrative rendered state:

> Alex and Morgan are committed partners. They resolved their disagreement about business workloads by agreeing that Alex handles bookkeeping and Morgan handles suppliers. Their weekend breakfasts are an established shared routine. No ongoing resentment is established by the available evidence as of event E87.

The last sentence expresses an evidence limit, not proof that resentment can never recur. When evidence is insufficient, render the uncertainty or omit the assertion.

Every generated fact needs source event references, an evidence digest, and an “as of” position. Maintain facts individually so a change to one supporting event invalidates the affected assertion rather than silently preserving stale prose.

### 3.2 Canon and user control

Separate user-authored canon constraints from generated continuity facts. Support an editor with source links, pin/unpin, correct, and remove actions.

- A pinned canon constraint cannot be overwritten by automatic synthesis.
- Observed anger in one scene does not establish “this character is hostile” or another permanent trait.
- Explicit relationship development can update mutable state, such as becoming married. It does not authorize unrelated changes to temperament or values.
- When evidence conflicts with a pinned constraint, flag the conflict for review rather than rewriting the constraint.
- User edits are marked as user-authored. They do not require fabricated event citations.

The model-facing block should identify canon constraints, current supported facts, and historical episodes separately. This improves the evidence presented to generation; it does not guarantee that every generation model will obey it.

### 3.3 Episode grouping and consequence status

Group multiple extracted records of the same incident under a stable episode identifier. Preserve all underlying event IDs for detailed recall.

Use `active`, `resolved`, and `unknown` for a consequence's status. Missing legacy metadata means `unknown`. Use `superseded` for an older state assertion replaced by a newer assertion; it does not mean an event never happened.

Resolution is specific to the consequence. A couple can reconcile emotionally while an unpaid debt remains active. Store separate consequences in that case rather than marking the entire incident harmless or finished.

Do not group every disagreement involving the same characters into one episode. Topic, chronology, explicit references, and source evidence must support the connection. A later new disagreement is a new episode unless the narrative explicitly reopens the earlier issue.

## 4. Proposed data contracts

These are illustrative contracts, not final API names. Existing EventBase schema version 1.3 remains the historical extraction contract; derived continuity has its own version.

| Proposed record / field | Required meaning |
|---|---|
| Event reference | `{ collection_id, event_id }`; include the backend namespace where necessary to avoid cross-backend collisions. |
| `continuity.version` | Version of the derived annotation, independent of extraction-window coverage. |
| `continuity.episode_refs` | Stable episode IDs related to an event. |
| Episode `source_refs` | Event references belonging to the incident; each link includes a digest of the evidence used. |
| Episode `consequences` | Concrete effects with a status, supporting refs, and resolution refs where applicable. |
| State `subject` | Character, relationship pair, group, or project, using stable subject IDs. |
| State `facts` | Individually cited assertions with origin, source digests, as-of position, and pinned status. |
| Repair checkpoint | Scope, repair version, input revision/digest, completed work, and pending work. |

Character alias groups currently provide a useful lookup foundation. Stable subject identity and behavior on alias merge/split need definition; display names alone are not sufficient durable relationship keys.

Recommended first implementation: keep generated state/episode bodies in a dedicated versioned continuity store, separate from NPC history cards and vector-search results. Small event payload annotations link to those records. Extension settings can support an initial local store, but export/import must include it. Moving the collection to another installation without the derived store should yield an explicit missing-state condition and allow reconstruction.

Keep large state bodies out of ordinary vector event results, and never insert them as ordinary events that could affect extraction coverage or the recent-event summarizer.

## 5. Retrieval and injection behavior

### 5.1 Ordinary scene continuation

1. Resolve the active chat/branch, locked collections, in-play characters, and relationship subjects.
2. Load eligible current states and user canon constraints.
3. Retrieve historical candidates using the existing dense, keyword, and agentic paths.
4. Attach episode/consequence annotations before final selection.
5. Fetch linked resolution evidence directly by reference, independent of similarity rank.
6. Consolidate duplicate records of the same incident into a compact episode view.
7. Reduce routine exposure of resolved temporary concerns while retaining relevant lasting facts.
8. Render current state and contextualized history within the configured budgets.

An old conflict must not be rendered with a current-looking open thread that is explicitly closed by later evidence. Preserve the original `open_threads` as archive data; use the derived lifecycle when rendering active concerns.

Example episode view:

> Resolved history — Alex and Morgan argued about unequal workloads. They later reconciled and agreed on separate responsibilities. The responsibility agreement remains current; the argument is not an established ongoing conflict.

### 5.2 Explicit historical recall

Queries such as “Do you remember our argument about the business?” should still find the original incident. Relax the resolved-episode exposure penalty for direct recall, preserve relevant detail, and include the outcome.

A query-mode signal can come from the planner or an explicit user control. Treat it as a bounded retrieval hint; uncertain intent must not cause historical records to disappear. The first release should use conservative downranking and contextualization rather than hard deletion or blanket filtering.

### 5.3 Resolution fetches must survive selection

Resolution evidence is a dependency of the incident being presented. Similarity thresholds, minimum-importance filters, cross-encoder ranking, and top-K trimming must not silently remove it after the link is established.

Budget the episode and its outcome together. If full detail cannot fit, include a cited compact episode or omit that historical episode while retaining current state. Do not inject only the confrontation because its resolution fell outside the token budget. If a linked record is missing, show that the outcome cannot currently be verified and invalidate the affected derived assertion.

### 5.4 Budgets and repeated exposure

Extend the existing shared EventBase budget to reserve capacity for current continuity before filling topical/cast history. A starting experiment is 250–500 estimated tokens across relevant relationship states, charged inside the configured envelope, not added on top. Choose a final default after measuring ordinary and group chats.

Summarizer Injection currently has a separate character budget. It needs the same lifecycle-aware rendering rules and explicit accounting for any outcome it adds. Avoid duplicate state blocks when both routes run.

An optional per-episode exposure cooldown can later reduce repeated historical reminders. Scope it to the chat/branch, allow explicit recall and new relevant evidence to bypass it, and never use it to hide active consequences or canon. It is secondary to accurate state and resolution handling.

## 6. Slice-of-life extraction profile

Offer a selectable profile alongside the existing story-change profile. Preserve custom prompts; do not silently replace a user's override. Display the effective profile/prompt in diagnostics.

Selection principle:

> Extract concrete information useful for future continuity, including established ordinary life, without requiring a dramatic change.

| Source scene | Useful memory | Avoid |
|---|---|---|
| Repeated weekend breakfasts | A supported shared ritual and any established preference. | One event for every identical breakfast. |
| Playful interaction | A specific nickname, shared joke, or established comfort/boundary. | Generic claims that all teasing proves affection. |
| College scene | Course enrollment, study arrangements, project progress, or a consequential deadline. | Recording every class attendance. |
| Business planning | An agreed division of responsibilities, a committed plan, or a concrete milestone. | Treating a plan as already completed. |
| Brief argument | The issue, explicit outcome, and any lasting consequence. | Inferring a permanent relationship deterioration. |
| Reconciliation | What was actually resolved and which agreement now applies. | Closing unrelated concerns. |

Assess future continuity value separately from dramatic intensity. Stable preferences, commitments, and practical progress should have a path into storage even when they are quiet scenes. If a new `continuity_value` field is introduced, both store and retrieval thresholds must honor it; changing the prompt alone while retaining incompatible importance gates would discard the new memories.

Profile output can use the existing event types initially, with explicit validation for any additional fields. Deduplicate repeated facts and update an established routine only when evidence adds or changes something. Preserve dates and multilingual behavior, and retain the existing rule that reasoning/planning blocks are not evidence of events.

## 7. Repairing existing Qdrant collections

### 7.1 Why a rebuild is unnecessary

Qdrant allows payload values to be updated on existing points by ID or filter. This supports adding lifecycle links while preserving event identity. [Qdrant Set payload API](https://api.qdrant.tech/api-reference/points/set-payload)

VectFox already exposes `updateChunkMetadata`, documented as not requiring re-embedding, and a separate `updateChunkText` path that does require re-embedding. The shared metadata wrapper also invalidates the character index. [Qdrant backend](../backends/qdrant.js), [vector API](../core/core-vector-api.js)

Verify the Similharity gateway's acceptance and round-trip behavior for the new fields before relying on the existing PATCH route. Qdrant capability alone does not prove that the gateway forwards every proposed field. A metadata-only repair should merge owned fields, preserve unrelated payload values, and leave text/vectors intact.

### 7.2 Proposed workflow: Review and repair memory

1. **Choose scope.** Select a chat's owned collection or an explicit collection set. Show which shared/locked collections are included.
2. **Inventory.** Read stored event text and metadata. Parse summaries from embed text where appropriate; summaries are not reliably duplicated as payload fields. Record source digests and a stable input revision.
3. **Order.** Within a conversation, use the stored timeline sort key or window position plus intra-window event order. Missing timing remains uncertain. Do not compare message indices across independent conversations.
4. **Analyze bounded batches.** Group candidate incidents, identify explicit outcomes, and construct relationship facts. Carry unresolved candidate links between batches, or perform targeted later-evidence lookups, so a resolution hundreds of events later can still be found.
5. **Preview.** Show proposed states, incident links, resolved consequences, and unknown cases with source references. Do not invent numeric model-confidence guarantees.
6. **Apply.** Save versioned derived records and update only owned event annotation fields. Preserve original summaries, hashes, source coordinates, `importance`, and `should_persist` during the initial repair.
7. **Refresh.** Invalidate relevant roster/state/card caches. Rebuild or revalidate affected NPC card facts before they are used again.
8. **Resume and undo.** Persist checkpoints; resume after interruption. Keep previous annotation/state revisions so the applied repair can be reverted without deleting original events.

This pass has its own version and work cache. It must not clear extracted-window fingerprints, change auto-sync start markers, advance the vectorization tip, or pretend that original messages were reprocessed. Extraction coverage and continuity repair coverage are different measurements.

Bound both provider cost and work per step. Reuse the configured generation rate gate, expose progress and cancellation, and perform no full-history LLM pass on every generation turn. Do not claim complete repair if the operation only sampled part of the evidence.

Handle concurrent auto-sync explicitly: freeze the input snapshot for one repair revision, verify digests before applying a batch, and queue newly arrived or edited evidence for the next increment. Repeated application of the same revision should be idempotent.

### 7.3 What repair can and cannot recover

Repair can contextualize information already stored: conflict records, reconciliation records, commitments, and explicit outcomes. It cannot reconstruct ordinary details that the earlier extractor never retained.

InlineSummary compatibility already expands originals stored on summary messages or through chat metadata references, including nested summaries. If those originals remain available, offer a later, optional continuity-only backfill over selected ranges. [InlineSummary expansion](../core/ils-expander.js)

That backfill should have its own coverage/checkpoint, avoid duplicating existing event records, and report which originals were actually recovered. Missing references or summary-only source material do not justify claiming raw-history recovery. Users can instead write or pin current-state corrections. Neither option requires deleting the old collection.

## 8. Shared policy across all memory routes

Create a common continuity resolver/renderer used by each route. Names such as `core/continuity-store.js`, `core/continuity-resolver.js`, and `core/continuity-repair.js` are proposed modules.

| Route | Required integration |
|---|---|
| Ordinary EventBase retrieval | Attach annotations, fetch outcomes, apply exposure policy, and budget episodes atomically. |
| Agent Mode | Carry scope and recall intent; do not allow planner filters to drop an already-required resolution. |
| Native Qdrant reranking | Use sufficient candidate overfetch; apply authoritative continuity handling after retrieval in the first release. Verify that server-side truncation does not starve useful alternatives. |
| Cast history spine | Select episode views and current continuity instead of repeatedly favoring raw conflict records. |
| NPC cards | Supply lifecycle-aware evidence. Include annotation/state revisions in source digests or explicitly invalidate affected cards; current digests do not include these proposed fields. |
| Summarizer Injection | Contextualize a selected incident with its outcome and remove closed concerns from its current-looking presentation. |
| Injection formats | Preserve lifecycle labels and outcomes in dense text, JSON, summary-only, and compact budget fallbacks. |
| Dry-run/debug tools | Show which facts, episodes, outcome dependencies, and exposure decisions produced the exact injected block. |

The roster's current slim records omit the proposed lifecycle fields. Extend that representation or resolve annotations through a side store; merely PATCHing Qdrant payloads will not make every route understand them.

## 9. Scope, compatibility, and invalidation

- **Branches and rewinds:** Current state must be computed for the active branch and horizon. Do not inject a reconciliation from later in a branch into an earlier scene.
- **Collection locks:** Include the eligible collection set in state/cache identity. A lock change cannot reuse a state synthesized from inaccessible evidence.
- **Cross-chat archives:** Message indices are local to a conversation. Require an explicit continuity relationship between archives, or expose separate source states rather than inventing one global timeline.
- **Chronology:** Story dates can help order evidence but may be missing or contradictory. Do not use real-world ingestion timestamps as proof of fictional chronology.
- **Edits and deletion:** Evidence digests must cover the fields actually used. Changed or missing sources invalidate dependent facts and links; reanalysis can restore them.
- **Aliases:** Merging/splitting subjects must migrate or invalidate relationship keys and show ambiguous cases.
- **Legacy events:** Missing lifecycle data stays unknown and readable. An extraction schema upgrade does not imply automatic re-extraction.
- **Backend capability:** Qdrant is the first durable metadata-repair target. Standard/Vectra needs a documented side-store fallback or an explicit unsupported-feature state where metadata is unavailable.
- **Exports:** Include derived records and their versions, or clearly mark that they require reconstruction on import. Do not silently present detached citations as verified facts.

## 10. Rollout

| Stage | Deliverable | Release condition |
|---|---|---|
| Immediate mitigation | Community guidance about importance/persistence weights and diagnostic comparison. | State clearly that this changes ranking, not memory contents or every injection route. |
| Foundation | Versioned derived store, user state editor, source validation, scope rules, and debug preview. | Pinned facts survive refresh; invalid evidence cannot produce a verified current state. |
| First functional release | Manual resolution links, episode views, reserved state budget, and integration into all active injection routes. | A known resolved conflict stays contextualized through every route and format. |
| Existing-memory repair | Bounded LLM analysis, preview/apply/undo, checkpoints, and incremental refresh. | Interrupted repair resumes safely without altering extraction coverage. |
| Prevention | Slice-of-life profile with compatible storage/ranking gates. | Ordinary continuity is retained without generating an event for every routine repetition. |
| Later refinement | Selective source backfill, optional exposure cooldown, and retrieval/performance tuning. | Measured benefit on representative long chats and no loss of explicit recall. |

Do not enable only the topical-search portion globally while other active routes still replay untreated records. Users should be able to preview the combined prompt before enabling automatic repair.

## 11. Acceptance criteria and evaluation

Use fixtures with a main character and two NPCs, interleaved business/college activity, several disagreements, and explicit recovery. Include both small fixtures and a long collection with thousands of stored events. These are planned tests, not results already obtained.

| Scenario | Expected result |
|---|---|
| Calm scene after an explicitly resolved disagreement | Relevant current state appears; any selected old argument includes its outcome. No closed concern is presented as active. |
| Direct request to remember the disagreement | Historical details remain available with the resolution. |
| Affection follows an argument without explicit closure | Status stays unknown or active according to evidence; affection does not fabricate resolution. |
| Emotional repair, unresolved financial obligation | Only the emotional consequence closes; the obligation remains represented. |
| Five records describe one incident | One episode view in ordinary injection, with all source records still accessible. |
| New argument involves the same pair | New evidence creates a new episode or explicitly reopens an identified consequence; it does not erase other relationship facts. |
| Resolution is outside top-K or has low importance | Dependency fetch includes it without requiring a vector-ranking win. |
| Budget is too small for full incident plus outcome | Compact contextualized episode or omission; never a dangling confrontation-only view. |
| Pinned canon conflicts with synthesized personality | Canon remains pinned; unsupported trait inference is rejected or flagged. |
| One pair argues in a three-person story | Other pairs' states do not change without evidence. |
| Rewind, branch, or collection-lock change | No future or out-of-scope state leaks into the prompt. |
| Cited source is edited or deleted | Dependent state/card facts become invalid and are refreshed. |
| Repair is canceled, resumed, applied twice, or undone | No duplicated derived records; original events and extraction coverage are preserved. |
| InlineSummary originals are missing | Repair works from available events; backfill reports the source limitation. |
| NPC cards or Summarizer Injection are enabled | The same lifecycle rules hold as in ordinary retrieval. |
| Custom extraction prompt or non-English chat | User override is respected; output remains in the appropriate language and required fields validate. |

Measure prompt-level correctness first: uncontextualized resolved conflicts, false active threads, state accuracy, citation validity, and explicit-recall coverage. Then compare multiple continuation samples with the same model/settings to assess unwanted conflict recurrence and canon adherence. Generation outcomes are variable; do not use one successful response as proof of a universal fix.

Also record token usage, provider calls/cost, repair completion, and retrieval latency. Compare against unchanged settings and the temporary weight mitigation.

## 12. Decisions for co-author review

1. Confirm the local derived-store/export approach or choose backend-backed storage before implementation.
2. Define stable subject IDs, alias migration, and how archives are declared part of the same continuity.
3. Choose the initial reserved state budget and the conservative resolved-episode downranking policy.
4. Decide how users identify immutable canon constraints and intentional character evolution.
5. Decide whether the slice-of-life profile launches with repair or follows immediately afterward.

Recommended priority is current states plus explicit outcome links and repair, with full injection-route coverage. The extraction profile prevents future missing evidence; it cannot retroactively fill gaps on its own.

## Appendix: Community notice draft

> We have identified a memory issue that can affect long-running slice-of-life and relationship RP: old dramatic events may receive enough importance and persistence weight to keep resurfacing after the story has moved on.
>
> As a temporary measure, try lowering the EventBase reranking weights for Importance and Persistence, then compare your retrieval/debug output. Save your previous settings so you can restore them if useful foundational memories become harder to retrieve.
>
> This changes retrieval ranking; it does not delete or rewrite stored events, mark conflicts resolved, or change every memory injection route. Summarizer Injection selects recent events separately, and NPC/cast history can still include important older incidents. There is no single tested replacement preset yet.
>
> We are exploring current relationship states, explicit resolution links, and a repair pass for existing collections so users can improve memory without rebuilding their full chat history. These changes are still proposals.
