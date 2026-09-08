const CHANNEL_MODEL_SEPARATOR = "::";
const DREAMINA_CHANNEL = "local:dreamina-cli";

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${channelId === DREAMINA_CHANNEL ? ":" : CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function decodeChannelModel(value: string) {
    const local = /^local:dreamina-cli:([A-Za-z0-9][A-Za-z0-9._:-]{0,119})$/.exec(value.trim());
    if (local) return { channelId: DREAMINA_CHANNEL, model: local[1] };
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function isChannelModelValue(value: string) {
    return decodeChannelModel(value) !== null;
}
