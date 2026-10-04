/** Scene detection only: no database queries and no planner-filter changes. */
import { normalizeCharacterName } from './character-roster.js';
import { stripReasoningBlocks, stripGameSystemBlocks } from './text-cleaning.js';

import { resolveCastSetting } from './scene-cast-settings.js';
const plannerMemory = new Map();

/** Prefix validation invalidates planner observations after edits, swipes or shrink. */
export function detectSceneCast({ roster, chat = [], plannerCharacters = [], chatId = '', settings = {}, dryRun = false, testMessage = null }) {
    const messages = chat.filter(m => !m?.is_system);
    const fingerprints = messages.map(m => JSON.stringify([m.is_user, m.name, m.mes]));
    const texts = messages.map(m => stripGameSystemBlocks(stripReasoningBlocks(String(m.mes || ''))).normalize('NFKC').toLocaleLowerCase());
    if (testMessage != null) texts.push(stripGameSystemBlocks(stripReasoningBlocks(String(testMessage))).normalize('NFKC').toLocaleLowerCase());
    const lookback = resolveCastSetting(settings, 'eventbase_cast_sticky_messages');
    const start = Math.max(0, texts.length - lookback);
    const detected = new Map();
    const groups = roster.groups.filter(g => !g.isLead);
    const add = (group, index, signal) => {
        const entry = detected.get(group) || { group, lastMention: index, signals: [] };
        entry.lastMention = Math.max(entry.lastMention, index);
        if (!entry.signals.includes(signal)) entry.signals.push(signal);
        detected.set(group, entry);
    };
    for (const group of groups) {
        const patterns = [...new Set([group.name, ...group.aliases].map(normalizeCharacterName))].filter(Boolean).map(name => {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
            // Unicode boundaries avoid Ann matching Anna; CJK names match literally.
            return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(name)
                ? new RegExp(escaped, 'u') : new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u');
        });
        for (let i = start; i < texts.length; i++) {
            if (patterns.some(pattern => pattern.test(texts[i]))) add(group, i, 'text');
        }
    }
    let remembered = (plannerMemory.get(chatId) || []).filter(entry =>
        entry.index >= start && entry.index < fingerprints.length &&
        entry.prefix.every((fingerprint, i) => fingerprints[i] === fingerprint));
    const current = Array.isArray(plannerCharacters) ? plannerCharacters.filter(n => typeof n === 'string' && n.trim()) : [];
    const observations = [...remembered, { names: current, index: texts.length - 1 }];
    if (lookback > 0) for (const entry of observations) {
        if (entry.index < start) continue;
        const names = new Set(entry.names.map(normalizeCharacterName));
        for (const group of groups) {
            if ([group.name, ...group.aliases].some(n => names.has(normalizeCharacterName(n)))) add(group, entry.index, 'planner');
        }
    }
    if (!dryRun && chatId) {
        if (current.length) remembered = remembered.filter(entry => entry.index !== fingerprints.length - 1);
        if (current.length && fingerprints.length && lookback > 0) remembered.push({ names: current, index: fingerprints.length - 1, prefix: fingerprints });
        plannerMemory.delete(chatId);
        plannerMemory.set(chatId, remembered);
        // Bound session memory across chat switches.
        if (plannerMemory.size > 20) plannerMemory.delete(plannerMemory.keys().next().value);
    }
    return [...detected.values()].sort((a, b) => b.lastMention - a.lastMention || a.group.name.localeCompare(b.group.name))
        .slice(0, resolveCastSetting(settings, 'eventbase_cast_max_characters'));
}