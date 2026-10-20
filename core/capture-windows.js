/** Deterministic scene selection; summaries rank scenes, never become evidence. */
export function selectCaptureWindows(events, maxWindows = 4) {
    const groups = [];
    const key = ref => JSON.stringify([ref.source_chat_id, ref.host_id, ref.host_mesid,
        ref.stored_fingerprint, ref.send_date, ref.expanded_index]);
    for (const event of events) {
        const refs = event.source_refs || [];
        if (!refs.length) continue;
        const keys = new Set(refs.map(key));
        const overlaps = groups.filter(group => [...keys].some(k => group.keys.has(k)));
        const group = { keys, sources: refs.slice(), events: [event], event_refs: [event.event_ref],
            position: event.source_window_start ?? Infinity,
            score: (/dialogue|decision|conflict|relationship|revelation/i.test(event.event_type || '') ? 3 : 0)
                + Math.min(3, Math.max(0, Number(event.importance) || 0)) };
        for (const other of overlaps) {
            group.sources.push(...other.sources);
            group.event_refs.push(...other.event_refs);
            group.events.push(...other.events);
            other.keys.forEach(k => group.keys.add(k));
            group.position = Math.min(group.position, other.position);
            group.score = Math.max(group.score, other.score);
            groups.splice(groups.indexOf(other), 1);
        }
        group.sources = [...new Map(group.sources.map(ref => [key(ref), ref])).values()];
        groups.push(group);
    }
    // Split transitive overlaps BEFORE temporal selection. Every candidate fits
    // its share of the total budget, so a later selected scene cannot be lost
    // to truncation after selection. Rank/cite only events touching each slice.
    const perWindow = Math.min(40, Math.floor(120 / maxWindows));
    const candidates = groups.flatMap(group => {
        group.sources.sort((a, b) => (a.expanded_index ?? Infinity) - (b.expanded_index ?? Infinity));
        const chunks = [];
        for (let start = 0; start < group.sources.length; start += perWindow) {
            const sources = group.sources.slice(start, start + perWindow);
            const keys = new Set(sources.map(key));
            const events = group.events.filter(event => event.source_refs.some(ref => keys.has(key(ref))));
            chunks.push({ sources, event_refs: events.map(event => event.event_ref),
                position: sources[0].expanded_index ?? group.position,
                score: Math.max(...events.map(event =>
                    (/dialogue|decision|conflict|relationship|revelation/i.test(event.event_type || '') ? 3 : 0)
                    + Math.min(3, Math.max(0, Number(event.importance) || 0)))),
                truncated: sources.length < group.sources.length });
        }
        return chunks;
    });
    candidates.sort((a, b) => a.position - b.position);
    // Allocate one ranked scene per temporal stratum before filling spare slots.
    const selected = [];
    for (let bin = 0; bin < maxWindows; bin++) {
        const segment = candidates.slice(Math.floor(bin * candidates.length / maxWindows),
            Math.floor((bin + 1) * candidates.length / maxWindows));
        segment.sort((a, b) => b.score - a.score || a.position - b.position);
        if (segment.length) selected.push(segment[0]);
    }
    let remaining = 120;
    return selected.map((group, index) => {
        // Merges start with the newest event; restore original-message order
        // before choosing which sources fit within the budget.
        group.sources.sort((a, b) => (a.expanded_index ?? Infinity) - (b.expanded_index ?? Infinity));
        const sources = group.sources.slice(0, Math.min(40, remaining));
        remaining -= sources.length;
        return { window_ref: `capture:${index}:${group.event_refs[0]}`, event_refs: group.event_refs,
            source_refs: sources, ranking: { score: group.score, temporal_position: group.position },
            availability: 'unresolved', truncated: group.truncated || sources.length < group.sources.length };
    }).filter(window => window.source_refs.length);
}