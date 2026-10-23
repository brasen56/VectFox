/** Host integration for the no-generation NPC card browser. */
import { mountNpcCardEditor } from './npc-card-editor.js';
import { resolveNpcCardBinding, exportNpcCardData, importNpcCardData } from '../core/npc-card-state.js';
import { npcCardSnapshot } from '../core/npc-cards.js';
import { continuityBackendNamespace, continuityDeclarations, readStorySoFar, resolveContinuityScope } from '../core/continuity-scope.js';
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

export async function openNpcCardBrowser(settings, { collectionKey, name = '' } = {}) {
    const [{ getLockedCharacterCollections }, { ensureCharacterIndex, getCharacterRoster, rosterCollectionId },
        { extension_settings, getContext }, { saveSettingsDebounced, getCurrentChatId }] = await Promise.all([
        import('../core/eventbase-workflow.js'), import('../core/character-roster.js'),
        import('../../../../extensions.js'), import('../../../../../script.js'),
    ]);
    const host = document.getElementById('VectFox_npc_card_browser');
    if (!host) return;
    host.replaceChildren();
    const save = () => { Object.assign(extension_settings.vectfox, settings); saveSettingsDebounced(); };
    const collections = getLockedCharacterCollections();
    const selector = element('select', undefined, host);
    for (const collection of collections) element('option', collection.collectionId, selector).value = collection.registryKey;
    if (collectionKey) selector.value = collectionKey;
    const search = element('input', undefined, host);
    search.placeholder = 'Search subject / name / alias'; search.value = name;
    const content = element('div', undefined, host);
    let generation = 0;
    const render = async () => {
        const token = ++generation, key = selector.value;
        content.replaceChildren();
        if (!key) { element('p', 'No locked EventBase collections.', content); return; }
        element('p', 'Loading stored evidence (no model calls)…', content);
        await ensureCharacterIndex(key, settings);
        if (token !== generation) return;
        content.replaceChildren();
        const collection = rosterCollectionId(key), namespace = continuityBackendNamespace(key, settings);
        const roster = getCharacterRoster([collection], settings);
        const readContext = () => JSON.stringify([getCurrentChatId(), selector.value, continuityBackendNamespace(key, settings),
            (getContext()?.chat || []).map(m => [m.mes, m.swipe_id])]);
        const contextKey = readContext();
        const scope = resolveContinuityScope({ namespace, continuityId: collection, collections: [collection], chatId: getCurrentChatId() || 'inspection',
            ...continuityDeclarations(settings, namespace, collection) });
        const story = readStorySoFar(settings, namespace, collection);
        element('p', story
            ? `Story so far declared (user-declared continuity, not verified): events stored up to ${new Date(story.cutoff).toLocaleString()} can support relationship state. Later events stay withheld until you update the declaration in roster review.`
            : 'No verified host source-frame mapping: generated current-state assertions remain withheld.', content);
        for (const group of roster.groups.filter(g => [g.name, ...g.aliases].join(' ').toLowerCase().includes(search.value.toLowerCase()))) {
            const snapshot = npcCardSnapshot(roster, group);
            const binding = resolveNpcCardBinding(settings, snapshot, group, namespace);
            const section = element('details', undefined, content);
            element('summary', `${group.name} · ${group.eventIds.size} events`, section);
            mountNpcCardEditor({ host: section, settings, binding, snapshot, contextKey, readContext,
                legacyKey: snapshot.key, scope, save });
        }
        const registryKey = JSON.stringify([namespace, collection]);
        const packageText = element('textarea', undefined, content);
        packageText.setAttribute('aria-label', 'Portable NPC card package');
        button('Export protected cards (JSON)', content, () => { packageText.value = JSON.stringify(exportNpcCardData(settings, namespace, collection), null, 2); });
        button('Import protected cards (preserve local conflicts)', content, () => {
            try {
                const result = importNpcCardData(settings, JSON.parse(packageText.value), namespace, collection);
                save(); element('p', `${result.restored} cards restored. Original package retained for review; local conflicts were not overwritten.`, content);
            } catch (error) { element('p', error.message, content); }
        });
        // Include retained stable cards even when their subject has no currently indexed events.
        for (const [cardKey, card] of Object.entries(settings.eventbase_npc_cards || {})) {
            if (card.registryKey !== registryKey || roster.groups.some(g => resolveNpcCardBinding(settings, npcCardSnapshot(roster, g), g, namespace)?.key === cardKey)) continue;
            const subject = settings.eventbase_subject_registries?.[registryKey]?.subjects.find(s => s.id === card.subjectId);
            if (!`${subject?.name || card.subjectId} ${(subject?.aliases || []).join(' ')}`.toLowerCase().includes(search.value.toLowerCase())) continue;
            const section = element('details', undefined, content);
            element('summary', `${subject?.name || card.subjectId} · no indexed evidence${subject?.retired ? ' · retired identity (read-only)' : ''}`, section);
            mountNpcCardEditor({ host: section, settings, binding: subject && !subject.retired ? { key: cardKey, registryKey,
                subjectId: card.subjectId, collection, namespace } : null,
            legacyKey: cardKey, snapshot: { events: [], digests: new Map() }, contextKey, readContext, scope, save });
        }
    };
    selector.addEventListener('change', () => void render());
    search.addEventListener('input', () => void render());
    await render();
}