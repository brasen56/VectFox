/** Bounded settings shared by the client, UI and outer retrieval deadline. */
export const CROSS_ENCODER_DEFAULTS = {
    enabled: false,
    api_url: '',
    api_key: '',
    model: '',
    max_documents: 50,
    timeout_ms: 10000,
};

export function resolveCrossEncoderNumber(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
        ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

export function resolveCrossEncoderTimeoutMs(settings = {}) {
    return resolveCrossEncoderNumber(settings.eventbase_cross_encoder_timeout_ms, CROSS_ENCODER_DEFAULTS.timeout_ms, 1000, 60000);
}

export function resolveCrossEncoderMaxDocuments(settings = {}) {
    return resolveCrossEncoderNumber(settings.eventbase_cross_encoder_max_documents, CROSS_ENCODER_DEFAULTS.max_documents, 2, 200);
}