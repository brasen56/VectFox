/** EventBase alias review. Choices are persisted per collection, never in chat metadata. */
import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { ensureCharacterIndex, getCharacterRoster, rosterCollectionId } from '../core/character-roster.js';

export async function openCharacterRosterReview(settings) {
    const { getLockedCharacterCollections } = await import('../core/eventbase-workflow.js');
    const collections = getLockedCharacterCollections();
    const host = $('#VectFox_character_roster_review').empty();
    if (!collections.length) {
        host.text('No enabled EventBase or archive-event collections are locked to this chat.');
        return;
    }
    const selector = $('<select class="vectfox-select">').appendTo(host);
    for (const collection of collections) {
        $('<option>').val(collection.registryKey).text(collection.collectionId).appendTo(selector);
    }
    const body = $('<div>').css({ marginTop: '8px', maxHeight: '400px', overflowY: 'auto' }).appendTo(host);
    let generation = 0;
    const render = async () => {
        const token = ++generation;
        const key = selector.val();
        const id = rosterCollectionId(key);
        body.text('Loading character index…');
        const entry = await ensureCharacterIndex(key, settings);
        if (token !== generation) return;
        if (!entry) { body.text('Index unavailable. Check backend connectivity and try Refresh.'); return; }
        const roster = getCharacterRoster([id], settings);
        body.empty();
        $('<p>').text(`${roster.totalEvents} events · ${roster.groups.length} character groups. Ambiguous names are not automatically merged.`).appendTo(body);
        const rows = [];
        for (const group of roster.groups) {
            const row = $('<div>').css({ padding: '6px 0', borderBottom: '1px solid #666' }).appendTo(body);
            const checkbox = $('<input type="checkbox">').appendTo(row);
            const name = $('<input type="text" class="vectfox-input">').val(group.name).css({ width: '65%', marginLeft: '8px' }).appendTo(row);
            $('<small>').text(`${group.eventCount} events · ${(group.share * 100).toFixed(1)}%${group.isLead ? ' · Lead' : ''}${group.ambiguous ? ' · Ambiguous alias' : ''}${group.manual ? ' · Manual' : ''}`).css('display', 'block').appendTo(row);
            $('<small>').text(`Stored spellings: ${group.aliases.join(', ')}`).css('display', 'block').appendTo(row);
            rows.push({ group, checkbox, name });
        }
        const persist = groups => {
            settings.eventbase_character_alias_overrides ??= {};
            settings.eventbase_character_alias_overrides[id] = groups;
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            void render();
        };
        const snapshot = () => rows.map(({ group, name }) => ({ name: String(name.val()).trim() || group.name, aliases: [...group.aliases] }));
        const selected = () => rows.map((row, index) => row.checkbox.prop('checked') ? index : -1).filter(index => index >= 0);
        const actions = $('<div>').css({ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }).appendTo(body);
        $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Save names').on('click', () => persist(snapshot())).appendTo(actions);
        $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Merge selected').on('click', () => {
            const indices = selected();
            if (indices.length < 2) { toastr.info('Select at least two groups to merge.'); return; }
            const groups = snapshot();
            const aliases = [...new Set(indices.flatMap(index => groups[index].aliases))];
            const merged = { name: groups[indices[0]].name, aliases };
            persist([...groups.filter((_, index) => !indices.includes(index)), merged]);
        }).appendTo(actions);
        $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Split selected into spellings').on('click', () => {
            const indices = selected();
            if (!indices.length) { toastr.info('Select a group to split.'); return; }
            persist(snapshot().flatMap((group, index) => indices.includes(index)
                ? group.aliases.map(alias => ({ name: alias, aliases: [alias] })) : [group]));
        }).appendTo(actions);
        $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Restore automatic grouping').on('click', () => persist([])).appendTo(actions);
    };
    selector.on('change', () => void render());
    await render();
}