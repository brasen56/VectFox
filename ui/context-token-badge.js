/** Optional, text-free presentation of the generation accounting lifecycle. */
import { CONTEXT_TOKEN_DISPLAY } from '../core/context-token-contract.js';
import { CONTEXT_TOKEN_ACCURACY } from '../core/context-token-accounting.js';

const owners = new WeakMap();
const categoryLabels = {
    chunkbase: 'ChunkBase', eventbase: 'EventBase', summarizer: 'Summarizer', lorebook: 'Separate lorebook',
};

export function createContextTokenBadge({ lifecycle, readVisible, document: doc = document }) {
    let root = null;
    let details = null;
    let summary = null;
    let content = null;
    let unsubscribe = null;
    let observer = null;
    let initialized = false;

    function element(tag, text, className) {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    }

    const countLabel = count => Number.isSafeInteger(count) && count >= 0 ? count.toLocaleString() : 'Unavailable';

    function render(state) {
        if (!root) return;
        const { status, result } = state;
        let label = CONTEXT_TOKEN_DISPLAY.UNMEASURED;
        if (status === 'disabled') label = CONTEXT_TOKEN_DISPLAY.DISABLED;
        else if (status === 'unavailable') label = CONTEXT_TOKEN_DISPLAY.UNAVAILABLE;
        else if (status === 'available') {
            label = result?.total === 0 ? CONTEXT_TOKEN_DISPLAY.ZERO :
                CONTEXT_TOKEN_DISPLAY.AVAILABLE.replace('{total}', countLabel(result?.total));
        }
        summary.textContent = label;
        content.replaceChildren(element('strong', 'Last measured turn'));
        if (!result) {
            content.append(element('p', status === 'disabled' ? 'Enable VectFox to measure context tokens.' :
                status === 'unavailable' ? 'Token count unavailable. Try another generation.' : 'No measured turn yet. Generate a reply to measure context tokens.'));
        } else {
            const table = element('table');
            table.append(element('caption', 'VectFox injection slots'));
            const header = element('tr');
            for (const title of ['Slot', 'Position / depth', 'Tokens']) {
                const cell = element('th', title);
                cell.scope = 'col';
                header.append(cell);
            }
            const head = element('thead');
            head.append(header);
            const body = element('tbody');
            for (const slot of result.slots) {
                const row = element('tr');
                const name = element('td');
                name.append(element('span', slot.label), element('code', slot.tag));
                row.append(name, element('td', `${slot.position ?? '—'} / ${slot.depth ?? '—'}`),
                    element('td', countLabel(slot.count)));
                body.append(row);
            }
            table.append(head, body);
            content.append(table);
            if (!result.slots.length) content.append(element('p', 'No injected content.'));
            const subtotals = element('dl', undefined, 'vectfox-token-subtotals');
            for (const [category, count] of Object.entries(result.perCategory)) {
                subtotals.append(element('dt', categoryLabels[category] ?? `Other VectFox injection (${category})`),
                    element('dd', countLabel(count)));
            }
            subtotals.append(element('dt', 'Total'), element('dd', countLabel(result.total)));
            content.append(subtotals);
        }
        const identity = result?.tokenizer;
        const tokenizer = identity ? ['name', 'key', 'id', 'model']
            .filter(key => identity[key] !== undefined).map(key => `${key}: ${identity[key]}`).join(' · ') : 'Not available';
        content.append(element('p', `Tokenizer: ${tokenizer}`),
            element('p', `Counting convention: sum-of-blocks (sum of individually tokenized slots). ${CONTEXT_TOKEN_ACCURACY}`));
    }

    function onKeyDown(event) {
        if (event.key === 'Escape' && details.open) {
            details.open = false;
            summary.focus();
            event.preventDefault();
            event.stopPropagation();
        }
    }

    function mount() {
        if (root) return true;
        // Reserve space directly above the composer instead of overlaying send controls.
        const composer = doc.getElementById('form_sheld');
        if (!composer?.parentElement) return false;
        root = element('div', undefined, 'vectfox-context-token-badge');
        root.id = 'VectFox_context_token_badge';
        details = element('details');
        summary = element('summary');
        summary.setAttribute('aria-controls', 'VectFox_context_token_breakdown');
        summary.setAttribute('aria-live', 'polite');
        summary.setAttribute('aria-atomic', 'true');
        content = element('div', undefined, 'vectfox-token-breakdown');
        content.id = 'VectFox_context_token_breakdown';
        content.setAttribute('role', 'region');
        content.setAttribute('aria-label', 'VectFox context token breakdown');
        content.tabIndex = 0;
        details.append(summary, content);
        root.append(details);
        root.addEventListener('keydown', onKeyDown);
        composer.before(root);
        render(lifecycle.getState());
        return true;
    }

    function unmount() {
        observer?.disconnect();
        observer = null;
        unsubscribe?.();
        unsubscribe = null;
        root?.removeEventListener('keydown', onKeyDown);
        root?.remove();
        root = details = summary = content = null;
    }

    function refresh() {
        if (!initialized) return;
        lifecycle.refreshEnabled();
        if (!readVisible()) {
            unmount();
            return;
        }
        if (!unsubscribe) unsubscribe = lifecycle.subscribe(render);
        if (mount()) {
            observer?.disconnect();
            observer = null;
            render(lifecycle.getState());
        } else if (!observer) {
            observer = new doc.defaultView.MutationObserver(() => {
                if (mount()) {
                    observer.disconnect();
                    observer = null;
                }
            });
            observer.observe(doc.body, { childList: true, subtree: true });
        }
    }

    const badge = {
        refresh,
        initialize() {
            if (initialized) return;
            owners.get(doc)?.dispose();
            owners.set(doc, badge);
            initialized = true;
            refresh();
        },
        dispose() {
            initialized = false;
            unmount();
            if (owners.get(doc) === badge) owners.delete(doc);
        },
    };
    return badge;
}