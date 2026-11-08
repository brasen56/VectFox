/** Database-browser event controls, mounted in the chunk detail view. */
import * as service from '../core/continuity-repair-service.js';
import { buildResolvedBy, getContinuityView, renderResolution } from '../core/continuity.js';
import { mountContinuityActions } from './continuity-actions.js';

export async function mountContinuityControls(host, collectionKey, eventId, settings, changed) {
    const context = await service.continuityCollection(collectionKey, settings);
    if (!host[0]?.isConnected) return;
    let busy = false;
    const render = async () => {
        const entry = await context.currentEntry();
        if (!host[0]?.isConnected) return;
        host.empty();
        const current = entry.events.get(eventId);
        if (!current) return;
        const events = entry.events;
        const roster = { eventById: events, events: [...events.values()], resolvedBy: buildResolvedBy(events.values()) };
        const view = getContinuityView(current, roster);
        $('<h4>').text('Event continuity').appendTo(host);
        $('<p>').text(view.fullyResolved ? 'Resolved' : `${view.remainingThreads.length} remaining threads`).appendTo(host);
        $('<p>').text(renderResolution(view) || 'No active resolution.').appendTo(host);
        mountContinuityActions({ host: host[0], event: current, index: roster, act: async (name, args, expected) => {
            if (busy) return;
            busy = true;
            host[0].querySelectorAll('button').forEach(node => { node.disabled = true; });
            try {
                if (name === 'removeResolutionLink') await service.removeResolutionLink(collectionKey, args[0], args[1], settings, expected);
                else if (name === 'markEventResolved') await service.markEventResolved(collectionKey, eventId, settings, ...args, expected);
                else if (name === 'unmarkEventResolved') await service.unmarkEventResolved(collectionKey, eventId, settings, args[0], expected);
                else await service.reopenEventSelfClosure(collectionKey, eventId, settings, expected);
                const fresh = await context.currentEntry();
                changed?.(fresh.events.get(eventId)?.continuity);
                await render();
            }
            catch (error) { toastr.error(error.message, 'Continuity'); }
            finally {
                busy = false;
                host[0]?.querySelectorAll('button').forEach(node => { node.disabled = false; });
            }
        } });
    };
    await render();
}