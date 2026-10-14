# Phase 3: extraction profiles and release validation

**2026-10-14:** implementation and automated regression coverage added. The real-model fixture measurement required by the scope is still pending; mocked tests are not evidence of extraction quality. Do not consider the release validation complete until the results below are recorded.

## Using the profile

In EventBase settings, beside **Extraction Prompt**, choose **Slice of life — quiet continuity**. Story changes remains the default for new and existing installations. A nonblank custom prompt overrides either profile; switching profiles never replaces a custom prompt. Reset to Default clears the override and uses the currently selected profile and language. Compare Current Default shows that same built-in variant.

The slice-of-life profile changes the introduction, all three gates, and the opening of the importance guidance in all six language modes; the per-type importance ranges are unchanged. Quiet facts score 3–5 using existing event types and schema fields, and normally carry no open threads. Resolution linking, proper-noun handling, dates, output examples, the count cap, and the prohibition on extracting events from reasoning remain unchanged.

Effective profile is shown beside the setting, in extraction lifecycle logs, and in retrieval dry-run diagnostics. Retrieval diagnostics describe **current settings**, not the profile used to create older events. No profile provenance is added to stored records.

Changing the setting affects future extraction only. It does not reset extraction markers or rebuild existing collections. A storage floor above 3 can discard some quiet facts. The prompt asks for one event per new or changed routine rather than each repetition; it can recognize prior establishment only when that evidence is visible in the excerpt/context. Cross-window routine deduplication is not a new state store and is not guaranteed by this phase.

## Real-model fixture benchmark (required before release)

The helper in `diagnostics/extraction-profile-benchmark.js` runs the same 20-message fixture through each profile at both requested configurations: **2 messages / 3 events** and **20 messages / 10 events**. It calls the normal extraction model, bypasses custom prompt overrides for a fair comparison, uses no collections, and never stores records or changes extraction markers. A complete run makes **22 paid extraction calls**. Normal model credentials and SillyTavern must be available.

In the SillyTavern browser console, use your installed extension's folder name (the example assumes `VectFox`):

```js
const { extension_settings } = await import('/scripts/extensions.js');
const { benchmarkExtractionProfiles } = await import(
    '/scripts/extensions/third-party/VectFox/diagnostics/extraction-profile-benchmark.js'
);
const report = await benchmarkExtractionProfiles(extension_settings.vectfox);
console.table(report.rows.map(({ windows, ...counts }) => counts));
console.table(report.comparisons);
console.log(JSON.stringify(report, null, 2));
```

Save the report, model, language mode, and date. Counts report validated extracted events and how many clear the default floor of 3. They are **not** estimates of deduplicated collection growth. `cappedWindows` flags windows where the event cap may hide differences. Calls are sequential and a failed extraction rejects the run rather than inventing a count.

Review the actual outputs, not only the totals:

- Saturday breakfasts and unsweetened tea establish quiet continuity; unchanged repetitions add no new fact.
- The agreed Sunny nickname and explicit family-teasing boundary are supported, without generic affection inference.
- Course enrollment, study arrangements, supplier/account responsibilities, the grant commitment, and the passed inspection are captured appropriately.
- The grant application remains a commitment, not completed work.
- The apology/privacy agreement does not resolve unpaid rent.
- The reasoning-only scholarship and rent payment are never extracted.
- Quiet facts score 3–5 and dramatic facts are not downscored into that band.
- Routines, preferences and nicknames come back with empty `open_threads`; only commitments keep a real question.

The English fixture can be translated to each supported language for manual model-quality review; automated tests already verify profile composition and language-rule preservation across all six variants.

| Configuration | Story extracted / ≥3 | Slice-of-life extracted / ≥3 | Extra events | Model / date | Manual review |
|---|---|---|---|---|---|
| 2 messages / 3 events | Pending | Pending | Pending | Pending | Pending |
| 20 messages / 10 events | Pending | Pending | Pending | Pending | Pending |

## Real-chat review cases (local only)

The synthetic fixture above states its own answers ("nothing changes", "no new details"), which real roleplay never does, so it is an easy test. `benchmarkExtractionCases` runs short excerpts from a real chat instead, each with what should and should not be stored. Each case runs under both profiles at the default 2-message windows, and again as one window when it is longer than two messages.

The excerpts are personal and live in `diagnostics/local/chat-cases.js`, which is gitignored. Never commit them, and keep them out of the shipped prompt: built-in examples must stay generic, and cases that appear in the prompt stop measuring anything. The file must exist in the installed extension folder; a git-based install does not include it.

```js
const { extension_settings } = await import('/scripts/extensions.js');
const dir = '/scripts/extensions/third-party/VectFox/diagnostics/';
const { benchmarkExtractionCases } = await import(dir + 'extraction-profile-benchmark.js');
const { CHAT_CASES } = await import(dir + 'local/chat-cases.js');
const report = await benchmarkExtractionCases(extension_settings.vectfox, CHAT_CASES);
console.table(report.rows.map(({ events, ...row }) => row));
console.log(report.reviewText);
```

The current eight cases make **26 paid calls**. The verdict column is only a first pass by count: negative and repetition cases `pass` when nothing reaches importance 3, and positive cases need a manual read of `reviewText` against each case's expected and prohibited facts. Tune the prompt after a run, not before. A rule added for a failing case should be phrased generically, and it then needs a fresh case to confirm it, because the case that prompted it can no longer show whether it generalizes.

| Case | Kind | Story default / whole | Slice default / whole | Notes |
|---|---|---|---|---|
| A3 | explicit preference, already practised | Pending | Pending | |
| A4 | routine invented and used in scene | Pending | Pending | |
| A4b | explicit agreement | Pending | Pending | |
| A6 | disclosed vulnerability + standing promise | Pending | Pending | |
| A5 | rule-scope clarification | Pending | Pending | |
| B2 | one-off request and substitution | Pending | Pending | |
| B3 | warmth and gratitude only | Pending | Pending | |
| D1 | habitual repetition | Pending | Pending | |