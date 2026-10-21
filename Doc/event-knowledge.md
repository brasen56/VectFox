# Phase 4a: fact-specific knowledge attribution

New built-in extractions use EventBase schema **1.4** and may include the optional
`knowledge` object below. No database migration, historical re-extraction, ledger
proposal, or MWT write is performed. Existing event IDs, user edits and continuity
links are not changed. An explicitly scoped/reviewable historical backfill remains
future work.

```json
{
  "knowledge": {
    "v": 1,
    "presence": [
      {
        "character": "Ranger",
        "status": "present",
        "evidence": [{ "source_index": 0, "quote": "Ranger watched Alex deliver the sealed letter." }]
      }
    ],
    "acquisitions": [
      {
        "character": "Ranger",
        "claim": "Alex delivered a sealed letter.",
        "basis": "witnessed",
        "epistemic_status": "fact",
        "uncertainty": "",
        "evidence": [{ "source_index": 0, "quote": "Ranger watched Alex deliver the sealed letter." }]
      }
    ]
  }
}
```

## Contract

- Presence status: `present`, `mentioned`, `absent`. Presence is optional evidence,
  not permission to attribute knowledge. Acquisition does not require physical presence.
- Basis: `witnessed`, `told`, `document`, `rumor`, `institutional_access`, `other`.
  The quote must support the basis; affiliation alone grants no institutional access.
- Epistemic status: `fact`, `belief`, `rumor`. These distinguish established facts
  from received claims and rumors. `belief` denotes a received/non-established claim,
  **not proof the recipient accepted it**; phrase `claim` accordingly and retain any
  stated deception, doubt or acceptance in `uncertainty`. A rumor basis requires rumor
  status. No model confidence score is invented.
- Each entry requires at least one non-empty quote and source index. `source_index`
  is the zero-based ordinal into the event's `source_messages` provenance array
  (or legacy `source_message_ids`), **not** an expanded/live chat coordinate.
  Extraction labels the immutable input window `[S0]`, `[S1]`, etc. Ingestion—not
  the model—captures host IDs, content fingerprints and expanded-coordinate hints.
- Bounds: 64 presence entries, 64 acquisitions, 16 evidence references per entry;
  character 200, claim 2000, quote 2000, uncertainty 1000 JS string characters.
- Missing/null knowledge means **unknown attribution**, not “nobody knows.” Empty
  arrays mean attribution was recorded with no supported entries. Never derive
  acquisitions or witnesses from `characters`, presence, or an event summary.

The shared validator rejects malformed versions, entries, enum values and source
indices. Extraction additionally checks quotes against cleaned narrative text,
excluding reasoning/system blocks, with Unicode/whitespace normalization. Invalid
attribution is dropped as a whole while retaining usable event history. Direct
storage and both import paths reject invalid attribution before embedding/writes.
Import validation cannot re-check unavailable originals and never claims to do so.
Export retains full metadata, including attribution and provenance.

## Public API

This is an additive extension of API version 1. `getStatus()` advertises
`capabilities.knowledge_acquisition` with `schema_version: 1`. Each `findEvents()`
record has `knowledge_status: recorded | unknown | invalid` and validated
`knowledge` (or null). Evidence gains a scope-bound `source_ref` string referencing
the event's issued `source_refs`; pass those strings to `resolveSources()` using
the response scope token. Evidence remains unresolved until that call verifies it.
Results remain detached snapshots. Source references can be unavailable, changed,
or ambiguous; knowledge attribution must not override those statuses.

Custom prompt templates are preserved, not rewritten. Their excerpts receive
source labels, but custom templates must opt into this contract themselves;
outputs without knowledge remain unknown. All built-in language/profile variants
receive the shared structural rules; claim/quote text stays in the excerpt language.
Knowledge is payload metadata, not serialized into the summary embedding text.
Native backends that discard event metadata cannot preserve or expose attribution.

## Verification and remaining evaluation

Automated fixtures cover sealed contents, mention-only characters, explicit and
unsupported off-screen acquisition, lies, rumors, partial disclosure, and mere
institutional affiliation. Tests cover validation, generation/source binding,
storage, import preview and refusal, JSON preservation, API citations, legacy
unknowns, snapshot isolation, and both built-in profiles in all language modes.

These are deterministic contract tests with expected model outputs. A matching
quote proves neither semantic entailment nor extraction completeness. Before 4b
or replacing any extraction, run representative live-model comparisons and record
per scene/NPC: expected acquisitions, returned claims, correctly supported additions,
unsupported additions, **missed knowledge**, source availability, model/profile,
calls and token usage. Review sealed contents, whether claims were merely heard
versus believed, and which part of a disclosure actually reached each recipient.
No automatic scanner suppression or ledger replacement is enabled by this phase.