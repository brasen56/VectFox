import { describe, it, expect } from 'vitest';
import {
    CONTEXT_TOKEN_CATEGORIES,
    CONTEXT_TOKEN_DISPLAY,
    classifyContextTokenTag,
} from '../core/context-token-contract.js';

describe('context-token measurement contract', () => {
    it.each([
        ['3_vectfox', 'chunkbase', 'ChunkBase — main injection'],
        ['3_vectfox_pos0', 'chunkbase', 'ChunkBase — position group 0'],
        ['3_vectfox_pos9', 'chunkbase', 'ChunkBase — position group 9'],
        ['3_vectfox_pos10', 'chunkbase', 'ChunkBase — position group 10'],
        ['3_vectfox_pos1234', 'chunkbase', 'ChunkBase — position group 1234'],
        ['3_vectfox_eventbase', 'eventbase', 'EventBase retrieval'],
        ['3_vectfox_summarizer', 'summarizer', 'Summarizer injection (including bundled NPC state)'],
        ['3_vectfox_lorebook', 'lorebook', 'Separate lorebook injection'],
    ])('maps %s to exactly one documented category', (tag, category, label) => {
        expect(classifyContextTokenTag(tag)).toEqual({ category, label });
        expect(Object.values(CONTEXT_TOKEN_CATEGORIES)).toContain(category);
    });

    it.each([
        '3_vectfox_future', '3_vectfox_future_other', '3_vectfox_eventbase_extra',
        '3_vectfox_pos', '3_vectfox_pos-1', '3_vectfox_pos1_extra',
        '3_vectfoxpos0', '3_vectfox2',
    ])('keeps unknown prefixed key %s in its own category', tag => {
        const result = classifyContextTokenTag(tag);
        expect(result).toEqual({ category: tag, label: `Other VectFox injection (${tag})` });
        expect(Object.values(CONTEXT_TOKEN_CATEGORIES)).not.toContain(result.category);
    });

    it.each([
        '', '3_vectors', 'vectfox', 'other_3_vectfox', ' 3_vectfox',
        '3_VectFox', 'world_info', 'summarize', null, undefined, 3, {},
    ])('excludes non-owned key %j', tag => {
        expect(classifyContextTokenTag(tag)).toBeNull();
    });

    it('assigns every owned snapshot key once without touching prompt values', () => {
        const registry = Object.freeze({
            '3_vectfox': Object.freeze({ value: '<memory>Final wrapped text</memory>', position: 1, depth: 2 }),
            '3_vectfox_pos12': Object.freeze({ value: '' }),
            '3_vectfox_eventbase': Object.freeze({ value: 'Event text' }),
            '3_vectfox_summarizer': Object.freeze({ value: 'Summary and NPC state' }),
            '3_vectfox_lorebook': Object.freeze({ value: 'VectFox lorebook text' }),
            '3_vectfox_future': Object.freeze({ value: 'Future route' }),
            '3_vectfox_another': Object.freeze({ value: 'Another future route' }),
            'other_extension': Object.freeze({ value: 'Not counted' }),
        });
        const before = JSON.stringify(registry);
        const categories = Object.keys(registry).map(classifyContextTokenTag).filter(Boolean);
        expect(categories).toHaveLength(7);
        expect(categories.filter(entry => entry.category === 'chunkbase')).toHaveLength(2);
        expect(new Set(categories.map(entry => entry.category)).size).toBe(6);
        expect(JSON.stringify(registry)).toBe(before);
    });

    it('keeps disabled, unmeasured, successful zero and unavailable displays distinct', () => {
        expect(CONTEXT_TOKEN_DISPLAY).toEqual({
            DISABLED: 'VectFox: Disabled',
            UNMEASURED: 'VectFox: —',
            AVAILABLE: 'VectFox: ~{total} tokens',
            ZERO: 'VectFox: 0 tokens',
            UNAVAILABLE: 'VectFox: Count unavailable',
        });
        expect(new Set(Object.values(CONTEXT_TOKEN_DISPLAY)).size).toBe(5);
        expect(Object.isFrozen(CONTEXT_TOKEN_DISPLAY)).toBe(true);
        expect(Object.isFrozen(CONTEXT_TOKEN_CATEGORIES)).toBe(true);
    });
});