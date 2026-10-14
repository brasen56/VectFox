import { extractEvents } from '../core/eventbase-extractor.js';

/** Twenty messages: quiet facts, repetitions, dramatic changes, and unsupported plans. */
export const PROFILE_FIXTURE = [
    ['Alex', 'Let us make breakfast together every Saturday. I prefer tea without sugar.'],
    ['Sam', 'Agreed, Saturday breakfast is our new ritual. Tea without sugar for you.'],
    ['Alex', 'The next Saturday, we have the same breakfast and unsweetened tea again.'],
    ['Sam', 'We eat and chat about the weather. Nothing about our arrangement changes.'],
    ['Alex', 'Can I call you Sunny? Tell me if that makes you uncomfortable.'],
    ['Sam', 'I like Sunny. Please use it, but no teasing about my family.'],
    ['Alex', 'I enrolled in the evening design course. Shall we study together on Tuesdays?'],
    ['Sam', 'Yes, Tuesday evenings in the library are our agreed study time.'],
    ['Alex', 'I attend the next class and do the usual homework.'],
    ['Sam', 'I go to work and commute home as usual.'],
    ['Alex', 'For our shop project, I commit to handling suppliers if you handle the accounts.'],
    ['Sam', 'Agreed. Our grant application is due Friday; I commit to submitting it then.'],
    ['Alex', 'The shop prototype passed its first inspection today. Here is the signed report.'],
    ['Sam', 'That completes the inspection milestone. We can now apply for the permit.'],
    ['Alex', 'You shared my private letter without asking. I cannot trust you with another one.'],
    ['Sam', 'I admit it. I will delete my copy and ask your permission before sharing anything private.'],
    ['Alex', 'I saw you delete it. I accept your apology and that privacy agreement. You still owe the rent.'],
    ['Sam', 'The rent remains unpaid. I have not submitted the grant application yet either.'],
    ['Alex', 'Another Saturday: the same breakfast, tea, and Sunny nickname, with no new details.'],
    ['Sam', 'We finish breakfast quietly.'],
].map(([name, mes]) => ({ name, mes }));
PROFILE_FIXTURE[19].reasoning = 'Plan: Sam secretly wins a scholarship and pays the rent. These events have not happened.';

/** Sequential windows over `messages` with the built-in prompt for `profile`; no collections. */
async function runWindows(messages, { windowSize, maxEvents, profile, settings, extract }) {
    const windows = [];
    for (let start = 0; start < messages.length; start += windowSize) {
        const events = await extract({ messages: messages.slice(start, start + windowSize),
            windowStart: start, windowEnd: Math.min(start + windowSize, messages.length) - 1,
            windowIndex: windows.length, collectionIds: [],
            settings: { ...settings, eventbase_custom_prompt: '', eventbase_extraction_profile: profile,
                eventbase_max_events_per_window: maxEvents } });
        windows.push({ start, events });
    }
    return windows;
}

/** Run in SillyTavern with the normal extraction model. Never writes collections or markers.
 * The default performs 22 paid calls: both profiles × (10 small windows + 1 large window).
 * Counts are raw validated extraction outputs, not deduplicated collection growth.
 */
export async function benchmarkExtractionProfiles(settings, { extract = extractEvents } = {}) {
    const rows = [];
    for (const [windowSize, maxEvents] of [[2, 3], [20, 10]]) {
        for (const profile of ['story', 'slice_of_life']) {
            const windows = await runWindows(PROFILE_FIXTURE, { windowSize, maxEvents, profile, settings, extract });
            const events = windows.flatMap(window => window.events);
            rows.push({ profile, windowSize, maxEvents, calls: windows.length, extracted: events.length,
                atDefaultStoreFloor: events.filter(event => event.importance >= 3).length,
                cappedWindows: windows.filter(window => window.events.length === maxEvents).length, windows });
        }
    }
    return { model: settings.chat_model, languageMode: settings.cjk_tokenizer_mode || 'intl',
        measuredAt: new Date().toISOString(), rows, comparisons: [2, 20].map(windowSize => {
            const story = rows.find(row => row.windowSize === windowSize && row.profile === 'story');
            const slice = rows.find(row => row.windowSize === windowSize && row.profile === 'slice_of_life');
            return { windowSize, extraExtracted: slice.extracted - story.extracted,
                extraAtDefaultStoreFloor: slice.atDefaultStoreFloor - story.atDefaultStoreFloor };
        }) };
}
const CASE_CONFIGS = [
    { config: 'default', windowSize: 2, maxEvents: 3 },
    { config: 'whole', windowSize: Infinity, maxEvents: 10 },
];

/** Real-chat review cases, kept out of git in diagnostics/local/. Each case runs under both
 * profiles at the default 2-message windows, and again as one window when it is longer than that.
 * Case shape: { id, kind, messages: [{ name, is_user, mes }], expect: [], mustNot: [] }. Kind is
 * positive (a fact should be stored), negative or repetition (nothing should be), or scope (review only).
 * The verdict is a first pass by event count; whether a stored fact is right is a manual review.
 */
export async function benchmarkExtractionCases(settings, cases, { extract = extractEvents } = {}) {
    const rows = [];
    for (const kase of cases) {
        for (const { config, windowSize, maxEvents } of CASE_CONFIGS) {
            if (config === 'whole' && kase.messages.length <= 2) continue; // same window as default
            for (const profile of ['story', 'slice_of_life']) {
                const windows = await runWindows(kase.messages, { windowSize, maxEvents, profile, settings, extract });
                const events = windows.flatMap(window => window.events);
                const stored = events.filter(event => event.importance >= 3);
                rows.push({ id: kase.id, kind: kase.kind, config, profile, calls: windows.length,
                    extracted: events.length, atDefaultStoreFloor: stored.length,
                    withOpenThreads: stored.filter(event => event.open_threads?.length).length,
                    verdict: caseVerdict(kase.kind, stored.length), events });
            }
        }
    }
    return { model: settings.chat_model, languageMode: settings.cjk_tokenizer_mode || 'intl',
        measuredAt: new Date().toISOString(), calls: rows.reduce((n, row) => n + row.calls, 0), rows,
        reviewText: formatCaseReview(cases, rows) };
}

function caseVerdict(kind, stored) {
    if (kind === 'negative' || kind === 'repetition') return stored ? 'check: expected nothing stored' : 'pass';
    if (kind === 'positive') return stored ? 'review' : 'check: nothing stored';
    return 'review';
}

/** Plain text for side-by-side reading: each case's expectations, then every event per run. */
function formatCaseReview(cases, rows) {
    return cases.map(kase => [
        `== ${kase.id} (${kase.kind}) ==`,
        `Expect: ${(kase.expect || []).join('; ') || '-'}`,
        `Must not: ${(kase.mustNot || []).join('; ') || '-'}`,
        ...rows.filter(row => row.id === kase.id).flatMap(row => [
            `-- ${row.config} / ${row.profile}: ${row.atDefaultStoreFloor} of ${row.extracted} at importance >=3 [${row.verdict}]`,
            ...row.events.map(event => `   [${event.event_type} ${event.importance}] ${event.summary}`
                + (event.open_threads?.length ? ` | threads: ${event.open_threads.join(' / ')}` : '')),
        ]),
    ].join('\n')).join('\n\n');
}
