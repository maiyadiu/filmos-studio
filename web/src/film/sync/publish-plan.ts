import { canonicalize } from "json-canonicalize";

import { createRemoteSyncPolicy, DEFAULT_REMOTE_SYNC_POLICY, type AuthorityMode, type RemoteSyncPolicy, type RemoteSyncPolicyInput } from "./authority";

export type FormalFilmReference = {
    film_entity_id: string;
    entity_type: string;
    version: number;
    content_hash: string;
    host_ref: {
        object_kind: string;
        opaque_id: string;
    };
};

export type PublishSelection = {
    local?: FormalFilmReference;
    remote?: FormalFilmReference;
};

export type PublishAssetSelection = PublishSelection & {
    availability: "LOCAL_ONLY" | "LOCAL_PROXY_READY" | "REMOTE_RESOURCE";
    proxy_ref?: FormalFilmReference;
};

export type RemoteResultSelection = {
    candidate_ref: FormalFilmReference;
    target_ref: FormalFilmReference;
};

export type RemotePublishPlanInput = {
    plan_id: string;
    host_project_id: string;
    generated_at: string;
    content_units: PublishSelection[];
    assets: PublishAssetSelection[];
    remote_results?: RemoteResultSelection[];
};

export type PublishConflictCode = "MISSING_LOCAL_FACT" | "MISSING_REMOTE_FACT" | "FILM_ID_MISMATCH" | "ENTITY_TYPE_MISMATCH" | "VERSION_DIVERGENCE" | "HASH_DIVERGENCE";

export type PublishConflict = {
    code: PublishConflictCode;
    path: string;
    message: string;
    human_decision_required: true;
};

export type PublishBlocker = {
    code: "FEATURE_DISABLED" | "LOCAL_ASSET_PROXY_REQUIRED" | PublishConflictCode;
    path: string;
    message: string;
};

type PlannedSelection = {
    path: string;
    authority_mode: AuthorityMode;
    local_ref: FormalFilmReference | null;
    remote_ref: FormalFilmReference | null;
    selected_ref: FormalFilmReference | null;
    state: "READY" | "BLOCKED";
    conflicts: PublishConflict[];
};

type PlannedAsset = PlannedSelection & {
    availability: PublishAssetSelection["availability"];
    publication_ref: FormalFilmReference | null;
    implicit_upload: false;
};

export type RemotePublishPreview = {
    schema_version: "0.1.0";
    kind: "FILM_REMOTE_PUBLISH_PREVIEW";
    execution_state: "PREVIEW_ONLY";
    plan_id: string;
    manifest_hash: string;
    generated_at: string;
    host_project_id: string;
    policy: RemoteSyncPolicy;
    selection: {
        content_units: PlannedSelection[];
        assets: PlannedAsset[];
    };
    proxy_jobs: Array<{
        source_ref: FormalFilmReference;
        operation: "GENERATE_LOCAL_REVIEW_PROXY";
        state: "NOT_GENERATED";
        upload_intent: "NONE";
    }>;
    inbound_results: Array<{
        candidate_ref: FormalFilmReference;
        target_ref: FormalFilmReference;
        import_state: "CANDIDATE_ONLY";
        local_approval: "REQUIRED";
        can_auto_promote: false;
    }>;
    conflicts: PublishConflict[];
    blockers: PublishBlocker[];
    publishable_after_explicit_execution: boolean;
    network: {
        executed: false;
        actions: [];
        uploaded_asset_ids: [];
        publication_receipts: [];
    };
};

export async function buildRemotePublishPreview(rawInput: RemotePublishPlanInput, rawPolicy: RemoteSyncPolicyInput = DEFAULT_REMOTE_SYNC_POLICY): Promise<RemotePublishPreview> {
    const input = validatePlanInput(rawInput);
    const policy = createRemoteSyncPolicy(rawPolicy);
    const contentUnits = input.content_units.map((selection, index) => planSelection(`content_units[${index}]`, selection, policy.authority_mode));
    const proxyJobs: RemotePublishPreview["proxy_jobs"] = [];
    const assetBlockers: PublishBlocker[] = [];
    const assets = input.assets.map((selection, index): PlannedAsset => {
        const path = `assets[${index}]`;
        const planned = planSelection(path, selection, policy.authority_mode);
        let publicationRef = planned.selected_ref;
        if (selection.availability === "LOCAL_ONLY") {
            if (!selection.local) throw new Error(`${path}.local 是 LOCAL_ONLY 资产的必填正式引用`);
            proxyJobs.push({
                source_ref: selection.local,
                operation: "GENERATE_LOCAL_REVIEW_PROXY",
                state: "NOT_GENERATED",
                upload_intent: "NONE",
            });
            assetBlockers.push({
                code: "LOCAL_ASSET_PROXY_REQUIRED",
                path,
                message: "本地资产未生成审片代理；Preview 不会上传原件或代理",
            });
            publicationRef = null;
        } else if (selection.availability === "LOCAL_PROXY_READY") {
            if (!selection.proxy_ref) throw new Error(`${path}.proxy_ref 是 LOCAL_PROXY_READY 资产的必填正式引用`);
            publicationRef = selection.proxy_ref;
        }
        return {
            ...planned,
            availability: selection.availability,
            publication_ref: planned.conflicts.length ? null : publicationRef,
            implicit_upload: false,
            state: planned.conflicts.length || !publicationRef ? "BLOCKED" : "READY",
        };
    });
    const conflicts = [...contentUnits, ...assets].flatMap((selection) => selection.conflicts);
    const blockers: PublishBlocker[] = [
        ...(!policy.enabled
            ? [
                  {
                      code: "FEATURE_DISABLED" as const,
                      path: "policy.enabled",
                      message: "film.remote_sync 默认关闭；本清单仅为本地 Preview",
                  },
              ]
            : []),
        ...conflicts.map(({ code, path, message }) => ({ code, path, message })),
        ...assetBlockers,
    ];
    const body = {
        schema_version: "0.1.0" as const,
        kind: "FILM_REMOTE_PUBLISH_PREVIEW" as const,
        execution_state: "PREVIEW_ONLY" as const,
        plan_id: input.plan_id,
        generated_at: input.generated_at,
        host_project_id: input.host_project_id,
        policy,
        selection: { content_units: contentUnits, assets },
        proxy_jobs: proxyJobs,
        inbound_results: (input.remote_results ?? []).map((result) => ({
            candidate_ref: result.candidate_ref,
            target_ref: result.target_ref,
            import_state: "CANDIDATE_ONLY" as const,
            local_approval: "REQUIRED" as const,
            can_auto_promote: false as const,
        })),
        conflicts,
        blockers,
        publishable_after_explicit_execution: policy.enabled && blockers.length === 0,
        network: {
            executed: false as const,
            actions: [] as [],
            uploaded_asset_ids: [] as [],
            publication_receipts: [] as [],
        },
    };
    return { ...body, manifest_hash: await sha256(body) };
}

function planSelection(path: string, selection: PublishSelection, mode: AuthorityMode): PlannedSelection {
    const local = selection.local ?? null;
    const remote = selection.remote ?? null;
    const conflicts: PublishConflict[] = [];
    if ((mode === "LOCAL_AUTHORITY" || mode === "HYBRID_LOCAL_AUTHORITY") && !local) {
        conflicts.push(conflict("MISSING_LOCAL_FACT", path, "当前权威模式要求本地正式事实"));
    }
    if (mode === "REMOTE_AUTHORITY" && !remote) {
        conflicts.push(conflict("MISSING_REMOTE_FACT", path, "REMOTE_AUTHORITY 要求远端正式事实"));
    }
    if (local && remote) {
        if (local.film_entity_id !== remote.film_entity_id) {
            conflicts.push(conflict("FILM_ID_MISMATCH", path, "本地与远端 Film UUID 不一致，禁止自动映射"));
        } else {
            if (local.entity_type !== remote.entity_type) {
                conflicts.push(conflict("ENTITY_TYPE_MISMATCH", path, "本地与远端 Film entity_type 不一致，必须人工决定"));
            }
            if (local.version !== remote.version) {
                conflicts.push(conflict("VERSION_DIVERGENCE", path, "本地与远端 version 不一致，必须人工决定"));
            }
            if (local.content_hash !== remote.content_hash) {
                conflicts.push(conflict("HASH_DIVERGENCE", path, "本地与远端 content_hash 不一致，必须人工决定"));
            }
        }
    }
    const selected = mode === "REMOTE_AUTHORITY" ? remote : local;
    return {
        path,
        authority_mode: mode,
        local_ref: local,
        remote_ref: remote,
        selected_ref: conflicts.length ? null : selected,
        state: conflicts.length || !selected ? "BLOCKED" : "READY",
        conflicts,
    };
}

function conflict(code: PublishConflictCode, path: string, message: string): PublishConflict {
    return { code, path, message, human_decision_required: true };
}

function validatePlanInput(input: RemotePublishPlanInput): RemotePublishPlanInput {
    if (!input || typeof input !== "object") throw new Error("Remote Publish Plan 输入无效");
    requireUuid4(input.plan_id, "plan_id");
    requireOpaqueId(input.host_project_id, "host_project_id");
    if (!isDateTime(input.generated_at)) throw new Error("generated_at 必须为 RFC3339 时间");
    if (!Array.isArray(input.content_units) || !Array.isArray(input.assets)) throw new Error("content_units/assets 必须为数组");
    input.content_units.forEach((selection, index) => validateSelection(selection, `content_units[${index}]`));
    input.assets.forEach((selection, index) => {
        validateSelection(selection, `assets[${index}]`);
        if (!["LOCAL_ONLY", "LOCAL_PROXY_READY", "REMOTE_RESOURCE"].includes(selection.availability)) {
            throw new Error(`assets[${index}].availability 无效`);
        }
        if (selection.proxy_ref) validateReference(selection.proxy_ref, `assets[${index}].proxy_ref`);
    });
    if (input.remote_results !== undefined && !Array.isArray(input.remote_results)) throw new Error("remote_results 必须为数组");
    input.remote_results?.forEach((result, index) => {
        validateReference(result.candidate_ref, `remote_results[${index}].candidate_ref`);
        validateReference(result.target_ref, `remote_results[${index}].target_ref`);
    });
    return structuredClone(input);
}

function validateSelection(selection: PublishSelection, path: string) {
    if (!selection || typeof selection !== "object") throw new Error(`${path} 无效`);
    if (!selection.local && !selection.remote) throw new Error(`${path} 至少需要 local 或 remote 正式引用`);
    if (selection.local) validateReference(selection.local, `${path}.local`);
    if (selection.remote) validateReference(selection.remote, `${path}.remote`);
}

function validateReference(reference: FormalFilmReference, path: string) {
    if (!reference || typeof reference !== "object") throw new Error(`${path} 无效`);
    requireUuid4(reference.film_entity_id, `${path}.film_entity_id`);
    if (typeof reference.entity_type !== "string" || !reference.entity_type.trim()) throw new Error(`${path}.entity_type 不能为空`);
    if (!Number.isInteger(reference.version) || reference.version < 1) throw new Error(`${path}.version 必须大于等于 1`);
    if (!/^[0-9a-f]{64}$/.test(reference.content_hash)) throw new Error(`${path}.content_hash 必须为小写 SHA-256`);
    if (!reference.host_ref || typeof reference.host_ref !== "object") throw new Error(`${path}.host_ref 无效`);
    requireOpaqueId(reference.host_ref.object_kind, `${path}.host_ref.object_kind`);
    requireOpaqueId(reference.host_ref.opaque_id, `${path}.host_ref.opaque_id`);
}

function requireUuid4(value: string, path: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
        throw new Error(`${path} 必须为小写 UUIDv4`);
    }
}

function requireOpaqueId(value: string, path: string) {
    if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error(`${path} 必须为非空 Host opaque ID`);
}

function isDateTime(value: string) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
}

async function sha256(value: unknown) {
    const bytes = new TextEncoder().encode(canonicalize(value));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
