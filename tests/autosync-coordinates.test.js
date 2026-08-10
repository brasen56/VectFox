import { describe, expect, it } from 'vitest';
import { getShrinkRecoveryMarker } from '../core/autosync-coordinates.js';

describe('getShrinkRecoveryMarker', () => {
    it('backs up over the last two committed one-turn windows', () => {
        expect(getShrinkRecoveryMarker(20, {
            eventbase_autosync_window_turns: 1,
            eventbase_autosync_settle_lag: true,
        })).toBe(14);
    });

    it('stays aligned for larger auto-sync windows', () => {
        expect(getShrinkRecoveryMarker(31, {
            eventbase_autosync_window_turns: 3,
            eventbase_autosync_settle_lag: false,
        })).toBe(18);
    });

    it('rewinds to zero when fewer than two useful windows exist', () => {
        expect(getShrinkRecoveryMarker(5, {
            eventbase_autosync_window_turns: 2,
        })).toBe(0);
    });

    it('clamps malformed settings and lengths safely', () => {
        expect(getShrinkRecoveryMarker(-10, {
            eventbase_autosync_window_turns: 999,
        })).toBe(0);
    });
});
