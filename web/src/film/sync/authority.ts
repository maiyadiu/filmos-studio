export const authorityModes = ["LOCAL_AUTHORITY", "REMOTE_AUTHORITY", "HYBRID_LOCAL_AUTHORITY"] as const;

export type AuthorityMode = (typeof authorityModes)[number];

export type RemoteSyncPolicy = {
    enabled: boolean;
    authority_mode: AuthorityMode;
    allow_network: false;
    allow_implicit_local_asset_upload: false;
    conflict_policy: "BLOCK";
};

export type RemoteSyncPolicyInput = {
    enabled?: boolean;
    authority_mode?: string;
    allow_network?: boolean;
    allow_implicit_local_asset_upload?: boolean;
    conflict_policy?: string;
};

export const DEFAULT_REMOTE_SYNC_POLICY: Readonly<RemoteSyncPolicy> = Object.freeze({
    enabled: false,
    authority_mode: "LOCAL_AUTHORITY",
    allow_network: false,
    allow_implicit_local_asset_upload: false,
    conflict_policy: "BLOCK",
});

export function createRemoteSyncPolicy(input: RemoteSyncPolicyInput = {}): RemoteSyncPolicy {
    if (input.allow_network === true) throw new Error("Remote Publish 首切片只允许 Preview，不得执行网络发布");
    if (input.allow_implicit_local_asset_upload === true) throw new Error("未发布的本地资产不得隐式上传");
    if (input.conflict_policy && input.conflict_policy !== "BLOCK") throw new Error("Remote 冲突策略必须为 BLOCK");
    const authorityMode = input.authority_mode ?? DEFAULT_REMOTE_SYNC_POLICY.authority_mode;
    if (!isAuthorityMode(authorityMode)) throw new Error("未知 Authority Mode");
    return {
        enabled: input.enabled === true,
        authority_mode: authorityMode,
        allow_network: false,
        allow_implicit_local_asset_upload: false,
        conflict_policy: "BLOCK",
    };
}

function isAuthorityMode(value: string): value is AuthorityMode {
    return authorityModes.some((mode) => mode === value);
}
