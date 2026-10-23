# Phase 4C measurement tooling — 2026-10-23

Episode grouping remains deferred pending the scope's post-Phase-2 measurement.
This increment collects reviewable evidence; it does not create memberships,
change selection, write annotations or decide a materiality threshold.

## Collect the five scenes

1. Apply/review Phase 2 resolution links and duplicate marks first. Use the same
   five representative scenes, chat contexts, locked collections and settings as
   the parent verification. The tool cannot verify this prerequisite for you.
2. Open **Query Tester**, enter the representative message and run the pipelines.
   Wait for roster warming to finish before collecting. Export using
   **Export Phase 4C measurement JSON**. Save each download under a distinct name.
3. The export includes the exact final EventBase rendered block, distinct final
   main/cast history records, lane attribution, duplicate status, lifecycle views,
   collection/source coordinates and a small settings/context snapshot. It does
   not export API keys or vectors. It DOES contain private story text and chat
   identifiers: review/redact before sharing, preserving quotes used for review.
4. Query Tester uses current chat context, not an automatic historical rewind.
   Restore the intended context yourself. Existing retrieval/planner services may
   make network/model calls. Capture/export and offline reporting add none.

## Review and report

Create a JSON bundle with `phase2Applied: true`, `settingsMatched: true`, and a
`scenes` array containing exactly five objects. Each scene has a unique `sceneId`,
the exported JSON object as `capture`, and a `review` array. Review every captured
non-duplicate record exactly once. A review row has this shape:

```json
{
  "eventId": "the captured event ID",
  "incidentId": "reviewer-assigned-loan-argument",
  "outcome": "present",
  "quote": "an exact excerpt from capture.injectionText showing the outcome",
  "note": "Why this record belongs to this incident and how the outcome is represented."
}
```

Use the same `incidentId` for distinct perspectives/stages of ONE incident.
Different arguments involving the same people need different labels. Labels are
local review data, not persisted episode IDs. Never infer membership solely from
shared characters, source proximity or resolution links.

`outcome` is `present`, `absent`, or `not_applicable`. Use `absent` when a known
outcome is missing from this incident's rendered context; explain the source of
that known outcome in `note`. Use `not_applicable` when no outcome is established
or expected, rather than inventing closure. For `present`, supply a verbatim quote
from the exported block. An outcome elsewhere in the block can contextualize more
than one record; judge the whole rendered incident, not just standalone summaries.
Partial reconciliation must not be reviewed as closure of unrelated consequences.

Run from the repository root:

```sh
npm run measure:episodes -- /absolute/path/to/review-bundle.json
```

The JSON report counts distinct non-duplicate records per incident, incident
co-injections per scene, scenes affected, and reviewed missing-outcome records.
Cross-lane appearances of one ID count once. Exit 0 means the review is complete,
2 means prerequisites/review are incomplete, and 1 means invalid input/read failure.
Counts in an incomplete report are provisional, not a passing baseline.

## Limits and decision

- This measures EventBase retrieval main/cast history, including the shared
  ordinary/native-Qdrant/Agent post-formatting path, NOT actual committed prompt
  exposure. It does not cover Summarizer Injection or synthesized NPC-card facts.
  If those routes matter in the five scenes, inspect them separately and record
  that evidence before making a Phase 4C launch decision.
- Lifecycle closure is diagnostic evidence, not proof that an outcome reached the
  rendered text. Human review plus the text quote is required. Quotes are checked
  for presence, not semantic correctness. Membership precision is not automated.
- The settings snapshot is intentionally partial. Preserve the full relevant
  non-secret retrieval configuration alongside the report and manually confirm
  parity. Metadata-unsupported/unready rosters block a complete report.
- A complete five-scene report is not an automatic authorization. Review whether
  remaining co-injection/missing outcomes are material, document that decision,
  and only then settle descriptor ownership/reconciliation/export before grouping.
- Existing roster event identity merges matching event IDs across collections;
  this export follows that identity contract and records collection attribution.
  It cannot disambiguate unrelated records sharing the same event ID.

No live-collection measurement or browser/backend validation is claimed here.