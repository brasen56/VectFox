/** Roster clean-up suggestions: spellings that are probably one person, and generic role
 * names worth ignoring. Deterministic and host-independent; no model calls and no settings
 * writes. Automatic name normalisation alone must never merge people (Phase 4 scope §4), so
 * these are only suggestions that the window applies through its merge/ignore paths after
 * the user confirms.
 */

export const HONORIFICS = /^(?:(?:mr|mrs|ms|miss|dr|prof|sir|lady|lord|captain|capt|officer|judge|doctor|professor)\.?\s+)+/i;
// Japanese suffixes only when hyphenated, so a surname such as "Chan" in "Jackie Chan" survives.
const SUFFIX_HONORIFICS = /(?:-(?:san|kun|chan|sama|sensei|senpai|dono))+$/i;

const ARTICLES = new Set(['the', 'a', 'an', 'some', 'another', 'this', 'that', 'these', 'those',
    'his', 'her', 'their', 'my', 'your', 'our', 'its']);
const ROLE_WORDS = new Set([
    'man', 'men', 'woman', 'women', 'boy', 'girl', 'child', 'children', 'kid', 'baby', 'guy', 'lady', 'gentleman',
    'teen', 'teenager', 'stranger', 'someone', 'somebody', 'everyone', 'everybody', 'people', 'person', 'figure',
    'voice', 'crowd', 'group', 'family', 'couple', 'villager', 'townsfolk', 'townspeople', 'local',
    'nurse', 'doctor', 'surgeon', 'paramedic', 'medic', 'therapist', 'pharmacist', 'dentist', 'vet',
    'receptionist', 'secretary', 'assistant', 'intern', 'clerk', 'cashier', 'barista', 'bartender', 'waiter',
    'waitress', 'server', 'host', 'hostess', 'chef', 'cook', 'baker', 'maid', 'butler', 'servant', 'housekeeper',
    'janitor', 'cleaner', 'nanny', 'babysitter', 'driver', 'cabbie', 'chauffeur', 'pilot', 'captain', 'sailor',
    'courier', 'mailman', 'postman', 'messenger', 'deliveryman', 'mechanic', 'plumber', 'electrician',
    'technician', 'worker', 'employee', 'staff', 'manager', 'boss', 'supervisor', 'owner', 'shopkeeper',
    'vendor', 'merchant', 'salesman', 'saleswoman', 'attendant', 'usher', 'bouncer', 'guard', 'bodyguard',
    'officer', 'cop', 'policeman', 'policewoman', 'detective', 'deputy', 'sheriff', 'agent', 'soldier',
    'sergeant', 'priest', 'nun', 'monk', 'teacher', 'professor', 'tutor', 'coach', 'principal', 'student',
    'classmate', 'librarian', 'lawyer', 'attorney', 'judge', 'witness', 'reporter', 'journalist',
    'photographer', 'announcer', 'narrator', 'caller', 'operator', 'dispatcher', 'customer', 'client',
    'patient', 'passenger', 'guest', 'visitor', 'tourist', 'neighbor', 'neighbour', 'roommate', 'landlord',
    'landlady', 'tenant', 'coworker', 'colleague', 'fan', 'audience', 'crew', 'team', 'gang', 'thug', 'thief',
    'robber', 'mugger', 'suspect', 'prisoner', 'inmate',
]);
// Words that may precede a role word without making it a proper name ("Head Nurse", "Delivery Driver").
const MODIFIERS = new Set(['old', 'older', 'young', 'younger', 'elderly', 'head', 'chief', 'senior', 'junior',
    'new', 'other', 'night', 'day', 'shift', 'male', 'female', 'unnamed', 'unknown', 'mysterious', 'masked',
    'hooded', 'tall', 'little', 'big', 'first', 'second', 'third', 'random', 'drunk', 'front', 'desk', 'store',
    'shop', 'coffee', 'delivery', 'pizza', 'taxi', 'cab', 'bus', 'train', 'hotel', 'hospital', 'school', 'office',
    'security', 'police', 'flight', 'bank', 'bar', 'restaurant', 'diner', 'cafe', 'kitchen', 'lab', 'er']);

const known = (set, word) => set.has(word) || (word.endsWith('s') && set.has(word.slice(0, -1)))
    || (word.endsWith('es') && set.has(word.slice(0, -2)));
const describing = word => ARTICLES.has(word) || known(ROLE_WORDS, word) || MODIFIERS.has(word);

/** Folds case, Latin accents, titles, hyphenated Japanese honorifics and punctuation. */
export function foldCharacterName(name) {
    return String(name || '').normalize('NFKD').replace(/(?<=\p{Script=Latin})\p{M}+/gu, '').normalize('NFC')
        .trim().replace(HONORIFICS, '').replace(SUFFIX_HONORIFICS, '')
        .toLowerCase().replace(/['’`.]/g, '').replace(/[\s_-]+/g, ' ').trim();
}

/** Optimal string alignment distance (a transposition counts once); stops past `max`. */
export function editDistance(a, b, max = Infinity) {
    const s = [...a], t = [...b];
    if (Math.abs(s.length - t.length) > max) return max + 1;
    let before = null;
    let previous = Array.from({ length: t.length + 1 }, (_, j) => j);
    for (let i = 1; i <= s.length; i++) {
        const row = [i];
        for (let j = 1; j <= t.length; j++) {
            let d = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
            if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) d = Math.min(d, before[j - 2] + 1);
            row.push(d);
        }
        if (Math.min(...row) > max) return max + 1;
        before = previous;
        previous = row;
    }
    return Math.min(previous[t.length], max + 1);
}

// Short names differ by one letter all the time (Mark/Mary), so only longer ones count as typos.
const typoLimit = (a, b) => {
    const shorter = Math.min([...a].length, [...b].length), longer = Math.max([...a].length, [...b].length);
    return shorter >= 8 ? 2 : longer >= 5 ? 1 : 0;
};
const shareEvent = (a, b) => {
    if (!(a.eventIds instanceof Set) || !(b.eventIds instanceof Set)) return false;
    const [small, large] = a.eventIds.size <= b.eventIds.size ? [a.eventIds, b.eventIds] : [b.eventIds, a.eventIds];
    for (const id of small) if (large.has(id)) return true;
    return false;
};
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Groups of roster groups that are probably one person. `dismissed` holds spelling pairs
 * the user said are different people; a pair keeps the two groups containing those
 * spellings apart, including through a third group that resembles both.
 */
export function findDuplicateSuggestions(groups, { dismissed = [] } = {}) {
    const entries = groups.map((group, index) => ({ group, index,
        spellings: group.aliases.map(alias => {
            const folded = foldCharacterName(alias);
            return { alias, folded, tokens: folded.split(' ') };
        }).filter(spelling => spelling.folded) }));
    const owner = new Map(entries.flatMap(entry => entry.group.aliases.map(alias => [alias, entry.index])));
    const blocked = [];
    for (const [a, b] of dismissed) {
        const i = owner.get(a), j = owner.get(b);
        if (i !== undefined && j !== undefined && i !== j) blocked.push([i, j]);
    }
    const parent = entries.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const allowed = (ra, rb) => !blocked.some(([i, j]) => (find(i) === ra && find(j) === rb) || (find(i) === rb && find(j) === ra));
    const union = (i, j) => {
        const ra = find(i), rb = find(j);
        if (ra === rb) return true;
        if (!allowed(ra, rb)) return false;
        parent[Math.max(ra, rb)] = Math.min(ra, rb);
        return true;
    };

    // Strongest link per pair of groups: same folded spelling (rank 0), then the smallest typo.
    const links = new Map();
    const addLink = (i, j, link) => {
        const key = i < j ? `${i}|${j}` : `${j}|${i}`;
        const rank = link.distance || 0;
        if (!links.has(key) || links.get(key).rank > rank) links.set(key, { ...link, i, j, rank });
    };
    const byFolded = new Map(), byInitial = new Map(), byToken = new Map();
    for (const entry of entries) for (const spelling of entry.spellings) {
        const item = { entry, spelling };
        for (const [map, key] of [[byFolded, spelling.folded], [byInitial, [...spelling.folded][0]]]) {
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(item);
        }
        if (spelling.tokens.length > 1) for (const token of new Set(spelling.tokens)) {
            if (!byToken.has(token)) byToken.set(token, []);
            byToken.get(token).push(item);
        }
    }
    for (const items of byFolded.values()) for (let x = 0; x < items.length; x++) for (let y = x + 1; y < items.length; y++) {
        if (items[x].entry !== items[y].entry) addLink(items[x].entry.index, items[y].entry.index,
            { kind: 'variant', a: items[x].spelling.alias, b: items[y].spelling.alias });
    }
    for (const items of byInitial.values()) for (let x = 0; x < items.length; x++) for (let y = x + 1; y < items.length; y++) {
        const [p, q] = [items[x], items[y]];
        if (p.entry === q.entry || p.spelling.folded === q.spelling.folded) continue;
        const limit = typoLimit(p.spelling.folded, q.spelling.folded);
        if (!limit || /\d/.test(p.spelling.folded + q.spelling.folded)) continue; // "Guard 1" vs "Guard 2"
        const distance = editDistance(p.spelling.folded, q.spelling.folded, limit);
        // Two spellings named in the same event are usually two people (Carl and Carol).
        if (distance > limit || shareEvent(p.entry.group, q.entry.group)) continue;
        addLink(p.entry.index, q.entry.index, { kind: 'typo', a: p.spelling.alias, b: q.spelling.alias, distance });
    }
    const ordered = [...links.values()].sort((x, y) => x.rank - y.rank || x.i - y.i || x.j - y.j);
    const accepted = ordered.filter(link => union(link.i, link.j));

    // A shorter name joins the one full name it is part of; if it fits several people, each
    // option is offered separately. A spelling already grouped with a full name is settled.
    const shortLinks = [];
    const options = [];
    for (const entry of entries) {
        const matches = new Map();
        for (const spelling of entry.spellings) {
            if (spelling.tokens.some(token => [...token].length < 2)) continue;
            const contains = other => other.tokens.length > spelling.tokens.length && spelling.tokens.every(token => other.tokens.includes(token));
            if (entry.spellings.some(contains)) continue;
            const candidates = spelling.tokens.map(token => byToken.get(token) || []).sort((x, y) => x.length - y.length)[0];
            for (const item of candidates) {
                const j = item.entry.index;
                if (item.entry === entry || matches.has(j) || !contains(item.spelling)) continue;
                if (blocked.some(pair => pair.includes(entry.index) && pair.includes(j))) continue;
                // Root as clustered by spelling alone, before any short name joins a cluster.
                matches.set(j, { kind: 'short', a: spelling.alias, b: item.spelling.alias, i: entry.index, j, root: find(j) });
            }
        }
        const found = [...matches.values()].filter(link => link.root !== find(entry.index));
        const roots = [...new Set(found.map(link => link.root))];
        if (roots.length === 1) shortLinks.push(...found);
        else if (roots.length > 1) options.push({ entry, found, roots });
    }
    for (const link of shortLinks) if (union(link.i, link.j)) accepted.push(link);

    const KINDS = ['variant', 'typo', 'short'];
    const suggestion = (members, memberLinks, extra = {}) => {
        const sorted = members.map(index => entries[index].group)
            .sort((a, b) => b.eventCount - a.eventCount || compare(a.name, b.name));
        const position = new Map(sorted.map((group, i) => [group, i]));
        // Same output for any input order: the busier group's spelling first (short names stay first).
        const shown = memberLinks.map(({ kind, a, b, i, j, distance }) => {
            const swap = kind !== 'short' && position.get(entries[i].group) > position.get(entries[j].group);
            return { kind, a: swap ? b : a, b: swap ? a : b, ...(kind === 'typo' && { distance }) };
        }).sort((x, y) => KINDS.indexOf(x.kind) - KINDS.indexOf(y.kind) || (x.distance || 0) - (y.distance || 0)
            || compare(x.a, y.a) || compare(x.b, y.b));
        return { key: JSON.stringify(sorted.flatMap(group => [...group.aliases].sort())), groups: sorted, links: shown,
            ambiguous: false, ...extra };
    };
    const clusters = new Map();
    for (const entry of entries) {
        const root = find(entry.index);
        if (!clusters.has(root)) clusters.set(root, []);
        clusters.get(root).push(entry.index);
    }
    const out = [];
    for (const [root, members] of clusters) {
        if (members.length < 2) continue;
        out.push(suggestion(members, accepted.filter(link => find(link.i) === root)));
    }
    for (const { entry, found, roots } of options) for (const root of roots) {
        const chosen = found.filter(link => link.root === root);
        if (chosen.some(link => find(link.j) === find(entry.index))) continue; // Joined another way.
        const others = found.filter(link => link.root !== root).map(link => entries[link.j].group.name);
        out.push(suggestion([entry.index, ...chosen.map(link => link.j)], chosen,
            { ambiguous: true, alsoMatches: [...new Set(others)].sort(compare) }));
    }
    const top = s => s.groups[0].eventCount;
    const total = s => s.groups.reduce((sum, group) => sum + group.eventCount, 0);
    return out.sort((a, b) => top(b) - top(a) || a.ambiguous - b.ambiguous || total(b) - total(a) || compare(a.key, b.key));
}

/** Why a spelling looks like an unnamed role rather than a name, or null. */
export function roleNameReason(name) {
    const raw = String(name || '').normalize('NFKC').trim();
    const words = raw.split(/[\s/_-]+/).map(word => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
    if (!words.length) return raw ? 'lowercase' : null;
    const lower = words.map(word => word.toLowerCase());
    const head = lower.filter(word => !/^\d+$/.test(word)).at(-1); // "Guard 2"
    // A capitalised word that is not a role or modifier is probably part of a name ("Nurse Joy").
    const plain = (word, i) => word === lower[i] || describing(lower[i]) || /^\d+$/.test(word);
    if (head && known(ROLE_WORDS, head) && words.every(plain)) return 'role';
    if (ARTICLES.has(lower[0]) && words.length > 1 && words.every(plain)) return 'article';
    if (/\p{Ll}/u.test(raw) && !/\p{Lu}/u.test(raw)) return 'lowercase';
    return null;
}

const REASONS = ['role', 'article', 'lowercase'];
/** Groups whose every spelling looks like a role; `kept` spellings were reviewed and kept. */
export function findRoleCandidates(groups, { kept = [] } = {}) {
    const keep = new Set(kept);
    const out = [];
    for (const group of groups) {
        if (!group.aliases.length || group.aliases.some(alias => keep.has(alias))) continue;
        const reasons = group.aliases.map(roleNameReason);
        if (reasons.every(Boolean)) out.push({ group, reason: REASONS.find(reason => reasons.includes(reason)) });
    }
    return out;
}

/** Sanitised per-collection dismissals: spelling pairs that are different people, and kept role names. */
export function readCleanupDismissals(raw) {
    const pairs = new Map();
    for (const pair of Array.isArray(raw?.pairs) ? raw.pairs : []) {
        if (!Array.isArray(pair) || pair.length !== 2 || pair.some(s => typeof s !== 'string' || !s.trim())) continue;
        const sorted = [...pair].sort(compare);
        if (sorted[0] !== sorted[1]) pairs.set(JSON.stringify(sorted), sorted);
    }
    const roles = Array.isArray(raw?.roles) ? [...new Set(raw.roles.filter(tag => typeof tag === 'string' && tag.trim()))] : [];
    return { pairs: [...pairs.values()], roles };
}

/** Spelling pairs that keep each group apart from the others (or from each of `others`). */
export function separationPairs(groups, others = null) {
    const pairs = [];
    groups.forEach((group, i) => {
        for (const other of others || groups.slice(i + 1)) {
            if (group !== other && group.aliases[0] && other.aliases[0]) pairs.push([group.aliases[0], other.aliases[0]]);
        }
    });
    return pairs;
}

/** Everything the window shows: role candidates first, then duplicates among the other names. */
export function suggestRosterCleanup(groups, dismissals) {
    const { pairs, roles: kept } = readCleanupDismissals(dismissals);
    const roles = findRoleCandidates(groups, { kept });
    const roleGroups = new Set(roles.map(candidate => candidate.group));
    return { roles, duplicates: findDuplicateSuggestions(groups.filter(group => !roleGroups.has(group)), { dismissed: pairs }) };
}
