/** EventBase alias review. Choices are persisted per collection, never in chat metadata. */
import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { ensureCharacterIndex, getCharacterRoster, getIgnoredCharacterTags, rosterCollectionId } from '../core/character-roster.js';
import { continuityBackendNamespace, continuityCollectionKey, resolveContinuityScope, readStorySoFar,
    declareStorySoFar, removeStorySoFar, eventIngestionTime } from '../core/continuity-scope.js';
import { subjectRegistryKey, previewSubjectMigration, applySubjectMigration, readSubjectRegistry } from '../core/continuity-subjects.js';
import { migrateNpcCard } from '../core/npc-card-migration.js';
import { npcCardSnapshot } from '../core/npc-cards.js';

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
        const namespace = continuityBackendNamespace(key, settings);
        // One collection is the initial explicit continuity boundary. No implicit cross-lock union.
        const identityKey = subjectRegistryKey(namespace, id);
        body.text('Loading character index…');
        const entry = await ensureCharacterIndex(key, settings);
        if (token !== generation) return;
        if (!entry) { body.text('Index unavailable. Check backend connectivity and try Refresh.'); return; }
        const roster = getCharacterRoster([id], settings);
        const ignoredTags = getIgnoredCharacterTags(id, settings);
        body.empty();
        const declarationKey = continuityCollectionKey(namespace, id);
        const declaration = $('<label>').css('display', 'block').appendTo(body);
        $('<input type="checkbox">').prop('checked', settings.eventbase_declared_continuity?.[declarationKey] === true)
            .on('change', function() {
                settings.eventbase_declared_continuity = { ...settings.eventbase_declared_continuity,
                    [declarationKey]: $(this).prop('checked') };
                Object.assign(extension_settings.vectfox, settings);
                saveSettingsDebounced();
            }).appendTo(declaration);
        declaration.append(document.createTextNode(' User-declared continuity: files sharing this collection are one linear story (not verified).'));
        $('<small>').text('This declaration does not prove branch membership or map source positions. Unmapped evidence remains historical. Stable subject IDs below belong only to this backend and collection.').appendTo(body);
        const story = readStorySoFar(settings, namespace, id);
        const storyBox = $('<div>').css({ margin: '8px 0', padding: '6px', border: '1px solid #666' }).appendTo(body);
        $('<strong>').text('Story so far').appendTo(storyBox);
        $('<small>').css('display', 'block').text(story
            ? `Declared ${new Date(story.declaredAt).toLocaleString()}: ${story.eventCount} events stored up to ${new Date(story.cutoff).toLocaleString()} count as one story that happened before now (user-declared continuity, not verified). Events stored later are not included until you update.`
            : 'Not declared. Events stored here remain history only and cannot support relationship state.').appendTo(storyBox);
        const storyEvents = roster.events.filter(event => eventIngestionTime(event) !== null);
        const saveStory = () => {
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            void render();
        };
        $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text(story ? 'Update to include everything stored now' : 'Declare story so far').on('click', () => {
            if (!storyEvents.length) { toastr.info('No stored events with an ingestion time to declare.'); return; }
            const calls = settings.eventbase_npc_state_enabled
                ? '\n\nRelationship state is on, so this can start model calls: about one per character pair (up to ~6,000 input tokens) when the pair is next in a scene and again when its evidence changes, through the existing card queue.' : '';
            if (!confirm(`Treat all ${storyEvents.length} events stored in ${id} as one linear story that happened before now?\n\nThey become eligible evidence for relationship state, labelled "user-declared continuity", not verified. Anything already stored from an abandoned branch or discarded swipe is included too. Events stored after this point stay excluded until you update.${calls}`)) return;
            declareStorySoFar(settings, namespace, id, storyEvents);
            saveStory();
        }).appendTo(storyBox);
        if (story) $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Remove declaration').on('click', () => {
            if (!confirm('Remove the story-so-far declaration? Generated relationship facts that relied on it will be withheld. Your authored canon is not affected.')) return;
            removeStorySoFar(settings, namespace, id);
            saveStory();
        }).appendTo(storyBox);
        $('<p>').text(`${roster.totalEvents} events · ${roster.groups.length} character groups. Ambiguous names are not automatically merged.`).appendTo(body);
        $('<small>').text('Select groups to merge their names or ignore all their stored spellings. Ignored tags are excluded from this collection’s roster and known-character extraction hints; stored entries stay unchanged.').css('display', 'block').appendTo(body);
        const rows = [];
        for (const group of roster.groups) {
            const row = $('<div>').css({ padding: '6px 0', borderBottom: '1px solid #666' }).appendTo(body);
            const checkbox = $('<input type="checkbox">').appendTo(row);
            const name = $('<input type="text" class="vectfox-input">').val(group.name).css({ width: '65%', marginLeft: '8px' }).appendTo(row);
            $('<small>').text(`${group.eventCount} events · ${(group.share * 100).toFixed(1)}%${group.isLead ? ' · Lead' : ''}${group.ambiguous ? ' · Ambiguous alias' : ''}${group.manual ? ' · Manual' : ''}`).css('display', 'block').appendTo(row);
            $('<small>').text(`Stored spellings: ${group.aliases.join(', ')}`).css('display', 'block').appendTo(row);
            $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Inspect card').on('click', async () => {
                const { openNpcCardBrowser } = await import('./npc-card-browser.js');
                await openNpcCardBrowser(settings, { collectionKey: key, name: group.name });
                document.getElementById('VectFox_npc_card_browser')?.scrollIntoView?.({ block: 'nearest' });
            }).appendTo(row);
            rows.push({ group, checkbox, name });
        }
        const save = () => {
            Object.assign(extension_settings.vectfox, settings);
            saveSettingsDebounced();
            void render();
        };
        const persist = groups => {
            const existing = readSubjectRegistry(settings, identityKey);
            if (existing.subjects.length && !confirm('Changing aliases invalidates dependent identity views. Review stable identities again after saving. Continue?')) return;
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
        const identityPreview = $('<div>').css('marginTop', '8px').appendTo(body);
        $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Preview stable subject identities').on('click', () => {
            identityPreview.empty();
            const preview = previewSubjectMigration(settings, identityKey,
                rows.map(({ group, name }) => ({ ...group, name: String(name.val()).trim() || group.name })));
            const survivors = {};
            for (const row of preview.rows) {
                $('<p>').text(`${row.name}: ${row.aliases.join(', ')} → ${row.candidates.join(', ') || 'new opaque ID'}${row.requiresConfirmation ? ' · confirmation required' : ''}`).appendTo(identityPreview);
                if (row.candidates.length > 1) {
                    const select = $('<select class="vectfox-select">').appendTo(identityPreview);
                    const subjects = readSubjectRegistry(settings, identityKey).subjects;
                    for (const candidate of row.candidates) $('<option>').val(candidate)
                        .text(`${subjects.find(s => s.id === candidate)?.name || candidate} · ${candidate}`).appendTo(select);
                    const mergeKey = row.candidates.slice().sort().join(',');
                    survivors[mergeKey] = select.val();
                    select.on('change', () => { survivors[mergeKey] = select.val(); });
                }
            }
            $('<small>').text('Renames retain IDs. Merges retain conflicting references for review. Splits retire the old ID and leave its facts unverified until explicitly reassigned; facts are never copied to both subjects.').appendTo(identityPreview);
            $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Confirm and apply identities').on('click', () => {
                if (!confirm('Apply this exact identity preview? Ambiguous groups, merges and splits require your explicit confirmation.')) return;
                try {
                    const registry = applySubjectMigration(settings, preview, { confirmed: true, survivors });
                    // No verified host horizon mapping exists in this UI. Migration retains originals
                    // and conservatively rebuilds generated facts; it does not claim current state.
                    const scope = resolveContinuityScope({ continuityId: id, namespace, collections: [id],
                        chatId: 'migration-review', aliasRevision: registry.revision });
                    for (const { group } of rows) {
                        const subject = registry.subjects.find(s => !s.retired && s.aliases.length === group.aliases.length
                            && s.aliases.every(alias => group.aliases.includes(alias)));
                        if (!subject) continue; // A split/merge needs explicit fact reassignment, not name guessing.
                        const snapshot = npcCardSnapshot(roster, group);
                        if (!settings.eventbase_npc_cards?.[snapshot.key]) continue;
                        migrateNpcCard({ settings, oldKey: snapshot.key, registryKey: identityKey,
                            subjectId: subject.id, scope, snapshot, collection: id, confirmed: true });
                    }
                    save();
                } catch (error) { toastr.warning(error.message); }
            }).appendTo(identityPreview);
        }).appendTo(actions);
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
