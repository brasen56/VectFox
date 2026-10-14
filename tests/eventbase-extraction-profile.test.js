import { describe, it, expect } from 'vitest';
import { getEventBaseExtractionPrompt } from '../core/prompts-i18n.js';
import { buildExtractionPrompt, validateEvent } from '../core/eventbase-schema.js';
import { effectiveExtractionProfile, resolveExtractionProfile } from '../core/eventbase-extraction-settings.js';
import { formatRetrievalDiagnostics } from '../core/eventbase-retrieval-debug.js';

describe('EventBase extraction profiles', () => {
    it('defaults to story and safely falls back for invalid settings', () => {
        for (const value of [undefined, null, '', 'invalid', 'story']) {
            expect(resolveExtractionProfile({ eventbase_extraction_profile: value })).toBe('story');
        }
        expect(effectiveExtractionProfile({ eventbase_extraction_profile: 'slice_of_life', eventbase_custom_prompt: '  ' })).toBe('slice_of_life');
        expect(effectiveExtractionProfile({ eventbase_extraction_profile: 'slice_of_life', eventbase_custom_prompt: '{{text}}' })).toBe('custom');
    });
    it.each(['intl', 'jieba', 'jieba_tw', 'tiny_segmenter', 'korean', 'others'])('changes only the selection guidance in %s', mode => {
        const story = getEventBaseExtractionPrompt(mode);
        expect(getEventBaseExtractionPrompt(mode, 'story')).toBe(story);
        expect(getEventBaseExtractionPrompt(mode, 'invalid')).toBe(story);
        const slice = getEventBaseExtractionPrompt(mode, 'slice_of_life');
        expect(slice).toContain('GATE 1: THE FUTURE-CONTINUITY TEST');
        expect(slice).toContain('GATE 2: THE RECALL TEST');
        expect(slice).toContain('GATE 3: THE NEW-OR-CHANGED TEST');
        expect(slice).toContain('One event per new or changed fact, never one per repetition');
        expect(slice).toContain('Routines, preferences and nicknames normally have open_threads: []');
        expect(slice).toContain('3-5: supported new or changed routines');
        expect(slice).not.toContain('Routine daily activities, schedules, and plans are NOT events');
        expect(slice).not.toContain('THE RETRIEVAL VALUE TEST');
        expect(slice).not.toContain('THE DAILY-ROUTINE FILTER');
        expect(slice).not.toContain('Examples that FAIL the gates');
        expect(slice).not.toContain('BEFORE ASSIGNING A SCORE');
        // Story changes keep the story profile's per-type ranges.
        const typeRanges = prompt => prompt.slice(prompt.indexOf('  PERMANENT / IRREVERSIBLE'), prompt.indexOf('- summary:'));
        expect(typeRanges(slice)).toContain('betrayal:             7-10');
        expect(typeRanges(slice)).toBe(typeRanges(story));
        // Prompt examples must not hand the benchmark fixture its answers.
        for (const fixtureTerm of ['breakfast', 'tea', 'Sunny', 'grant', 'rent', 'supplier']) {
            expect(slice.split('3. WHEN TO RETURN')[1].split('4. REASONING BLOCKS')[0]).not.toMatch(new RegExp(`\\b${fixtureTerm}\\b`, 'i'));
        }
        expect(slice.split('1. LANGUAGE')[1].split('2. EVENT COUNT')[0]).toBe(story.split('1. LANGUAGE')[1].split('2. EVENT COUNT')[0]);
        expect(slice.split('4. REASONING BLOCKS')[1].split('- importance:')[0]).toBe(story.split('4. REASONING BLOCKS')[1].split('- importance:')[0]);
        expect(slice.slice(slice.indexOf('- summary:'))).toBe(story.slice(story.indexOf('- summary:')));
        for (const placeholder of ['{{text}}', '{{maxCount}}', '{{knownCharacters}}', '{{openIssues}}']) expect(slice).toContain(placeholder);
    });
    it('substitutes placeholders without modifying custom templates or excerpt literals', () => {
        expect(buildExtractionPrompt('literal {{maxCount}}', 3, '{{text}}', 'intl', '', '', 'slice_of_life')).toBe('literal {{maxCount}}');
        const prompt = buildExtractionPrompt('scene', 10, ' ', 'korean', 'Alex', 'I1: issue', 'slice_of_life');
        expect(prompt).toContain('AT MOST 10 events');
        expect(prompt).toContain('I1: issue');
        expect(prompt).toContain('FUTURE-CONTINUITY TEST');
        expect(prompt).not.toContain('{{text}}');
    });
    it.each([3, 4, 5])('keeps quiet importance %s in the existing schema', importance => {
        const result = validateEvent({ event_type: 'other', importance, summary: 'Alex and Sam establish Saturday breakfasts.' });
        expect(result.ok).toBe(true);
        expect(result.event.importance).toBe(importance);
        expect(result.event.continuity_value).toBeUndefined();
    });
    it('labels diagnostics as current settings rather than stored-event provenance', () => {
        const text = formatRetrievalDiagnostics({ extractionProfile: 'custom', selectedExtractionProfile: 'slice_of_life' }).castText;
        expect(text).toContain('custom (selected: slice_of_life');
        expect(text).toContain('not the profile of stored events');
    });
});