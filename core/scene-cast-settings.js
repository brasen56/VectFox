/** Shared settings, kept host-independent for the injection formatter. */
export const SCENE_CAST_DEFAULTS = Object.freeze({
    eventbase_cast_sticky_messages: 30,
    eventbase_cast_max_characters: 3,
    eventbase_cast_token_budget: 700,
});

export function resolveCastSetting(settings, key) {
    const value = settings?.[key];
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : SCENE_CAST_DEFAULTS[key];
}