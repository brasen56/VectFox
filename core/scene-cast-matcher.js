/** Shared alias-aware scene text matching, including lead characters. */
export function matchesSceneCharacter(group, text) {
    const normalized = String(text || '').normalize('NFKC').toLocaleLowerCase();
    return [...new Set([group.name, ...(group.aliases || [])])].some(alias => {
        const name = String(alias || '').normalize('NFKC').trim().replace(/^(?:(?:mr|mrs|ms|miss|dr|prof|sir|lady|lord|captain|capt|officer|judge|doctor|professor)\.?\s+)+/i, '').replace(/\s+/g, ' ').toLocaleLowerCase();
        if (!name) return false;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        return (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(name)
            ? new RegExp(escaped, 'u') : new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u')).test(normalized);
    });
}