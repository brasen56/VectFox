import { describe, it, expect } from 'vitest';
import { validateKnowledge, validateEventKnowledge, assertKnowledgeChunks, publicEventKnowledge } from '../core/event-knowledge.js';
import { validateEvent, buildEmbedText, buildExtractionPrompt, EVENTBASE_SCHEMA_VERSION } from '../core/eventbase-schema.js';

const support = quote => [{ source_index: 0, quote }];
const acquisition = (claim, quote, fields = {}) => ({ character: 'Ranger', claim, basis: 'witnessed',
    epistemic_status: 'fact', uncertainty: '', evidence: support(quote), ...fields });
const knowledge = acquisitions => ({ v: 1, presence: [], acquisitions });

// These are expected model outputs, not a claim that deterministic validation
// can decide semantic entailment. Live extraction quality requires human review.
export const cases = [
    { id: 'sealed', narrative: "Ranger watched Alex deliver a sealed letter. Its hidden contents were the king's confession.",
        acquisitions: [acquisition('Alex delivered a sealed letter.', 'Ranger watched Alex deliver a sealed letter.')],
        excluded: "king's confession" },
    { id: 'mention-only', narrative: 'Alex mentioned Ranger, who was far away and never heard the conversation.', acquisitions: [] },
    { id: 'off-screen', narrative: 'Off-screen, Ranger read the report and learned that the bridge had collapsed.',
        acquisitions: [acquisition('The bridge had collapsed.', 'Ranger read the report and learned that the bridge had collapsed.', { basis: 'document' })] },
    { id: 'off-screen-unknown', narrative: 'The bridge collapsed out of sight. Ranger was elsewhere.', acquisitions: [] },
    { id: 'lie', narrative: 'Alex lied to Ranger: "The vault is empty." Ranger heard him but doubted the claim.',
        acquisitions: [acquisition('Alex said the vault is empty.', 'Alex lied to Ranger: "The vault is empty."',
            { basis: 'told', epistemic_status: 'belief', uncertainty: 'Alex lied; Ranger doubted the claim.' })] },
    { id: 'rumor', narrative: 'Ranger heard a rumor that the queen had fled; nobody could confirm it.',
        acquisitions: [acquisition('The queen had fled.', 'Ranger heard a rumor that the queen had fled;',
            { basis: 'rumor', epistemic_status: 'rumor', uncertainty: 'Unconfirmed.' })] },
    { id: 'partial', narrative: 'Alex told Ranger that a shipment would arrive, but concealed its cargo and destination.',
        acquisitions: [acquisition('A shipment would arrive.', 'Alex told Ranger that a shipment would arrive,', { basis: 'told' })], excluded: 'destination' },
    { id: 'institution-only', narrative: 'Ranger belonged to the guard. A secret report was locked away unread.', acquisitions: [] },
];

describe('fact-specific knowledge contract', () => {
    it('retains valid entries independently during extraction and folds curly quotes', () => {
        const valid = acquisition('Delivery.', 'Ranger said "it’s delivered".');
        const raw = knowledge([valid, acquisition('Invented.', 'Never happened.')]);
        const result = validateKnowledge(raw, { sourceCount: 1, discardInvalid: true,
            narratives: ['Ranger said “it\'s delivered”.'] });
        expect(result.knowledge.acquisitions).toEqual([valid]);
        expect(result.errors).toHaveLength(1);
        // Import validation remains strict, rather than silently accepting corrupt records.
        expect(validateKnowledge(raw, { sourceCount: 1, narratives: ['Ranger said “it\'s delivered”.'] }).ok).toBe(false);
    });

    it.each(cases)('preserves the expected attribution for $id', fixture => {
        const raw = knowledge(fixture.acquisitions);
        const result = validateKnowledge(raw, { sourceCount: 1, narratives: [fixture.narrative] });
        expect(result).toEqual({ ok: true, errors: [], knowledge: raw });
        if (fixture.excluded) expect(result.knowledge.acquisitions.map(item => item.claim).join(' ')).not.toContain(fixture.excluded);
        const persisted = JSON.parse(JSON.stringify({ knowledge: raw, source_messages: [{ expanded_index: 30 }] }));
        expect(validateEventKnowledge(persisted).ok).toBe(true);
        assertKnowledgeChunks([{ metadata: persisted }]);
        expect(publicEventKnowledge(persisted, [{ ref: 'source-0' }]).knowledge.acquisitions)
            .toEqual(raw.acquisitions.map(entry => ({ ...entry, evidence: entry.evidence.map(item => ({ ...item, source_ref: 'source-0' })) })));
    });
    it('keeps legacy characters unknown and explicit empty attribution recorded', () => {
        expect(publicEventKnowledge({ characters: ['Ranger'] }, [])).toEqual({ knowledge_status: 'unknown', knowledge: null });
        expect(publicEventKnowledge({ knowledge: knowledge([]) }, []).knowledge_status).toBe('recorded');
        expect(validateEvent({ summary: 'Old history', characters: ['Ranger'] }).event.knowledge).toBeUndefined();
    });
    it.each([
        raw => { raw.v = 2; },
        raw => { raw.acquisitions[0].evidence = []; },
        raw => { raw.acquisitions[0].evidence[0].source_index = -1; },
        raw => { raw.acquisitions[0].evidence[0].source_index = 1; },
        raw => { raw.acquisitions[0].claim = ''; },
        raw => { raw.acquisitions[0].basis = 'assumed'; },
        raw => { raw.acquisitions[0].epistemic_status = 'certain'; },
        raw => { raw.acquisitions[0].basis = 'rumor'; },
        raw => { delete raw.acquisitions[0].uncertainty; },
        raw => { raw.presence = [{ character: 'Ranger', status: 'present', evidence: [] }]; },
    ])('rejects malformed, unsupported and out-of-window attribution (%#)', mutate => {
        const raw = knowledge([acquisition('Delivery.', 'Delivered.')]);
        mutate(raw);
        const event = { knowledge: raw, source_messages: [{}] };
        expect(validateEventKnowledge(event).ok).toBe(false);
        expect(() => assertKnowledgeChunks([{ metadata: event }])).toThrow('Invalid event knowledge');
        expect(publicEventKnowledge(event, []).knowledge_status).toBe('invalid');
    });
    it('drops non-matching quotes and handles whitespace without fabricating evidence', () => {
        const raw = knowledge([acquisition('Delivery.', 'Ranger  saw\n delivery.')]);
        expect(validateKnowledge(raw, { sourceCount: 1, narratives: ['Ranger saw delivery.'] }).ok).toBe(true);
        expect(validateKnowledge(raw, { sourceCount: 1, narratives: ['Nobody saw anything.'] }).knowledge).toBeNull();
    });
    it('validates presence separately without granting acquisitions', () => {
        const raw = { v: 1, presence: [{ character: 'Ranger', status: 'mentioned', evidence: support('Ranger was mentioned.') }], acquisitions: [] };
        const event = validateEvent({ summary: 'Mention.', knowledge: raw }).event;
        expect(event.knowledge).toEqual(raw);
        expect(buildEmbedText(event)).not.toContain('source_index');
        expect(EVENTBASE_SCHEMA_VERSION).toBe(1.4);
    });
    it.each(['intl', 'jieba', 'jieba_tw', 'tiny_segmenter', 'korean', 'others'])('adds the contract to both built-in %s profiles only', mode => {
        for (const profile of ['story', 'slice_of_life']) {
            expect(buildExtractionPrompt('text', 5, '', mode, '', '', profile)).toContain('FACT-SPECIFIC KNOWLEDGE');
        }
        expect(buildExtractionPrompt('text', 5, 'CUSTOM {{text}}', mode)).toBe('CUSTOM text');
    });
});