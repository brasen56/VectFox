/** Public provenance primitives. No generation, persistence, or MWT identities. */
import { prepareMessagesForEventBase } from './ils-expander.js';
import { stripReasoningBlocks, stripGameSystemBlocks } from './text-cleaning.js';

export function legacySourceHash(message) {
    const text = `${message.name || ''}:${String(message.mes || '').trim()}`;
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    return hash >>> 0;
}

/** Raw edit signal only; SHA-256 narrative fingerprints remain the identity proof. */
export function rawSourceHash(message) {
    const text = JSON.stringify([String(message.name || ''), String(message.mes || '')]);
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    return `djb2-raw-v1:${hash >>> 0}`;
}

export function canFingerprintNarrative() {
    return typeof globalThis.crypto?.subtle?.digest === 'function';
}

export async function narrativeFingerprint(message) {
    // Provenance is optional on non-secure origins; never substitute a weak hash
    // for the SHA-256 proof required to verify a source.
    if (!canFingerprintNarrative()) return null;
    const narrative = stripGameSystemBlocks(stripReasoningBlocks(String(message.mes || '')))
        .normalize('NFKC').replace(/\s+/gu, ' ').trim();
    const bytes = new TextEncoder().encode(JSON.stringify([String(message.name || '').normalize('NFKC'), narrative]));
    let digest;
    try {
        digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    } catch {
        return null;
    }
    return `sha256-narrative-v1:${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Persist only host identifiers, never extension-private extra fields. */
export async function captureEventSources(messages, windowStart) {
    return Promise.all(messages.map(async (message, index) => ({
        expanded_index: windowStart + index,
        host_id: message.id ?? null,
        host_mesid: message.extra?.mesid ?? null,
        legacy_hash: message.hash ?? legacySourceHash(message),
        raw_content_hash: rawSourceHash(message),
        fingerprint: await narrativeFingerprint(message),
    })));
}

export function eventSourceReferences(event, collectionId, eventRef, scopeToken) {
    const stored = Array.isArray(event.source_messages) ? event.source_messages : [];
    const indices = Array.isArray(event.source_message_ids) ? event.source_message_ids : [];
    const hashes = Array.isArray(event.source_message_hashes) ? event.source_message_hashes : [];
    return Array.from({ length: Math.max(stored.length, indices.length, hashes.length) }, (_, i) => ({
        ref: `${eventRef}:source:${i}`,
        event_ref: eventRef,
        collection_id: collectionId,
        collection_key: event.collection_key ?? collectionId,
        source_chat_id: event.source_chat_id ?? null,
        expanded_index: stored[i]?.expanded_index ?? indices[i] ?? null,
        host_id: stored[i]?.host_id ?? null,
        host_mesid: stored[i]?.host_mesid ?? null,
        stored_fingerprint: stored[i]?.fingerprint ?? null,
        legacy_hash: stored[i]?.legacy_hash ?? hashes[i] ?? null,
        raw_content_hash: stored[i]?.raw_content_hash ?? null,
        scope_token: scopeToken,
        status: 'unresolved',
        reason: 'not_resolved',
    }));
}

/** Indices and djb2 hashes are hints, never sufficient proof of identity. */
export async function resolveEventSources(references, { chatId, chat, chatMetadata }) {
    const prepared = prepareMessagesForEventBase(chat, chatMetadata);
    const leaves = (await Promise.all(prepared.messages.map(async (message, index) => ({
        message, index, container: prepared.sourceIndices[index],
        fingerprint: await narrativeFingerprint(message), legacyHash: legacySourceHash(message),
        rawHash: rawSourceHash(message),
    })))).filter(leaf => !leaf.message.extra?.ILS_Data);
    return references.map(reference => {
        const base = { ...reference, status: 'unresolved', reason: null, current_fingerprint: null, message: null };
        if (!reference.source_chat_id || reference.source_chat_id !== chatId) {
            return { ...base, reason: reference.source_chat_id ? 'cross_chat_unavailable' : 'unknown_source_chat' };
        }
        const hasIdentity = reference.host_id != null || reference.host_mesid != null;
        const identityMatches = leaf => (reference.host_id == null || leaf.message.id === reference.host_id)
            && (reference.host_mesid == null || leaf.message.extra?.mesid === reference.host_mesid);
        let candidates = hasIdentity ? leaves.filter(identityMatches) : [];
        if (hasIdentity && !candidates.length) return { ...base, status: 'missing', reason: 'host_identity_missing' };
        if (!hasIdentity && reference.stored_fingerprint) {
            candidates = leaves.filter(leaf => leaf.fingerprint === reference.stored_fingerprint);
        }
        if (candidates.length > 1) return { ...base, reason: 'ambiguous_duplicate' };
        let leaf = candidates[0];
        let status = 'unresolved', reason = 'legacy_identity_unverified';
        if (leaf && reference.stored_fingerprint && leaf.fingerprint) {
            status = leaf.fingerprint === reference.stored_fingerprint ? 'verified' : 'changed';
            reason = status === 'changed' ? 'narrative_changed' : null;
            // Extraction/deduplication hashes may use an unrelated hash convention.
            if (status === 'verified' && reference.raw_content_hash != null && leaf.rawHash !== reference.raw_content_hash) {
                status = 'changed';
                reason = 'raw_content_changed';
            }
        } else if (leaf) {
            status = reference.raw_content_hash != null && leaf.rawHash !== reference.raw_content_hash ? 'changed' : 'unresolved';
            reason = status === 'changed' ? 'raw_content_changed'
                : !leaf.fingerprint ? 'fingerprinting_unavailable' : 'legacy_identity_unverified';
        } else {
            const hashMatches = leaves.filter(item => reference.legacy_hash != null && item.legacyHash === reference.legacy_hash);
            if (hashMatches.length > 1) return { ...base, reason: 'ambiguous_duplicate' };
            leaf = hashMatches[0];
            if (!leaf) {
                // A position alone cannot tell an edit from a deletion or a lost ILS original.
                return { ...base, reason: 'source_not_located' };
            }
        }
        const message = leaf.message;
        const container = chat[leaf.container];
        return {
            ...base, status, reason, current_fingerprint: leaf.fingerprint,
            expanded_index: leaf.index, visible_index: leaf.container,
            recovered_ils: message !== container,
            leaf_identity: { id: message.id ?? null, mesid: message.extra?.mesid ?? null },
            container_identity: { id: container?.id ?? null, mesid: container?.extra?.mesid ?? null },
            // Never return an unverified original as usable evidence.
            message: status === 'verified' || status === 'changed' ? {
                name: message.name ?? '', mes: message.mes ?? '', is_user: !!message.is_user,
                is_system: !!message.is_system, send_date: message.send_date ?? null,
                id: message.id ?? null, extra: { mesid: message.extra?.mesid ?? null },
            } : null,
        };
    });
}