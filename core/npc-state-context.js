/** Host-independent assembly. Host frames must be explicit: never infer them from chat length. */
import { continuityBackendNamespace, continuityDeclarations, resolveContinuityScope } from './continuity-scope.js';
import { resolveNpcCardBinding } from './npc-card-state.js';
import { npcCardSnapshot } from './npc-cards.js';

export function buildNpcStateContexts({ settings, roster, cast, collections, chatId, frames = [] }) {
    if (!roster?.ready || !chatId) return [];
    const contexts = [];
    for (const collection of collections) {
        const namespace = continuityBackendNamespace(collection.registryKey, settings);
        const registryKey = JSON.stringify([namespace, collection.collectionId]);
        const registry = settings.eventbase_subject_registries?.[registryKey];
        if (!registry) continue;
        const snapshots = new Map(), groups = new Map();
        for (const { group } of cast) {
            const snapshot = npcCardSnapshot(roster, group);
            const binding = resolveNpcCardBinding(settings, snapshot, group, namespace);
            if (binding?.registryKey !== registryKey) continue;
            snapshots.set(binding.subjectId, snapshot); groups.set(binding.subjectId, group);
        }
        const scope = resolveContinuityScope({ namespace, continuityId: collection.collectionId,
            collections: [collection.collectionId], chatId, frames, aliasRevision: registry.revision,
            ...continuityDeclarations(settings, namespace, collection.collectionId) });
        contexts.push({ registryKey, scope, snapshots, groups, subjectIds: [...snapshots.keys()] });
    }
    return contexts;
}