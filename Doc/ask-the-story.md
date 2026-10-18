# Ask the Story (Phase 3)

Open **Ask the Story** beside **Debug Query** in VectFox's actions. Enable manual
requests in the panel (off by default), review the displayed Core chat model and
current-chat collection scope, enter a question, and press **Ask**. Debug Query
remains available and unchanged.

Answers stay in this panel. They are not inserted into roleplay prompts, saved to
lorebooks, or written to MWT. Copy includes claims, event references and coverage.
Expand a citation to inspect its stored summary. Verified originals are inspectable
as snapshots; recovered ILS originals are identified explicitly. Unverified,
changed, missing and cross-chat originals are not presented as verified evidence.

## Retrieval and limits

- Uses the read-only public API's `findEvents({ mode: 'question', question, ... })`.
  `question_research` advertises bounded lexical/chronological research, not semantic
  search. History mode and the public API version remain unchanged.
- Roster aliases identify subjects; ambiguous matches require a clarified name.
- Research includes old and resolved events, ignores injection Top-K and recency
  suppression, and retains Phase 0's duplicate and current-chat scope handling.
- At most 200 candidates and 40 evidence records, with 24,000 serialized evidence
  characters. Broad histories distinguish subject membership from topical relevance
  and reserve at least a quarter of the record budget for chronological spine
  sampling. Topical hits take priority in the remaining slots at both selection
  stages. Outstanding-obligation questions use remaining thread state.
- In question mode, subject matches anchor research; adjacent, topically relevant
  records can supply context even without the subject's tag. Expansion stays within
  the same source chat and existing filters and budgets. Ordinary history requests
  retain strict subject filtering.
- Existing Phase 0 metadata scanning limits still apply (10,000 records, at most 20
  collections). Coverage reports sampling, truncation and unavailable records.
- At most one answer call through the configured Core provider and shared generation
  rate limiter, capped at 2048 output tokens and 120 seconds per dispatched request.
  No planning, automatic retries or embedding calls. There is no deeper-research mode.
- Output is bounded to 20 claims of at most 600 characters each, with supplied
  event references. Malformed, truncated or unknown-reference output is rejected.
  Structural citation validation is not a semantic guarantee; inspect the evidence.
- Cancel and closing the panel abort the answer request. Scope changes invalidate
  pending and displayed answers. Pending metadata reads may finish in the background,
  but their results cannot proceed to answer generation after cancellation.

## Known limits

Lexical research can miss paraphrases, especially in languages without word
boundaries. It is not an exhaustive semantic investigation. A missing result means
no relevant evidence was found in the searched records, not proof an event never
happened. Large histories may be sampled; unavailable originals do not invalidate
the inspectable stored event summaries. Current-chat scope is the initial UI policy;
there is no implicit cross-chat or alternate-branch merging.

The model is instructed to distinguish co-mentions from meetings, avoid invented
connecting events and causal inferences, and state gaps. The validator checks shape,
size and citation membership; it cannot prove that every generated interpretation
is supported. Review the cited summaries before relying on an answer.