import { localForageStorageForScope } from "@/lib/localforage-storage";

import { buildRemotePublishPreview, type RemotePublishPlanInput, type RemotePublishPreview } from "./publish-plan";
import type { RemoteSyncPolicy, RemoteSyncPolicyInput } from "./authority";

export type RemoteSyncLocalReceipt = {
    kind: "FILM_REMOTE_LOCAL_CONFIRMATION_RECEIPT";
    receipt_id: string;
    confirmation_id: string;
    confirmed_by_user_id: string;
    confirmed_at: string;
    expected_manifest_version: 1;
    expected_manifest_hash: string;
    execution_state: "NOT_EXECUTED";
    network_executed: false;
    uploaded_asset_ids: [];
    publication_receipts: [];
    inbound_result_policy: "CANDIDATE_ONLY";
};

export type RemoteSyncLocalSession = {
    schema_version: "0.1.0";
    kind: "FILM_REMOTE_LOCAL_SYNC_SESSION";
    session_id: string;
    user_scope: string;
    host_project_id: string;
    state: "LOCALLY_CONFIRMED_NOT_EXECUTED";
    manifest_version: 1;
    manifest_hash: string;
    authority_mode: RemoteSyncPolicy["authority_mode"];
    plan: RemotePublishPlanInput;
    policy: RemoteSyncPolicy;
    preview: RemotePublishPreview;
    receipt: RemoteSyncLocalReceipt;
    created_at: string;
    updated_at: string;
};

export interface RemoteSyncSessionStore {
    read(projectId: string): Promise<RemoteSyncLocalSession[]>;
    write(projectId: string, sessions: RemoteSyncLocalSession[]): Promise<void>;
}

export type ConfirmRemoteSyncLocallyInput = {
    userScope: string;
    hostProjectId: string;
    plan: RemotePublishPlanInput;
    policy: RemoteSyncPolicyInput;
    humanConfirmed: boolean;
    confirmationId: string;
    expectedManifestVersion: number;
    expectedManifestHash: string;
};

type LocalSessionDependencies = {
    store: RemoteSyncSessionStore;
    now?: () => string;
    createId?: () => string;
};

export type RecoveredRemoteSyncSession =
    { state: "NONE" } | { state: "RECOVERED"; session: RemoteSyncLocalSession; preview: RemotePublishPreview } | { state: "STALE_MANIFEST"; session: RemoteSyncLocalSession; preview: RemotePublishPreview | null; reason: string };

const MAX_LOCAL_SESSIONS_PER_PROJECT = 20;
const storageName = "film-remote-sync-sessions";

export async function confirmRemoteSyncPreviewLocally(input: ConfirmRemoteSyncLocallyInput, dependencies: LocalSessionDependencies): Promise<RemoteSyncLocalSession> {
    requireNonEmpty(input.userScope, "userScope");
    requireNonEmpty(input.hostProjectId, "hostProjectId");
    if (!input.humanConfirmed) throw new Error("保存 Remote/Hybrid 本地同步会话需要 Human 显式确认");
    if (!isSafeConfirmationId(input.confirmationId)) throw new Error("confirmationId 必须是 8-128 位安全字符");
    if (input.expectedManifestVersion !== 1) throw new Error("expectedManifestVersion 与当前本地 manifest 版本不一致");
    if (!/^[0-9a-f]{64}$/.test(input.expectedManifestHash)) throw new Error("expectedManifestHash 必须为小写 SHA-256");

    const preview = await buildRemotePublishPreview(input.plan, input.policy);
    if (!preview.policy.enabled) throw new Error("film.remote_sync 未显式开启，不得保存可执行意图");
    if (preview.host_project_id !== input.hostProjectId) throw new Error("manifest 不属于当前 Host 项目");
    if (preview.manifest_version !== input.expectedManifestVersion) throw new Error("manifest version 已漂移，请重新预演");
    if (preview.manifest_hash !== input.expectedManifestHash) throw new Error("manifest hash 已漂移，请重新预演");
    if (preview.blockers.length || !preview.publishable_after_explicit_execution) throw new Error("Preview 存在 blocker，不得记录同步确认");
    assertOfflineCandidateBoundary(preview);

    const current = await dependencies.store.read(input.hostProjectId);
    const repeated = current.find((session) => session.receipt.confirmation_id === input.confirmationId);
    if (repeated) {
        if (repeated.user_scope !== input.userScope || repeated.manifest_version !== input.expectedManifestVersion || repeated.manifest_hash !== input.expectedManifestHash) {
            throw new Error("confirmationId 已绑定其他 manifest，已拒绝覆盖");
        }
        return structuredClone(repeated);
    }

    const now = dependencies.now?.() ?? new Date().toISOString();
    const receiptId = dependencies.createId?.() ?? crypto.randomUUID();
    const receipt: RemoteSyncLocalReceipt = {
        kind: "FILM_REMOTE_LOCAL_CONFIRMATION_RECEIPT",
        receipt_id: receiptId,
        confirmation_id: input.confirmationId,
        confirmed_by_user_id: input.userScope,
        confirmed_at: now,
        expected_manifest_version: 1,
        expected_manifest_hash: input.expectedManifestHash,
        execution_state: "NOT_EXECUTED",
        network_executed: false,
        uploaded_asset_ids: [],
        publication_receipts: [],
        inbound_result_policy: "CANDIDATE_ONLY",
    };
    const session: RemoteSyncLocalSession = {
        schema_version: "0.1.0",
        kind: "FILM_REMOTE_LOCAL_SYNC_SESSION",
        session_id: receiptId,
        user_scope: input.userScope,
        host_project_id: input.hostProjectId,
        state: "LOCALLY_CONFIRMED_NOT_EXECUTED",
        manifest_version: preview.manifest_version,
        manifest_hash: preview.manifest_hash,
        authority_mode: preview.policy.authority_mode,
        plan: structuredClone(input.plan),
        policy: structuredClone(preview.policy),
        preview: structuredClone(preview),
        receipt,
        created_at: now,
        updated_at: now,
    };
    const next = [...current.filter((item) => item.session_id !== session.session_id), session]
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.session_id.localeCompare(left.session_id))
        .slice(0, MAX_LOCAL_SESSIONS_PER_PROJECT);
    await dependencies.store.write(input.hostProjectId, next);
    const persisted = (await dependencies.store.read(input.hostProjectId)).find((item) => item.session_id === session.session_id);
    if (!persisted || persisted.manifest_hash !== session.manifest_hash || persisted.receipt.receipt_id !== receiptId) {
        throw new Error("本地同步会话未能持久化，不得返回成功回执");
    }
    return structuredClone(persisted);
}

export async function recoverLatestRemoteSyncSession(userScope: string, projectId: string, store: RemoteSyncSessionStore): Promise<RecoveredRemoteSyncSession> {
    const session = (await store.read(projectId))
        .filter((item) => item.user_scope === userScope && item.host_project_id === projectId)
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.session_id.localeCompare(left.session_id))[0];
    if (!session) return { state: "NONE" };
    try {
        const preview = await buildRemotePublishPreview(session.plan, session.policy);
        assertOfflineCandidateBoundary(preview);
        if (preview.manifest_version !== session.manifest_version || preview.manifest_hash !== session.manifest_hash) {
            return { state: "STALE_MANIFEST", session, preview, reason: "恢复时重算的 manifest version/hash 已漂移" };
        }
        return { state: "RECOVERED", session, preview };
    } catch (error) {
        return { state: "STALE_MANIFEST", session, preview: null, reason: error instanceof Error ? error.message : "本地 manifest 无法重算" };
    }
}

export function createBrowserRemoteSyncSessionStore(userScope: string): RemoteSyncSessionStore {
    const storage = localForageStorageForScope(userScope);
    const keyFor = (projectId: string) => `${storageName}:${projectId}`;
    return {
        async read(projectId) {
            const raw = await storage.getItem(keyFor(projectId));
            if (!raw) return [];
            const value = JSON.parse(raw) as unknown;
            if (!Array.isArray(value) || !value.every(isLocalSession)) throw new Error("本地 Remote/Hybrid 同步会话已损坏");
            return structuredClone(value);
        },
        async write(projectId, sessions) {
            await storage.setItem(keyFor(projectId), JSON.stringify(sessions));
        },
    };
}

export function createMemoryRemoteSyncSessionStore(initial: RemoteSyncLocalSession[] = []): RemoteSyncSessionStore & { writeCount: number } {
    const projects = new Map<string, RemoteSyncLocalSession[]>();
    for (const session of initial) projects.set(session.host_project_id, [...(projects.get(session.host_project_id) ?? []), structuredClone(session)]);
    return {
        writeCount: 0,
        async read(projectId) {
            return structuredClone(projects.get(projectId) ?? []);
        },
        async write(projectId, sessions) {
            this.writeCount += 1;
            projects.set(projectId, structuredClone(sessions));
        },
    };
}

function assertOfflineCandidateBoundary(preview: RemotePublishPreview) {
    if (preview.execution_state !== "PREVIEW_ONLY" || preview.network.executed || preview.network.actions.length || preview.network.uploaded_asset_ids.length || preview.network.publication_receipts.length) {
        throw new Error("Remote/Hybrid 本地会话不得包含网络执行或上传回执");
    }
    if (preview.inbound_results.some((result) => result.import_state !== "CANDIDATE_ONLY" || result.local_approval !== "REQUIRED" || result.can_auto_promote)) {
        throw new Error("远端结果必须保持 Candidate-only 且等待本地批准");
    }
}

function isLocalSession(value: unknown): value is RemoteSyncLocalSession {
    if (!value || typeof value !== "object") return false;
    const session = value as Partial<RemoteSyncLocalSession>;
    return (
        session.kind === "FILM_REMOTE_LOCAL_SYNC_SESSION" &&
        session.schema_version === "0.1.0" &&
        session.manifest_version === 1 &&
        typeof session.session_id === "string" &&
        typeof session.user_scope === "string" &&
        typeof session.host_project_id === "string" &&
        /^[0-9a-f]{64}$/.test(session.manifest_hash ?? "") &&
        session.state === "LOCALLY_CONFIRMED_NOT_EXECUTED" &&
        Boolean(session.plan) &&
        Boolean(session.policy) &&
        Boolean(session.preview) &&
        isLocalReceipt(session.receipt)
    );
}

function isLocalReceipt(value: unknown): value is RemoteSyncLocalReceipt {
    if (!value || typeof value !== "object") return false;
    const receipt = value as Partial<RemoteSyncLocalReceipt>;
    return (
        receipt.kind === "FILM_REMOTE_LOCAL_CONFIRMATION_RECEIPT" &&
        typeof receipt.receipt_id === "string" &&
        typeof receipt.confirmation_id === "string" &&
        typeof receipt.confirmed_by_user_id === "string" &&
        typeof receipt.confirmed_at === "string" &&
        receipt.expected_manifest_version === 1 &&
        /^[0-9a-f]{64}$/.test(receipt.expected_manifest_hash ?? "") &&
        receipt.execution_state === "NOT_EXECUTED" &&
        receipt.network_executed === false &&
        Array.isArray(receipt.uploaded_asset_ids) &&
        receipt.uploaded_asset_ids.length === 0 &&
        Array.isArray(receipt.publication_receipts) &&
        receipt.publication_receipts.length === 0 &&
        receipt.inbound_result_policy === "CANDIDATE_ONLY"
    );
}

function isSafeConfirmationId(value: string) {
    return typeof value === "string" && /^[A-Za-z0-9._-]{8,128}$/.test(value);
}

function requireNonEmpty(value: string, path: string) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${path} 不能为空`);
}
