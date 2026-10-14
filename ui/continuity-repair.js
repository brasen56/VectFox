/** One-collection repair preview. All story/model text is inserted as text, never HTML. */
import { createContinuityRepair, repairConfiguration } from '../core/continuity-repair-service.js';
import { estimateRepair, listRepairEntries } from '../core/continuity-repair.js';
import { rosterCollectionId } from '../core/character-roster.js';

const sessions = new Map();
const SCOPE_LABELS = Object.freeze({ conflicts: 'Conflicts only', all: 'Every event with open threads', duplicates: 'Duplicates only (no LLM)' });
const button = (host, text, action) => $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text(text)
    .appendTo(host).on('click', async function () {
        $(this).prop('disabled', true);
        try { await action(); } catch (error) { toastr.error(error.message, 'Continuity repair'); }
        finally { $(this).prop('disabled', false); }
    });

export async function openContinuityRepair(settings) {
    const { getLockedCharacterCollections } = await import('../core/eventbase-workflow.js');
    const collections = getLockedCharacterCollections();
    const host = $('#VectFox_continuity_repair_panel');
    if (host.children().length) { toastr.info('Repair review is already open. Close it before reopening.'); return; }
    host.empty();
    if (!collections.length) { host.text('No enabled EventBase collections are locked to this chat.'); return; }
    $('<p>').text('Metadata-only repair; no re-embedding or deletion. Use one writer/tab only. Pause takes effect after the current batch. Estimated tokens are approximate; provider pricing is not included.').appendTo(host);
    const selector = $('<select class="vectfox-select">').appendTo(host);
    collections.forEach(collection => $('<option>').val(collection.registryKey).text(collection.collectionId).appendTo(selector));
    const scope = $('<select class="vectfox-select">').append(Object.entries(SCOPE_LABELS)
        .map(([value, label]) => `<option value="${value}">${label}</option>`).join('')).appendTo(host);
    const input = (label, value, type = 'text') => {
        const row = $('<label>').text(`${label} `).css({ display: 'block', margin: '6px 0' }).appendTo(host);
        return $('<input class="vectfox-input">').attr('type', type).val(value).appendTo(row);
    };
    const importance = input('Minimum importance', 6, 'number').attr({ min: 1, max: 10 });
    // Only "Conflicts only" applies the floor; a live box under another scope reads as if it did.
    const syncImportance = () => importance.prop('disabled', scope.val() !== 'conflicts');
    scope.on('change', syncImportance);
    syncImportance();
    const characters = input('Character pair (comma-separated; optional)', '');
    const start = input('First message (optional)', '', 'number');
    const end = input('Last message (optional)', '', 'number');
    const provider = input('Provider override (openrouter or vllm; optional)', '');
    const model = input('Model override (optional)', '');
    const url = input('vLLM URL override (optional)', '');
    const status = $('<p>').attr('aria-live', 'polite').appendTo(host);
    const actions = $('<div>').css({ display: 'flex', gap: '6px', flexWrap: 'wrap' }).appendTo(host);
    const preview = $('<div>').appendTo(host);
    let engine = null, estimatedOptions = null, selectedKey = null, lease = null;
    const release = () => { if (lease) { lease.close(); lease = null; } };
    const claim = () => {
        if (typeof BroadcastChannel === 'undefined' || lease) return;
        lease = new BroadcastChannel(`vectfox-continuity-${rosterCollectionId(selector.val())}`);
        lease.onmessage = message => {
            if (message.data === 'open') lease?.postMessage('occupied');
            if (message.data === 'open' || message.data === 'occupied') {
                engine?.pause();
                toastr.warning('Another tab has continuity repair open. Use only one writer; repair paused.');
            }
        };
        lease.postMessage('open');
    };
    const options = () => ({ scope: scope.val(), importance: Number(importance.val()),
        characters: String(characters.val()).split(',').map(name => name.trim()).filter(Boolean),
        start: start.val() === '' ? null : Number(start.val()), end: end.val() === '' ? null : Number(end.val()) });
    const configuration = () => repairConfiguration(settings, { provider: String(provider.val()).trim(),
        model: String(model.val()).trim(), url: String(url.val()).trim() });
    const estimateConfiguration = () => ({ options: options(), ...configuration() });
    const describe = () => {
        const state = engine?.state;
        if (state) status.text(`${state.status}: ${state.cursor} conflicts processed · ${state.counts.calls} calls · ${state.counts.inputTokens.toLocaleString()} input tokens · ${state.model}`
            + (state.skipped?.length ? ` · ${state.skipped.length} batch(es) skipped after repeated unusable responses` : ''));
    };
    let page = 0;
    const filter = $('<input class="vectfox-input" placeholder="Filter preview by character">').appendTo(preview);
    const rows = $('<div>').appendTo(preview);
    const paging = $('<div>').appendTo(preview);
    const render = () => {
        describe(); rows.empty(); paging.empty();
        if (!engine?.state) return;
        const chosen = runs.val();
        runs.empty();
        for (const item of engine.listRuns?.() || [engine.state]) {
            $('<option>').val(item.run).text(`${item.run}${item.status ? ` (${item.status})` : ''}`).appendTo(runs);
        }
        if (chosen) runs.val(chosen);
        const events = engine.events;
        const query = String(filter.val()).trim().toLowerCase();
        const entries = listRepairEntries(events.values(), engine.state.run).filter(item => !query
            || [events.get(item.owner), events.get(item.entry.event_id)].some(event => event?.characters?.some(name => name.toLowerCase().includes(query))));
        page = Math.min(page, Math.max(0, Math.ceil(entries.length / 20) - 1));
        for (const item of entries.slice(page * 20, (page + 1) * 20)) {
            const row = $('<div>').css({ borderBottom: '1px solid #666', padding: '8px' }).appendTo(rows);
            $('<p>').text(`${item.field} · ${item.entry.status} · ${events.get(item.owner)?.summary || item.owner}`).appendTo(row);
            // Show the thread text being closed; bare indices cannot be judged.
            const conflict = item.field === 'resolves' ? events.get(item.entry.event_id) : events.get(item.owner);
            const closes = item.field === 'duplicate_of' ? '' : item.entry.threads === 'all' ? 'all threads'
                : (item.entry.threads || []).map(i => conflict?.open_threads?.[i] ?? `#${i}`).join('; ');
            $('<p>').text(`Target: ${events.get(item.entry.event_id)?.summary || '(same record)'}${closes ? ` · Closes: ${closes}` : ''} · ${item.entry.how || ''}`).appendTo(row);
            if (item.entry.status === 'proposed') {
                button(row, 'Accept', async () => { await engine.review(engine.state.run, true, [item]); render(); });
                button(row, 'Reject', async () => { await engine.review(engine.state.run, false, [item]); render(); });
            }
        }
        $('<span>').text(`${entries.length} entries · Page ${page + 1}`).appendTo(paging);
        button(paging, 'Previous', () => { page = Math.max(0, page - 1); render(); });
        button(paging, 'Next', () => { page++; render(); });
    };
    filter.on('input', () => { page = 0; render(); });
    const load = async () => {
        const key = String(selector.val());
        if (engine?.running && key !== selectedKey) throw new Error('Pause the current collection first');
        if (key !== selectedKey) { release(); engine = null; }
        selectedKey = key;
        claim();
        const existing = sessions.get(key);
        const requested = configuration();
        const requestedModel = `${requested.provider}/${requested.model}`;
        if (existing && (existing.model !== requestedModel || existing.endpoint !== requested.url)) {
            if (existing.running) throw new Error('Pause repair before changing models or endpoints');
            sessions.delete(key);
        }
        engine = sessions.get(key) || await createContinuityRepair(key, settings, requested);
        await engine.refreshEvents();
        sessions.set(key, engine);
    };
    selector.on('change', () => {
        if (engine?.running) { selector.val(selectedKey); toastr.warning('Pause the current collection before switching.'); return; }
        estimatedOptions = null; release(); engine = null; selectedKey = null; preview.hide();
    });
    button(actions, 'Inventory and estimate (no LLM)', async () => {
        status.text('Loading stored vectors…');
        await load(); estimatedOptions = estimateConfiguration();
        const estimate = estimateRepair(engine.plan(estimatedOptions.options), engine.model, engine.language);
        preview.show(); render();
        const { scope: chosen, importance: floor } = estimatedOptions.options;
        const scopeName = `${SCOPE_LABELS[chosen] || chosen}${chosen === 'conflicts' ? ` (importance ≥ ${floor})` : ''}`;
        status.text(chosen === 'duplicates'
            ? `${scopeName}: no LLM calls. Proposals still need review before they take effect.`
            : `${scopeName}: ${estimate.events} to judge · up to ${estimate.calls} calls · about ${estimate.inputTokens.toLocaleString()} input tokens (output and reasoning tokens not included) · ${estimate.model}. Duplicate scan uses no LLM. Review this estimate before Start.`);
    });
    button(actions, 'Start', async () => {
        if (!engine || !estimatedOptions || JSON.stringify(estimateConfiguration()) !== JSON.stringify(estimatedOptions) || selector.val() !== selectedKey) throw new Error('Inventory and estimate this scope and provider/model/endpoint first');
        // The engine decides: a finished run blocks only while its proposals await review.
        await engine.start(estimatedOptions.options); render();
        try { await engine.resume(); } finally { render(); }
    });
    button(actions, 'Load / Resume run', async () => { await load(); preview.show(); render(); try { await engine.resume(); } finally { render(); } });
    button(actions, 'Pause', () => { engine?.pause(); status.text('Pausing after the current batch…'); });
    button(actions, 'Cancel', async () => { if (engine?.state) await engine.cancel(); render(); });
    button(actions, 'Accept all', async () => { if (engine?.state) await engine.review(engine.state.run, true); render(); });
    button(actions, 'Reject all proposals', async () => { if (engine?.state) await engine.review(engine.state.run, false); render(); });
    const runs = $('<select class="vectfox-select">').attr('aria-label', 'Repair run to undo').appendTo(actions);
    button(actions, 'Undo run', async () => {
        const run = runs.val() || engine?.state?.run;
        if (!engine || !run || !confirm('Remove all continuity annotations created by this repair run?')) return;
        await engine.undo(run); render();
    });
    button(actions, 'Close review', () => { engine?.pause(); release(); host.empty(); });
}