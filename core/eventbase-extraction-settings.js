/** Unknown or legacy values retain the original story-change behavior. */
export function resolveExtractionProfile(settings = {}) {
    return settings.eventbase_extraction_profile === 'slice_of_life' ? 'slice_of_life' : 'story';
}

/** A nonblank user template always overrides the selected built-in profile. */
export function effectiveExtractionProfile(settings = {}) {
    return settings.eventbase_custom_prompt?.trim() ? 'custom' : resolveExtractionProfile(settings);
}