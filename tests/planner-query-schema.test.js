import { describe, it, expect } from 'vitest';
import { getAgenticPlannerPrompt } from '../core/prompts-i18n.js';

describe('Phase 3B planner prompt schema', () => {
    it.each(['intl', 'jieba', 'jieba_tw', 'tiny_segmenter', 'korean', 'others'])
    ('uses valid per-query character scopes in every %s example', mode => {
        const prompt = getAgenticPlannerPrompt(mode);
        const examples = [...prompt.matchAll(/\{\n  "queries": \[[\s\S]*?\n\}/g)]
            .map(match => JSON.parse(match[0]));
        expect(examples).toHaveLength(3);
        for (const example of examples) {
            expect(example.filters?.characters_any).toBeUndefined();
            for (const query of example.queries) {
                expect(typeof query.query).toBe('string');
                expect(Array.isArray(query.characters_any)).toBe(true);
            }
        }
        const participants = examples[2].queries.map(query => query.characters_any);
        expect(participants.map(names => names.length)).toEqual([1, 2, 2]);
        expect(participants[0][0]).toBe(participants[1][1]);
        expect(participants[2][0]).not.toBe(participants[0][0]);
        expect(prompt).toContain('characters_any belongs to THAT query only');
    });
});