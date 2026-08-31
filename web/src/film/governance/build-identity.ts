export const RELEASE_CHANNELS = ["development", "candidate", "pilot", "stable"] as const;

export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export type BuildIdentity = {
    commit: string;
    tree: string;
    buildId: string;
    channel: ReleaseChannel;
    version: string;
    externalPaidSubmitEnabled: boolean;
};

const SHA256_PATTERN = /^[0-9a-f]{40,64}$/;

function releaseChannel(value: string | undefined): ReleaseChannel {
    return RELEASE_CHANNELS.includes(value as ReleaseChannel) ? value as ReleaseChannel : "development";
}

function sourceHash(value: string | undefined) {
    return value && SHA256_PATTERN.test(value) ? value : "unknown";
}

export function currentBuildIdentity(environment: ImportMetaEnv = import.meta.env): BuildIdentity {
    return {
        commit: sourceHash(environment.VITE_FILMOS_BUILD_COMMIT),
        tree: sourceHash(environment.VITE_FILMOS_BUILD_TREE),
        buildId: environment.VITE_FILMOS_BUILD_ID?.trim() || "web-development",
        channel: releaseChannel(environment.VITE_FILMOS_RELEASE_CHANNEL),
        version: __APP_VERSION__,
        externalPaidSubmitEnabled: environment.VITE_FILMOS_EXTERNAL_PAID_SUBMIT_ENABLED === "true",
    };
}

export function releaseChannelLabel(channel: ReleaseChannel) {
    return {
        development: "Development",
        candidate: "Candidate",
        pilot: "Pilot",
        stable: "Stable",
    }[channel];
}

export function shortSourceHash(value: string) {
    return SHA256_PATTERN.test(value) ? value.slice(0, 8) : value;
}
