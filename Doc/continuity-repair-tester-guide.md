# EventBase continuity repair — tester guide

**Audience:** testers trying out the Phase 2 continuity feature before Phase 3 ships.
**Status:** 2026-10-13, matches the Phase 2 implementation (revision 2). Scope and design background: [eventbase-continuity-scope.md](eventbase-continuity-scope.md).

## What this feature does

Long-running EventBase collections accumulate two problems:

1. **Conflicts that were already resolved keep coming back as if they were open.** The events are stored fine; the problem is that nothing ever linked the conflict to the event that resolves it, so every retrieval route shows the thread as still open.
2. **Duplicate events.** The same scene sometimes got extracted more than once, so the same memory appears twice.

The continuity repair links conflicts to their resolutions and marks duplicates — using **metadata only**. Nothing is re-embedded, nothing is deleted, and nothing about your original events (summaries, importance, threads, timestamps) changes. Everything the repair does can be reviewed before it takes effect, and undone per run afterwards.

New events extracted from now on get resolution links automatically during extraction (that was Phase 1); this repair is what fixes collections that already exist.

## Requirements

- **A backend that stores metadata: Qdrant, or the Standard backend with the Similharity plugin.** Native Vectra does not store metadata, so links would be lost there. The EventBase tab shows *"Continuity unsupported: native Vectra does not store metadata."* if this applies to you.
- The collection you want to repair must be **enabled and locked to the current chat** (the repair panel lists those collections).
- **Use only one tab/writer.** The panel warns if another tab has repair open, but the warning is advisory, not a lock. Two simultaneous writers can overwrite each other's changes.
- Expect **real LLM cost** for resolution links. An estimate is shown before anything runs (see below). The *Duplicates only* scope uses no LLM at all.

## How to run a repair

### 1. Open the repair panel

In SillyTavern, open the VectFox extension → **EventBase** tab → scroll to the **Character roster and aliases** section → click **Review and repair memory**.

The panel that opens starts with a reminder worth reading: metadata-only repair, one writer, pause takes effect after the current batch, token estimates are approximate.

### 2. Choose a collection and scope

- **Collection:** the dropdown lists every enabled EventBase collection locked to this chat.
- **Scope:**
  - **Conflicts only** *(default, recommended)* — interpersonal events (relationship changes, significant dialogue, betrayals, promises/oaths, character state changes) that still have open threads, at or above the importance floor.
  - **Every event with open threads** — broader and correspondingly more expensive.
  - **Duplicates only (no LLM)** — just the duplicate scan. No model calls, but proposals still need review before they take effect.
- **Minimum importance** (default 6): raising it to 7 roughly halves the work on conflict-heavy collections.
- Optional narrowing: a **character pair** (comma-separated) and a **message range** (first/last message).
- Optional overrides: **provider** (openrouter or vllm), **model**, and **vLLM URL**. Left blank, the repair uses your extraction provider and model. You cannot change these while a run is unpaused — pause first.

### 3. Get the estimate first

Click **Inventory and estimate (no LLM)**. This loads the stored vectors (no embedding calls) and shows, for the current scope and model:

> `2,364 conflicts · up to 591 calls · about 2,200,000 input tokens · <model>. Duplicate scan uses no LLM. Review this estimate before Start.`

**Start refuses to run** until you have taken an estimate for exactly this scope and provider/model/endpoint — if you change any setting afterwards, take the estimate again. This is deliberate: the point of the estimate is that you see the cost before paying it.

### 4. Start, pause, resume, cancel

- **Start** begins judging. Batches of 4 conflicts are sent per call; each batch's proposals are written immediately, so an interrupted run resumes instead of starting over.
- **Pause** stops after the current batch finishes (queued calls don't contact the provider). **Load / Resume run** continues from the checkpoint. Pause and resume are safe to repeat.
- **Cancel** ends the run; the proposals already made stay for review.
- The status line shows live progress: `running: 240 conflicts processed · 60 calls · 212,000 input tokens · <model>`, plus a count of skipped batches if any.
- A batch whose model response is unusable (truncated or malformed) twice is **skipped and recorded**, not re-billed on every resume. If you see skips reported, that's useful feedback — tell us.

### 5. Review the proposals

Below the controls, the preview lists every proposal for the current run, 20 per page:

- Each entry shows the field (`resolves` or `duplicate_of`), its status, the owner event's summary, the target event's summary, **which thread texts it closes** (shown as text, not bare indices), and the judge's short "how" note.
- Use the **filter box** to narrow by character name.
- **Accept** or **Reject** individual entries, or use **Accept all** / **Reject all proposals**.
- Only **accepted** entries take effect. A `proposed` entry influences nothing until you accept it.

Read the threads being closed carefully — that's where judge mistakes (if any) will be visible. If a link looks wrong, rejecting it is free and final for that run.

### 6. Undo

Every run has an ID. The dropdown next to **Undo run** lists past runs; pick one and confirm to remove all annotations that run created. Undo preserves any earlier annotations — user marks, extraction links — that the run had displaced. If undo leaves the event with no annotations at all, its continuity data is reset cleanly.

## Manual fixes in the Database Browser

Some things the judge can't know: a conflict resolved off-screen, or a link it simply missed. For those, open the **Database Browser** (Action tab), open an event's chunk detail, and find the **Event continuity** section:

- **Mark resolved — all** — closes every thread on the event.
- **Mark selected threads resolved** — tick the checkboxes next to specific threads first.
- An optional **Outcome** text field records how it was settled (defaults to "Marked resolved by the user.").
- **Unmark** — restores the event's previous closure state.
- **Show what resolves this** — lists active and proposed resolutions for the event, with a **Remove link** button per link.

Manual marks are `active` immediately and affect rendering and ranking right away.

## Settings that matter

In the EventBase tab, under the extraction prompt:

- **Open-issue context status line** — says `Open-issue context: on.` when the built-in prompt (or a custom prompt containing `{{openIssues}}`) is in use. If you use a custom prompt, it must contain `{{openIssues}}` or new extractions won't link resolutions.
- **Resolved score factor** (default 0.85) — fully resolved conflicts are ranked at 85% of their score. Set to 1 to disable downranking. Partially resolved events are never downranked.
- **Open issues per window** (default 6) — how many unresolved issues are listed in the extraction prompt for the model to potentially resolve.

Note for testers with tweaked custom prompts: the settings textarea saves a frozen copy of the old default once edited. If your custom prompt predates Phase 1, compare it against the current default before assuming links will be created.

## Known limitations (expected behavior, not bugs)

- **Do not delete the lexically first event of a collection while a run is pending** — the run manifest lives there while a run is in progress. It is compacted away once the run completes or is cancelled.
- A completed run blocks a new start **only while its proposals await review** — finish (or reject) the review before starting the next run.
- Repair never purges duplicates. Marked duplicates are skipped by retrieval, roster, cast lane, NPC cards and Summarizer Injection, but permanently deleting them is a separate, later action.
- Token estimates are conservative approximations, not dollar quotes. The actual calls/tokens are recorded in the checkpoint and shown in the status line.
- Events that arrive during a run are outside the run's frozen scope — they get their links from normal extraction instead.
- Repair traffic goes through the generation rate limiter at the lowest priority (`repair`), so it stays out of the way of generation and card refreshes. Runs may be slower than the raw call count suggests — that's the rate gate doing its job.

## What we'd like feedback on

1. **Link quality:** after accepting links, do a few generations in a long chat. Are resolved conflicts staying downranked / shown with their outcome instead of as open?
2. **Estimate accuracy:** how close were the estimated vs. actual calls and input tokens (status line after a run)?
3. **Resume behavior:** pause mid-run, reload the page, then *Load / Resume run*. Did it pick up where it left off without duplicate proposals?
4. **Undo:** did undo restore the pre-run state cleanly?
5. **Skipped batches:** did any appear in the status line, and were the affected conflicts ones you'd have wanted linked?
6. **Duplicates only** scope: was the duplicate review sensible (right copy chosen as canonical)?
7. Anything in the manual controls that felt confusing or was missing.

For anything reproducible, note the collection size, scope, importance floor, and model used — the scope doc's validation targets are precision on accepted links, so bad links matter more than missed ones at this stage.
