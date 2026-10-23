/** Characters and NPC cards window: story so far, stable IDs, roster names and card editing
 * in one place. Opening, browsing and editing never call a model or change stored events.
 * Host integration is injected through `deps` so the window can be tested in isolation.
 */
import { continuityBackendNamespace, continuityCollectionKey, continuityDeclarations, resolveContinuityScope,
    readStorySoFar, declareStorySoFar, removeStorySoFar, eventIngestionTime } from '../core/continuity-scope.js';
import { subjectRegistryKey, previewSubjectMigration, applySubjectMigration, readSubjectRegistry } from '../core/continuity-subjects.js';
import { migrateNpcCard } from '../core/npc-card-migration.js';
import { npcCardSnapshot } from '../core/npc-cards.js';
import { subjectCardKey, resolveNpcCardBinding, beginNpcCardEdit, editNpcCardFact, saveNpcCardEdit, inspectNpcCard,
    formatNpcState, exportNpcCardData, importNpcCardData } from '../core/npc-card-state.js';
import { estimateCastTokens } from '../core/eventbase-injection.js';
import { suggestRosterCleanup, readCleanupDismissals, separationPairs } from '../core/character-cleanup.js';

const LIST_PAGE = 100;
const ID_CHANGE_WARNING = 'Changing spellings means updating character IDs (step 2) before affected cards can be edited again.';
const ROLE_REASONS = {
    role: ['role word', 'Looks like a job or role, not a name'],
    article: ['description', 'Starts with "the", "a" or a possessive, so it describes someone rather than naming them'],
    lowercase: ['no capitals', 'Written without capital letters, so probably not a name'],
};

const element = (tag, text, parent, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    parent?.append(node);
    return node;
};
const button = (text, parent, action, className = 'vectfox-btn vectfox-btn-secondary') => {
    const node = element('button', text, parent, className);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
};
const iconButton = (icon, label, parent, action, active = false) => {
    const node = button(undefined, parent, action, `vf-cc-icon${active ? ' vf-cc-on' : ''}`);
    node.setAttribute('aria-label', label);
    node.title = label;
    element('i', undefined, node, `fa-solid ${icon}`).setAttribute('aria-hidden', 'true');
    return node;
};
const aliasKey = aliases => JSON.stringify([...aliases].sort());
const sameAliases = (a, b) => a.length === b.length && a.every(alias => b.includes(alias));
const formatDate = time => new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
const listNames = groups => {
    const names = groups.map(group => group.name);
    return names.length > 10 ? `${names.slice(0, 10).join(', ')} and ${(names.length - 10).toLocaleString()} more` : names.join(', ');
};
const describeLink = link => link.kind === 'variant' ? `"${link.a}" and "${link.b}" differ only in case, accents, titles or punctuation`
    : link.kind === 'typo' ? `"${link.a}" and "${link.b}" are ${plural(link.distance, 'letter')} apart`
        : `"${link.a}" is part of "${link.b}"`;

export function mountCharacterCardsWindow({ root, settings, collections, deps }) {
    const state = { key: collections[0]?.registryKey || null, filter: 'frequent', checked: new Set(), unticked: new Set(),
        selected: null, view: 'card', limit: LIST_PAGE, draft: null, editing: null, prefill: null, ctx: null };
    let generation = 0;
    root.classList.add('vf-cc');
    root.replaceChildren();

    const header = element('div', undefined, root, 'vf-cc-header');
    element('i', undefined, header, 'fa-solid fa-users').setAttribute('aria-hidden', 'true');
    element('h3', 'Characters and NPC cards', header);
    const selector = element('select', undefined, header, 'vectfox-select');
    selector.setAttribute('aria-label', 'Collection');
    for (const collection of collections) element('option', collection.collectionId, selector).value = collection.registryKey;
    if (state.key) selector.value = state.key;
    selector.hidden = collections.length < 2;
    iconButton('fa-rotate', 'Reload characters', header, () => {
        if (!discardOk()) return;
        deps.invalidate?.(state.key);
        void load();
    });
    iconButton('fa-xmark', 'Close', header, () => { if (discardOk()) deps.onClose(); });
    const notice = element('div', undefined, root, 'vf-cc-notice');
    notice.setAttribute('aria-live', 'polite');
    const steps = element('div', undefined, root, 'vf-cc-steps');
    const body = element('div', undefined, root, 'vf-cc-body');
    const list = element('div', undefined, body, 'vf-cc-list');
    const search = element('input', undefined, list, 'vectfox-input');
    search.type = 'search';
    search.placeholder = 'Search names or spellings';
    search.setAttribute('aria-label', 'Search characters');
    const chips = element('div', undefined, list, 'vf-cc-chips');
    const items = element('div', undefined, list, 'vf-cc-items');
    const bulk = element('div', undefined, list, 'vf-cc-bulk');
    const more = element('details', undefined, list, 'vf-cc-more');
    const pane = element('div', undefined, body, 'vf-cc-pane');

    const notify = text => { notice.textContent = text || ''; };
    const commit = text => { deps.save(); notify(text); };
    const contextKey = () => JSON.stringify([deps.readContext(), state.key]);
    const dirty = () => state.draft ? state.draft.card.audit.length - state.draft.before.audit.length : 0;
    const discardOk = () => !dirty() || deps.confirm(`Discard ${plural(dirty(), 'unsaved change')}?`);
    const resetDraft = () => { state.draft = null; state.editing = null; };

    const buildContext = () => {
        const id = deps.collectionId(state.key);
        const namespace = continuityBackendNamespace(state.key, settings);
        return { id, namespace, identityKey: subjectRegistryKey(namespace, id), roster: deps.getRoster([id], settings),
            ignoredTags: deps.ignoredTags(id, settings), snapshots: new Map(), cleanup: null };
    };
    const load = async () => {
        const token = ++generation;
        state.ctx = null;
        resetDraft();
        steps.replaceChildren();
        items.replaceChildren(element('p', 'Loading characters (no model calls)…', undefined, 'vf-cc-muted'));
        pane.replaceChildren();
        if (!state.key) { items.replaceChildren(element('p', 'No enabled EventBase collections are locked to this chat.', undefined, 'vf-cc-muted')); return; }
        const entry = await deps.ensureIndex(state.key, settings);
        if (token !== generation) return;
        if (!entry) { items.replaceChildren(element('p', 'Character index unavailable. Check the backend connection, then reload.', undefined, 'vf-cc-muted')); return; }
        state.ctx = buildContext();
        renderAll();
    };
    const refreshRoster = () => { state.ctx = buildContext(); };

    const groups = () => state.ctx?.roster.groups || [];
    const selectedGroup = () => groups().find(group => aliasKey(group.aliases) === state.selected) || null;
    const registry = () => readSubjectRegistry(settings, state.ctx.identityKey);
    const subjectFor = group => registry().subjects.find(s => !s.retired && sameAliases(s.aliases, group.aliases)) || null;
    const groupForSubject = subject => groups().find(group => sameAliases(group.aliases, subject.aliases)) || null;
    const legacyCardKeys = group => [[state.ctx.id], []].map(ids => JSON.stringify([ids, group.name, [...group.aliases].sort()]));
    const hasCard = (group, subjects) => {
        const subject = subjects.get(aliasKey(group.aliases));
        return Boolean((subject && settings.eventbase_npc_cards?.[subjectCardKey(state.ctx.identityKey, subject.id)])
            || legacyCardKeys(group).some(key => settings.eventbase_npc_cards?.[key]));
    };
    // Snapshots scan every stored event, so build them only for characters actually opened.
    const snapshotFor = group => {
        const key = aliasKey(group.aliases);
        if (!state.ctx.snapshots.has(key)) state.ctx.snapshots.set(key, npcCardSnapshot(state.ctx.roster, group));
        return state.ctx.snapshots.get(key);
    };
    const scopeFor = chatId => resolveContinuityScope({ namespace: state.ctx.namespace, continuityId: state.ctx.id,
        collections: [state.ctx.id], chatId, aliasRevision: registry().revision,
        ...continuityDeclarations(settings, state.ctx.namespace, state.ctx.id) });

    const identityStatus = () => {
        const preview = previewSubjectMigration(settings, state.ctx.identityKey, groups());
        const subjects = registry().subjects.filter(s => !s.retired);
        const uses = new Map();
        for (const row of preview.rows) for (const id of row.candidates) uses.set(id, (uses.get(id) || 0) + 1);
        const rows = preview.rows.map(row => {
            const subject = row.candidates.length === 1 ? subjects.find(s => s.id === row.candidates[0]) : null;
            const kind = !row.candidates.length ? 'new' : row.candidates.some(id => uses.get(id) > 1) ? 'split'
                : row.candidates.length > 1 ? 'merge' : !sameAliases(subject.aliases, row.aliases) ? 'spellings'
                    : subject.name !== row.name ? 'rename' : 'ready';
            return { ...row, kind, subject };
        });
        return { preview, rows, pending: rows.filter(row => row.kind !== 'ready') };
    };

    // ---------------------------------------------------------------- steps
    const step = (number, title, detail, status) => {
        const card = element('div', undefined, steps, `vf-cc-step vf-cc-step-${status}`);
        const heading = element('div', undefined, card, 'vf-cc-step-title');
        if (status === 'done') element('i', undefined, heading, 'fa-solid fa-check').setAttribute('aria-hidden', 'true');
        heading.append(document.createTextNode(`${number} · ${title}`));
        element('div', detail, card, 'vf-cc-step-detail');
        return element('div', undefined, card, 'vf-cc-step-actions');
    };
    const renderSteps = () => {
        steps.replaceChildren();
        const { ctx } = state;
        const story = readStorySoFar(settings, ctx.namespace, ctx.id);
        const storyActions = step(1, 'Story so far', story
            ? `${plural(story.eventCount, 'event')} up to ${formatDate(story.cutoff)} count as one story (your declaration, not verified)`
            : 'Not declared: stored events stay history only', story ? 'done' : 'todo');
        button(story ? 'Update' : 'Declare', storyActions, declareStory);
        if (story) button('Remove', storyActions, () => {
            if (!discardOk() || !deps.confirm('Remove the story-so-far declaration? Generated relationship facts that relied on it will be withheld. Your canon is not affected.')) return;
            removeStorySoFar(settings, ctx.namespace, ctx.id);
            resetDraft();
            commit('Story-so-far declaration removed.');
            renderAll();
        });

        const status = identityStatus();
        const known = registry().subjects.length > 0;
        const ready = !status.pending.length;
        const idActions = step(2, ready ? 'Character IDs ready' : known ? 'Update character IDs' : 'Set up character IDs',
            ready ? `${plural(status.rows.length, 'character')} can be edited`
                : known ? `${plural(status.pending.length, 'name change')} to apply` : 'Needed before editing cards', ready ? 'done' : 'todo');
        if (!ready) button(known ? `Review ${plural(status.pending.length, 'change')}` : `Set up ${plural(status.pending.length, 'character')}`, idActions, openSetup);

        const enabled = Boolean(settings.eventbase_npc_state_enabled);
        const promptActions = step(3, 'Use in prompts', enabled
            ? `On · up to ${settings.eventbase_npc_state_tokens ?? 350} tokens of canon and state per turn`
            : 'Off · canon alone never calls a model', 'optional');
        const label = element('label', undefined, promptActions, 'vf-cc-toggle');
        const toggle = element('input', undefined, label);
        toggle.type = 'checkbox';
        toggle.checked = enabled;
        label.append(document.createTextNode(' Inject canon and state'));
        toggle.addEventListener('change', () => {
            if (toggle.checked && story && settings.eventbase_npc_cards_enabled
                && !deps.confirm('With the story so far declared and NPC cards on, this can start model calls: about one per character pair (up to ~6,000 input tokens) when the pair is next in a scene, and again when its evidence changes.')) {
                toggle.checked = false;
                return;
            }
            settings.eventbase_npc_state_enabled = toggle.checked;
            commit(toggle.checked ? 'Canon and state will be injected.' : 'Canon and state injection is off.');
            renderSteps();
        });
    };
    const declareStory = () => {
        const { ctx } = state;
        const stored = ctx.roster.events.filter(event => eventIngestionTime(event) !== null);
        if (!stored.length) { notify('No stored events with an ingestion time to declare.'); return; }
        const calls = settings.eventbase_npc_state_enabled && settings.eventbase_npc_cards_enabled
            ? '\n\nRelationship state and NPC cards are on, so this can start model calls: about one per character pair (up to ~6,000 input tokens) when the pair is next in a scene, and again when its evidence changes.' : '';
        if (!discardOk() || !deps.confirm(`Treat all ${stored.length.toLocaleString()} events stored in ${ctx.id} as one linear story that happened before now?\n\nThey become eligible evidence for relationship state, labelled "user-declared continuity", not verified. Anything already stored from an abandoned branch or discarded swipe is included too. Events stored after this point stay excluded until you update.${calls}`)) return;
        declareStorySoFar(settings, ctx.namespace, ctx.id, stored);
        resetDraft();
        commit('Story so far declared.');
        renderAll();
    };

    // ------------------------------------------------------------ character list
    const persistGroups = (next, { aliasChange = true, confirmed = false } = {}) => {
        if (aliasChange && !confirmed && registry().subjects.length && !deps.confirm(`${ID_CHANGE_WARNING} Continue?`)) return false;
        settings.eventbase_character_alias_overrides = { ...settings.eventbase_character_alias_overrides, [state.ctx.id]: next };
        state.checked.clear();
        state.unticked.clear();
        refreshRoster();
        return true;
    };
    const persistIgnored = tags => {
        settings.eventbase_character_ignored_tags = { ...settings.eventbase_character_ignored_tags, [state.ctx.id]: [...new Set(tags)] };
        state.checked.clear();
        refreshRoster();
    };
    // Every visible group plus manual choices for ignored spellings, so ignoring and later
    // restoring a tag does not lose its aliases.
    const currentGroups = (rename = new Map()) => {
        const next = groups().map(group => ({ name: rename.get(aliasKey(group.aliases)) || group.name, aliases: [...group.aliases] }));
        for (const override of settings.eventbase_character_alias_overrides?.[state.ctx.id] || []) {
            if (!Array.isArray(override?.aliases) || typeof override.name !== 'string') continue;
            const hidden = override.aliases.filter(alias => state.ctx.ignoredTags.includes(alias));
            if (!hidden.length) continue;
            const target = next.find(group => group.aliases.some(alias => override.aliases.includes(alias)));
            if (target) target.aliases = [...new Set([...target.aliases, ...hidden])];
            else next.push({ name: override.name, aliases: hidden });
        }
        return next;
    };
    const visibleAliases = group => group.aliases.filter(alias => !state.ctx.ignoredTags.includes(alias));
    // Merges groups (keys of their visible spellings) into one manual group; hidden ignored
    // spellings stay with it. Used by bulk Merge and by accepted duplicate suggestions.
    const mergeGroups = (keys, { name, confirmed = false } = {}) => {
        const all = currentGroups();
        const picked = all.filter(group => keys.has(aliasKey(visibleAliases(group))));
        const merged = { name: name || picked[0].name, aliases: [...new Set(picked.flatMap(group => group.aliases))] };
        const anchor = visibleAliases(picked[0])[0];
        if (!persistGroups([...all.filter(group => !picked.includes(group)), merged], { confirmed })) return null;
        resetDraft();
        state.selected = aliasKey(groups().find(group => group.aliases.includes(anchor))?.aliases || []);
        return merged;
    };
    const threshold = () => Math.max(1, Number(settings.eventbase_npc_card_min_events) || 30);

    // Clean-up suggestions compare spellings only. They are worked out once per roster and
    // change nothing until the user merges, ignores or dismisses one.
    const dismissals = () => readCleanupDismissals(settings.eventbase_character_cleanup_dismissed?.[state.ctx.id]);
    const persistDismissals = next => {
        settings.eventbase_character_cleanup_dismissed = { ...settings.eventbase_character_cleanup_dismissed, [state.ctx.id]: readCleanupDismissals(next) };
        state.ctx.cleanup = null;
    };
    const cleanup = () => (state.ctx.cleanup ||= suggestRosterCleanup(groups(), dismissals()));
    const tickKey = (suggestion, group) => JSON.stringify([suggestion.key, aliasKey(group.aliases)]);
    const acceptSuggestion = suggestion => {
        const ticked = suggestion.groups.filter(group => !state.unticked.has(tickKey(suggestion, group)));
        const left = suggestion.groups.filter(group => !ticked.includes(group));
        if (ticked.length < 2) { notify('Tick at least two names to merge.'); return; }
        if (!discardOk()) return;
        const name = ticked[0].name;
        if (!deps.confirm([`Merge ${listNames(ticked)} into one character, ${name}?`,
            left.length ? `${listNames(left)} will stay separate and won't be suggested with them again.` : '',
            registry().subjects.length ? ID_CHANGE_WARNING : '',
            'Stored events are unchanged. You can split them again from Names.'].filter(Boolean).join('\n\n'))) return;
        const merged = mergeGroups(new Set(ticked.map(group => aliasKey(group.aliases))), { name, confirmed: true });
        if (!merged) return;
        if (left.length) {
            const current = dismissals();
            persistDismissals({ ...current, pairs: [...current.pairs, ...separationPairs(ticked.slice(0, 1), left)] });
        }
        commit(`Merged into ${merged.name}.`);
        renderAll();
    };
    const dismissSuggestion = suggestion => {
        const current = dismissals();
        persistDismissals({ ...current, pairs: [...current.pairs, ...separationPairs(suggestion.groups)] });
        commit(`${listNames(suggestion.groups)} won't be suggested as one character again.`);
        renderList();
    };
    const keepName = group => {
        const current = dismissals();
        persistDismissals({ ...current, roles: [...current.roles, ...group.aliases] });
        state.checked.delete(aliasKey(group.aliases));
        commit(`Kept ${group.name}. It won't be suggested as a role again.`);
        renderList();
    };
    const restoreDismissed = (field, question) => {
        if (!deps.confirm(question)) return;
        persistDismissals({ ...dismissals(), [field]: [] });
        commit('Dismissed suggestions are shown again.');
        renderList();
    };

    const renderRow = (parent, group, subjects, checked, label, onCheck, badge = null) => {
        const row = element('div', undefined, parent, `vf-cc-row${state.selected === aliasKey(group.aliases) ? ' vf-cc-selected' : ''}`);
        const check = element('input', undefined, row);
        check.type = 'checkbox';
        check.checked = checked;
        check.setAttribute('aria-label', label);
        check.addEventListener('change', () => onCheck(check.checked));
        const name = button(group.name, row, () => select(group), 'vf-cc-name');
        if (group.aliases.length > 1) {
            name.title = `Also: ${group.aliases.filter(a => a !== group.name).join(', ')}`;
            name.setAttribute('aria-label', group.name);
        }
        if (hasCard(group, subjects)) element('i', undefined, row, 'fa-solid fa-id-card vf-cc-card-icon').setAttribute('aria-label', 'Has card');
        if (group.isLead) element('span', 'Lead', row, 'vf-cc-badge');
        if (badge) element('span', badge[0], row, 'vf-cc-badge').title = badge[1];
        element('span', group.eventCount.toLocaleString(), row, 'vf-cc-count');
        return row;
    };
    const showMore = remaining => {
        if (remaining > 0) button(`Show ${Math.min(LIST_PAGE, remaining)} more of ${remaining}`, items,
            () => { state.limit += LIST_PAGE; renderList(); }, 'vf-cc-link');
    };
    const renderDuplicates = (duplicates, query, subjects) => {
        element('p', 'Spellings that may be one person, found by comparing names only (no model calls). Nothing changes until you merge.', items, 'vf-cc-muted');
        const shown = duplicates.filter(suggestion => suggestion.groups.some(group => [group.name, ...group.aliases].join(' ').toLowerCase().includes(query)));
        if (!shown.length) element('p', query ? 'No suggestions match that search.' : 'No more suggestions.', items, 'vf-cc-muted');
        for (const suggestion of shown.slice(0, state.limit)) {
            const box = element('div', undefined, items, 'vf-cc-suggestion');
            for (const link of suggestion.links.slice(0, 3)) element('div', describeLink(link), box, 'vf-cc-why');
            if (suggestion.links.length > 3) element('div', `…and ${(suggestion.links.length - 3).toLocaleString()} more`, box, 'vf-cc-why');
            if (suggestion.ambiguous) element('div', `Also part of ${suggestion.alsoMatches.join(', ')}. Merge only if this is the same person.`, box, 'vf-cc-why vf-cc-why-warn');
            for (const group of suggestion.groups) {
                const tick = tickKey(suggestion, group);
                renderRow(box, group, subjects, !state.unticked.has(tick), `Include ${group.name}`, on => {
                    if (on) state.unticked.delete(tick); else state.unticked.add(tick);
                });
            }
            const actions = element('div', undefined, box, 'vf-cc-actions');
            const names = listNames(suggestion.groups);
            button('Merge', actions, () => acceptSuggestion(suggestion), 'vectfox-btn vectfox-btn-primary').setAttribute('aria-label', `Merge ${names}`);
            button('Not the same', actions, () => dismissSuggestion(suggestion)).setAttribute('aria-label', `Not the same: ${names}`);
        }
        showMore(shown.length - state.limit);
        if (dismissals().pairs.length) {
            button('Show dismissed suggestions again', items, () => restoreDismissed('pairs', 'Show every duplicate suggestion you dismissed again?'), 'vf-cc-link');
        }
    };

    const renderList = () => {
        chips.replaceChildren();
        items.replaceChildren();
        bulk.replaceChildren();
        const subjects = new Map(registry().subjects.filter(s => !s.retired).map(s => [aliasKey(s.aliases), s]));
        const ignored = state.ctx.ignoredTags;
        const { duplicates, roles } = cleanup();
        const roleReasons = new Map(roles.map(candidate => [aliasKey(candidate.group.aliases), candidate.reason]));
        const filters = [
            ['frequent', `${threshold()}+ events`, group => group.eventCount >= threshold()],
            ['cards', 'Has card', group => hasCard(group, subjects)],
            ['all', `All ${groups().length}`, () => true],
            ...(duplicates.length || state.filter === 'duplicates' ? [['duplicates', `Possible duplicates ${duplicates.length}`, () => false]] : []),
            ...(roles.length || state.filter === 'roles' ? [['roles', `Generic roles ${roles.length}`, group => roleReasons.has(aliasKey(group.aliases))]] : []),
            ...(ignored.length ? [['ignored', `Ignored ${ignored.length}`, () => false]] : []),
        ];
        if (!filters.some(([id]) => id === state.filter)) state.filter = 'frequent';
        for (const [id, label] of filters) {
            const chip = button(label, chips, () => { state.filter = id; state.limit = LIST_PAGE; renderList(); }, `vf-cc-chip${state.filter === id ? ' vf-cc-on' : ''}`);
            chip.setAttribute('aria-pressed', String(state.filter === id));
        }
        const query = search.value.trim().toLowerCase();
        if (state.filter === 'ignored') {
            for (const tag of ignored.filter(t => t.toLowerCase().includes(query))) {
                const row = element('div', undefined, items, 'vf-cc-row');
                element('span', tag, row, 'vf-cc-name');
                button('Restore', row, () => { persistIgnored(ignored.filter(t => t !== tag)); commit(`Restored ${tag}.`); renderAll(); }, 'vf-cc-link');
            }
            button('Restore all ignored names', bulk, () => { persistIgnored([]); commit('Restored all ignored names.'); renderAll(); }, 'vf-cc-link');
            return;
        }
        if (state.filter === 'duplicates') { renderDuplicates(duplicates, query, subjects); return; }
        const matches = filters.find(([id]) => id === state.filter)[2];
        const shown = groups().filter(group => matches(group)
            && [group.name, ...group.aliases].join(' ').toLowerCase().includes(query));
        const reviewingRoles = state.filter === 'roles';
        if (reviewingRoles) {
            element('p', 'Names that look like unnamed roles or generic words, judged from the spelling alone. Tick the ones to ignore. Stored events are unchanged, and Ignored can restore them.', items, 'vf-cc-muted');
            if (shown.length) button(`Select all ${shown.length.toLocaleString()}`, items, () => {
                for (const group of shown) state.checked.add(aliasKey(group.aliases));
                renderList();
            }, 'vf-cc-link');
        }
        if (!shown.length) element('p', query ? 'No characters match that search.' : reviewingRoles ? 'No more role names to review.' : 'No characters in this view.', items, 'vf-cc-muted');
        for (const group of shown.slice(0, state.limit)) {
            const key = aliasKey(group.aliases);
            const reason = reviewingRoles ? ROLE_REASONS[roleReasons.get(key)] : null;
            const row = renderRow(items, group, subjects, state.checked.has(key), `Select ${group.name}`, on => {
                if (on) state.checked.add(key); else state.checked.delete(key);
                renderBulk();
            }, reason);
            if (reason) button('Keep', row, () => keepName(group), 'vf-cc-link').setAttribute('aria-label', `Keep ${group.name}`);
        }
        showMore(shown.length - state.limit);
        if (reviewingRoles && dismissals().roles.length) {
            button('Suggest kept names as roles again', items, () => restoreDismissed('roles', 'Suggest the names you kept as possible roles again?'), 'vf-cc-link');
        }
        renderBulk();
    };
    const renderBulk = () => {
        bulk.replaceChildren();
        if (!state.checked.size || ['ignored', 'duplicates'].includes(state.filter)) return;
        element('span', `${state.checked.size} selected`, bulk, 'vf-cc-muted');
        button('Merge', bulk, () => {
            if (state.checked.size < 2) { notify('Select at least two characters to merge.'); return; }
            if (!discardOk()) return;
            const merged = mergeGroups(state.checked);
            if (!merged) return;
            commit(`Merged into ${merged.name}.`);
            renderAll();
        });
        button('Ignore', bulk, () => {
            if (!discardOk()) return;
            const chosen = groups().filter(group => state.checked.has(aliasKey(group.aliases)));
            if (state.filter === 'roles' && !deps.confirm(`Ignore ${listNames(chosen)}?\n\nIgnored names leave the character roster. Stored events are unchanged, and you can restore them from Ignored.`)) return;
            persistIgnored([...state.ctx.ignoredTags, ...chosen.flatMap(group => group.aliases)]);
            if (chosen.some(group => aliasKey(group.aliases) === state.selected)) { state.selected = null; resetDraft(); }
            commit(`Ignored ${plural(chosen.length, 'character')}. Stored events are unchanged.`);
            renderAll();
        });
        button('Clear', bulk, () => { state.checked.clear(); renderList(); }, 'vf-cc-link');
    };
    const select = group => {
        const key = aliasKey(group.aliases);
        if (key === state.selected && state.view === 'card') { root.classList.add('vf-cc-show-pane'); return; }
        if (!discardOk()) return;
        resetDraft();
        state.selected = key;
        state.view = 'card';
        root.classList.add('vf-cc-show-pane');
        renderList();
        renderPane();
    };

    const renderMore = () => {
        more.replaceChildren();
        element('summary', 'More options', more);
        const { ctx } = state;
        const declarationKey = continuityCollectionKey(ctx.namespace, ctx.id);
        const label = element('label', undefined, more, 'vf-cc-toggle');
        const sibling = element('input', undefined, label);
        sibling.type = 'checkbox';
        sibling.checked = settings.eventbase_declared_continuity?.[declarationKey] === true;
        label.append(document.createTextNode(' Other chat files in this collection are the same story (advanced; needs a source mapping)'));
        sibling.addEventListener('change', () => {
            if (!discardOk()) { sibling.checked = !sibling.checked; return; }
            settings.eventbase_declared_continuity = { ...settings.eventbase_declared_continuity, [declarationKey]: sibling.checked };
            resetDraft();
            commit('Saved.');
            renderPane();
        });
        button('Restore automatic name grouping', more, () => {
            if (!discardOk() || !deps.confirm('Undo every manual merge, split and rename for this collection?')) return;
            if (!persistGroups([])) return;
            resetDraft();
            commit('Automatic name grouping restored.');
            renderAll();
        }, 'vf-cc-link');
        element('div', 'Backup of your canon, pins and hidden facts', more, 'vf-cc-muted');
        const packageText = element('textarea', undefined, more, 'vectfox-input vf-cc-package');
        packageText.setAttribute('aria-label', 'Card backup JSON');
        const row = element('div', undefined, more, 'vf-cc-actions');
        button('Export', row, () => { packageText.value = JSON.stringify(exportNpcCardData(settings, ctx.namespace, ctx.id), null, 2); notify('Copy the text below to keep a backup.'); });
        button('Import', row, () => {
            if (!discardOk()) return;
            try {
                const result = importNpcCardData(settings, JSON.parse(packageText.value), ctx.namespace, ctx.id);
                resetDraft();
                commit(`${plural(result.restored, 'card')} restored. Existing local cards were not overwritten.`);
                renderAll();
            } catch (error) { notify(error.message); }
        });
    };

    // --------------------------------------------------------------- identity setup
    const openSetup = () => {
        if (!discardOk()) return;
        resetDraft();
        state.view = 'setup';
        root.classList.add('vf-cc-show-pane');
        renderPane();
    };
    const migrateLegacyCards = saved => {
        // Declarations let migration keep old generated facts whose sources are eligible.
        const scope = scopeFor('migration-review');
        for (const group of groups()) {
            if (!legacyCardKeys(group).some(key => settings.eventbase_npc_cards?.[key])) continue;
            const subject = saved.subjects.find(s => !s.retired && sameAliases(s.aliases, group.aliases));
            if (!subject) continue; // A split/merge needs explicit fact reassignment, not name guessing.
            const snapshot = snapshotFor(group);
            if (!settings.eventbase_npc_cards?.[snapshot.key]) continue;
            migrateNpcCard({ settings, oldKey: snapshot.key, registryKey: state.ctx.identityKey,
                subjectId: subject.id, scope, snapshot, collection: state.ctx.id, confirmed: true });
        }
    };
    const renderSetup = () => {
        const status = identityStatus();
        const known = registry().subjects.length > 0;
        element('h4', known ? 'Update character IDs' : 'Set up character IDs', pane);
        element('p', 'Each character gets a permanent ID, so renaming it later keeps its card. Nothing is sent to a model and no stored events change.', pane, 'vf-cc-muted');
        if (!status.pending.length) element('p', 'Every character already has an up-to-date ID.', pane);
        const kinds = kind => status.pending.filter(row => row.kind === kind);
        const section = (rows, title, describe) => {
            if (!rows.length) return;
            const box = element('details', undefined, pane, 'vf-cc-section');
            box.open = rows.length <= 10;
            element('summary', `${title} (${rows.length.toLocaleString()})`, box);
            for (const row of rows.slice(0, 300)) element('div', describe(row), box, 'vf-cc-setup-row');
            if (rows.length > 300) element('div', `…and ${(rows.length - 300).toLocaleString()} more`, box, 'vf-cc-muted');
        };
        section(kinds('new'), 'New characters get an ID', row => row.name);
        section(kinds('rename'), 'Renamed', row => `${row.subject.name} → ${row.name}`);
        section(kinds('spellings'), 'Spellings changed', row => `${row.name}: ${row.aliases.join(', ')}`);
        section(kinds('split'), 'Split into new characters. Facts on the old card are held back until you reassign them', row => `${row.name}: ${row.aliases.join(', ')}`);
        const survivors = {};
        const merges = kinds('merge');
        if (merges.length) {
            const box = element('div', undefined, pane, 'vf-cc-section');
            element('div', 'Merged characters: choose which existing ID to keep', box, 'vf-cc-section-title');
            for (const row of merges) {
                const line = element('label', `${row.name} `, box, 'vf-cc-setup-row');
                const choice = element('select', undefined, line, 'vectfox-select');
                for (const id of row.candidates) {
                    const subject = registry().subjects.find(s => s.id === id);
                    element('option', `${subject?.name || id} (${subject?.aliases.join(', ') || 'unknown'})`, choice).value = id;
                }
                const mergeKey = row.candidates.slice().sort().join(',');
                survivors[mergeKey] = choice.value;
                choice.addEventListener('change', () => { survivors[mergeKey] = choice.value; });
            }
        }
        const ambiguous = status.pending.filter(row => row.requiresConfirmation && !['merge', 'split'].includes(row.kind));
        section(ambiguous, 'Check these are one person each', row => `${row.name}: ${row.aliases.join(', ')}`);
        const legacy = groups().filter(group => legacyCardKeys(group).some(key => settings.eventbase_npc_cards?.[key])).length;
        if (legacy && !readStorySoFar(settings, state.ctx.namespace, state.ctx.id)) {
            element('p', `${plural(legacy, 'existing card')} will only keep facts whose sources are eligible. Declare the story so far first (step 1) to keep their generated facts; otherwise they are rebuilt on later turns.`, pane, 'vf-cc-warning');
        }
        const actions = element('div', undefined, pane, 'vf-cc-footer');
        button('Cancel', actions, () => { state.view = 'card'; renderPane(); });
        if (!status.pending.length) return;
        button(known ? 'Apply changes' : 'Apply IDs', actions, () => {
            if (status.preview.rows.some(row => row.requiresConfirmation)
                && !deps.confirm('Apply these IDs exactly as shown, including merges, splits and the names to check?')) return;
            try {
                const saved = applySubjectMigration(settings, status.preview, { confirmed: true, survivors });
                migrateLegacyCards(saved);
                state.view = 'card';
                commit('Character IDs saved. Cards can now be edited.');
                renderAll();
            } catch (error) { notify(error.message); }
        }, 'vectfox-btn vectfox-btn-primary');
    };

    // ------------------------------------------------------------------ names
    const renderNames = group => {
        element('h4', `Names for ${group.name}`, pane);
        const label = element('label', 'Display name ', pane, 'vf-cc-field');
        const input = element('input', undefined, label, 'vectfox-input');
        input.value = group.name;
        const actions = element('div', undefined, pane, 'vf-cc-actions');
        button('Save name', actions, () => {
            const name = input.value.trim();
            if (!name) { notify('Enter a name.'); return; }
            if (!persistGroups(currentGroups(new Map([[aliasKey(group.aliases), name]])), { aliasChange: false })) return;
            state.view = 'card';
            commit(`Renamed to ${name}. The character keeps its card.`);
            renderAll();
        });
        element('p', `Spellings found in stored events: ${group.aliases.join(', ')}`, pane, 'vf-cc-muted');
        if (group.aliases.length > 1) button('Split into separate characters', actions, () => {
            if (!persistGroups(currentGroups().flatMap(g => sameAliases(visibleAliases(g), group.aliases)
                ? g.aliases.map(alias => ({ name: alias, aliases: [alias] })) : [g]))) return;
            state.selected = null;
            state.view = 'card';
            commit(`Split ${group.name} into ${group.aliases.length} characters.`);
            renderAll();
        });
        button('Ignore this character', actions, () => {
            persistIgnored([...state.ctx.ignoredTags, ...group.aliases]);
            state.selected = null;
            state.view = 'card';
            commit(`Ignored ${group.name}. Stored events are unchanged.`);
            renderAll();
        });
        const footer = element('div', undefined, pane, 'vf-cc-footer');
        button('Back to card', footer, () => { state.view = 'card'; renderPane(); });
    };

    // ------------------------------------------------------------------- card
    const renderPane = () => {
        pane.replaceChildren();
        if (!state.ctx) return;
        button('All characters', pane, () => root.classList.remove('vf-cc-show-pane'), 'vf-cc-link vf-cc-back');
        if (state.view === 'setup') { renderSetup(); return; }
        const group = selectedGroup();
        if (!group) {
            state.selected = null;
            element('p', 'Pick a character to see their card.', pane, 'vf-cc-empty');
            return;
        }
        if (state.view === 'names') { renderNames(group); return; }
        renderCard(group);
    };
    const renderCard = group => {
        const { ctx } = state;
        const snapshot = snapshotFor(group);
        const binding = resolveNpcCardBinding(settings, snapshot, group, ctx.namespace);
        if (binding && !state.draft) state.draft = beginNpcCardEdit(settings, binding, contextKey(), snapshot.key);
        const draft = binding ? state.draft : null;
        const stored = draft?.card || settings.eventbase_npc_cards?.[snapshot.key];
        const subjects = registry().subjects.filter(s => !s.retired);
        const nameOf = id => subjects.find(s => s.id === id)?.name || 'unknown character';
        const edit = (action, fact, options = {}) => {
            try { editNpcCardFact(draft, action, fact, options); state.editing = null; renderPane(); }
            catch (error) { notify(error.message); }
        };

        const title = element('div', undefined, pane, 'vf-cc-card-title');
        element('h4', group.name, title);
        const others = group.aliases.filter(alias => alias !== group.name);
        element('span', `${others.length ? `also: ${others.join(', ')} · ` : ''}${plural(group.eventCount, 'event')}`, title, 'vf-cc-muted');
        button('Names', title, () => { if (discardOk()) { resetDraft(); state.view = 'names'; renderPane(); } });
        if (!binding) {
            const banner = element('div', undefined, pane, 'vf-cc-warning');
            element('span', 'Read-only: set up character IDs (step 2) to edit this card.', banner);
            button('Set up IDs', banner, openSetup);
        }
        if (!settings.eventbase_npc_cards_enabled) element('p', 'NPC card generation is off. Stored facts stay visible and your canon can still be injected.', pane, 'vf-cc-muted');
        const facts = inspectNpcCard(stored, snapshot);

        // Your canon
        const canon = element('div', undefined, pane, 'vf-cc-section');
        element('div', 'Your canon', canon, 'vf-cc-section-title');
        const authored = facts.filter(f => f.origin === 'authored');
        if (!authored.length) element('div', 'No canon yet. Add facts the story must respect.', canon, 'vf-cc-muted');
        for (const fact of authored) {
            const row = element('div', undefined, canon, 'vf-cc-fact');
            if (state.editing === fact.id) { renderCorrection(row, fact, edit); continue; }
            const text = element('span', fact.fact, row, 'vf-cc-fact-text');
            if (fact.pairKey) element('span', `with ${nameOf(fact.subjectIds.find(id => id !== binding?.subjectId))}`, text, 'vf-cc-badge');
            if (fact.validity === 'unverified') element('span', 'needs review', text, 'vf-cc-badge vf-cc-badge-warn');
            element('span', `${estimateCastTokens(fact.fact)} tokens`, row, 'vf-cc-muted');
            if (!draft) continue;
            iconButton('fa-pen', 'Edit', row, () => { state.editing = fact.id; renderPane(); });
            iconButton('fa-trash', 'Delete', row, () => {
                if (deps.confirm('Delete this canon fact? Stored events will not change.')) edit('suppress', fact, { confirmed: true });
            });
        }
        if (draft) renderAddCanon(canon, group, binding, subjects, edit);
        renderSharedCanon(group, binding);

        // Generated facts
        const generated = facts.filter(f => f.origin !== 'authored');
        const pairs = generated.filter(f => f.pairKey), history = generated.filter(f => !f.pairKey);
        if (pairs.length) renderGenerated('Relationship state', pairs, draft, edit, nameOf, binding);
        renderGenerated('Generated facts', history, draft, edit, nameOf, binding, stored);
        for (const review of stored?.review || []) element('p', `A hidden fact may be back: ${review.fact}`, pane, 'vf-cc-warning');
        renderRecheck(group, binding);
        renderAdvanced(draft, binding, snapshot);

        const footer = element('div', undefined, pane, 'vf-cc-footer');
        if (!draft) return;
        element('span', dirty() ? `${plural(dirty(), 'unsaved change')}` : 'No unsaved changes', footer, dirty() ? 'vf-cc-dirty' : 'vf-cc-muted');
        button('Cancel', footer, () => { resetDraft(); renderPane(); notify('Changes discarded.'); });
        button('Save', footer, () => {
            if (!dirty()) { notify('No changes to save.'); return; }
            try {
                saveNpcCardEdit(settings, draft, contextKey());
                resetDraft();
                commit('Saved. Stored events were not changed.');
                renderList();
                renderPane();
            } catch (error) { notify(error.message); }
        }, 'vectfox-btn vectfox-btn-primary');
    };
    const renderCorrection = (row, fact, edit) => {
        row.classList.add('vf-cc-editing');
        const text = element('textarea', undefined, row, 'vectfox-input');
        text.value = fact.fact;
        text.setAttribute('aria-label', 'Corrected fact');
        const actions = element('div', undefined, row, 'vf-cc-actions');
        button(fact.origin === 'authored' ? 'Update' : 'Save as my canon', actions, () => edit('correct', fact,
            { text: text.value, pairSubjectIds: fact.pairKey ? fact.subjectIds : [] }));
        button('Cancel', actions, () => { state.editing = null; renderPane(); }, 'vf-cc-link');
    };
    const renderAddCanon = (canon, group, binding, subjects, edit) => {
        const add = element('div', undefined, canon, 'vf-cc-add');
        const text = element('input', undefined, add, 'vectfox-input');
        text.placeholder = `Something true about ${group.name}`;
        text.setAttribute('aria-label', 'New canon text');
        const pair = element('input', undefined, add, 'vectfox-input vf-cc-pair');
        pair.placeholder = 'With… (optional)';
        pair.setAttribute('aria-label', 'Pair with character');
        const options = element('datalist', undefined, add);
        options.id = `vf-cc-pairs-${Math.random().toString(36).slice(2)}`;
        pair.setAttribute('list', options.id);
        for (const subject of subjects.filter(s => s.id !== binding.subjectId)) element('option', undefined, options).value = subject.name;
        if (state.prefill) { text.value = state.prefill.text; pair.value = state.prefill.pair; state.prefill = null; }
        button('Add', add, () => {
            const name = pair.value.trim();
            const partner = name ? subjects.find(s => s.id !== binding.subjectId && s.name.toLowerCase() === name.toLowerCase()) : null;
            if (name && !partner) { notify(`No character named ${name}. Pick a name from the list.`); return; }
            if (partner && [binding.subjectId, partner.id].sort()[0] !== binding.subjectId) {
                // Pair state has one canonical owner; open it rather than storing a second copy.
                const target = groupForSubject(partner);
                if (!target) { notify(`${partner.name} has no stored events here, so this pair can't be edited yet.`); return; }
                if (!text.value.trim()) { notify('Enter the canon text first.'); return; }
                const prefill = { text: text.value, pair: group.name };
                if (!discardOk()) return;
                resetDraft();
                state.prefill = prefill;
                select(target);
                notify(`Canon shared by ${group.name} and ${partner.name} is kept on ${partner.name}'s card. Press Add, then Save.`);
                return;
            }
            edit('add', null, { text: text.value, pairSubjectIds: partner ? [binding.subjectId, partner.id] : [] });
        });
    };
    const renderSharedCanon = (group, binding) => {
        const subject = binding ? subjectFor(group) : null;
        if (!subject) return;
        const shared = Object.values(settings.eventbase_npc_cards || {}).filter(card => card.v === 4
            && card.registryKey === state.ctx.identityKey && card.subjectId !== subject.id)
            .flatMap(card => [...card.authored, ...Object.values(card.pairs).flatMap(p => p.facts || [])]
                .filter(fact => fact.subjectIds?.includes(subject.id)).map(fact => ({ fact, owner: card.subjectId })));
        if (!shared.length) return;
        const box = element('div', undefined, pane, 'vf-cc-section');
        element('div', 'Shared facts kept on other cards', box, 'vf-cc-section-title');
        for (const { fact, owner } of shared) {
            const row = element('div', undefined, box, 'vf-cc-fact');
            element('span', fact.fact, row, 'vf-cc-fact-text');
            const ownerSubject = registry().subjects.find(s => s.id === owner);
            const target = ownerSubject && groupForSubject(ownerSubject);
            if (target) button(`Open ${ownerSubject.name}`, row, () => select(target), 'vf-cc-link');
        }
    };
    const renderGenerated = (title, facts, draft, edit, nameOf, binding, stored) => {
        const box = element('div', undefined, pane, 'vf-cc-section');
        const heading = element('div', title, box, 'vf-cc-section-title');
        if (stored && title === 'Generated facts') element('span', ` · historical summary, may be sampled`, heading, 'vf-cc-muted');
        if (!facts.length) element('div', 'No generated facts stored yet.', box, 'vf-cc-muted');
        for (const fact of facts) {
            const row = element('div', undefined, box, `vf-cc-fact${fact.validity === 'suppressed' ? ' vf-cc-hidden' : ''}`);
            if (state.editing === fact.id) { renderCorrection(row, fact, edit); continue; }
            const text = element('span', fact.fact, row, 'vf-cc-fact-text');
            if (fact.pairKey) element('span', `with ${nameOf(fact.subjectIds.find(id => id !== binding?.subjectId))}`, text, 'vf-cc-badge');
            if (fact.validity === 'unverified') element('span', 'source changed', text, 'vf-cc-badge vf-cc-badge-warn');
            const sources = element('details', undefined, row, 'vf-cc-sources');
            element('summary', fact.validity === 'suppressed' ? 'hidden' : plural(fact.sources?.length || 0, 'source'), sources);
            for (const ref of fact.sources || []) element('div', ref.summary, sources, 'vf-cc-muted');
            if (!draft) continue;
            if (fact.validity === 'suppressed') { button('Restore', row, () => edit('restore', fact), 'vf-cc-link'); continue; }
            iconButton('fa-thumbtack', fact.pinned ? 'Unpin' : 'Pin', row, () => edit('pin', fact), fact.pinned);
            iconButton('fa-pen', 'Correct', row, () => { state.editing = fact.id; renderPane(); });
            iconButton('fa-eye-slash', 'Hide', row, () => edit('suppress', fact));
        }
    };
    // A card migrated before the story was declared kept only some facts. Recheck while it
    // is still an untouched migration envelope; an edited card is never replaced.
    const renderRecheck = (group, binding) => {
        const stored = binding ? settings.eventbase_npc_cards?.[binding.key] : null;
        if (stored?.v !== 3 || !stored.migration?.generatedRebuildRequired) return;
        const old = stored.legacy?.facts?.length || 0, kept = stored.historical?.facts?.length || 0;
        if (!readStorySoFar(settings, state.ctx.namespace, state.ctx.id) || old <= kept) return;
        const banner = element('div', undefined, pane, 'vf-cc-warning');
        element('span', `${plural(old - kept, 'fact')} from this character's old card were held back when IDs were set up.`, banner);
        button('Recheck with story so far', banner, () => {
            if (!discardOk()) return;
            const cards = settings.eventbase_npc_cards;
            const { [binding.key]: envelope, ...rest } = cards;
            settings.eventbase_npc_cards = rest;
            try {
                migrateNpcCard({ settings, oldKey: envelope.migration.oldKey, registryKey: state.ctx.identityKey,
                    subjectId: binding.subjectId, scope: scopeFor('migration-review'), snapshot: snapshotFor(group),
                    collection: state.ctx.id, confirmed: true });
            } catch (error) {
                settings.eventbase_npc_cards = cards;
                notify(error.message);
                return;
            }
            resetDraft();
            commit(`Rechecked. ${plural(settings.eventbase_npc_cards[binding.key].historical.facts.length, 'fact')} kept.`);
            renderPane();
        });
    };
    const renderAdvanced = (draft, binding, snapshot) => {
        const advanced = element('details', undefined, pane, 'vf-cc-more');
        element('summary', 'Advanced: prompt preview, raw changes, reset', advanced);
        if (!draft) { element('p', 'Available once this character has an ID.', advanced, 'vf-cc-muted'); return; }
        const subjects = registry().subjects.filter(s => !s.retired).map(s => s.id);
        const previewSettings = { ...settings, eventbase_npc_cards: { ...settings.eventbase_npc_cards, [binding.key]: draft.card } };
        const preview = formatNpcState({ settings: previewSettings, scope: scopeFor(deps.chatId() || 'inspection'),
            registryKey: binding.registryKey, subjectIds: subjects, snapshots: new Map([[binding.subjectId, snapshot]]),
            tokenBudget: Math.min(Number(settings.eventbase_token_budget ?? 4000), Number(settings.eventbase_npc_state_tokens ?? 350)) });
        element('div', 'Prompt preview (every character in this collection; a real scene only includes characters in play)', advanced, 'vf-cc-muted');
        element('pre', preview.text || '(Nothing would be injected: turned off, not eligible, or no budget.)', advanced);
        if (preview.excluded.length || preview.omitted.length) element('pre', JSON.stringify({ excluded: preview.excluded, omitted: preview.omitted }, null, 2), advanced);
        const raw = element('details', undefined, advanced);
        element('summary', 'Raw before / after', raw);
        element('pre', JSON.stringify({ before: draft.before, after: draft.card }, null, 2), raw);
        button('Reset this card\'s generated facts (no model calls)', advanced, () => {
            draft.card.generated = { v: 2, facts: [], cited: {}, coverage: '', planned: '' };
            draft.card.pairs = {};
            draft.card.audit.push({ action: 'reset_generated_cache', at: new Date().toISOString() });
            renderPane();
            notify('Reset in this draft only. Save to apply. Your canon, pins and hidden facts stay; rebuilding on later turns can take up to 4 model calls.');
        }, 'vf-cc-link');
    };

    const renderAll = () => {
        if (!state.ctx) return;
        renderSteps();
        renderList();
        renderMore();
        renderPane();
    };

    search.addEventListener('input', () => { state.limit = LIST_PAGE; if (state.ctx) renderList(); });
    selector.addEventListener('change', () => {
        if (!discardOk()) { selector.value = state.key; return; }
        state.key = selector.value;
        state.selected = null;
        state.view = 'card';
        state.checked.clear();
        void load();
    });
    root.addEventListener('keydown', event => {
        if (event.key === 'Escape' && discardOk()) deps.onClose();
    });
    const ready = load();
    return { ready, state };
}
