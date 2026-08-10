import { describe, it, expect } from 'vitest';
import {
    expandILSMessages,
    prepareMessagesForEventBase,
    mapEffectiveTipToTopLevel,
} from '../core/ils-expander.js';

const msg = (mes, extra = {}) => ({ mes, name: 'Character', extra });
const embeddedSummary = (mes, originals) => msg(mes, {
    ILS_Data: { OriginalMessages: originals },
});
const referencedSummary = (mes, ref) => msg(mes, {
    ILS_Data: { Ref: ref },
});

describe('InlineSummary expansion', () => {
    it('passes ordinary messages through without cloning or mutation', () => {
        const messages = [msg('one'), msg('two')];
        const result = expandILSMessages(messages);

        expect(result.expanded).toEqual(messages);
        expect(result.expanded[0]).toBe(messages[0]);
        expect(result.sourceIndices).toEqual([0, 1]);
        expect(result.stats.summariesFound).toBe(0);
    });

    it('replaces an embedded summary with its original messages', () => {
        const originals = [msg('original one'), msg('original two')];
        const result = expandILSMessages([
            msg('before'),
            embeddedSummary('condensed', originals),
            msg('after'),
        ]);

        expect(result.expanded.map(m => m.mes)).toEqual([
            'before', 'original one', 'original two', 'after',
        ]);
        expect(result.sourceIndices).toEqual([0, 1, 1, 2]);
        expect(result.stats).toMatchObject({
            summariesFound: 1,
            originalsRecovered: 2,
            maxDepth: 0,
        });
    });

    it('recursively expands nested summaries', () => {
        const nested = embeddedSummary('inner summary', [msg('leaf one'), msg('leaf two')]);
        const outer = embeddedSummary('outer summary', [msg('leaf zero'), nested]);

        const result = expandILSMessages([outer]);

        expect(result.expanded.map(m => m.mes)).toEqual(['leaf zero', 'leaf one', 'leaf two']);
        expect(result.sourceIndices).toEqual([0, 0, 0]);
        expect(result.stats).toMatchObject({
            summariesFound: 2,
            originalsRecovered: 3,
            maxDepth: 1,
        });
    });

    it('resolves reference-backed originals from chat metadata', () => {
        const result = expandILSMessages(
            [referencedSummary('condensed', 'summary-42')],
            { ILS_Originals: { 'summary-42': [msg('from metadata')] } },
        );

        expect(result.expanded.map(m => m.mes)).toEqual(['from metadata']);
        expect(result.stats.originalsRecovered).toBe(1);
    });

    it('keeps a dangling reference summary instead of dropping content', () => {
        const summary = referencedSummary('keep this summary', 'missing');
        const result = expandILSMessages([summary], { ILS_Originals: {} });

        expect(result.expanded).toEqual([summary]);
        expect(result.stats.danglingSummaries).toBe(1);
        expect(result.stats.originalsRecovered).toBe(0);
    });

    it('stops cyclic summary graphs without hanging or losing the fallback summary', () => {
        const cyclic = embeddedSummary('cyclic fallback', []);
        cyclic.extra.ILS_Data.OriginalMessages.push(cyclic);

        const result = expandILSMessages([cyclic]);

        expect(result.expanded).toEqual([cyclic]);
        expect(result.stats.cycleOrDepthStops).toBe(1);
    });

    it('expands before filtering empty visible summary text', () => {
        const result = prepareMessagesForEventBase([
            embeddedSummary('', [msg('recover me')]),
            msg('   '),
        ]);

        expect(result.messages.map(m => m.mes)).toEqual(['recover me']);
        expect(result.visibleCount).toBe(0);
    });
});

describe('InlineSummary coordinate mapping', () => {
    const chat = [
        msg('normal one'),
        embeddedSummary('collapsed', [msg('a'), msg('b'), msg('c')]),
        msg('normal two'),
    ];

    it('does not treat a partially-vectorized collapsed summary as covered', () => {
        expect(mapEffectiveTipToTopLevel(chat, 2)).toEqual({
            topLevelExclusive: 1,
            effectiveLength: 5,
        });
    });

    it('advances past a summary once all of its originals are covered', () => {
        expect(mapEffectiveTipToTopLevel(chat, 4)).toEqual({
            topLevelExclusive: 2,
            effectiveLength: 5,
        });
        expect(mapEffectiveTipToTopLevel(chat, 5)).toEqual({
            topLevelExclusive: 3,
            effectiveLength: 5,
        });
    });
});
