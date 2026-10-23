import { describe, it, expect, vi } from 'vitest';
import {
    foldCharacterName, editDistance, findDuplicateSuggestions, roleNameReason, findRoleCandidates,
    readCleanupDismissals, separationPairs, suggestRosterCleanup,
} from '../core/character-cleanup.js';

vi.mock('../core/log.js', () => ({ log: { warn: vi.fn() } }));
const { buildCharacterRoster } = await import('../core/character-roster.js');

const g = (name, eventCount, aliases = [name], eventIds) => ({ name, aliases, eventCount, ...(eventIds && { eventIds: new Set(eventIds) }) });
const names = suggestions => suggestions.map(s => s.groups.map(group => group.name));

describe('name folding and edit distance', () => {
    it('folds case, Latin accents, titles, hyphenated honorifics and punctuation only', () => {
        expect(['KAI', 'Dr. Kai', 'Hiro-kun', 'José', 'Zoë', "O'Brien", 'Mary-Jane'].map(foldCharacterName))
            .toEqual(['kai', 'kai', 'hiro', 'jose', 'zoe', 'obrien', 'mary jane']);
        expect(foldCharacterName('Jackie Chan')).toBe('jackie chan');
        expect(foldCharacterName('ガク')).not.toBe(foldCharacterName('カク')); // Kana marks are not accents.
    });

    it('counts a transposition once and stops past the limit', () => {
        expect(editDistance('brennan', 'brenan')).toBe(1);
        expect(editDistance('ezra', 'ezar')).toBe(1);
        expect(editDistance('kitten', 'sitting')).toBe(3);
        expect(editDistance('kitten', 'sitting', 1)).toBe(2);
        expect(editDistance('', 'abc')).toBe(3);
    });
});

describe('duplicate suggestions', () => {
    it('suggests case, accent and honorific variants and small typos with their counts', () => {
        const suggestions = findDuplicateSuggestions([g('Brennan', 300), g('Hiro', 40), g('Brenan', 3), g('Hiro-kun', 5), g('José', 3), g('Jose', 2)]);
        expect(names(suggestions)).toEqual([['Brennan', 'Brenan'], ['Hiro', 'Hiro-kun'], ['José', 'Jose']]);
        expect(suggestions[0].links).toEqual([{ kind: 'typo', a: 'Brennan', b: 'Brenan', distance: 1 }]);
        expect(suggestions[1].links).toEqual([{ kind: 'variant', a: 'Hiro', b: 'Hiro-kun' }]);
        expect(suggestions[0].groups.map(group => group.eventCount)).toEqual([300, 3]);
    });

    it('leaves short names, different initials, numbered roles and co-occurring spellings apart', () => {
        expect(findDuplicateSuggestions([g('Mark', 10), g('Mary', 9), g('Mara', 3), g('Sara', 3), g('Agent 47', 2), g('Agent 46', 2),
            g('Carl', 5, ['Carl'], ['e1', 'e2']), g('Carol', 4, ['Carol'], ['e2'])])).toEqual([]);
        // Without shared events, Carl and Carol are only a suggestion the user can dismiss.
        expect(names(findDuplicateSuggestions([g('Carl', 5, ['Carl'], ['e1']), g('Carol', 4, ['Carol'], ['e2'])]))).toEqual([['Carl', 'Carol']]);
    });

    it('allows two letters of difference only for long names', () => {
        expect(names(findDuplicateSuggestions([g('Alexandria', 9), g('Alexandira', 1), g('Aleksandria', 1)]))).toEqual([['Alexandria', 'Aleksandria', 'Alexandira']]);
        expect(findDuplicateSuggestions([g('Brennan', 9), g('Brenon', 1)])).toEqual([]);
    });

    it('joins a short name to its one full name and offers each option when it fits several', () => {
        const unique = findDuplicateSuggestions([g('Howard', 4), g('Howard Brennan', 20)]);
        expect(unique).toMatchObject([{ ambiguous: false, links: [{ kind: 'short', a: 'Howard', b: 'Howard Brennan' }] }]);
        expect(names(unique)).toEqual([['Howard Brennan', 'Howard']]);
        const shared = findDuplicateSuggestions([g('Brennan', 30), g('Howard Brennan', 20), g('Mary Brennan', 8)]);
        expect(names(shared)).toEqual([['Brennan', 'Howard Brennan'], ['Brennan', 'Mary Brennan']]);
        expect(shared.map(s => [s.ambiguous, s.alsoMatches])).toEqual([[true, ['Mary Brennan']], [true, ['Howard Brennan']]]);
        // Two spellings of one full name are one option, not an ambiguity.
        expect(names(findDuplicateSuggestions([g('Howard', 4), g('Howard Brennan', 20), g('Howard Brenan', 2)])))
            .toEqual([['Howard Brennan', 'Howard', 'Howard Brenan']]);
    });

    it('does not offer a short spelling again once it is grouped with a full name', () => {
        expect(findDuplicateSuggestions([g('Howard Brennan', 30, ['Brennan', 'Howard Brennan']), g('Mary Brennan', 8)])).toEqual([]);
    });

    it('keeps dismissed spellings apart, even through a third similar name', () => {
        const groups = [g('Brennan', 30), g('Brenan', 3), g('Brennen', 2)];
        expect(names(findDuplicateSuggestions(groups))).toEqual([['Brennan', 'Brenan', 'Brennen']]);
        expect(names(findDuplicateSuggestions(groups, { dismissed: [['Brennen', 'Brennan']] }))).toEqual([['Brennan', 'Brenan']]);
        expect(findDuplicateSuggestions(groups, { dismissed: separationPairs(groups) })).toEqual([]);
        // A dismissed ambiguous option leaves the other one as an ordinary suggestion.
        const shared = [g('Brennan', 30), g('Howard Brennan', 20), g('Mary Brennan', 8)];
        expect(findDuplicateSuggestions(shared, { dismissed: [['Brennan', 'Howard Brennan']] }))
            .toMatchObject([{ ambiguous: false, groups: [{ name: 'Brennan' }, { name: 'Mary Brennan' }] }]);
        // A pair applies to whichever groups now hold those spellings.
        expect(findDuplicateSuggestions([g('Brennan', 33, ['Brenan', 'Brennan']), g('Brennen', 2)], { dismissed: [['Brennan', 'Brennen']] })).toEqual([]);
    });

    it('is deterministic for any input order and finds split variants in a real roster', () => {
        const groups = [g('Brennan', 30), g('Hiro', 40), g('Brenan', 3), g('Hiro-kun', 5), g('Howard', 4), g('Howard Brennan', 20)];
        const forward = findDuplicateSuggestions(groups);
        expect(findDuplicateSuggestions([...groups].reverse())).toEqual(forward);
        const event = (id, characters) => ({ event_id: id, characters });
        const roster = buildCharacterRoster([event('1', ['Kai']), event('2', ['KAI']), event('3', ['Dr. Kai'])],
            ['Kai', 'KAI', 'Dr. Kai'].map(alias => ({ name: alias, aliases: [alias] })));
        expect(roster.groups).toHaveLength(3);
        expect(findDuplicateSuggestions(roster.groups)[0].groups.map(group => group.name).sort()).toEqual(['Dr. Kai', 'KAI', 'Kai']);
    });
});

describe('role name candidates', () => {
    it('flags job and role words, articles and lowercase tags but not named people', () => {
        const flagged = { nurse: 'role', 'Delivery Driver': 'role', Barista: 'role', 'the stranger': 'role', 'Head Nurse': 'role',
            'Guard 2': 'role', 'his boss': 'role', 'the old man': 'role', 'a tall figure': 'role', 'The Doctor': 'role',
            'physics-ugrad-advising': 'lowercase', 'nurse, the waitress': 'role', 'the someone else': 'article', kai: 'lowercase' };
        for (const [name, reason] of Object.entries(flagged)) expect([name, roleNameReason(name)]).toEqual([name, reason]);
        for (const name of ['Kai', 'Nurse Joy', 'Officer Daniels', 'The Smiths', 'Starbucks Barista', '田中', 'Mom']) {
            expect([name, roleNameReason(name)]).toEqual([name, null]);
        }
    });

    it('needs every spelling of a group to look like a role and skips kept names', () => {
        const groups = [g('Nurse', 12, ['Nurse', 'nurse']), g('Kai', 8, ['Kai', 'kai']), g('the barista', 2), g('Delivery Driver', 1)];
        expect(findRoleCandidates(groups).map(c => [c.group.name, c.reason])).toEqual([['Nurse', 'role'], ['the barista', 'role'], ['Delivery Driver', 'role']]);
        expect(findRoleCandidates(groups, { kept: ['nurse'] }).map(c => c.group.name)).toEqual(['the barista', 'Delivery Driver']);
    });

    it('keeps role candidates out of duplicate suggestions until they are kept', () => {
        const groups = [g('Nurse', 12), g('Nurse Joy', 5), g('Brennan', 30), g('Brenan', 2)];
        const fresh = suggestRosterCleanup(groups, undefined);
        expect(fresh.roles.map(c => c.group.name)).toEqual(['Nurse']);
        expect(names(fresh.duplicates)).toEqual([['Brennan', 'Brenan']]);
        const kept = suggestRosterCleanup(groups, { roles: ['Nurse'], pairs: [['Brenan', 'Brennan']] });
        expect(kept.roles).toEqual([]);
        expect(names(kept.duplicates)).toEqual([['Nurse', 'Nurse Joy']]);
    });
});

describe('dismissal records', () => {
    it('sanitises and deduplicates stored pairs and kept names', () => {
        expect(readCleanupDismissals({ pairs: [['b', 'a'], ['a', 'b'], ['a', 'a'], ['x'], [1, 'y'], 'bad'], roles: ['nurse', 'nurse', '', 3] }))
            .toEqual({ pairs: [['a', 'b']], roles: ['nurse'] });
        expect(readCleanupDismissals(null)).toEqual({ pairs: [], roles: [] });
    });

    it('builds pairs within a list or across two lists', () => {
        const [a, b, c] = [g('A', 1), g('B', 1), g('C', 1)];
        expect(separationPairs([a, b, c])).toEqual([['A', 'B'], ['A', 'C'], ['B', 'C']]);
        expect(separationPairs([a], [b, c])).toEqual([['A', 'B'], ['A', 'C']]);
    });
});
