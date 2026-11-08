/** DOM-only thread window; host, metadata reader and explicit actions are injected. */
import { loadOpenThreads, filterOpenThreads, OPEN_THREAD_LIMITS } from '../core/open-threads.js';
import { mountContinuityActions } from './continuity-actions.js';

export function mountOpenThreadsWindow({ root, settings, collections, activeCollection, deps }) {
    root.classList.add('vf-ot');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Open Threads');
    root.tabIndex = -1;
    const el = (tag, text, parent = root) => {
        const node = document.createElement(tag);
        if (text != null) node.textContent = text;
        parent.append(node);
        return node;
    };
    const button = (text, task, parent = root) => {
        const node = el('button', text, parent);
        node.type = 'button'; node.className = 'menu_button';
        node.addEventListener('click', task);
        return node;
    };
    let closed = false, operation = 0, scopeRevision = 0, controller = null, snapshot = null, page = 0, computed = '', writing = false;
    const header = el('header');
    el('h3', 'Open Threads', header);
    const cancel = () => { operation++; controller?.abort(); controller = null; };
    const close = () => {
        if (closed) return;
        closed = true; cancel(); observer.disconnect();
        document.removeEventListener('vectfox:api-status-changed', contextChanged);
        deps.onClose();
    };
    button('Close', close, header);
    el('p', 'Archive-derived status, not whole-story coverage: extraction gaps are invisible. Audit closed threads to inspect potentially incorrect stored closures. Manual actions change continuity metadata only; no model calls or pins.');
    el('p', 'Age is the age of the event stating the thread, not its last mention. Approximate message positions are not globally comparable across sibling or slimmed chats. Story age is relative to the latest stored story date in each collection.');
    const scopeLabel = el('label', 'Collection scope (select 1–20; Ctrl/Cmd-click for additional archives)');
    const scope = el('select', null, scopeLabel);
    scope.multiple = true; scope.size = Math.min(5, Math.max(2, collections.length));
    scope.setAttribute('aria-label', 'Collection scope');
    for (const key of [...new Set([activeCollection, ...collections].filter(Boolean))]) {
        const option = el('option', key, scope); option.value = key; option.title = key; option.selected = key === activeCollection;
    }
    const filters = el('div'); filters.className = 'vf-ot-filters';
    const castLabel = el('label', 'Cast group');
    filters.append(castLabel);
    const cast = el('select', null, castLabel); cast.setAttribute('aria-label', 'Cast group');
    el('option', 'All cast', cast).value = '';
    const importanceLabel = el('label', 'Minimum importance', filters);
    const importance = el('input', null, importanceLabel);
    importance.type = 'number'; importance.min = '0'; importance.max = '10'; importance.value = '0';
    importance.setAttribute('aria-label', 'Minimum importance');
    const auditLabel = el('label', null, filters);
    const audit = el('input', null, auditLabel); audit.type = 'checkbox';
    audit.setAttribute('aria-label', 'Show closed threads');
    auditLabel.append(document.createTextNode(' Show closed threads (audit)'));
    const actions = el('div');
    const status = el('p'); status.setAttribute('role', 'status');
    const output = el('div'); output.className = 'vf-ot-results';
    const paging = el('div'); paging.className = 'vf-ot-paging';
    const selectedScope = () => [...scope.selectedOptions].map(option => option.value);
    const cite = (collection, event, parent) => button(`${collection} / ${event.event_id} — View source event`, async () => {
        try { await deps.openEvent(collection, event.event_id); }
        catch (error) { if (!closed) status.textContent = `Source view unavailable: ${error.message}`; }
    }, parent);
    const render = () => {
        output.replaceChildren(); paging.replaceChildren();
        if (!snapshot || closed) return;
        const rows = filterOpenThreads(snapshot, { audit: audit.checked, importance: Number(importance.value) || 0, group: cast.value });
        const remaining = rows.reduce((n, row) => n + row.indices.length, 0);
        const events = rows.filter(row => row.indices.length).length;
        status.textContent = `Archive-derived: ${remaining} remaining threads across ${events} events. Scope: ${selectedScope().join(', ')}. Computed ${computed}. ${audit.checked ? `${rows.length} events including closed-thread audit.` : ''}`;
        page = Math.min(page, Math.max(0, Math.ceil(rows.length / OPEN_THREAD_LIMITS.pageSize) - 1));
        for (const row of rows.slice(page * OPEN_THREAD_LIMITS.pageSize, (page + 1) * OPEN_THREAD_LIMITS.pageSize)) {
            const { event, view, collection } = row;
            const card = el('article', null, output);
            cite(collection, event, card);
            el('h4', event.summary || '(No stored summary)', card);
            el('p', `${row.age} · importance ${event.importance ?? 'unknown'} · ${event.event_type || 'unknown type'}`, card);
            el('p', `Cast: ${(event.characters || []).join(', ') || '—'} · Locations: ${(event.locations || []).join(', ') || '—'} · Keywords: ${(event.keywords || []).join(', ') || '—'}`, card);
            el('small', `Sibling status: ${row.indices.length} remaining / ${view.closedThreads.length} closed`, card);
            const list = el('ul', null, card);
            event.open_threads.forEach((thread, index) => {
                const isClosed = view.closedThreads.includes(index);
                if (isClosed && !audit.checked) return;
                const item = el('li', `[${index}] ${isClosed ? 'Closed' : 'Open'}: ${thread}`, list);
                if (isClosed) {
                    for (const resolution of view.resolutions.filter(r => r.threads === 'all' || r.threads.includes(index))) {
                        const resolver = row.index.eventById.get(resolution.event_id);
                        el('p', `Resolution origin: ${resolution.origin || 'unknown'} · ${resolver?.summary || resolution.text} · How: ${resolution.how || '(no note)'}`, item);
                        if (resolver) cite(collection, resolver, item);
                    }
                }
            });
            for (const link of view.inactiveLinks) {
                el('p', `Inactive link: ${link.reason} · origin ${link.origin || 'unknown'} · event ${link.event_id}. This link does not close threads.`, card);
            }
            if (deps.continuityAction) mountContinuityActions({ host: card, event, index: row.index,
                act: async (name, args, expected) => {
                    if (writing || closed) return;
                    writing = true;
                    const run = scopeRevision, context = deps.contextKey?.();
                    root.querySelectorAll('.vf-continuity-actions button').forEach(node => { node.disabled = true; });
                    try {
                        await deps.continuityAction(name, collection, event.event_id, args, expected);
                        if (!closed && run === scopeRevision && context === deps.contextKey?.()) await load();
                    } catch (error) {
                        if (!closed && run === scopeRevision && context === deps.contextKey?.()) status.textContent = `Continuity action failed: ${error.message}`;
                    } finally {
                        writing = false;
                        root.querySelectorAll('.vf-continuity-actions button').forEach(node => { node.disabled = false; });
                    }
                } });
        }
        if (!rows.length) el('p', 'No stored threads match these filters.', output);
        const previous = button('Previous page', () => { page--; render(); }, paging); previous.disabled = page === 0;
        el('span', `Page ${page + 1} of ${Math.max(1, Math.ceil(rows.length / OPEN_THREAD_LIMITS.pageSize))}`, paging);
        const next = button('Next page', () => { page++; render(); }, paging);
        next.disabled = (page + 1) * OPEN_THREAD_LIMITS.pageSize >= rows.length;
    };
    const clear = (message, invalidate = true) => { if (invalidate) scopeRevision++; cancel(); snapshot = null; output.replaceChildren(); paging.replaceChildren(); status.textContent = message; };
    const load = async () => {
        clear('Loading archive metadata…', false);
        const run = operation, context = deps.contextKey?.();
        const request = new AbortController(); controller = request;
        try {
            const result = await loadOpenThreads(selectedScope(), settings, deps.ensureIndex, request.signal);
            if (closed || run !== operation || request.signal.aborted || context !== deps.contextKey?.()) return;
            snapshot = result; page = 0; computed = new Date().toLocaleString();
            const oldCast = cast.value;
            cast.replaceChildren(); el('option', 'All cast', cast).value = '';
            for (const group of result.groups) el('option', `${group.name} (${group.collection})`, cast).value = group.key;
            cast.value = result.groups.some(group => group.key === oldCast) ? oldCast : '';
            render();
        } catch (error) {
            if (!closed && run === operation) status.textContent = request.signal.aborted ? 'Load cancelled.' : error.message;
        } finally { if (run === operation) controller = null; }
    };
    button('Refresh', load, actions);
    button('Cancel load', () => clear('Load cancelled. Refresh to enumerate.'), actions);
    scope.addEventListener('change', () => clear('Scope changed. Refresh to enumerate selected archives.'));
    for (const control of [cast, importance, audit]) control.addEventListener('change', () => { page = 0; render(); });
    let context = deps.contextKey?.();
    const contextChanged = () => {
        const next = deps.contextKey?.();
        if (next !== context) { context = next; clear('Chat or collection context changed. Reopen this window for the current scope.'); }
    };
    root.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
    const observer = new MutationObserver(() => { if (!root.isConnected) close(); });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('vectfox:api-status-changed', contextChanged);
    void load();
    return { close };
}