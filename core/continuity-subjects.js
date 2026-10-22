/** Durable authored identity, stored in extension settings, never in generated-card cache. */
import { continuityCollectionKey } from './continuity-scope.js';

const copy = value => structuredClone(value);
const spellings = aliases => [...new Set(aliases.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim()))].sort();
const opaqueId = () => globalThis.crypto.randomUUID();

export function subjectRegistryKey(namespace, continuityId) {
    return continuityCollectionKey(namespace, continuityId);
}

export function readSubjectRegistry(settings, key) {
    const stored = settings.eventbase_subject_registries?.[key];
    if (stored && stored.v !== 1) throw new Error('Unsupported subject registry version');
    return copy(stored || { v: 1, revision: 0, subjects: [], audit: [], references: [] });
}

export function relationshipPairKey(registryKey, subjectIds) {
    if (subjectIds.length !== 2 || subjectIds.some(id => typeof id !== 'string' || !id) || subjectIds[0] === subjectIds[1]) {
        throw new Error('A pair requires two distinct subject IDs');
    }
    return JSON.stringify([registryKey, [...subjectIds].sort()]);
}

/** Exact spellings only. Normalized names are suggestions, never durable identity. */
export function previewSubjectMigration(settings, key, groups) {
    const registry = readSubjectRegistry(settings, key);
    const rows = groups.map(group => {
        const aliases = spellings(group.aliases || []);
        const candidates = registry.subjects.filter(s => !s.retired && s.aliases.some(a => aliases.includes(a))).map(s => s.id);
        return { name: String(group.name || '').trim(), aliases, candidates,
            requiresConfirmation: Boolean(group.ambiguous || candidates.length > 1) };
    });
    for (const row of rows) {
        if (rows.some(other => other !== row && other.candidates.some(id => row.candidates.includes(id)))) row.requiresConfirmation = true;
    }
    return { key, revision: registry.revision, rows };
}

/** Preview apply is atomic. Splits never duplicate an old subject's references. Merges
 * retain conflicting facts separately; audit entries keep their original ownership.
 */
export function applySubjectMigration(settings, preview, { confirmed = false, survivors = {}, idFactory = opaqueId } = {}) {
    const registry = readSubjectRegistry(settings, preview.key);
    if (registry.revision !== preview.revision) throw new Error('Subject preview is stale; refresh before applying');
    if (preview.rows.some(row => row.requiresConfirmation) && !confirmed) throw new Error('Explicit identity confirmation required');
    const usedAliases = new Set();
    const next = [];
    const remaps = new Map();
    const splitIds = new Set();
    const assigned = new Set();
    for (const row of preview.rows) {
        if (!row.name || !row.aliases.length) throw new Error('Each subject needs a name and aliases');
        for (const alias of row.aliases) {
            if (usedAliases.has(alias)) throw new Error('An alias cannot belong to multiple subjects');
            usedAliases.add(alias);
        }
        const splitting = row.candidates.some(id => preview.rows.filter(r => r.candidates.includes(id)).length > 1);
        if (splitting) row.candidates.forEach(id => splitIds.add(id));
        let id = splitting ? idFactory() : row.candidates[0] || idFactory();
        if (row.candidates.length > 1 && !splitting) {
            id = survivors[row.candidates.slice().sort().join(',')];
            if (!row.candidates.includes(id)) throw new Error('Select a surviving subject ID for each merge');
            row.candidates.filter(candidate => candidate !== id).forEach(candidate => remaps.set(candidate, id));
        }
        if (!id || assigned.has(id) || ((!row.candidates.includes(id) || splitting)
            && registry.subjects.some(s => s.id === id))) throw new Error('Subject ID collision');
        assigned.add(id);
        next.push({ id, name: row.name, aliases: [...row.aliases] });
    }
    const changed = JSON.stringify(registry.subjects.filter(s => !s.retired)) !== JSON.stringify(next);
    if (!changed) return registry;
    const before = copy(registry.subjects);
    // Omitted/hidden subjects stay intact. Retired IDs remain available for audit/import repair.
    registry.subjects = [...next, ...registry.subjects.filter(s => !assigned.has(s.id)).map(s =>
        remaps.has(s.id) || splitIds.has(s.id) ? { ...s, retired: true } : s)];
    registry.references = registry.references.map(ref => {
        if (ref.subjectIds.some(id => splitIds.has(id))) return { ...ref, validity: 'unverified', reason: 'subject_split' };
        const ids = ref.subjectIds.map(id => remaps.get(id) || id);
        return { ...ref, subjectIds: ids, ...(new Set(ids).size !== ids.length
            ? { validity: 'unverified', reason: 'collapsed_pair' } : {}) };
    });
    registry.revision++;
    registry.audit.push({ revision: registry.revision, action: 'alias_migration', before, after: copy(registry.subjects),
        remaps: [...remaps], splitIds: [...splitIds], at: new Date().toISOString() });
    settings.eventbase_subject_registries = { ...settings.eventbase_subject_registries, [preview.key]: registry };
    return copy(registry);
}

/** Explicit reassignment after a split; no inferred ownership or copied assertions. */
export function reassignSubjectReference(settings, key, revision, referenceId, subjectIds) {
    const registry = readSubjectRegistry(settings, key);
    if (registry.revision !== revision) throw new Error('Subject registry is stale');
    if (!subjectIds.length || subjectIds.some(id => !registry.subjects.some(s => s.id === id && !s.retired))) throw new Error('Unknown subject');
    const ref = registry.references.find(r => r.id === referenceId);
    if (!ref) throw new Error('Unknown reference');
    const before = copy(ref);
    ref.subjectIds = [...subjectIds];
    ref.validity = 'unverified'; // Subject assignment alone does not verify evidence.
    ref.reason = 'evidence_review_required';
    registry.revision++;
    registry.audit.push({ revision: registry.revision, action: 'reassign', before, after: copy(ref) });
    settings.eventbase_subject_registries = { ...settings.eventbase_subject_registries, [key]: registry };
    return copy(registry);
}