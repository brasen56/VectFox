/** Non-destructive Phase 4A migration. Originals are retained for recovery and review. */
import { continuityEvidenceEligibility } from './continuity-scope.js';
import { readNpcCard } from './npc-cards.js';

export function stableNpcCardKey(registryKey, subjectId) {
    return JSON.stringify(['subject-card', 1, registryKey, subjectId]);
}

/** The caller must supply an exact old-key binding confirmed in the identity preview.
 * Legacy unqualified citations are reusable only for a single proven source collection.
 * Nothing is removed and repeat/interrupted execution cannot overwrite later edits.
 */
export function migrateNpcCard({ settings, oldKey, registryKey, subjectId, scope, snapshot,
    collection, confirmed = false, readScope = () => scope }) {
    if (!confirmed) throw new Error('Confirm the legacy card subject and scope before migrating');
    if (!scope || readScope()?.key !== scope.key) throw new Error('Continuity scope is stale');
    const registry = settings.eventbase_subject_registries?.[registryKey];
    if (!registry?.subjects.some(s => s.id === subjectId && !s.retired)) throw new Error('Unknown migration subject');
    if (registryKey !== JSON.stringify([scope.namespace, scope.continuityId])) throw new Error('Subject scope mismatch');
    const key = stableNpcCardKey(registryKey, subjectId);
    const old = settings.eventbase_npc_cards?.[oldKey];
    if (!old) throw new Error('Legacy card is missing');
    if (oldKey === key) throw new Error('Legacy and destination keys must differ');
    if (settings.eventbase_npc_cards?.[key]) return { key, card: structuredClone(settings.eventbase_npc_cards[key]), reused: true };
    const verifiedEvents = snapshot.events.filter(event => event._collectionIds?.length === 1
        && event._collectionIds[0] === collection && continuityEvidenceEligibility(event, collection, scope).eligible);
    const ids = new Set(verifiedEvents.map(e => e.event_id));
    const verified = { ...snapshot, events: verifiedEvents,
        digests: new Map([...snapshot.digests].filter(([id]) => ids.has(id))) };
    const facts = readNpcCard(old, verified, Number.MAX_SAFE_INTEGER)?.facts || [];
    const card = { v: 3, subjectId, registryKey, scopeKey: scope.key,
        historical: { facts: facts.map(fact => ({ ...fact, subjectIds: [subjectId], origin: 'generated',
            source_refs: fact.source_ids.map(id => ({ namespace: scope.namespace, collection, event_id: id,
                digest: verified.digests.get(id) })) })) },
        // Preserve *all* legacy fields, including unknown authored formats, rather than guessing.
        legacy: structuredClone(old), migration: { oldKey, status: 'complete',
            generatedRebuildRequired: facts.length !== (old.facts || []).length, at: new Date().toISOString() } };
    if (readScope()?.key !== scope.key) throw new Error('Continuity scope is stale');
    settings.eventbase_npc_cards = { ...settings.eventbase_npc_cards, [key]: card };
    return { key, card: structuredClone(card), reused: false };
}