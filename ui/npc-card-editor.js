/** Text-only browser/editor. Host integration is lazy so the editor can be tested in isolation. */
import { beginNpcCardEdit, editNpcCardFact, saveNpcCardEdit, inspectNpcCard, formatNpcState } from '../core/npc-card-state.js';
import { estimateCastTokens } from '../core/eventbase-injection.js';

const element = (tag, text, parent) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent?.append(node);
    return node;
};
const button = (text, parent, action) => {
    const node = element('button', text, parent);
    node.type = 'button';
    node.className = 'vectfox-btn vectfox-btn-secondary';
    node.addEventListener('click', action);
    return node;
};

export function mountNpcCardEditor({ host, settings, binding, snapshot, contextKey, readContext = () => contextKey,
    legacyKey, scope, save = () => {}, confirmDelete = text => globalThis.confirm(text) }) {
    let draft = binding ? beginNpcCardEdit(settings, binding, contextKey, legacyKey) : null;
    const stored = () => draft?.card || settings.eventbase_npc_cards?.[legacyKey];
    const message = element('p', '', host);
    const body = element('div', undefined, host);
    const render = () => {
        body.replaceChildren();
        message.textContent = settings.eventbase_npc_cards_enabled ? 'Inspection does not generate cards.'
            : 'Generation disabled. Stored facts remain inspectable; inspection does not enable generation or injection.';
        if (!binding) element('p', 'Read-only: unsupported or ambiguous legacy identity. Apply stable subject identities in roster review before editing.', body);
        const card = stored();
        element('p', `Updated: ${card?.updatedAt || card?.generated?.updatedAt || 'never'} · Historical card, not verified current state. Evidence may be sampled/incomplete.`, body);
        if (draft) button('Reset this generated cache (no model calls)', body, () => {
            draft.card.generated = { v: 2, facts: [], cited: {}, coverage: '', planned: '' };
            draft.card.pairs = {};
            draft.card.audit.push({ action: 'reset_generated_cache', at: new Date().toISOString() });
            render(); message.textContent = 'Generated cache reset in draft only. Save to apply. Authored facts, pins and suppressions retained; rebuilding on later real turns may cost up to 4 historical calls per NPC.';
        });
        const facts = inspectNpcCard(card, snapshot);
        for (const review of card?.review || []) element('p', `Review: ${review.reason}: ${review.fact}`, body);
        if (!facts.length) element('p', snapshot.events.length ? 'No stored facts.' : 'No eligible evidence or stored facts.', body);
        for (const [label, filter] of [
            ['Historical generated facts', f => f.origin !== 'authored' && !f.pairKey],
            ['Current pair facts', f => f.origin !== 'authored' && f.pairKey],
            ['User canon / corrections', f => f.origin === 'authored'],
        ]) {
            element('h4', label, body);
            for (const fact of facts.filter(filter)) {
                const row = element('div', undefined, body);
                element('p', `${fact.pinned ? '📌 ' : ''}${fact.fact}`, row);
                element('small', `${fact.origin} · ${fact.validity} · ${fact.reason || ''} · ${estimateCastTokens(fact.fact)} estimated tokens · as of ${fact.asOf || 'unknown'}`, row);
                const sources = element('details', undefined, row);
                element('summary', `Sources (${fact.sources?.length || 0})`, sources);
                for (const ref of fact.sources || []) element('p', `${ref.event_id}: ${ref.summary}`, sources);
                if (!draft) continue;
                const edit = (action, options = {}) => {
                    try { editNpcCardFact(draft, action, fact, options); render(); }
                    catch (error) { message.textContent = error.message; }
                };
                button(fact.pinned ? 'Unpin' : 'Pin', row, () => edit('pin'));
                button(fact.validity === 'suppressed' ? 'Restore' : fact.origin === 'authored' ? 'Delete authored fact' : 'Suppress', row, () => {
                    const confirmed = fact.origin !== 'authored' || confirmDelete('Delete this user-authored fact? Source events will not be changed.');
                    if (confirmed) edit(fact.validity === 'suppressed' ? 'restore' : 'suppress', { confirmed });
                });
                const correction = element('textarea', undefined, row);
                correction.value = fact.fact;
                correction.setAttribute('aria-label', 'Correct fact text');
                button('Correct as user-authored', row, () => edit('correct', { text: correction.value, pairSubjectIds: fact.pairKey ? fact.subjectIds : [] }));
            }
        }
        if (!draft) return;
        element('h4', 'Add user canon / constraint', body);
        const input = element('textarea', undefined, body);
        input.setAttribute('aria-label', 'New canon text');
        const pair = element('select', undefined, body);
        element('option', 'Subject only', pair).value = '';
        for (const subject of settings.eventbase_subject_registries[binding.registryKey].subjects.filter(s => !s.retired && s.id !== binding.subjectId)) {
            element('option', `Pair with ${subject.name}`, pair).value = subject.id;
        }
        button('Add canon', body, () => {
            try { editNpcCardFact(draft, 'add', null, { text: input.value,
                pairSubjectIds: pair.value ? [binding.subjectId, pair.value] : [] }); render(); }
            catch (error) { message.textContent = error.message; }
        });
        const diff = element('details', undefined, body);
        element('summary', 'Before / after (unsaved)', diff);
        element('pre', JSON.stringify({ before: draft.before, after: draft.card }, null, 2), diff);
        const previewSettings = { ...settings, eventbase_npc_cards: { ...settings.eventbase_npc_cards, [binding.key]: draft.card } };
        const preview = formatNpcState({ settings: previewSettings, scope, registryKey: binding.registryKey,
            subjectIds: settings.eventbase_subject_registries[binding.registryKey].subjects.filter(s => !s.retired).map(s => s.id),
            snapshots: new Map([[binding.subjectId, snapshot]]), tokenBudget: Math.min(Number(settings.eventbase_token_budget ?? 4000), Number(settings.eventbase_npc_state_tokens ?? 350)) });
        element('h4', 'State dry-run (all subjects in this continuity; final scene selection may differ)', body);
        element('pre', preview.text || '(No state injected: disabled, ineligible or insufficient budget.)', body);
        element('pre', JSON.stringify({ tokens: preview.estimatedTokens, omitted: preview.omitted, excluded: preview.excluded }, null, 2), body);
        button('Save', body, () => {
            try {
                saveNpcCardEdit(settings, draft, readContext());
                save();
                draft = beginNpcCardEdit(settings, binding, readContext(), legacyKey);
                render(); message.textContent = 'Saved. Historical events and backend records were not changed.';
            } catch (error) { message.textContent = error.message; }
        });
        button('Cancel / reload', body, () => {
            if (readContext() !== contextKey) { message.textContent = 'Scope changed. Reopen the browser.'; return; }
            draft = beginNpcCardEdit(settings, binding, contextKey, legacyKey); render();
        });
    };
    render();
    return { getDraft: () => draft };
}

