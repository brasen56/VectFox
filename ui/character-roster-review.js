/** EventBase alias review. Choices are persisted per collection, never in chat metadata. */
import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { ensureCharacterIndex, getCharacterRoster, getIgnoredCharacterTags, rosterCollectionId } from '../core/character-roster.js';

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
        const ignoredTags = getIgnoredCharacterTags(id, settings);
        body.empty();
        $('<p>').text(`${roster.totalEvents} events · ${roster.groups.length} character groups. Ambiguous names are not automatically merged.`).appendTo(body);
        $('<small>').text('Select groups to merge their names or ignore all their stored spellings. Ignored tags are excluded from this collection’s roster and known-character extraction hints; stored entries stay unchanged.').css('display', 'block').appendTo(body);
        const rows = [];
        for (const group of roster.groups) {
            const row = $('<div>').css({ padding: '6px 0', borderBottom: '1px solid #666' }).appendTo(body);
            const checkbox = $('<input type="checkbox">').appendTo(row);
            const name = $('<input type="text" class="vectfox-input">').val(group.name).css({ width: '65%', marginLeft: '8px' }).appendTo(row);
            $('<small>').text(`${group.eventCount} events · ${(group.share * 100).toFixed(1)}%${group.isLead ? ' · Lead' : ''}${group.ambiguous ? ' · Ambiguous alias' : ''}${group.manual ? ' · Manual' : ''}`).css('display', 'block').appendTo(row);
            $('<small>').text(`Stored spellings: ${group.aliases.join(', ')}`).css('display', 'block').appendTo(row);
            rows.push({ group, checkbox, name });
        }
        const save = () => {
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            void render();
        };
        const persist = groups => {
            settings.eventbase_character_alias_overrides ??= {};
            settings.eventbase_character_alias_overrides[id] = groups;
            save();
        };
        const persistIgnored = tags => {
            settings.eventbase_character_ignored_tags ??= {};
            settings.eventbase_character_ignored_tags[id] = [...new Set(tags)];
            save();
        };
        const snapshot = () => {
            const groups = rows.map(({ group, name }) => ({ name: String(name.val()).trim() || group.name, aliases: [...group.aliases] }));
            // Keep manual choices for hidden spellings when reviewing visible
            // groups, so ignoring and later restoring a tag does not lose its aliases.
            for (const override of settings.eventbase_character_alias_overrides?.[id] || []) {
                if (!Array.isArray(override?.aliases) || typeof override.name !== 'string') continue;
                const hidden = override.aliases.filter(alias => ignoredTags.includes(alias));
                if (!hidden.length) continue;
                const target = groups.find(group => group.aliases.some(alias => override.aliases.includes(alias)));
                if (target) target.aliases = [...new Set([...target.aliases, ...hidden])];
                else groups.push({ name: override.name, aliases: hidden });
            }
            return groups;
        };
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
        $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Ignore selected tags').on('click', () => {
            const indices = selected();
            if (!indices.length) { toastr.info('Select a group to ignore.'); return; }
            persistIgnored([...ignoredTags, ...indices.flatMap(index => rows[index].group.aliases)]);
        }).appendTo(actions);
        $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Split selected into spellings').on('click', () => {
            const indices = selected();
            if (!indices.length) { toastr.info('Select a group to split.'); return; }
            persist(snapshot().flatMap((group, index) => indices.includes(index)
                ? group.aliases.map(alias => ({ name: alias, aliases: [alias] })) : [group]));
        }).appendTo(actions);
        $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Restore automatic grouping').on('click', () => persist([])).appendTo(actions);
        if (ignoredTags.length) {
            const ignoredList = $('<details>').css('marginTop', '8px').appendTo(body);
            $('<summary>').text(`Ignored tags (${ignoredTags.length})`).appendTo(ignoredList);
            for (const tag of ignoredTags) {
                const row = $('<div>').css({ display: 'flex', gap: '8px', alignItems: 'center', padding: '4px 0' }).appendTo(ignoredList);
                $('<span>').text(tag).appendTo(row);
                $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Restore').attr('aria-label', `Restore tag ${tag}`).on('click', () => {
                    persistIgnored(ignoredTags.filter(ignored => ignored !== tag));
                }).appendTo(row);
            }
            $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Restore all ignored tags').on('click', () => persistIgnored([])).appendTo(ignoredList);
        }
    };
    selector.on('change', () => void render());
    await render();
}
