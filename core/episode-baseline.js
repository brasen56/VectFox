/** Read-only Phase 4C measurements. Incident labels are review data, never membership. */
import { getContinuityView, isActiveDuplicate } from './continuity.js';

export function captureEpisodeBaseline({ main = [], cast = [], roster, text = '', context = {} }) {
    const records = new Map();
    for (const [lane, events] of [['main', main], ['cast', cast]]) {
        for (const event of events) {
            if (!event.event_id) continue;
            if (records.has(event.event_id)) {
                const lanes = records.get(event.event_id).lanes;
                if (!lanes.includes(lane)) lanes.push(lane);
                continue;
            }
            records.set(event.event_id, {
                eventId: event.event_id, lanes: [lane],
                collections: event._collectionIds || roster?.eventById?.get(event.event_id)?._collectionIds || [],
                summary: event.summary || event.text || '',
                sourceChatId: event.source_chat_id ?? null,
                sourceWindow: [event.source_window_start ?? null, event.source_window_end ?? null],
                duplicate: isActiveDuplicate(event, roster),
                lifecycle: event._continuityView || getContinuityView(event, roster),
            });
        }
    }
    return JSON.parse(JSON.stringify({ v: 1, kind: 'phase4c-baseline', context,
        coverage: 'EventBase retrieval main/cast history only; not a committed prompt, NPC-card facts or Summarizer Injection',
        rosterReady: roster?.ready === true, metadataSupported: roster?.continuitySupported === true,
        unidentifiedRecords: [...main, ...cast].filter(e => !e.event_id).length,
        injectionText: text, records: [...records.values()] }));
}

/** No heuristic same-incident inference and no automatic launch threshold. */
export function measureEpisodeBaseline({ phase2Applied, settingsMatched, scenes = [] }) {
    const blockers = [];
    if (phase2Applied !== true) blockers.push('Confirm Phase 2 resolution links and duplicate marks were applied.');
    if (settingsMatched !== true) blockers.push('Confirm the baseline settings and representative scene contexts match.');
    if (scenes.length !== 5) blockers.push('Exactly five representative scenes are required.');
    const seen = new Set();
    const results = scenes.map(({ sceneId, capture, review = [] }) => {
        if (!sceneId || seen.has(sceneId)) blockers.push('Scene IDs must be nonempty and unique.');
        seen.add(sceneId);
        if (capture?.v !== 1 || capture.kind !== 'phase4c-baseline' || !Array.isArray(capture.records)) {
            throw new Error(`Invalid baseline capture for scene ${sceneId}`);
        }
        if (!capture.rosterReady || !capture.metadataSupported || capture.unidentifiedRecords) {
            blockers.push(`${sceneId}: incomplete identity, roster or metadata coverage.`);
        }
        const eligible = capture.records.filter(r => !r.duplicate);
        const ids = new Set(eligible.map(r => r.eventId));
        if (ids.size !== eligible.length) blockers.push(`${sceneId}: repeated record identities.`);
        const reviewed = new Set(), incidents = new Map();
        for (const row of review) {
            if (!ids.has(row.eventId) || reviewed.has(row.eventId) || !row.incidentId?.trim()
                || !['present', 'absent', 'not_applicable'].includes(row.outcome)
                || typeof row.note !== 'string' || !row.note.trim()) {
                blockers.push(`${sceneId}: invalid, duplicate or undocumented review row.`);
                continue;
            }
            reviewed.add(row.eventId);
            // For 'present', require a verbatim excerpt from the final rendered block.
            if (row.outcome === 'present' && (!row.quote?.trim() || !capture.injectionText.includes(row.quote))) {
                blockers.push(`${sceneId}/${row.eventId}: outcome quote is not in the rendered text.`);
            }
            if (!incidents.has(row.incidentId)) incidents.set(row.incidentId, []);
            incidents.get(row.incidentId).push(row);
        }
        if (reviewed.size !== ids.size) blockers.push(`${sceneId}: review every distinct non-duplicate injected record.`);
        const groups = [...incidents].map(([incidentId, rows]) => ({ incidentId,
            eventIds: rows.map(r => r.eventId), recordCount: rows.length,
            missingOutcomeEventIds: rows.filter(r => r.outcome === 'absent').map(r => r.eventId) }));
        return { sceneId, distinctRecords: ids.size, excludedDuplicates: capture.records.length - eligible.length,
            incidents: groups, multiRecordIncidents: groups.filter(g => g.recordCount >= 2).length,
            missingOutcomeRecords: groups.reduce((n, g) => n + g.missingOutcomeEventIds.length, 0) };
    });
    return { v: 1, complete: blockers.length === 0, blockers, scenes: results,
        scenesWithMultiRecordIncidents: results.filter(r => r.multiRecordIncidents > 0).length,
        multiRecordIncidents: results.reduce((n, r) => n + r.multiRecordIncidents, 0),
        missingOutcomeRecords: results.reduce((n, r) => n + r.missingOutcomeRecords, 0),
        decision: 'Human review required: assess materiality; this report does not authorize episode grouping.' };
}