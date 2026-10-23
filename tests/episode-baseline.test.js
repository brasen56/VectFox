import { describe, it, expect } from 'vitest';
import { captureEpisodeBaseline, measureEpisodeBaseline } from '../core/episode-baseline.js';
import { threadsDigest } from '../core/continuity.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const event = id => ({ event_id: id, summary: `Incident perspective ${id}`, open_threads: ['Debt', 'Trust'] });
const capture = (extra = {}) => captureEpisodeBaseline({ main: [event('a'), event('b')],
    roster: { ready: true, continuitySupported: true }, text: 'Trust repaired; debt remains unpaid.', ...extra });
const review = () => [
    { eventId: 'a', incidentId: 'loan', outcome: 'present', quote: 'Trust repaired', note: 'Partial reconciliation is visible.' },
    { eventId: 'b', incidentId: 'loan', outcome: 'absent', note: 'This perspective omits the partial repair.' },
];
const bundle = () => ({ phase2Applied: true, settingsMatched: true,
    scenes: Array.from({ length: 5 }, (_, i) => ({ sceneId: `scene-${i}`, capture: capture(), review: review() })) });

describe('Phase 4C read-only baseline', () => {
    it('runs the offline CLI with complete/incomplete and invalid-input exit codes', () => {
        const dir = mkdtempSync(join(tmpdir(), 'vectfox-episodes-'));
        const file = join(dir, 'review.json');
        const script = fileURLToPath(new URL('../scripts/measure-episode-baseline.mjs', import.meta.url));
        const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
        try {
            writeFileSync(file, JSON.stringify(bundle()));
            const complete = run(file);
            expect(complete.status).toBe(0);
            expect(JSON.parse(complete.stdout).multiRecordIncidents).toBe(5);
            writeFileSync(file, JSON.stringify({ scenes: [] }));
            expect(run(file).status).toBe(2);
            writeFileSync(file, '{');
            expect(run(file).status).toBe(1);
            expect(run().stderr).toContain('Usage:');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it('counts distinct records across lanes once and excludes active duplicates', () => {
        const a = event('a'), b = event('b');
        const copy = { ...event('copy'), continuity: { v: 1, duplicate_of: { status: 'active', event_id: 'a' } } };
        const before = JSON.stringify([a, b, copy]);
        const sample = capture({ main: [a, copy], cast: [a, b] });
        expect(sample.records[0].lanes).toEqual(['main', 'cast']);
        const input = bundle();
        input.scenes[0].capture = sample;
        const report = measureEpisodeBaseline(input);
        expect(report.complete).toBe(true);
        expect(report.scenes[0]).toMatchObject({ distinctRecords: 2, excludedDuplicates: 1, multiRecordIncidents: 1 });
        expect(JSON.stringify([a, b, copy])).toBe(before);
        sample.records[0].summary = 'Changed export';
        expect(a.summary).not.toBe('Changed export');
    });

    it('requires human labels rather than merging shared characters or unrelated arguments', () => {
        const input = bundle();
        input.scenes[0].review[1].incidentId = 'chores';
        const report = measureEpisodeBaseline(input);
        expect(report.scenes[0].multiRecordIncidents).toBe(0);
        expect(report.scenesWithMultiRecordIncidents).toBe(4);
        expect(report.missingOutcomeRecords).toBe(5);
        expect(report.decision).toContain('Human review required');
    });

    it('preserves partial lifecycle closure and invalidated resolver evidence', () => {
        const a = event('a');
        const resolver = { ...event('r'), summary: 'Trust repaired', continuity: { v: 1, resolves: [
            { event_id: 'a', status: 'active', threads: [1], threads_digest: threadsDigest(a), resolver_digest: 'stale' },
        ] } };
        const roster = { ready: true, continuitySupported: true, events: [a, resolver] };
        expect(capture({ main: [a], roster }).records[0].lifecycle.inactiveLinks[0].reason).toBe('resolver_digest_mismatch');
        resolver.continuity.resolves[0].resolver_digest = threadsDigest(resolver);
        const view = capture({ main: [a], roster }).records[0].lifecycle;
        expect(view.closedThreads).toEqual([1]);
        expect(view.remainingThreads).toEqual(['Debt']);
        expect(view.fullyResolved).toBe(false);
    });

    it('blocks incomplete baselines, missing reviews, invented outcome quotes and duplicate scenes', () => {
        const input = bundle();
        input.phase2Applied = false;
        input.settingsMatched = false;
        input.scenes[0].review = [];
        input.scenes[1].review[0].quote = 'Invented resolution';
        input.scenes[2].sceneId = input.scenes[3].sceneId;
        input.scenes[4].capture.rosterReady = false;
        const result = measureEpisodeBaseline(input);
        expect(result.complete).toBe(false);
        expect(result.blockers).toHaveLength(6);
        expect(measureEpisodeBaseline({ scenes: [] }).blockers).toHaveLength(3);
    });

    it('does not confuse candidates, missing identities or repeated review rows with injected records', () => {
        const input = bundle();
        input.scenes[0].capture = capture({ cast: [{ summary: 'no identity' }] });
        input.scenes[0].review.push({ ...review()[0], eventId: 'candidate-not-injected' }, review()[0]);
        const report = measureEpisodeBaseline(input);
        expect(report.complete).toBe(false);
        expect(report.scenes[0].distinctRecords).toBe(2);
        expect(report.blockers).toHaveLength(3);
    });

    it('supports empty scenes without pretending missing captures were measured', () => {
        const input = bundle();
        input.scenes[0] = { sceneId: 'empty', capture: capture({ main: [], text: '' }), review: [] };
        expect(measureEpisodeBaseline(input).complete).toBe(true);
        input.scenes[0].capture = null;
        expect(() => measureEpisodeBaseline(input)).toThrow('Invalid baseline capture');
    });
});