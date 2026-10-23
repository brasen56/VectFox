import { describe, it, expect } from 'vitest';
import { resolveContinuityScope, continuityEvidenceEligibility, continuityBackendNamespace,
    isContinuityScopeCurrent, declareStorySoFar, readStorySoFar, removeStorySoFar, continuityDeclarations,
    eventIngestionTime } from '../core/continuity-scope.js';
import { subjectRegistryKey, previewSubjectMigration, applySubjectMigration, relationshipPairKey,
    reassignSubjectReference } from '../core/continuity-subjects.js';
import { migrateNpcCard } from '../core/npc-card-migration.js';
import { npcCardSnapshot, advanceNpcCard } from '../core/npc-cards.js';

const key = subjectRegistryKey('backend', 'story');
const group = (name, aliases = [name]) => ({ name, aliases });
let sequence = 0;
const apply = (settings, groups, options = {}) => applySubjectMigration(settings,
    previewSubjectMigration(settings, key, groups), { idFactory: () => `id-${++sequence}`, ...options });
const scope = (extra = {}) => resolveContinuityScope({ continuityId: 'story', namespace: 'backend',
    collections: ['events'], chatId: 'active', frames: [{ collection: 'events', chatId: 'active', frameId: 'expanded-active', horizon: 10 }], ...extra });

describe('Phase 4A scope eligibility', () => {
    it('rejects future, sibling, legacy, unlocked and foreign-backend evidence', () => {
        const s = scope();
        const event = { source_chat_id: 'active', source_window_end: 10 };
        expect(continuityEvidenceEligibility(event, 'events', s).label).toBe('verified');
        for (const [changed, collection, reason] of [
            [{ source_window_end: 11 }, 'events', 'beyond_horizon'],
            [{ source_chat_id: 'sibling' }, 'events', 'unmapped_sibling_source'],
            [{ source_chat_id: undefined }, 'events', 'ambiguous_legacy_source'],
            [{}, 'archive', 'collection_not_locked'],
            [{ backend_namespace: 'other' }, 'events', 'backend_mismatch'],
            [{ source_window_end: null }, 'events', 'unknown_source_position'],
        ]) expect(continuityEvidenceEligibility({ ...event, ...changed }, collection, s)).toEqual({ eligible: false, reason });
    });
    it('requires explicit mapping even in declared continuity and labels it honestly', () => {
        const s = scope({ declaredCollections: ['events'] });
        expect(continuityEvidenceEligibility({ source_window_end: 2 }, 'events', s).eligible).toBe(false);
        expect(continuityEvidenceEligibility({ source_chat_id: 'active', source_window_end: 2 }, 'events', s).label).toBe('user-declared continuity');
        const sibling = { source_chat_id: 'sibling', source_window_end: 4 };
        const frames = [{ collection: 'events', chatId: 'sibling', frameId: 'sibling-expanded', horizon: 4 }];
        expect(continuityEvidenceEligibility(sibling, 'events', scope({ frames })).eligible).toBe(false);
        expect(continuityEvidenceEligibility(sibling, 'events', scope({ frames, declaredCollections: ['events'] })).eligible).toBe(true);
    });
    it('invalidates frozen work on rewind, branch, lock, alias, mapping and backend changes', () => {
        const s = scope();
        for (const change of [{ horizon: 2 }, { branchId: 'branch' }, { collections: [] },
            { aliasRevision: 1 }, { frames: [] }, { namespace: 'other' }, { revision: 1 }]) {
            expect(isContinuityScopeCurrent(s, () => scope(change))).toBe(false);
        }
        expect(continuityBackendNamespace('qdrant:events', { qdrant_url: 'one' }))
            .not.toBe(continuityBackendNamespace('qdrant:events', { qdrant_url: 'two' }));
    });
});

describe('story-so-far declaration', () => {
    const declared = (settings, extra = {}) => scope({ frames: [], ...continuityDeclarations(settings, 'backend', 'events'), ...extra });
    it('freezes at the newest stored ingestion time and revises on update', () => {
        const settings = {};
        expect(() => declareStorySoFar(settings, 'backend', 'events', [{ created_at: undefined }])).toThrow('ingestion time');
        expect(settings).toEqual({});
        const first = declareStorySoFar(settings, 'backend', 'events',
            [{ created_at: 100 }, { inserted_at: 300 }, { created_at: '1970-01-01T00:00:00.200Z' }, {}], new Date(0));
        expect(first).toEqual({ v: 1, cutoff: 300, eventCount: 3, declaredAt: '1970-01-01T00:00:00.000Z', revision: 1 });
        expect(declareStorySoFar(settings, 'backend', 'events', [{ created_at: 500 }]).revision).toBe(2);
        expect(readStorySoFar(settings, 'backend', 'events').cutoff).toBe(500);
        expect(readStorySoFar(settings, 'other backend', 'events')).toBeNull();
        settings.eventbase_story_so_far[JSON.stringify(['backend', 'events'])].v = 2;
        expect(readStorySoFar(settings, 'backend', 'events')).toBeNull();
        expect(eventIngestionTime({ created_at: 'not a date' })).toBeNull();
    });
    it('admits stored legacy, sibling and unpositioned events but not later or undated ones', () => {
        const settings = {};
        declareStorySoFar(settings, 'backend', 'events', [{ created_at: 100 }]);
        const s = declared(settings);
        for (const event of [{ created_at: 50 }, { created_at: 100, source_chat_id: 'sibling', source_window_end: 9000 },
            { created_at: 100, source_window_end: null }]) {
            expect(continuityEvidenceEligibility(event, 'events', s)).toMatchObject({ eligible: true,
                label: 'user-declared continuity', basis: 'story_so_far' });
        }
        expect(continuityEvidenceEligibility({ created_at: 101, source_window_end: 3 }, 'events', s))
            .toEqual({ eligible: false, reason: 'after_declared_story_so_far' });
        expect(continuityEvidenceEligibility({ source_chat_id: 'active', source_window_end: 3 }, 'events', s))
            .toEqual({ eligible: false, reason: 'unknown_ingestion_time' });
        // A later event can still qualify through a verified per-file mapping.
        const mapped = declared(settings, { frames: [{ collection: 'events', chatId: 'active', frameId: 'expanded-active', horizon: 10 }] });
        expect(continuityEvidenceEligibility({ created_at: 101, source_chat_id: 'active', source_window_end: 3 }, 'events', mapped).label).toBe('verified');
        expect(continuityEvidenceEligibility({ created_at: 101, source_chat_id: 'active', source_window_end: 11 }, 'events', mapped).reason).toBe('beyond_horizon');
    });
    it('stays inside its own locked collection and backend', () => {
        const settings = {};
        declareStorySoFar(settings, 'backend', 'events', [{ created_at: 100 }]);
        const s = declared(settings, { collections: ['events', 'archive'] });
        expect(continuityEvidenceEligibility({ created_at: 1, source_window_end: 1 }, 'archive', s).reason).toBe('ambiguous_legacy_source');
        expect(continuityEvidenceEligibility({ created_at: 1, backend_namespace: 'other' }, 'events', s).reason).toBe('backend_mismatch');
        expect(continuityEvidenceEligibility({ created_at: 1 }, 'events', declared(settings, { collections: ['archive'] })).reason).toBe('collection_not_locked');
        expect(continuityDeclarations(settings, 'other backend', 'events').storySoFar).toEqual([]);
    });
    it('changes scope identity on declare, update and removal', () => {
        const settings = {};
        const none = declared(settings);
        declareStorySoFar(settings, 'backend', 'events', [{ created_at: 100 }]);
        const first = declared(settings);
        expect(isContinuityScopeCurrent(none, () => first)).toBe(false);
        declareStorySoFar(settings, 'backend', 'events', [{ created_at: 100 }]);
        expect(isContinuityScopeCurrent(first, () => declared(settings))).toBe(false);
        removeStorySoFar(settings, 'backend', 'events');
        expect(declared(settings).key).toBe(none.key);
        expect(continuityEvidenceEligibility({ created_at: 1, source_window_end: 1 }, 'events', declared(settings)).reason).toBe('ambiguous_legacy_source');
    });
});

describe('durable subject migration', () => {
    it('keeps rename/pair identity and separates similarly named people', () => {
        const settings = {};
        const first = apply(settings, [group('Hiro'), group('HIRO'), group('Alex')]);
        expect(new Set(first.subjects.map(s => s.id)).size).toBe(3);
        const ids = first.subjects.map(s => s.id);
        const pair = relationshipPairKey(key, [ids[0], ids[2]]);
        const renamed = apply(settings, [group('Hiroshi', ['Hiro']), group('HIRO'), group('Alex')]);
        expect(renamed.subjects[0].id).toBe(ids[0]);
        expect(relationshipPairKey(key, [ids[2], ids[0]])).toBe(pair);
        expect(relationshipPairKey(subjectRegistryKey('other', 'story'), [ids[0], ids[2]])).not.toBe(pair);
        expect(apply(settings, [group('Hiroshi', ['Hiro']), group('HIRO'), group('Alex')]).revision).toBe(renamed.revision);
    });
    it('requires confirmation and survivor selection; preserves conflicting references', () => {
        const settings = {};
        const first = apply(settings, [group('Hiro'), group('Hiro-kun')]);
        const ids = first.subjects.map(s => s.id);
        settings.eventbase_subject_registries[key].references = ids.map((id, i) => ({ id: `fact${i}`, subjectIds: [id], text: `conflict ${i}`, pinned: true }));
        const groups = [group('Hiroshi', ['Hiro', 'Hiro-kun'])];
        expect(() => apply(settings, groups)).toThrow('confirmation');
        expect(() => apply(settings, groups, { confirmed: true })).toThrow('surviving');
        const merged = apply(settings, groups, { confirmed: true, survivors: { [ids.slice().sort().join(',')]: ids[0] } });
        expect(merged.references.map(r => r.subjectIds)).toEqual([[ids[0]], [ids[0]]]);
        expect(merged.references.every(r => r.pinned)).toBe(true);
        expect(merged.audit.at(-1).remaps).toEqual([[ids[1], ids[0]]]);
    });
    it('splits without copying facts and explicitly reassigns unverified references', () => {
        const settings = {};
        const first = apply(settings, [group('Hiro', ['Hiro', 'Hiro-kun'])]);
        const old = first.subjects[0].id;
        settings.eventbase_subject_registries[key].references = [{ id: 'fact', subjectIds: [old], pinned: true }];
        const groups = [group('Hiro'), group('Hiro-kun')];
        expect(() => apply(settings, groups)).toThrow('confirmation');
        const split = apply(settings, groups, { confirmed: true });
        expect(split.references).toHaveLength(1);
        expect(split.references[0]).toMatchObject({ subjectIds: [old], validity: 'unverified', reason: 'subject_split' });
        const reassigned = reassignSubjectReference(settings, key, split.revision, 'fact', [split.subjects[0].id]);
        expect(reassigned.references[0].reason).toBe('evidence_review_required');
    });
    it('rejects stale previews and duplicate aliases without partial writes', () => {
        const settings = {};
        const preview = previewSubjectMigration(settings, key, [group('A')]);
        apply(settings, [group('B')]);
        expect(() => applySubjectMigration(settings, preview)).toThrow('stale');
        const before = JSON.stringify(settings);
        expect(() => apply(settings, [group('A'), group('Another A', ['A'])])).toThrow('multiple');
        expect(JSON.stringify(settings)).toBe(before);
    });
});

describe('recoverable NPC card migration', () => {
    it('preserves original/authored data, gates evidence and repeats without overwriting edits', async () => {
        const settings = {};
        const registry = apply(settings, [group('Hiro')]);
        const events = [{ event_id: 'one', summary: 'History', source_chat_id: 'active', source_window_end: 1, _collectionIds: ['events'] }];
        const character = { ...group('Hiro'), eventIds: new Set(['one']) };
        const snapshot = npcCardSnapshot({ events }, character);
        const old = await advanceNpcCard(null, snapshot, character, settings,
            async () => [{ fact: 'History', source_ids: ['one'] }]);
        old.authored = [{ text: 'Canon', pinned: true }];
        settings.eventbase_npc_cards = { old };
        const args = { settings, oldKey: 'old', registryKey: key, subjectId: registry.subjects[0].id,
            scope: scope(), snapshot, collection: 'events', confirmed: true };
        const migrated = migrateNpcCard(args);
        expect(migrated.card.historical.facts).toHaveLength(1);
        expect(migrated.card.legacy.authored).toEqual(old.authored);
        expect(settings.eventbase_npc_cards.old).toEqual(old);
        settings.eventbase_npc_cards[migrated.key].userEdit = 'keep';
        expect(migrateNpcCard(args).card.userEdit).toBe('keep');
        delete settings.eventbase_npc_cards[migrated.key]; // Simulated interrupted write; old remains recoverable.
        const noMapping = migrateNpcCard({ ...args, scope: scope({ frames: [] }) });
        expect(noMapping.card.historical.facts).toEqual([]);
        expect(noMapping.card.migration.generatedRebuildRequired).toBe(true);
        expect(noMapping.card.legacy.authored).toEqual(old.authored);
        expect(() => migrateNpcCard({ ...args, readScope: () => scope({ revision: 3 }) })).toThrow('stale');
    });
});