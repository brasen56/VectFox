/** Shared DOM controls. Writes are supplied by the host and never run on mount. */
export function mountContinuityActions({ host, event, index, act }) {
    const el = (tag, text, parent = host) => {
        const node = document.createElement(tag);
        if (text != null) node.textContent = text;
        parent.append(node);
        return node;
    };
    const controls = el('details');
    controls.className = 'vf-continuity-actions';
    el('summary', 'Manual continuity actions', controls);
    el('p', 'Unmark removes only user marks. Reopen removes the whole extraction/repair self-closure, including one beneath a user mark. Other closures may still keep threads closed.', controls);
    const checks = (event.open_threads || []).map((thread, i) => {
        const label = el('label', null, controls);
        const check = el('input', null, label); check.type = 'checkbox';
        check.setAttribute('aria-label', `Select thread ${i}`);
        label.append(document.createTextNode(` [${i}] ${thread}`));
        return check;
    });
    const note = el('input', null, controls);
    note.type = 'text'; note.maxLength = 200; note.placeholder = 'Outcome (optional)';
    note.setAttribute('aria-label', 'Outcome (optional)');
    const selected = () => checks.flatMap((check, i) => check.checked ? [i] : []);
    const action = (text, name, args) => {
        const button = el('button', text, controls);
        button.type = 'button'; button.className = 'vectfox-btn vectfox-btn-secondary menu_button';
        button.addEventListener('click', () => act(name, args()));
    };
    const markArgs = threads => [threads, note.value || 'Marked resolved by the user.'];
    action('Mark resolved — all', 'markEventResolved', () => markArgs('all'));
    action('Mark selected threads resolved', 'markEventResolved', () => markArgs(selected()));
    if (event.continuity?.v === 1 && event.continuity.closed_threads?.origin === 'user') {
        action('Unmark', 'unmarkEventResolved', () => []);
        action('Unmark selected threads', 'unmarkEventResolved', () => [selected()]);
    }
    const self = event.continuity?.closed_threads?.origin === 'user'
        ? event.continuity.user_previous_closure : event.continuity?.closed_threads;
    if (event.continuity?.v === 1 && ['repair', 'extraction'].includes(self?.origin)) {
        el('p', `Self-closure: ${self.origin} · ${self.status} · threads ${JSON.stringify(self.threads)} · ${self.how || '(no note)'}`, controls);
        action('Reopen self-closure', 'reopenEventSelfClosure', () => []);
    }
    for (const { resolver, link } of index.resolvedBy.get(event.event_id) || []) {
        el('p', `External resolution link stored on ${resolver.event_id}: ${resolver.summary || ''} · ${link.origin} · ${link.status} · threads ${JSON.stringify(link.threads)} · ${link.how || '(no note)'}`, controls);
        action(`Remove link from ${resolver.event_id}`, 'removeResolutionLink', () => [resolver.event_id, link]);
    }
    return controls;
}