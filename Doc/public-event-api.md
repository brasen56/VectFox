# VectFox public event API — version 1 (Phase 0)

`window.VectFoxAPI` is installed during module loading. Check `version` and
`getStatus()` when connecting; subscribe to the host event bus event
`vectfox:api-status-changed` for readiness and scope invalidation notifications.
Absence of the global means the extension is not installed/loaded.

## Read history

```js
const api = window.VectFoxAPI;
const status = api.getStatus();
const result = await api.findEvents({
    subjects: [{ name: 'Alex', aliases: ['Alexander'] }, { name: 'Ranger' }],
    match: 'all',
    types: [],
    mode: 'history',
    scope: { kind: 'current_chat' },
    scope_token: status.scope_token,
    limit: 100,
});
if (result.ok) {
    const originals = await api.resolveSources({
        scope_token: result.scope_token,
        sources: result.events.flatMap(event => event.source_refs).slice(0, 500),
    });
    console.log(result, originals);
}
```

The default scope reads enabled event collections locked to the loaded chat and
includes only records stamped with that exact source chat ID. Legacy records with
unknown source chat IDs are reported in coverage, not silently assigned to this
chat. Explicit `{ kind: 'selected_collections', collections: ['collection ID'] }`
scope includes other source chats from the selected enabled registered event
collections. This is the consumer's explicit continuity selection, not automatic
branch merging. No cross-chat original messages are loaded.

History ignores injection thresholds, recent-context suppression and Top-K.
Subject aliases are alternatives within one person; `all`/`any` applies between
people. Ambiguity returns `ambiguous_subject` with candidates. Full stored event
fields, opaque event citations, source references and `continuity_view` are
returned. Active duplicate events are excluded. Ordering groups by source chat,
then extraction window and intra-window order; it does not establish cross-chat
story chronology or invent dates.

Returned records and source references retain the bare `collection_id` and also
include a backend-qualified `collection_key` (for example, `standard:events`).
Matching, opaque citations, source-cache keys and continuity targets use this
qualified identity so identical collection/event IDs on different backends remain
distinct. A resolution link prefers
the matching event in its own collection; without a local target, it applies only
when exactly one matching target exists across the selected collection union.
Ambiguous duplicate-ID cross-collection targets do not close any threads.

Limits: 20 collections, 20 subjects, 20 aliases per subject, 50 types, 500 returned
events, 10,000 scanned records, 500 resolved references. Database/backend reads
have a 30-second per-call timeout. Coverage discloses unavailable collections,
scan truncation, unknown chat attribution, matched and returned counts. Unknown
backend totals make counts inexact. There is no history sampling. Backend metadata
support is reported per collection after probing; `available: null` means not yet
probed. Standard listings explicitly report `capabilities.metadata`; native
hashes-only listings return `unsupported`, including empty fallbacks after plugin
transport errors or server failures even when the plugin remains available.

## Sources and lifecycle

New extractions persist `source_messages`: expanded-coordinate hints, host `id`
and `extra.mesid`, extraction/deduplication hashes, a separate versioned
`raw_content_hash` (`djb2-raw-v1`), and versioned SHA-256 fingerprints of normalized
narrative. The raw-content hash is an edit signal, not identity proof, and is
computed independently of any existing message hash without trimming the raw text.
Legacy extraction hashes with unknown conventions are never treated as raw-content
edit signals. No model or embedding request is made by either API read.
Narrative normalization uses the existing reasoning/game-system cleaners, NFKC
and whitespace normalization; character names participate in the fingerprint.
Extraction snapshots its input before asynchronous work so later live-chat edits
cannot become verified evidence for a prompt that contained earlier text.

On origins without Web Crypto SHA-256 support (including non-secure HTTP LAN
origins), history and extraction remain available. New source fingerprints are
`null`, and `getStatus().capabilities.source_resolution` reports
`fingerprinting_unavailable`. Resolution never verifies a source without a current
SHA-256 fingerprint; unchanged identity-matched sources remain unresolved, while
raw-content edits can still be reported as changed. Scope tokens use an
initialization-safe session fallback when `crypto.randomUUID` is unavailable.

`resolveSources` accepts only references issued in the current scope. References
are bounded session handles, not persistent bookmarks (up to 20,000 retained).
Results distinguish `verified`, `changed`, `missing`, and `unresolved`. Recovered
ILS leaves retain separate expanded positions and share the actual visible
container position; host identities for both are exposed. An ambiguous duplicate,
unknown chat, or legacy hash alone never verifies an original. Position alone
cannot distinguish a deletion from an edit: such cases remain unresolved.
Tracker-only raw-content changes are reported as changed even when narrative
fingerprints agree. A changed snapshot is not verified historical evidence.
Only verified/changed identity-resolved sources include message snapshots.

All responses are detached snapshots. Changing them cannot change the host or
assign MWT receipt identities. VectFox neither reads nor returns MWT private
message identity fields. Consumers must retain their own write/revision guards.
Chat content, ILS originals, collection selection, roster configuration and local
archive mutations invalidate scope tokens; stale async reads return `stale_scope`
without events. Source fingerprints are added prospectively, without rewriting
legacy event records. Unknown or old references require a fresh history request.

Failures are `{ ok: false, error: { code, message, ...details } }`; successful empty
history is `{ ok: true, events: [], coverage, scope_token }`. Loading, disabled,
unsupported and backend failures are not empty successes. Partial successes expose
unavailable portions. The global master switch disables this integration API.

Semantic question research is deliberately unavailable (`unsupported`), advertised
separately from history, until Phase 3 implements its research policy. This API
does not generate answers, profiles, lorebook writes, or MWT receipts.