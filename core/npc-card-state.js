/** Durable card contract. Inspection and editing never call a provider or mutate events. */
import { relationshipPairKey } from './continuity-subjects.js';
import { continuityBackendNamespace, continuityEvidenceEligibility } from './continuity-scope.js';
import { estimateCastTokens, compareCastChronology } from './eventbase-injection.js';

const copy = value => structuredClone(value);
const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
export const subjectCardKey = (registryKey, subjectId) => JSON.stringify(['subject-card', 1, registryKey, subjectId]);
// Lossless identities avoid hash collisions and survive provider reorderings and cache rebuilds.
export const npcFactId = fact => JSON.stringify(['fact', clean(fact.fact), [...new Set(fact.source_ids || [])].sort()]);

export function resolveNpcCardBinding(settings, snapshot, group, namespace = continuityBackendNamespace('', settings)) {
    const matches = [];
    for (const [registryKey, registry] of Object.entries(settings.eventbase_subject_registries || {})) {
        const [backend, collection] = JSON.parse(registryKey);
        if (backend !== namespace || snapshot.events.some(e => !e._collectionIds?.includes(collection))) continue;
        for (const subject of registry.subjects || []) {
            if (!subject.retired && subject.aliases.length === group.aliases.length
                && subject.aliases.every(a => group.aliases.includes(a))) {
                matches.push({ key: subjectCardKey(registryKey, subject.id), registryKey,
                    subjectId: subject.id, collection, namespace, registryRevision: registry.revision });
            }
        }
    }
    return matches.length === 1 ? matches[0] : null;
}

export function upgradeNpcCard(stored, binding) {
    if (stored?.v === 4) return copy(stored);
    const migratedFacts = stored?.v === 3 ? stored.historical?.facts || [] : [];
    return { v: 4, revision: 0, registryKey: binding.registryKey, subjectId: binding.subjectId,
        collection: binding.collection, namespace: binding.namespace,
        generated: stored?.v === 2 ? copy(stored) : { v: 2, facts: copy(migratedFacts),
            cited: Object.fromEntries(migratedFacts.flatMap(f => f.source_refs || []).map(r => [r.event_id, r.digest])), coverage: '', planned: '' },
        authored: [], pins: [], suppressions: [], pairs: {}, audit: [],
        ...(stored ? { recovery: copy(stored) } : {}) };
}

export function npcEditorRevision(settings, key, contextKey) {
    return JSON.stringify([contextKey, settings.eventbase_npc_cards?.[key] || null,
        settings.eventbase_subject_registries, settings.eventbase_character_alias_overrides,
        settings.eventbase_declared_continuity]);
}

export function beginNpcCardEdit(settings, binding, contextKey, legacyKey) {
    const stored = settings.eventbase_npc_cards?.[binding.key];
    return { key: binding.key, binding: copy(binding), contextKey, legacyKey,
        revision: npcEditorRevision(settings, binding.key, contextKey),
        legacyRevision: JSON.stringify(settings.eventbase_npc_cards?.[legacyKey] || null),
        before: upgradeNpcCard(stored || settings.eventbase_npc_cards?.[legacyKey], binding),
        card: upgradeNpcCard(stored || settings.eventbase_npc_cards?.[legacyKey], binding) };
}

export function editNpcCardFact(draft, action, fact, { text = '', pairSubjectIds = [], confirmed = false,
    idFactory = () => globalThis.crypto.randomUUID() } = {}) {
    const card = draft.card;
    const id = fact?.id || (fact && npcFactId(fact));
    if (action === 'add' || action === 'correct') {
        const value = clean(text);
        if (!value) throw new Error('Fact text cannot be empty');
        const subjectIds = pairSubjectIds.length ? [...pairSubjectIds].sort() : [card.subjectId];
        const pairKey = pairSubjectIds.length ? relationshipPairKey(card.registryKey, subjectIds) : undefined;
        if (pairKey && !subjectIds.includes(card.subjectId)) throw new Error('The card owner must belong to the pair');
        if (pairKey && subjectIds[0] !== card.subjectId) throw new Error('Open the other subject’s card to edit this pair (canonical owner)');
        card.authored.push({ id: idFactory(), fact: value, origin: 'authored', subjectIds, pairKey,
            pinned: true, validity: 'authored', source_refs: [], asOf: new Date().toISOString() });
        if (action === 'correct') {
            if (fact.origin === 'authored') card.authored = card.authored.filter(f => f.id !== id);
            else card.suppressions.push({ id, fact: copy(fact), reason: 'corrected' });
        }
    } else if (action === 'pin') {
        if (fact.origin === 'authored') {
            const authored = card.authored.find(f => f.id === id);
            if (!authored) throw new Error('Unknown authored fact');
            authored.pinned = !authored.pinned;
        } else {
            const index = card.pins.findIndex(f => f.id === id);
            if (index >= 0) card.pins.splice(index, 1);
            else card.pins.push({ ...copy(fact), id, pinned: true, origin: 'generated',
                cited: { ...card.generated.cited } });
        }
    } else if (action === 'suppress') {
        if (fact.origin === 'authored') {
            if (!confirmed) throw new Error('Confirm deletion of user-authored content');
            card.authored = card.authored.filter(f => f.id !== id);
        } else if (!card.suppressions.some(f => f.id === id)) card.suppressions.push({ id, fact: copy(fact), reason: 'suppressed' });
    } else if (action === 'restore') card.suppressions = card.suppressions.filter(f => f.id !== id);
    else throw new Error('Unknown card edit action');
    card.audit.push({ action, before: fact ? copy(fact) : null, text: clean(text), at: new Date().toISOString() });
}

export function saveNpcCardEdit(settings, draft, contextKey) {
    if (contextKey !== draft.contextKey || npcEditorRevision(settings, draft.key, contextKey) !== draft.revision
        || JSON.stringify(settings.eventbase_npc_cards?.[draft.legacyKey] || null) !== draft.legacyRevision) {
        throw new Error('Card or scope changed. Reload the card and reapply your edits; nothing was saved.');
    }
    const registry = settings.eventbase_subject_registries?.[draft.binding.registryKey];
    if (!registry?.subjects.some(s => s.id === draft.binding.subjectId && !s.retired)) throw new Error('Card subject is no longer active');
    for (const fact of draft.card.authored) {
        if (!clean(fact.fact) || fact.subjectIds.some(id => !registry.subjects.some(s => s.id === id && !s.retired))) {
            throw new Error('Invalid authored fact or subject scope');
        }
    }
    const card = copy(draft.card);
    card.revision++;
    card.updatedAt = new Date().toISOString();
    settings.eventbase_npc_cards = { ...settings.eventbase_npc_cards, [draft.key]: card };
    return copy(card);
}

export function inspectNpcCard(stored, snapshot) {
    if (stored?.v === 3) stored = upgradeNpcCard(stored, stored);
    const generated = stored?.v === 4 ? stored.generated : stored?.v === 2 ? stored : null;
    const suppressions = stored?.suppressions || [];
    const pins = stored?.pins || [];
    const facts = [...(generated?.facts || []), ...pins.filter(p => !(generated?.facts || []).some(f => npcFactId(f) === p.id))];
    for (const suppressed of suppressions) {
        if (!facts.some(f => (f.id || npcFactId(f)) === suppressed.id)
            && !Object.values(stored?.pairs || {}).some(p => p.facts?.some(f => f.id === suppressed.id))) facts.push(suppressed.fact);
    }
    return facts.map(fact => {
        const id = fact.id || npcFactId(fact);
        const pin = pins.find(p => p.id === id);
        const cited = pin?.cited || generated?.cited || {};
        const intact = fact.source_ids?.length && fact.source_ids.every(source => snapshot.digests.has(source)
            && snapshot.digests.get(source) === cited[source]);
        return { ...copy(pin || fact), id, origin: 'generated', pinned: Boolean(pin),
            validity: suppressions.some(s => s.id === id) ? 'suppressed' : intact ? 'historical' : 'unverified',
            reason: intact ? 'Historical evidence is not proof of current state' : 'Source missing or changed',
            sources: (fact.source_ids || []).map(event_id => ({ event_id,
                summary: snapshot.events.find(e => e.event_id === event_id)?.summary || '(source unavailable)' })) };
    }).concat(Object.values(stored?.pairs || {}).flatMap(pair => (pair.facts || []).map(raw => {
        const f = pins.find(p => p.id === raw.id) || raw;
        return { ...copy(f),
        validity: suppressions.some(s => s.id === f.id) ? 'suppressed' : f.source_refs?.every(ref => snapshot.digests.get(ref.event_id) === ref.digest) ? 'supported' : 'unverified',
        reason: pair.sampled ? 'Sampled/incomplete evidence; scope rechecked at injection' : 'Scope rechecked at injection',
        sources: (f.source_refs || []).map(ref => ({ ...ref, summary: snapshot.events.find(e => e.event_id === ref.event_id)?.summary || '(source unavailable)' })) }; })))
        .concat(copy(stored?.authored || []).map(f => ({ ...f, validity: f.validity === 'unverified' ? 'unverified' : 'authored', sources: [] })));
}

export function mergeNpcCardRefresh(stored, generated) {
    if (stored?.v !== 4) return generated;
    const card = copy(stored);
    card.generated = { ...generated, facts: generated.facts.filter(f => !card.suppressions.some(s => s.id === npcFactId(f))
        && !card.pins.some(p => p.id === npcFactId(f))) };
    card.review = card.generated.facts.filter(f => card.suppressions.some(s => clean(s.fact.fact).toLowerCase() === clean(f.fact).toLowerCase()))
        .map(f => ({ id: npcFactId(f), reason: 'possible_reintroduction', fact: f.fact }));
    card.revision++;
    card.updatedAt = generated.updatedAt;
    return card;
}

export function resetNpcGeneratedCards(settings) {
    settings.eventbase_npc_cards = Object.fromEntries(Object.entries(settings.eventbase_npc_cards || {}).flatMap(([key, card]) => {
        if (card.v === 3) return [[key, card]];
        if (card.v !== 4) return [];
        return [[key, { ...card, revision: card.revision + 1,
            generated: { v: 2, facts: [], cited: {}, coverage: '', planned: '' }, pairs: {} }]];
    }));
}

/** Recency first, then validated resolver outcomes/cited support. No history-spine sampling. */
export function selectNpcPairEvidence({ snapshot, groups, scope, tokenBudget = 6000, sourceIds = [] }) {
    const diagnostics = [];
    const eligible = snapshot.events.filter(event => {
        const collection = event._collectionIds?.length === 1 ? event._collectionIds[0] : null;
        const gate = collection ? continuityEvidenceEligibility(event, collection, scope) : { eligible: false, reason: 'ambiguous_collection' };
        const paired = groups.every(g => g.eventIds.has(event.event_id));
        diagnostics.push({ event_id: event.event_id, ...gate, paired });
        return gate.eligible && paired;
    }).sort(compareCastChronology).reverse();
    const recentLimit = Math.floor(tokenBudget * 0.65), selected = [];
    let spent = 0;
    const take = (event, limit) => {
        if (selected.includes(event)) return;
        const cost = estimateCastTokens(JSON.stringify(event));
        if (spent + cost <= limit) { selected.push(event); spent += cost; }
    };
    eligible.forEach(e => take(e, recentLimit));
    eligible.filter(e => e._continuityView?.resolutions?.length || sourceIds.includes(e.event_id)).forEach(e => take(e, tokenBudget));
    eligible.forEach(e => take(e, tokenBudget));
    return { events: selected, diagnostics, sampled: selected.length < eligible.length, eligibleCount: eligible.length, estimatedTokens: spent };
}

/** Whole-fact, fair-share state blocks. Canon is never presented with model provenance. */
export function formatNpcState({ settings, scope, snapshots = new Map(), subjectIds = [], tokenBudget, registryKey }) {
    const budget = Math.max(0, Math.floor(Number(tokenBudget) || 0));
    const groups = new Map(), excluded = [], omitted = [], included = [];
    if (!settings.eventbase_npc_state_enabled || !scope || registryKey !== JSON.stringify([scope.namespace, scope.continuityId])) return { text: '', included, omitted, excluded, estimatedTokens: 0 };
    const registry = settings.eventbase_subject_registries?.[registryKey];
    const allowed = id => subjectIds.includes(id) && registry?.subjects.some(s => s.id === id && !s.retired);
    for (const card of Object.values(settings.eventbase_npc_cards || {})) {
        if (card.v !== 4 || card.registryKey !== registryKey || !allowed(card.subjectId)) continue;
        const snapshot = snapshots.get(card.subjectId);
        const facts = [...card.authored, ...card.pins.filter(p => p.pairKey),
            ...Object.values(card.pairs).flatMap(pair => (pair.facts || []).filter(f => !card.pins.some(p => p.id === f.id)))];
        for (const fact of facts) {
            const ids = fact.subjectIds || [card.subjectId];
            if (!ids.every(allowed)) continue;
            let reason;
            if (fact.validity === 'unverified') reason = 'unverified';
            if (card.suppressions.some(s => s.id === (fact.id || npcFactId(fact)))) reason = 'suppressed';
            if (fact.origin !== 'authored') {
                if (!fact.source_refs?.length) reason = 'missing_sources';
                for (const ref of fact.source_refs || []) {
                    const event = snapshot?.events.find(e => e.event_id === ref.event_id && e._collectionIds?.length === 1 && e._collectionIds[0] === ref.collection);
                    if (ref.namespace !== scope.namespace || !event || snapshot.digests.get(ref.event_id) !== ref.digest
                        || !continuityEvidenceEligibility(event, ref.collection, scope).eligible) reason = 'source_or_scope_changed';
                }
            }
            if (reason) { excluded.push({ id: fact.id, reason, pinned: fact.pinned }); continue; }
            const key = ids.length === 2 ? relationshipPairKey(registryKey, ids) : JSON.stringify(ids);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(fact);
        }
    }
    const blocks = [], seen = new Set();
    const ordered = [...groups].map(([key, facts]) => ({ key, facts: facts.sort((a, b) => Number(b.origin === 'authored') - Number(a.origin === 'authored') || Number(b.pinned) - Number(a.pinned)), lines: [] }));
    const heading = 'Continuity state (canon is user-authored; generated state is evidence-linked):';
    const render = () => blocks.length ? `${heading}\n${blocks.join('\n')}` : '';
    // Round-robin across pairs, authored constraints globally before generated assertions.
    for (const origin of ['authored', 'generated']) {
        const queues = ordered.map(g => ({ ...g, facts: g.facts.filter(f => (f.origin === 'authored' ? 'authored' : 'generated') === origin) }));
        while (queues.some(g => g.facts.length)) for (const group of queues) {
            const fact = group.facts.shift();
            if (!fact || seen.has(fact.id)) continue;
            seen.add(fact.id);
            const names = fact.subjectIds.map(id => registry.subjects.find(s => s.id === id)?.name || id).join(' ↔ ');
            const refs = fact.origin === 'authored' ? 'User canon' : `Supported as of ${fact.asOf || 'cited evidence'}; sources: ${fact.source_refs.map(r => `${r.collection}/${r.event_id}`).join(', ')}`;
            const line = `- [${names}; ${refs}] ${clean(fact.fact)}`;
            blocks.push(line);
            if (estimateCastTokens(render()) > budget) { blocks.pop(); omitted.push({ id: fact.id, reason: 'budget', origin: fact.origin }); }
            else included.push(fact.id);
        }
    }
    return { text: render(), included, omitted, excluded, estimatedTokens: estimateCastTokens(render()) };
}

/** Portable protected cards and identity; imports require the exact destination namespace.
 * Cross-backend/remapped imports retain a recovery package rather than guessing identity.
 */
export function exportNpcCardData(settings, namespace, collection) {
    const registries = Object.fromEntries(Object.entries(settings.eventbase_subject_registries || {}).filter(([key]) => {
        const identity = JSON.parse(key);
        return identity[0] === namespace && identity[1] === collection;
    }));
    return { v: 1, namespace, collection, registries: copy(registries),
        cards: copy(Object.fromEntries(Object.entries(settings.eventbase_npc_cards || {}).filter(([, card]) => card.v >= 3 && registries[card.registryKey]))) };
}

export function importNpcCardData(settings, data, namespace, collection) {
    if (!data) return { restored: 0 };
    if (data.v !== 1 || !data.registries || !data.cards) throw new Error('Unsupported NPC card package');
    for (const [key, registry] of Object.entries(data.registries)) {
        if (key !== JSON.stringify([data.namespace, data.collection]) || registry.v !== 1 || !Array.isArray(registry.subjects)) throw new Error('NPC registry scope mismatch');
    }
    for (const [key, card] of Object.entries(data.cards)) {
        if (!data.registries[card.registryKey] || key !== subjectCardKey(card.registryKey, card.subjectId)
            || ![3, 4].includes(card.v) || !data.registries[card.registryKey].subjects.some(s => s.id === card.subjectId)) throw new Error('NPC card ownership mismatch');
        if (card.v === 4 && (!Array.isArray(card.authored) || !Array.isArray(card.pins) || !Array.isArray(card.suppressions)
            || !Array.isArray(card.audit) || !card.pairs || card.generated?.v !== 2)) throw new Error('Malformed NPC card');
    }
    const recoveryKey = JSON.stringify([data.namespace, data.collection, namespace, collection]);
    // Always retain the original package, including conflicting local edits.
    settings.eventbase_npc_card_imports = { ...settings.eventbase_npc_card_imports, [recoveryKey]: copy(data) };
    if (data.namespace !== namespace || data.collection !== collection) return { restored: 0, reviewRequired: true };
    let restored = 0;
    for (const [key, registry] of Object.entries(data.registries)) {
        if (key !== JSON.stringify([namespace, collection]) || registry.v !== 1) throw new Error('NPC registry scope mismatch');
        const current = settings.eventbase_subject_registries?.[key];
        if (current && JSON.stringify(current) !== JSON.stringify(registry)) continue;
        settings.eventbase_subject_registries = { ...settings.eventbase_subject_registries, [key]: copy(registry) };
        for (const [cardKey, card] of Object.entries(data.cards)) {
            if (card.registryKey !== key || cardKey !== subjectCardKey(key, card.subjectId)) throw new Error('NPC card ownership mismatch');
            if (settings.eventbase_npc_cards?.[cardKey]) continue;
            settings.eventbase_npc_cards = { ...settings.eventbase_npc_cards, [cardKey]: copy(card) };
            restored++;
        }
    }
    return { restored, reviewRequired: true };
}