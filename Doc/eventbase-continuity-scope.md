# EventBase continuity: phased scope

**Status:** Scope proposal, revision 1, 2026-10-12. Nothing is implemented yet.
**Responds to:** [eventbase-continuity-design.md](eventbase-continuity-design.md), the co-author's proposal. This document turns it into phases, and adds measurements taken from a real long-running collection.

**Already decided:**
- Resolution handling is on by default in the built-in extraction prompt. It is not an opt-in profile.
- Conflicts that are fully resolved are downranked by default.

## Summary

| Phase | Ships | Main effect | LLM cost |
|---|---|---|---|
| 0 | Revised community notice | Gives users a mitigation that actually works today | None |
| 1 | Shared continuity renderer for all routes, plus downranking of resolved conflicts, plus resolution-aware extraction | New events link to what they resolve, and every route shows outcomes | No extra calls; about 300–700 more input tokens per extraction call |
| 2 | Repair of existing collections: resolution links, duplicate marking, manual "mark resolved" | Existing collections get links without being rebuilt | Bounded and resumable, with an estimate shown first (about 1.3–2M input tokens for the measured collection) |
| 3 | Slice-of-life extraction profile (opt-in) | Quiet continuity gets stored: routines, agreements, preferences | None beyond normal extraction |
| 4 | Deferred design-doc items | Relationship state, episodes, cooldown, backfill | To be measured |

Phase 1 is useful on its own for new events. Phase 2 is what fixes collections that already exist.

The order differs from the design doc in three ways:
- **Rendering moves into the first release.** Without it, links change nothing that the model sees.
- **The relationship-state store moves to Phase 4.** Phase 4 also builds it on NPC cards rather than as a parallel store.
- **The derived data lives in one namespaced field on the event, not in a separate store.**

## What the measurements changed

These numbers come from a read-only analysis of the primary maintainer's live collection:
- 5,537 events.
- Windows of 15–20 messages, with up to 10 events per window.
- Minimum store importance 2.
- Mostly long slice-of-life and relationship play with three leads.

| Measurement | Implication |
|---|---|
| About 1,200 events read as conflicts and about 430 as resolutions. Both average importance about 6.7. Another 160 events contain both a conflict and its outcome. | In this collection, resolutions are stored. The main failure is how events are shown, not what is extracted. Small default windows (2 messages, 3 events) may still lose resolutions; this collection can't show that. |
| 18 conflicts were sampled and read by hand: 4 were not interpersonal, 4 had a clear stored resolution, 3 had a partial one, and 7 had none nearby (often ongoing arcs). | Repair has real material. It might link a few hundred of about 1,050 conflicts. Some conflicts are genuinely unresolved in the story and must stay open. |
| "Same characters, shortly after" is mostly base rate. 79% of conflicts have a resolution-worded event within 40 messages after, and 71% have one within 40 messages before. | A heuristic can't link a conflict to its resolution. Linking needs an LLM judge, and candidate selection only narrows the field. |
| Median similarity between a conflict and its best later resolution is 0.69. A threshold of 0.6 keeps 93% of them. | A resolution is usually not similar enough to be retrieved together with its conflict, so rendering must fetch the resolution by ID (design doc §5.3). 0.6 is a reasonable pre-filter. |
| 88% of events (4,864) carry `open_threads`, 9,649 threads in total. None are ever closed, and every route shows them as current. | The cheapest broad fix is rendering threads as "open at the time". Closing threads is the repair's job. |
| `should_persist` is true on 96% of events. | The persistence weight is almost a constant. Lowering it barely changes ranking. The cast spine's "persistent or importance ≥ 7" stage admits nearly every event. |
| About 200 (cosine ≥ 0.92) to 320 (≥ 0.90) events are re-extraction copies of a window already stored. Real paraphrased copies measure ≥ 0.91. About half of the copy pairs escape the retrieval dedup because their type or name spelling differs. | A cheap cleanup fits in the repair pass, which reads the same vectors anyway. Copies are not skewed toward conflicts (18% of copies vs 19% of all events), so this is a quality fix, not the cause of the conflict problem. Copies dropped to 2 in September and 9 in October, so the cause appears mostly fixed. |
| Repair scope on this collection: every event with open threads is 4,864 events (about 1,216 calls, about 5.7M input tokens). Conflict-type events with open threads and importance ≥ 6 are 1,660 (about 415 calls, about 2.0M). The same with importance ≥ 7 is 1,094 (about 274 calls, about 1.3M). | The repair needs a selectable scope and an up-front estimate. The default should be conflicts-only. |

## Data model: the `continuity` payload key

Every phase reads and writes the same small object, stored in the event's payload under one key.

```json
"continuity": {
  "v": 1,
  "resolves": [
    { "event_id": "eb_…", "threads": [0, 2], "threads_digest": "k3f9a", "how": "Derek admits his mistake and Alex stays.",
      "origin": "extraction", "run": null, "status": "active" }
  ],
  "closed_threads": { "threads": "all", "threads_digest": "p01zz", "how": "Settled in the same scene.",
      "origin": "repair", "run": "r1", "status": "proposed" },
  "duplicate_of": { "event_id": "eb_…", "origin": "repair", "run": "r1", "status": "active" }
}
```

Rules:

- **One key, written whole.** The Similharity metadata PATCH goes to Qdrant's set-payload. That call merges top-level keys and leaves vectors and text alone, but it replaces a top-level key as a unit. Merge in JS from the roster copy, then write the full object. The design doc's open question about whether the gateway forwards new fields is answered: it does, for top-level keys. Read-back still has to be added (see Phase 1A).
- **A link is stored once, on the event that resolves.** The roster index builds the reverse map (`resolvedBy`) in memory when it loads. Extraction never writes to older events. That avoids PATCH traffic during auto-sync and races with it.
- **Two kinds of closure stay on the conflict itself.** These are an outcome inside the same record and a manual "mark resolved". Both use `closed_threads`.
- **`threads` are indices into the conflict's stored `open_threads`, or `"all"`.** `threads_digest` hashes the conflict's thread list. If the conflict's text or threads are later edited, the link goes inactive, and the dry-run shows it.
- **Only `status: "active"` affects rendering or ranking.** `"proposed"` entries appear only in the repair preview and in the dry-run.
- **`run` identifies a repair run, so undo removes exactly that run's entries.**
- **A link is honored only when both events are in the collections eligible for this generation.**
- **Original fields never change.** That covers summary, `open_threads`, importance, `should_persist`, hashes and coordinates. Extraction fingerprints, auto-sync markers and the vectorization tip are untouched as well.
- **Embed text is unchanged, so nothing is re-embedded.**

How an event's state is derived (shared helper, Phase 1A):
- **Closed threads:** the union of active `closed_threads` and the threads named by active incoming `resolves` links.
- **Fully resolved:** every thread is closed, or a link names `"all"`. A partial resolution closes only the threads it names.
- **Resolution text:** for each resolver, the first sentence of its summary (capped at about 200 characters) plus its message position, or the link's `how` text when the resolver isn't loaded.

## Phase 0: community notice (Completed)

Edit the appendix draft in the design doc:

- Tell users to lower the **Importance** weight. Say that the Persistence weight has little effect, because nearly every event is marked persistent (96% in a 5,500-event collection).
- Keep the note that Summarizer Injection and the cast lane are not affected by the weights.
- Drop the promise of relationship states in the first release. Promise resolution links and a repair pass instead.

## Phase 1: continuity in every route, and in new extractions

### 1A. Shared renderer (ships first)

New module `core/continuity.js`:
- `getContinuityView(event, rosterIndex)` returns the remaining open threads, the closed threads, the resolutions and the fully-resolved flag.
- `renderResolution(view)` returns the one-line text.

The roster has to keep the fields this needs:
- `slimEvent` ([character-roster.js:34](../core/character-roster.js)) adds `open_threads`, `continuity` and `timeline_sort_key`. It currently drops them, so a PATCHed field would reach no route.
- The reverse map is built when the index loads and updated through the existing `upsertCharacterEvents` and `pruneCharacterEvents`.

| Route | File | Change |
|---|---|---|
| Dense text, JSON, summary-only | [eventbase-injection.js:67](../core/eventbase-injection.js) `_cleanEventForInjection` and the three formatters | `open_threads` becomes `open_threads_at_the_time`, listing only the remaining threads. A `resolution` line is added when one exists. Summary-only gets the `resolution` line only. |
| Injection header | [eventbase-injection.js:176](../core/eventbase-injection.js) `INJECTION_HEADER` | One sentence: threads were open when the event happened, and a resolution line means a later event settled them. |
| Cast lane | [eventbase-injection.js:393](../core/eventbase-injection.js) `formatCastHistoryDetailed`, `line()` | Append "— later resolved: …" to the same line. The spine and the budget then charge for the outcome together with the conflict, so it can't be trimmed away on its own (design doc §5.3). |
| Cast spine | [eventbase-injection.js:352](../core/eventbase-injection.js) `selectHistorySpine` | Fully resolved events skip the "persistent or important" stage but can still enter in the gap-fill stage. This is controlled by the downrank setting in 1B. |
| NPC cards | [npc-cards.js:28](../core/npc-cards.js) `sourceRecord`, `npcCardPrompt` | Add `resolution` text to the source record only when present. `JSON.stringify` omits undefined fields, so digests change only for linked events, and per-fact gating then refreshes only the facts that cite them. Prompt line: an event marked resolved is history, not a current state. |
| Summarizer Injection | [summarizer-injection.js:371](../core/summarizer-injection.js) `_detailLines` | Same labels and resolution line. Falls back to `how` text when the roster isn't ready. |
| Planner candidates | [prompts-i18n.js:996](../core/prompts-i18n.js) `_formatCandidateLine` | Tag fully resolved candidates `[resolved]`. |
| Dry-run | [eventbase-retrieval-debug.js](../core/eventbase-retrieval-debug.js) | For each injected event: threads closed, resolution source, link origin, inactive links (digest mismatch, ineligible collection), and whether it was downranked. |

Release condition: a fixture conflict with an active link shows its outcome in dense text, JSON, summary-only, the cast lane, NPC card evidence and Summarizer Injection, and no route shows the closed threads as open.

### 1B. Downrank fully resolved conflicts

- In [eventbase-retrieval.js](../core/eventbase-retrieval.js), after `_finalScore` is computed on both paths (JS weighted sum and native formula, around lines 578–606) and before duplicate suppression: multiply by `eventbase_resolved_downrank`. Proposed default is 0.85. 1 turns it off.
- The factor is multiplicative, so it behaves the same on the native path, where scores sit around 0.8–1.5, and on the JS path, where they sit around 0.2–0.6.
- The native path returns an overfetched pool before the JS trim. Downranking only lowers scores, so that pool is enough.
- **Recall bypass (Agent Mode):**
  - The planner prompt gets an optional `recall_past_event: true` for messages that explicitly ask about a past event. This goes in the [prompts-i18n.js](../core/prompts-i18n.js) planner header, all language variants, with parsing in [agentic-retrieval.js](../core/agentic-retrieval.js).
  - When it is set, the factor is skipped for that turn.
  - Without Agent Mode there is no bypass. The factor is mild, and the event still carries its outcome when retrieved.
- Partially resolved events are never downranked.
- This has no effect on existing collections until Phase 2 creates links.

### 1C. Resolution-aware extraction (default prompt)

**Placeholder.** Add `{{openIssues}}` to the built-in prompt for all six language variants. It sits next to `{{knownCharacters}}`, with a localized intro line in `getEventBaseExtractionPrompt` ([prompts-i18n.js:928](../core/prompts-i18n.js)). `buildExtractionPrompt` ([eventbase-schema.js:333](../core/eventbase-schema.js)) substitutes it. It renders "(none)" when the roster isn't ready or nothing qualifies.

**Selection** (`selectOpenIssues` in `core/continuity.js`):
- Draw from the target collection's roster events that come before the window (`source_window_end < windowStart`), still have open threads, and share an alias group with a character named in the window. Use the scene-cast matcher for that.
- Prefer interpersonal types (`relationship_change`, `dialogue_significant`, `betrayal`, `promise_or_oath`, `character_state_change`), then the most recent.
- Cap the list with `eventbase_open_issues_max` (default 6), at about 600 tokens.
- Each line: `I3: [message 6674, importance 7] Alex packs a suitcase… | threads: (0) Will Alex actually leave the loft? (1) …`.
- When the leads appear in every event, this becomes "most recent unresolved". That's acceptable, because the model decides.

**Prompt rules.** Add a new rule after Rule 4, plus adjustments to the gates:
- "If the excerpt clearly settles, answers, or reverses a listed open issue, add `resolves`: `[{"ref":"I3","threads":[0],"how":"short outcome"}]` to the event that does so. Cite only listed refs. Name only the threads actually settled. Affection, time passing or a calm scene is not a resolution unless the excerpt shows the issue was addressed."
- Gate 1 exception: an event that resolves a listed issue passes Gate 1. A reconciliation returns the story to an earlier state, and the "would the story read the same" test otherwise rejects it.
- Importance: a resolution scores within 1 of the issue it closes. The list shows each issue's importance.
- When an excerpt contains both the conflict and its outcome, extract one event with the outcome in `result`, and keep only the questions still open in `open_threads`.
- Retain the reasoning-block rule. A planned reconciliation in a reasoning block is not a resolution.

**Validator** ([eventbase-schema.js:152](../core/eventbase-schema.js)):
- Accept an optional `resolves` array (ref format `I<n>`, integer thread indices within bounds, `how` capped at 200 characters).
- [eventbase-extractor.js](../core/eventbase-extractor.js) maps refs to event IDs with the window's own ref map. Unknown refs are dropped with a warning.
- It writes `continuity.resolves` with `origin: "extraction"` and `status: "active"`.
- The insert path already spreads event fields into the payload ([eventbase-store.js:371](../core/eventbase-store.js)), so storage needs no change. The roster upsert after insert updates the reverse map within the session.

**Limits and notes:**
- **Backfill.** Bulk extraction runs windows in parallel, so a window's list only includes events already stored. Links made during a backfill are incomplete, and Phase 2 covers them. Sequential auto-sync during play is where this works best.
- **Custom prompts.** They are unchanged unless they contain `{{openIssues}}`. The settings textarea shows the full default and saves it once edited ([ui-manager.js:4716](../ui/ui-manager.js)), so anyone who tweaked anything holds a frozen copy of the old default. Diagnostics should say "open-issue context: off (custom prompt has no {{openIssues}})", and the settings panel should offer a comparison with the current default.
- **Backends.** This needs a backend that stores metadata (Qdrant, or Standard with the Similharity plugin). Native Vectra stores only hash, text and index, so links would be lost. Show an "unsupported" state there.

## Phase 2: repair existing collections

All repair runs from an EventBase-tab action, "Review and repair memory". It is for one collection at a time and needs a backend that can write metadata.

### 2A. Resolution links

1. **Scope and estimate.** Choose a scope, then show the counts, calls, input tokens and model before anything runs:
   - **Conflicts only (default).** Interpersonal types, with open threads, at importance ≥ 6. The importance floor is adjustable. This filter doesn't depend on story language.
   - **Every event with open threads.**
   - Either scope can be narrowed to a character pair or a message range.
   - For the measured collection the default scope is 1,660 events, about 415 calls and about 2.0M input tokens.
2. **Inventory.** Use the roster index, which already lists every event, with the Phase 1A fields. Fetch the stored vectors once through the export path's `fetchChunksWithVectors` ([collection-export.js](../core/collection-export.js)). That avoids embedding calls; 5,500 vectors of 1,024 dimensions is about 22MB. Freeze the scope as a set of event IDs.
3. **Candidates (no LLM).** For each conflict, take later events in timeline order within the same collection and a look-ahead of 300 messages. Keep those that share a character group and have similarity ≥ 0.6, and take the top 5.
4. **Judge.** Batch 4 conflicts per call, each with up to 5 candidates (summary, result, threads). For each conflict the model returns either the resolving refs plus the threads closed and a short `how`, or `self_closed` when the conflict's own result already settles it, or nothing. Refs are validated against the offered set.
5. **Store proposals.** Each batch writes its proposals right away as `status: "proposed"` with the run ID. Qdrant is the durable store, so the repair can resume. Settings hold only a small checkpoint: `eventbase_continuity_repair[collectionId] = { run, cursor, counts, model }`.
6. **Preview.** A paginated list showing both summaries, filterable by character, with accept or reject per link and "accept all".
7. **Apply.** Flip accepted entries to `active`. That's one PATCH per affected event. Update the roster in place. NPC card facts that cite changed events are gated out until the card refreshes, which stays within the existing 4-call cap per card.
8. **Undo.** Remove a run's entries.

Constraints:
- **Rate gate.** Calls go through the generation rate gate under a new lowest-priority label, `repair`, below `npc-card`. Like `npc-card`, it never takes the last slot ([generation-rate-limiter.js:46](../core/generation-rate-limiter.js)). Pause, resume and cancel are available.
- **Model.** The extraction provider and model by default, with an optional override.
- **New events.** Events that arrive during a run fall outside the frozen scope; Phase 1C handles them.
- **Writes.** Before each write, re-read the roster copy and merge. The plugin has no compare-and-set, so the design assumes one active writer (one open tab).
- **Coverage.** Extraction coverage is not touched. The repair has its own version and checkpoint.

### 2B. Duplicate marking (no LLM)

This uses the vectors the inventory already fetched.
- **Finding copies.** Events whose source windows overlap and whose similarity is ≥ 0.92 are treated as copies. The copy that holds `continuity` links stays canonical, or otherwise the earliest-created one. The other copies get `duplicate_of`, first as proposed and then active after preview.
- **Effect.** Retrieval (after the native or JS query), the roster, the cast lane, NPC cards and Summarizer Injection all skip active duplicates. Card facts that cite a duplicate are gated out and refresh.
- **Purge.** Permanently deleting marked duplicates is a separate, later action with its own confirmation.
- **Expected count.** About 200 events in the measured collection.

### 2C. Manual controls

In the database browser, each event gets:
- "Mark resolved" (all threads or selected ones), written as `closed_threads` with `origin: "user"` and `status: "active"`.
- "Unmark".
- "Show what resolves this".
- "Remove link".

This covers conflicts resolved off-screen, and links the judge missed.

Release condition: an interrupted repair resumes without duplicating proposals, applying twice is a no-op, undo restores the earlier `continuity` state, and the fingerprint, marker and tip maps are unchanged.

## Phase 3: slice-of-life extraction profile

- **Setting.** `eventbase_extraction_profile`: `story` (default) or `slice_of_life`. A custom prompt overrides it, and diagnostics show the effective profile.
- **What the profile changes:**
  - It swaps the text of Gate 1 and Gate 3 and the importance guidance, so established routines, agreements, preferences, nicknames, commitments and project milestones get stored.
  - These score 3–5, so they clear the default store floor of 3. The design doc's warning about the store floor is met without adding a `continuity_value` field.
  - The rule is one event for each new or changed routine, never one per repetition.
- **Languages.** All six variants.
- **Before it is offered.** Measure on a fixture chat how many more events the profile produces, both at the default window (2 messages, 3 events) and at 20 messages and 10 events.

## Phase 4: deferred design-doc items

| Design-doc item | Plan | Reason |
|---|---|---|
| Relationship states with a reserved budget (§3.1, §5.4) | Later, as a "current relationship with {lead}" section on NPC cards | Cards already have capped incremental refresh and per-fact citations. A parallel store needs subject IDs, per-pair synthesis and branch scoping before it helps. |
| Canon constraints and pinning (§3.2) | With relationship states | It needs a state to pin. Character cards and lorebooks hold canon today. |
| Episode grouping (§3.3) | Later | Resolution links and duplicate marking cover the visible symptoms first. |
| Separate derived store in extension settings (§4) | Not planned for now | The payload key is enough, and settings.json already carries many per-chat maps. |
| Exposure cooldown (§5.4) | After Phase 2 | Measure repeated exposure once links exist. |
| InlineSummary continuity backfill (§7.3) | Later | Rare, and independent of the rest. |
| Stable subject IDs and alias migration (§4, §9) | With relationship states | Links key on event IDs, which are already stable. |

## Verification

**Unit tests (vitest).** Existing suites to extend: [eventbase-injection-order.test.js](../tests/eventbase-injection-order.test.js), [eventbase-retrieval.test.js](../tests/eventbase-retrieval.test.js), [character-roster.test.js](../tests/character-roster.test.js), [generation-rate-limiter.test.js](../tests/generation-rate-limiter.test.js). New cases:
- Continuity view:
  - Partial vs full resolution.
  - Ineligible collection.
  - Digest mismatch makes the link inactive.
  - Proposed entries are ignored.
- Rendering:
  - Every format renders the remaining threads and the resolution line.
  - The cast line charges for the outcome together with the conflict.
  - The Summarizer Injection formatter matches.
- Ranking and cards:
  - The downrank is applied once on each path; the recall bypass and partial resolutions are exempt.
  - NPC card digests change only for linked events.
- Extraction:
  - The validator maps refs and drops unknown refs and out-of-range threads.
  - `{{openIssues}}` is substituted, and custom prompts without it are untouched.
- Repair:
  - Resume from the cursor.
  - Applying twice is idempotent.
  - Undo by run ID.
  - Fingerprint, marker and tip maps are unchanged.
  - The duplicate threshold and the choice of canonical copy.

**Fixture chat** (three characters):
- An argument, then a reconciliation 30 messages later.
- Emotional repair alongside a debt that stays unpaid (a partial resolution).
- Affection with no closure (stays open).
- A new argument between the same pair later (must not link to the old one).
- Five extracted records of one incident (duplicate marking).

**Real collection** (the measured one, after Phase 2):
- Read 50 accepted links. Target: at least 90% judged correct.
- Rerun the 18-conflict sample.
- Dry-run five representative scenes before and after. Count injected events that show a thread as open even though an active link closes it. Target: zero.
- Log calls and tokens per repair run against the up-front estimate.

## Risks and open questions

1. **No positional horizon check.** `source_window_end` can be in stale coordinates on InlineSummary or slimmed chats. The measured collection reaches message 9329 while the live chat expands to 3615. Filtering resolutions by position would hide valid ones. As a result, a resolution extracted on a sibling branch that shares the collection can appear in another branch. Ordinary retrieval already injects sibling-branch events today, so the leak isn't new, but resolution lines make it more visible. Revisit with branch-aware coverage.
2. **Judge precision.** The judge works from summaries, which can overstate. Mitigations: preview, closing individual threads, visibility in the dry-run, undo, and the manual controls.
3. **No compare-and-set on payload writes.** Two sessions writing the same event means the last write wins. The repair UI should warn when a second tab has the repair open.
4. **Export.** Single-collection export spreads the full metadata and keeps `continuity`. Multi-collection export maps a fixed list of fields ([collection-export.js:280](../core/collection-export.js)) and drops `continuity`. It seems to drop other EventBase fields as well, which is worth checking separately.
5. **Defaults to settle:** downrank factor 0.85, the open-issues cap of 6, the 300-message look-ahead, similarity ≥ 0.6 for candidates, and ≥ 0.92 for duplicates. Tune each with dry-runs on the measured collection once Phase 2 has produced links.

**Decisions for the co-author:**
1. Downrank default factor (0.85 proposed), and whether resolved events skip the spine's importance stage by default.
2. Whether links created during extraction are active immediately (recommended, since they are visible in the dry-run and removable) or start as proposed.
3. Default repair scope: conflicts only at importance ≥ 6 (recommended) or every event with open threads.
4. Duplicates: mark only in Phase 2 (recommended), with purge as a later explicit action.
5. Model-facing field names: `open_threads_at_the_time` and `resolution`.
