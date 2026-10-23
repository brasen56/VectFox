/** Repair list/detail window. Model and story text is inserted as text, never HTML. */
import { estimateRepair, listRepairEntries } from '../core/continuity-repair.js';

const SCOPES = { conflicts: 'Conflicts only', all: 'Every event with open threads', duplicates: 'Duplicates only (no LLM)' };
const TYPES = { resolves: 'Resolves earlier event', closed_threads: 'Closes own threads', duplicate_of: 'Duplicate event' };
const PAGE_SIZE = 50;
const el = (tag, text, parent, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    parent?.append(node);
    return node;
};
const identity = item => JSON.stringify([item.owner, item.field, item.entry]);
const statusName = status => ({ proposed: 'Needs review', active: 'Accepted', complete: 'Complete', paused: 'Paused / ready to resume',
    interrupted: 'Interrupted — not running', running: 'Running', cancelled: 'Cancelled', undone: 'Undone' })[status] || status || 'Recorded';
const runLabel = run => {
    const time = run.created || Number(/^repair_(\d+)_/.exec(run.run)?.[1]);
    return `${time ? new Date(time).toLocaleString() : run.run} · ${statusName(run.status)} · ${run.model || 'Unknown model'} · ${run.run.slice(-8)}`;
};

export function mountContinuityRepairWindow({ root, settings, collections, deps, sessions = new Map() }) {
    root.classList.add('vf-cr');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Review and repair memory');
    root.tabIndex = -1;
    let engine = null, selectedKey = null, estimate = null, selectedRun = '', selected = null, page = 0;
    let lease = null, closed = false, busy = false, lastProgress = '';
    const controls = [];
    const action = (label, parent, task, enabled = () => true) => {
        const node = el('button', label, parent, 'vectfox-btn vectfox-btn-secondary');
        node.type = 'button';
        controls.push({ node, enabled });
        node.addEventListener('click', async () => {
            if (busy || !enabled()) return;
            busy = true; sync();
            try { await task(); }
            catch (error) { notice.textContent = error.message || String(error); }
            finally { busy = false; if (!closed) render(); }
        });
        return node;
    };
    const release = () => { lease?.close(); lease = null; };
    const close = () => {
        if (closed) return;
        closed = true; engine?.pause(); release(); clearInterval(timer); deps.onClose();
    };
    const header = el('header', undefined, root, 'vf-cr-header');
    el('h3', 'Review and repair memory', header);
    const collection = el('select', undefined, header, 'vectfox-select');
    collection.setAttribute('aria-label', 'Collection');
    for (const item of collections) el('option', `${item.collectionId} · ${item.registryKey}`, collection).value = item.registryKey;
    const closeButton = el('button', 'Close review', header, 'vectfox-btn vectfox-btn-secondary');
    closeButton.type = 'button'; closeButton.addEventListener('click', close);
    el('p', 'Metadata-only repair; no re-embedding or deletion. Use one writer/tab. Pause finishes the current batch. Proposals only take effect after acceptance.', root, 'vf-cr-help');
    const notice = el('p', '', root, 'vf-cr-notice');
    notice.setAttribute('role', 'status');
    const setup = el('details', undefined, root, 'vf-cr-setup');
    setup.open = true;
    el('summary', '1. Configure and estimate', setup);
    const fields = el('div', undefined, setup, 'vf-cr-fields');
    const field = (label, value = '', type = 'text', parent = fields) => {
        const wrapper = el('label', label, parent);
        const input = el('input', undefined, wrapper, 'vectfox-input');
        input.type = type; input.value = value; input.setAttribute('aria-label', label);
        return input;
    };
    const scopeLabel = el('label', 'Scope', fields);
    const scope = el('select', undefined, scopeLabel, 'vectfox-select');
    scope.setAttribute('aria-label', 'Scope');
    for (const [value, label] of Object.entries(SCOPES)) el('option', label, scope).value = value;
    const importance = field('Minimum importance', 6, 'number'); importance.min = 1; importance.max = 10;
    const characters = field('Character pair (comma-separated; optional)');
    const advanced = el('details', undefined, setup);
    el('summary', 'Advanced: message range and provider / model', advanced);
    const advancedFields = el('div', undefined, advanced, 'vf-cr-fields');
    const start = field('First message (optional)', '', 'number', advancedFields);
    const end = field('Last message (optional)', '', 'number', advancedFields);
    const provider = field('Provider override (openrouter or vllm; optional)', '', 'text', advancedFields);
    const model = field('Model override (optional)', '', 'text', advancedFields);
    const url = field('vLLM URL override (optional)', '', 'text', advancedFields);
    scope.addEventListener('change', () => { importance.disabled = scope.value !== 'conflicts'; });
    const configuration = () => deps.configuration(settings, { provider: provider.value.trim(), model: model.value.trim(), url: url.value.trim() });
    const requested = () => ({ ...configuration(), options: { scope: scope.value, importance: Number(importance.value),
        characters: characters.value.split(',').map(name => name.trim()).filter(Boolean),
        start: start.value === '' ? null : Number(start.value), end: end.value === '' ? null : Number(end.value) } });
    const setupActions = el('div', undefined, setup, 'vf-cr-actions');
    const progress = el('p', '', root, 'vf-cr-progress');
    progress.setAttribute('aria-live', 'polite');
    const toolbar = el('div', undefined, root, 'vf-cr-actions vf-cr-toolbar');
    const runSelect = el('select', undefined, toolbar, 'vectfox-select');
    runSelect.setAttribute('aria-label', 'Repair run');
    const runActions = el('div', undefined, toolbar, 'vf-cr-actions');
    const body = el('div', undefined, root, 'vf-cr-body');
    const sidebar = el('section', undefined, body, 'vf-cr-sidebar');
    el('h4', '2. Choose a proposal', sidebar);
    const search = field('Search proposals', '', 'search', sidebar);
    const filter = el('select', undefined, sidebar, 'vectfox-select');
    filter.setAttribute('aria-label', 'Proposal status');
    for (const [value, label] of [['proposed', 'Needs review'], ['active', 'Accepted'], ['', 'All statuses']]) el('option', label, filter).value = value;
    const count = el('p', '', sidebar, 'vf-cr-help');
    const list = el('div', undefined, sidebar, 'vf-cr-list');
    list.setAttribute('aria-label', 'Proposals');
    const paging = el('div', undefined, sidebar, 'vf-cr-actions');
    const previous = el('button', 'Previous', paging, 'vectfox-btn vectfox-btn-secondary'); previous.type = 'button';
    const pageLabel = el('span', '', paging);
    const next = el('button', 'Next', paging, 'vectfox-btn vectfox-btn-secondary'); next.type = 'button';
    const detail = el('section', undefined, body, 'vf-cr-detail');
    detail.setAttribute('aria-label', 'Proposal details');
    const currentRun = () => engine?.listRuns().find(run => run.run === selectedRun);
    const idle = () => !!engine && !engine.running;
    const reviewable = () => idle() && !!selectedRun;
    const entries = () => engine && selectedRun ? listRepairEntries(engine.events.values(), selectedRun) : [];
    const hasSavedClosure = () => engine && [...engine.events.values()].some(event => event.continuity?.user_previous_closure?.run === selectedRun);
    const sync = () => {
        for (const control of controls) control.node.disabled = busy || !control.enabled();
        collection.disabled = busy || !!engine?.running;
        runSelect.disabled = busy || !!engine?.running;
        for (const input of setup.querySelectorAll('input, select')) input.disabled = busy || !!engine?.running || (input === importance && scope.value !== 'conflicts');
    };
    const load = async () => {
        const key = collection.value;
        if (!key) throw new Error('No enabled EventBase collections are locked to this chat.');
        if (engine?.running) throw new Error('Pause the current run and wait for the batch first');
        const config = configuration(), effectiveModel = `${config.provider}/${config.model}`;
        const existing = sessions.get(key);
        if (existing?.running) throw new Error('This collection already has a running repair');
        if (existing && (existing.model !== effectiveModel || existing.endpoint !== config.url)) sessions.delete(key);
        const loaded = sessions.get(key) || await deps.create(key, settings, config);
        await loaded.refreshEvents();
        release(); engine = loaded; selectedKey = key; sessions.set(key, engine);
        if (typeof BroadcastChannel !== 'undefined') {
            lease = new BroadcastChannel(`vectfox-continuity-${deps.collectionId(key)}`);
            lease.onmessage = message => {
                if (message.data === 'open') lease?.postMessage('occupied');
                if (['open', 'occupied'].includes(message.data)) {
                    engine.pause(); notice.textContent = 'Another tab has repair open. Use one writer only; repair paused.';
                }
            };
            lease.postMessage('open');
        }
        selectedRun = engine.state?.run || engine.listRuns()[0]?.run || '';
        selected = null; page = 0;
    };
    const resume = async () => {
        setup.open = false;
        const pending = engine.resume();
        render();
        await pending;
    };
    action('Inventory and estimate (no LLM)', setupActions, async () => {
        notice.textContent = 'Loading stored vectors…';
        await load(); estimate = requested();
        const result = estimateRepair(engine.plan(estimate.options), engine.model, engine.language);
        const name = `${SCOPES[scope.value]}${scope.value === 'conflicts' ? ` (importance ≥ ${importance.value})` : ''}`;
        notice.textContent = scope.value === 'duplicates' ? `${name}: no LLM calls. Proposals still need review.`
            : `${name}: ${result.events} to judge · up to ${result.calls} calls · about ${result.inputTokens.toLocaleString()} input tokens · ${result.model}. Output/reasoning tokens and provider pricing not included. Duplicate scan uses no LLM. Review before Start.`;
    }, () => collections.length > 0 && !engine?.running);
    action('Start', setupActions, async () => {
        if (!engine || !estimate || selectedKey !== collection.value || JSON.stringify(requested()) !== JSON.stringify(estimate)) throw new Error('Inventory and estimate this scope and provider/model/endpoint first');
        await engine.start(estimate.options); selectedRun = engine.state.run; selected = null; page = 0;
        await resume();
    }, () => collections.length > 0 && !engine?.running);
    action('Load saved runs (no LLM)', setupActions, async () => {
        await load(); setup.open = false;
        notice.textContent = 'Saved runs loaded. Loading does not resume model calls.';
    }, () => collections.length > 0 && !engine?.running);
    action('Resume current run', runActions, resume, () => idle() && selectedRun === engine.state?.run && ['paused', 'running'].includes(engine.state?.status));
    // Pause and Close stay available while Start/Resume is awaiting a batch.
    const pause = el('button', 'Pause', runActions, 'vectfox-btn vectfox-btn-secondary'); pause.type = 'button';
    pause.addEventListener('click', () => { engine?.pause(); notice.textContent = 'Pausing after the current batch…'; });
    action('Stop interrupted run', runActions, async () => {
        if (deps.confirm('Stop this run without removing its proposals or accepted repairs? It will no longer be resumable.')) await engine.stopRun(selectedRun);
    }, () => reviewable() && ['paused', 'interrupted', 'running'].includes(currentRun()?.status));
    action('Accept all pending', runActions, async () => {
        if (deps.confirm(`Accept all ${entries().filter(item => item.entry.status === 'proposed').length} pending proposals in the selected run, including hidden results?`)) await engine.review(selectedRun, true);
    }, () => reviewable() && entries().some(item => item.entry.status === 'proposed'));
    action('Reject all pending', runActions, async () => {
        if (deps.confirm('Reject all pending proposals in the selected run, including hidden results? Accepted repairs are kept.')) await engine.review(selectedRun, false);
    }, () => reviewable() && entries().some(item => item.entry.status === 'proposed'));
    action('Undo selected run', runActions, async () => {
        if (deps.confirm('Remove all continuity annotations created by the selected run? Event text and vectors are kept.')) await engine.undo(selectedRun);
    }, reviewable);
    const clear = action('Clear empty run record', runActions, async () => {
        if (!deps.confirm('Clear this empty run record? No event text, vectors or accepted repairs will be deleted.')) return;
        await engine.clearRun(selectedRun); selectedRun = ''; selected = null;
    }, () => reviewable() && ['complete', 'cancelled', 'undone'].includes(currentRun()?.status) && !entries().length && !hasSavedClosure());
    clear.title = 'Only empty, finished/stopped runs can be cleared. Reject pending proposals first; accepted repairs retain their undo history.';
    const eventCard = (label, event) => {
        const card = el('article', undefined, detail, 'vf-cr-event');
        el('h4', label, card);
        if (!event) { el('p', 'Event no longer available.', card); return; }
        el('p', (event.characters || []).join(', ') || 'No character tags', card, 'vf-cr-help');
        el('p', event.summary || '(No summary)', card);
        if (event.result) el('p', `Result: ${event.result}`, card);
        el('small', `Event ${event.event_id} · Messages ${event.source_window_start ?? '?'}–${event.source_window_end ?? '?'}`, card);
    };
    const renderDetail = item => {
        detail.replaceChildren();
        el('h4', '3. Review the evidence', detail);
        if (!item) { el('p', 'Choose a proposal from the list. Load saved runs to review earlier work without making model calls.', detail); return; }
        el('h3', TYPES[item.field] || item.field, detail);
        el('p', statusName(item.entry.status), detail, 'vf-cr-badge');
        const owner = engine.events.get(item.owner), target = engine.events.get(item.entry.event_id);
        eventCard(item.field === 'resolves' ? 'Later event — evidence for resolution' : item.field === 'duplicate_of' ? 'Proposed duplicate' : 'Event being closed', owner);
        if (item.field !== 'closed_threads') eventCard(item.field === 'duplicate_of' ? 'Original event to keep' : 'Earlier event — threads being resolved', target);
        if (item.field !== 'duplicate_of') {
            const conflict = item.field === 'resolves' ? target : owner;
            el('h4', 'Threads to close', detail);
            const threads = el('ul', undefined, detail);
            const indices = item.entry.threads === 'all' ? (conflict?.open_threads || []).map((_, i) => i) : item.entry.threads || [];
            for (const index of indices) el('li', conflict?.open_threads?.[index] ?? `Thread #${index} (unavailable)`, threads);
            if (!indices.length) el('li', 'No thread text available; inspect the source before accepting.', threads);
        }
        el('h4', 'Reasoning', detail);
        el('p', item.entry.how || (item.field === 'duplicate_of' ? 'Vector and source-window duplicate match (no LLM).' : 'No explanation supplied.'), detail);
        if (item.entry.status === 'proposed') {
            const actions = el('div', undefined, detail, 'vf-cr-actions');
            for (const accept of [true, false]) action(accept ? 'Accept proposal' : 'Reject proposal', actions, async () => {
                await engine.review(selectedRun, accept, [item]); selected = null;
            }, reviewable);
        }
    };
    function render() {
        if (closed) return;
        const runs = engine?.listRuns() || [];
        if (!runs.some(run => run.run === selectedRun)) selectedRun = runs[0]?.run || '';
        runSelect.replaceChildren();
        for (const run of runs) el('option', runLabel(run), runSelect).value = run.run;
        if (!runs.length) el('option', 'No saved runs', runSelect).value = '';
        runSelect.value = selectedRun;
        const state = engine?.state;
        if (state) progress.textContent = `${statusName(state.status === 'running' && !engine.running ? 'paused' : state.status)} · ${state.cursor} events processed · ${state.counts.calls} calls · ${state.counts.inputTokens.toLocaleString()} input tokens · ${state.model}${state.skipped?.length ? ` · ${state.skipped.length} batches skipped after unusable responses` : ''}`;
        else progress.textContent = engine ? 'No current run. Select a saved run to review, or estimate a new one.' : 'Inventory a collection or load saved runs to begin.';
        const all = entries(), query = search.value.trim().toLowerCase();
        const matches = all.filter(item => (!filter.value || item.entry.status === filter.value) && (!query || [TYPES[item.field], item.owner, item.entry.event_id, item.entry.how,
            ...[engine.events.get(item.owner), engine.events.get(item.entry.event_id)].flatMap(event => [event?.summary, ...(event?.characters || [])])].filter(Boolean).join(' ').toLowerCase().includes(query)));
        const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
        page = Math.max(0, Math.min(page, pages - 1));
        const visible = matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        if (!visible.some(item => identity(item) === selected)) selected = visible[0] ? identity(visible[0]) : null;
        count.textContent = `${all.filter(item => item.entry.status === 'proposed').length} pending · ${all.filter(item => item.entry.status === 'active').length} accepted · ${matches.length} shown`;
        const scrollTop = list.scrollTop;
        list.replaceChildren();
        for (const [index, item] of visible.entries()) {
            const row = el('button', undefined, list, `vf-cr-row${selected === identity(item) ? ' vf-cr-selected' : ''}`); row.type = 'button';
            row.setAttribute('aria-pressed', String(selected === identity(item)));
            el('strong', `${page * PAGE_SIZE + index + 1}. ${TYPES[item.field] || item.field}`, row);
            el('span', statusName(item.entry.status), row, 'vf-cr-badge');
            el('span', engine.events.get(item.owner)?.summary || item.owner, row, 'vf-cr-row-summary');
            el('small', (engine.events.get(item.owner)?.characters || []).join(', '), row);
            row.addEventListener('click', () => { selected = identity(item); render(); list.querySelector('[aria-pressed="true"]')?.focus(); });
        }
        list.scrollTop = scrollTop;
        if (!visible.length) el('p', all.length ? 'No proposals match these filters.' : 'No proposals in this run.', list, 'vf-cr-help');
        previous.disabled = page === 0; next.disabled = page >= pages - 1; pageLabel.textContent = `${page + 1} / ${pages}`;
        renderDetail(visible.find(item => identity(item) === selected));
        for (let i = controls.length - 1; i >= 0; i--) if (!root.contains(controls[i].node)) controls.splice(i, 1);
        pause.disabled = !engine?.running;
        sync();
    }
    for (const input of [search, filter]) input.addEventListener(input === search ? 'input' : 'change', () => { page = 0; selected = null; render(); });
    previous.addEventListener('click', () => { page--; selected = null; render(); });
    next.addEventListener('click', () => { page++; selected = null; render(); });
    runSelect.addEventListener('change', () => { selectedRun = runSelect.value; selected = null; page = 0; render(); });
    collection.addEventListener('change', () => { release(); engine = null; estimate = null; selectedKey = null; selectedRun = ''; selected = null; page = 0; notice.textContent = ''; render(); });
    root.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') {
            const nodes = [...root.querySelectorAll('button, input, select, summary')].filter(node => !node.disabled && !node.closest('details:not([open]) > :not(summary)'));
            const first = nodes[0], last = nodes.at(-1);
            if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) { event.preventDefault(); first?.focus(); }
        }
    });
    const timer = setInterval(() => {
        if (!root.isConnected) { close(); return; }
        const signature = JSON.stringify([engine?.running, engine?.state]);
        if (signature !== lastProgress) { lastProgress = signature; render(); }
    }, 1000);
    if (!collections.length) notice.textContent = 'No enabled EventBase collections are locked to this chat.';
    render();
    return { close };
}