/**
 * Pick a conservative auto-sync restart point after the chat's effective
 * message coordinate space shrinks (for example, after destructive ILS
 * flattening). Auto-sync windows are non-overlapping and aligned from zero.
 * Rechecking the last two committed windows catches the usual tail-compaction
 * case while the fingerprint cache keeps unchanged windows cheap.
 *
 * @param {number} chatLength Effective (InlineSummary-expanded) message count.
 * @param {object} settings VectFox settings.
 * @returns {number} A window-aligned, inclusive auto-sync start marker.
 */
export function getShrinkRecoveryMarker(chatLength, settings = {}) {
    const length = Math.max(0, Math.floor(Number(chatLength) || 0));
    const turns = Math.max(1, Math.min(20, Number(settings.eventbase_autosync_window_turns) || 1));
    const windowSize = turns * 2;
    const commitBoundary = settings.eventbase_autosync_settle_lag === false
        ? length
        : Math.max(0, length - windowSize);

    if (commitBoundary < windowSize) return 0;

    const lastCompleteWindowStart = Math.floor((commitBoundary - windowSize) / windowSize) * windowSize;
    return Math.max(0, lastCompleteWindowStart - windowSize);
}
