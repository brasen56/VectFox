/** Database-browser event controls, mounted in the chunk detail view. */
import { continuityCollection, markEventResolved, unmarkEventResolved, removeResolutionLink } from '../core/continuity-repair-service.js';
import { buildResolvedBy, getContinuityView, renderResolution } from '../core/continuity.js';

export async function mountContinuityControls(host, collectionKey, eventId, settings, changed) {
    const context = await continuityCollection(collectionKey, settings);
    if (!host[0]?.isConnected) return;
    const event = context.entry.events.get(eventId);
    if (!event) return;
    const render = () => {
        host.empty();
        const current = context.entry.events.get(eventId);
        const events = context.entry.events;
        const roster = { eventById: events, events: [...events.values()], resolvedBy: buildResolvedBy(events.values()) };
        const view = getContinuityView(current, roster);
        $('<h4>').text('Event continuity').appendTo(host);
        $('<p>').text(view.fullyResolved ? 'Resolved' : `${view.remainingThreads.length} remaining threads`).appendTo(host);
        const checks = (current.open_threads || []).map((thread, index) => {
            const label = $('<label>').css('display', 'block').appendTo(host);
            const checkbox = $('<input type="checkbox">').appendTo(label);
            $('<span>').text(` ${index}: ${thread}`).appendTo(label);
            return checkbox;
        });
        const how = $('<input class="vectfox-input" placeholder="Outcome (optional)">').appendTo(host);
        const action = (text, fn) => $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text(text).appendTo(host).on('click', async function () {
            $(this).prop('disabled', true);
            try { await fn(); changed?.(context.entry.events.get(eventId).continuity); render(); }
            catch (error) { toastr.error(error.message, 'Continuity'); }
            finally { $(this).prop('disabled', false); }
        });
        action('Mark resolved — all', () => markEventResolved(collectionKey, eventId, settings, 'all', how.val() || 'Marked resolved by the user.'));
        action('Mark selected threads resolved', () => markEventResolved(collectionKey, eventId, settings,
            checks.flatMap((checkbox, index) => checkbox.prop('checked') ? [index] : []), how.val() || 'Marked resolved by the user.'));
        action('Unmark', () => unmarkEventResolved(collectionKey, eventId, settings));
        const details = $('<div>').appendTo(host);
        $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Show what resolves this').appendTo(host).on('click', () => {
            details.empty();
            $('<p>').text(renderResolution(view) || 'No active resolution.').appendTo(details);
            for (const { resolver, link } of roster.resolvedBy.get(eventId) || []) {
                const row = $('<div>').appendTo(details);
                $('<p>').text(`${resolver.summary} · ${link.status} · threads ${JSON.stringify(link.threads)} · ${link.how}`).appendTo(row);
                $('<button type="button" class="vectfox-btn vectfox-btn-secondary">').text('Remove link').appendTo(row).on('click', async () => {
                    try { await removeResolutionLink(collectionKey, resolver.event_id, link, settings); render(); }
                    catch (error) { toastr.error(error.message, 'Continuity'); }
                });
            }
        });
    };
    render();
}