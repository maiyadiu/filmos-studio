import localforage from "localforage";

import { currentBuildIdentity, type BuildIdentity } from "@/film/governance/build-identity";
import { inferIssueRoutingRisk } from "@/film/governance/issue-lane";
import { useCanvasAgentStore } from "@/stores/canvas/use-canvas-agent-store";

export const ISSUE_DRAFT_FORMAT = "filmos.usage-issue-draft/v2";
export const ISSUE_DRAFT_STORE = "filmos-usage-issue-drafts";
export const ISSUE_MIGRATION_TOMBSTONE_STORE = "filmos-usage-issue-migration-tombstones";
export const STAGE_A_BOOTSTRAP_UUID = "b3274782-30a0-44a1-a05e-01730678da8b";

export type IssueSurface = "global" | "project" | "content-unit" | "canvas" | "agent" | "generation-composer" | "error";

export type IssueAttachment = {
    id: string;
    name: string;
    mediaType: string;
    size: number;
    content: Blob;
};

export const MAX_ISSUE_ATTACHMENTS = 5;
export const MAX_ISSUE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type ClipboardFileItem = {
    kind?: string;
    getAsFile?: () => File | null;
};

export function issueEvidenceFilesFromClipboard(clipboardData: {
    files?: ArrayLike<File>;
    items?: ArrayLike<ClipboardFileItem>;
}) {
    const candidates = [
        ...Array.from(clipboardData.items || []).flatMap((item) => item.kind === "file" ? [item.getAsFile?.()].filter((file): file is File => Boolean(file)) : []),
        ...Array.from(clipboardData.files || []),
    ];
    const seen = new Set<string>();
    return candidates.filter((file) => {
        const key = `${file.name}\u0000${file.type}\u0000${file.size}\u0000${file.lastModified}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function selectPastedIssueEvidence(files: File[], currentCount: number) {
    const media = files.filter((file) => file.type.startsWith("image/") || file.type.startsWith("video/"));
    const withinSize = media.filter((file) => file.size <= MAX_ISSUE_ATTACHMENT_BYTES);
    const accepted = withinSize.slice(0, Math.max(0, MAX_ISSUE_ATTACHMENTS - currentCount));
    return {
        accepted,
        oversizedCount: media.length - withinSize.length,
        truncatedCount: withinSize.length - accepted.length,
    };
}

export function pastedIssueUploadDescriptor(file: File, uid: string) {
    return {
        uid,
        name: file.name || `粘贴截图-${new Date().toISOString()}.png`,
        mediaType: file.type,
        size: file.size,
        file,
        status: "done" as const,
    };
}

export type IssueContext = {
    pathname: string;
    surface: IssueSurface;
    projectId?: string;
    contentUnitId?: string;
    canvasId?: string;
};

export type IssueContextSnapshot = {
    appCommit: string;
    appTree: string;
    buildId: string;
    projectId?: string;
    domainProjectId?: string;
    contentUnitId?: string;
    sceneId?: string;
    directorUnitId?: string;
    shotId?: string;
    canvasId?: string;
    canvasRevision?: number;
    canvasStateHash?: string;
    selectedNodeIds: string[];
    activeBrainProfileId?: string;
    brainSessionId?: string;
    contextReceiptId?: string;
    recentAuditIds: string[];
    recentErrorCodes: string[];
    runtimeStatus: Record<string, unknown>;
    providerStatus: Record<string, unknown>;
};

export type LocalIssueDraft = {
    format: typeof ISSUE_DRAFT_FORMAT;
    localDraftId: string;
    submissionId: string;
    legacyLocalId?: string;
    canonicalIssueId?: string;
    state: "OBSERVED_IN_USE";
    occurred: string;
    expected: string;
    blocking: boolean;
    context: IssueContext;
    contextSnapshot: IssueContextSnapshot;
    build: BuildIdentity;
    attachments: IssueAttachment[];
    observedAt: string;
    delivery: "LOCAL_PENDING_REVIEW_BUS" | "SUBMISSION_STAGED" | "ATTACHMENTS_STAGED" | "ACCEPTED_AWAITING_READBACK" | "CONFIRMED" | "STOPPED";
    captureHash?: string;
    receipt?: SubmissionReceipt;
    lastDeliveryAt?: string;
    retryCount: number;
    lastErrorCode?: string;
    stoppedReason?: string;
};

export type SubmissionReceipt = {
    schema_version: "filmos.review-submission.receipt.v1";
    submission_id: string;
    formal_issue_id: string;
    project_id: string;
    capture_hash: string;
    projection_content_hash: string;
    evidence_manifest_hash: string;
    receipt_hash: string;
    accepted_at: string;
};

type LegacyIssueDraft = Omit<LocalIssueDraft, "format" | "localDraftId" | "submissionId" | "retryCount" | "delivery"> & {
    format: "filmos.usage-issue-draft/v1";
    issueId: string;
    delivery: "LOCAL_PENDING_REVIEW_BUS" | "REVIEW_BUS_ACCEPTED";
};

type MigrationTombstone = {
    schema_version: "filmos.review-intake-migration-tombstone.v1";
    legacy_local_id: string;
    local_draft_id: string;
    submission_id: string;
    canonical_issue_id: string;
    project_id: string;
    capture_hash: string;
    receipt_hash: string;
    projection_content_hash: string;
    evidence_manifest_hash: string;
    confirmed_at: string;
};

export type IssueDraftInput = {
    occurred: string;
    expected: string;
    blocking: boolean;
    attachments?: IssueAttachment[];
};

export function issueDraftReplayMode(draft: LocalIssueDraft): "SUBMIT_OR_RESUME" | "READBACK_ONLY" | "NONE" {
    if (draft.delivery === "ACCEPTED_AWAITING_READBACK") return "READBACK_ONLY";
    if (draft.delivery === "CONFIRMED" || draft.delivery === "STOPPED") return "NONE";
    return "SUBMIT_OR_RESUME";
}

declare global {
    interface Window {
        filmOSIssueSurface?: IssueSurface;
        filmOSReportIssue?: (surface?: IssueSurface) => void;
        filmOSReviewIssueIntake?: (draft: LocalIssueDraft) => Promise<LocalIssueDraft>;
        filmOSReviewCenterRequest?: (operation: string, payload?: Record<string, string>) => Promise<unknown>;
        filmOSResolveReviewIssue?: (requestId: string, result: unknown, error: string | null) => void;
        webkit?: { messageHandlers?: { filmosDesktop?: { postMessage: (message: unknown) => void } } };
    }
}

const nativeResolvers = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout: number }>();

const issueDraftStore = localforage.createInstance({
    name: "FilmOS Studio",
    storeName: ISSUE_DRAFT_STORE,
    description: "Local-only usage observations waiting for the FilmOS Review Bus",
});

const migrationTombstoneStore = localforage.createInstance({
    name: "FilmOS Studio",
    storeName: ISSUE_MIGRATION_TOMBSTONE_STORE,
    description: "Auditable mapping from legacy local observations to canonical Review Bus issues",
});

function installNativeReviewIssueIntake() {
    const handler = window.webkit?.messageHandlers?.filmosDesktop;
    if (!handler) return;
    window.filmOSResolveReviewIssue = (requestId, result, error) => {
        const pending = nativeResolvers.get(requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeout);
        nativeResolvers.delete(requestId);
        if (error) pending.reject(new Error(error));
        else if (result && typeof result === "object") pending.resolve(result);
        else pending.reject(new Error("REVIEW_BUS_INVALID_RESPONSE"));
    };
    const nativeRequest = (action: "reviewIssueRequest" | "reviewIssueAttachmentRequest" | "reviewIssueFinalizeRequest", payload: Record<string, unknown>, submissionId?: string) => new Promise<unknown>((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timeout = window.setTimeout(() => {
            nativeResolvers.delete(requestId);
            reject(new Error("REVIEW_BUS_TIMEOUT"));
        }, action === "reviewIssueAttachmentRequest" ? 60_000 : 20_000);
        nativeResolvers.set(requestId, { resolve, reject, timeout });
        handler.postMessage({ action, requestId, ...(submissionId ? { submissionId } : {}), payload });
    });
    window.filmOSReviewIssueIntake = async (draft) => {
        const replayMode = issueDraftReplayMode(draft);
        if (replayMode === "READBACK_ONLY") return confirmAcceptedDraft(draft);
        if (replayMode === "NONE") return draft;
        const snapshot = draft.contextSnapshot ?? captureIssueContextSnapshot(draft.build);
        const projectId = boundProjectId(draft);
        const currentProjectId = currentDomainProjectId();
        if (!projectId) throw new Error("PROJECT_SCOPE_REQUIRED");
        if (currentProjectId && currentProjectId !== projectId) throw new Error("SUBMISSION_PROJECT_SCOPE_CONFLICT");
        const attachmentManifest = await Promise.all(draft.attachments.map(async (item) => ({
            attachment_id: attachmentId(item.id),
            media_type: item.mediaType,
            original_name: item.name,
            size_bytes: item.size,
            sha256: await blobSha256(item.content),
            captured_at: draft.observedAt,
        })));
        const risk = inferIssueRoutingRisk({
            occurred: draft.occurred,
            expected: draft.expected,
            blocking: draft.blocking,
            context: draft.context,
        });
        const payload: Record<string, unknown> = {
            submission_id: draft.submissionId,
            project_id: projectId,
            what_happened: draft.occurred,
            expected_result: draft.expected,
            location: `${draft.context.surface}:${draft.context.pathname}`,
            blocks_work: draft.blocking,
            captured_at: draft.observedAt,
            risk,
            suggested_lane: suggestedLane(risk),
            allowed_change_scope: [],
            app_build_id: draft.build.buildId === "unknown" ? null : draft.build.buildId,
            app_tree: draft.build.tree === "unknown" ? null : draft.build.tree,
            route: draft.context.pathname,
            context_snapshot: snapshot,
            attachment_manifest: attachmentManifest,
        };
        const staged = expectObject(await nativeRequest("reviewIssueRequest", payload));
        const captureHash = requireHash(staged.capture_hash, "REVIEW_BUS_INVALID_CAPTURE_HASH");
        if (staged.receipt) {
            const recoveredReceipt = validateSubmissionReceipt(staged.receipt, draft.submissionId, projectId, captureHash);
            const recovered = await persistDraft({
                ...draft,
                captureHash,
                canonicalIssueId: recoveredReceipt.formal_issue_id,
                receipt: recoveredReceipt,
                delivery: "ACCEPTED_AWAITING_READBACK",
                lastDeliveryAt: new Date().toISOString(),
                lastErrorCode: undefined,
                stoppedReason: undefined,
            });
            return confirmAcceptedDraft(recovered);
        }
        if (staged.state !== "STAGED") throw new Error("SUBMISSION_RECEIPT_NOT_FOUND");
        let current = await persistDraft({ ...draft, delivery: "SUBMISSION_STAGED", captureHash, lastDeliveryAt: new Date().toISOString(), lastErrorCode: undefined, stoppedReason: undefined });
        for (let index = 0; index < draft.attachments.length; index += 1) {
            const item = draft.attachments[index];
            const manifest = attachmentManifest[index];
            await nativeRequest("reviewIssueAttachmentRequest", {
                attachment_id: manifest.attachment_id,
                media_type: item.mediaType,
                original_name: item.name,
                size_bytes: item.size,
                sha256: manifest.sha256,
                base64: await blobBase64(item.content),
                captured_at: draft.observedAt,
            }, draft.submissionId);
        }
        current = await persistDraft({ ...current, delivery: "ATTACHMENTS_STAGED", lastDeliveryAt: new Date().toISOString() });
        const finalized = expectObject(await nativeRequest("reviewIssueFinalizeRequest", { project_id: projectId, capture_hash: captureHash }, draft.submissionId));
        const receipt = validateSubmissionReceipt(finalized.receipt, draft.submissionId, projectId, captureHash);
        current = await persistDraft({
            ...current,
            canonicalIssueId: receipt.formal_issue_id,
            receipt,
            delivery: "ACCEPTED_AWAITING_READBACK",
            lastDeliveryAt: new Date().toISOString(),
            lastErrorCode: undefined,
            stoppedReason: undefined,
        });
        return confirmAcceptedDraft(current);
    };
    window.filmOSReviewCenterRequest = (operation, payload = {}) => new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timeout = window.setTimeout(() => { nativeResolvers.delete(requestId); reject(new Error("REVIEW_CENTER_TIMEOUT")); }, 15_000);
        nativeResolvers.set(requestId, { resolve, reject, timeout });
        handler.postMessage({ action: "reviewCenterRequest", requestId, operation, payload });
    });
}

if (typeof window !== "undefined") installNativeReviewIssueIntake();

function safePathname(rawPathname: string) {
    const pathname = rawPathname.split(/[?#]/, 1)[0] || "/";
    return pathname.startsWith("/") ? pathname.slice(0, 2048) : "/";
}

export function contextFromPathname(rawPathname: string, surfaceHint?: IssueSurface): IssueContext {
    const pathname = safePathname(rawPathname);
    const projectMatch = pathname.match(/^\/projects\/([^/]+)/);
    const contentUnitMatch = pathname.match(/^\/projects\/([^/]+)\/chapters\/([^/]+)/);
    const canvasMatch = pathname.match(/^\/canvas\/([^/]+)/);
    const surface: IssueSurface = surfaceHint
        || (canvasMatch ? "canvas" : contentUnitMatch ? "content-unit" : projectMatch ? "project" : "global");
    return {
        pathname,
        surface,
        ...(projectMatch ? { projectId: decodeURIComponent(projectMatch[1]) } : {}),
        ...(contentUnitMatch ? { contentUnitId: decodeURIComponent(contentUnitMatch[2]) } : {}),
        ...(canvasMatch ? { canvasId: decodeURIComponent(canvasMatch[1]) } : {}),
    };
}

function normalizedText(value: string, label: string) {
    const normalized = value.trim();
    if (!normalized) throw new Error(`请填写${label}`);
    if (normalized.length > 4000) throw new Error(`${label}不能超过4000字`);
    return normalized;
}

export function createLocalIssueDraft(
    input: IssueDraftInput,
    dependencies: {
        pathname?: string;
        surface?: IssueSurface;
        build?: BuildIdentity;
        localDraftId?: string;
        submissionId?: string;
        legacyLocalId?: string;
        now?: string;
    } = {},
): LocalIssueDraft {
    const browserWindow = typeof window === "undefined" ? undefined : window;
    const uuid = dependencies.submissionId?.replace(/^FILMOS-SUBMISSION-/, "") || crypto.randomUUID();
    const localDraftId = dependencies.localDraftId || `local-draft-${uuid}`;
    const submissionId = dependencies.submissionId || `FILMOS-SUBMISSION-${uuid}`;
    const observedAt = dependencies.now || new Date().toISOString();
    if (!/^local-draft-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(localDraftId)) throw new Error("本机草稿ID无效");
    if (!/^FILMOS-SUBMISSION-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(submissionId)) throw new Error("投递ID无效");
    if (!Number.isFinite(Date.parse(observedAt))) throw new Error("观测时间无效");
    const attachments = input.attachments ?? [];
    if (attachments.length > MAX_ISSUE_ATTACHMENTS || attachments.some((item) => item.size > MAX_ISSUE_ATTACHMENT_BYTES)) {
        throw new Error("最多添加5个、单个不超过25MB的截图或录屏");
    }
    const build = dependencies.build ?? currentBuildIdentity();
    const contextSnapshot = captureIssueContextSnapshot(build);
    const pathContext = contextFromPathname(
        dependencies.pathname ?? browserWindow?.location.pathname ?? "/",
        dependencies.surface ?? browserWindow?.filmOSIssueSurface,
    );
    return {
        format: ISSUE_DRAFT_FORMAT,
        localDraftId,
        submissionId,
        ...(dependencies.legacyLocalId ? { legacyLocalId: dependencies.legacyLocalId } : {}),
        state: "OBSERVED_IN_USE",
        occurred: normalizedText(input.occurred, "发生了什么"),
        expected: normalizedText(input.expected, "期望达到什么"),
        blocking: input.blocking,
        context: {
            ...pathContext,
            ...(contextSnapshot.domainProjectId || contextSnapshot.projectId ? { projectId: contextSnapshot.domainProjectId || contextSnapshot.projectId } : {}),
            ...(contextSnapshot.contentUnitId ? { contentUnitId: contextSnapshot.contentUnitId } : {}),
            ...(contextSnapshot.canvasId ? { canvasId: contextSnapshot.canvasId } : {}),
        },
        contextSnapshot,
        build,
        attachments,
        observedAt,
        delivery: "LOCAL_PENDING_REVIEW_BUS",
        retryCount: 0,
    };
}

export async function saveIssueDraft(draft: LocalIssueDraft) {
    await persistDraft(draft);
    if (typeof window === "undefined" || !window.filmOSReviewIssueIntake) return draft;
    try {
        return await deliverIssueDraft(draft);
    } catch (error) {
        return recordDeliveryFailure(draft, error);
    }
}

export async function replayPendingIssueDrafts() {
    await migrateStageALegacyDraft();
    if (typeof window === "undefined" || !window.filmOSReviewIssueIntake) return { delivered: 0, pending: await countPendingIssueDrafts() };
    const pending: LocalIssueDraft[] = [];
    await issueDraftStore.iterate<LocalIssueDraft | LegacyIssueDraft | { format?: string }, void>((draft) => {
        if (!isLocalIssueDraft(draft)) return;
        if (["LOCAL_PENDING_REVIEW_BUS", "SUBMISSION_STAGED", "ATTACHMENTS_STAGED", "ACCEPTED_AWAITING_READBACK"].includes(draft.delivery)
            && draft.retryCount < 5) pending.push(draft);
    });
    let delivered = 0;
    for (const draft of pending) {
        try {
            const result = await deliverIssueDraft(draft);
            if (result.delivery === "CONFIRMED") delivered += 1;
        } catch (error) {
            const failed = await recordDeliveryFailure(draft, error);
            window.dispatchEvent(new CustomEvent("filmos:review-issue-replay", { detail: {
                localDraftId: failed.localDraftId,
                submissionId: failed.submissionId,
                canonicalIssueId: failed.canonicalIssueId,
                error: failed.lastErrorCode,
                retryCount: failed.retryCount,
                stoppedReason: failed.stoppedReason,
            } }));
        }
    }
    return { delivered, pending: await countPendingIssueDrafts() };
}

export async function countPendingIssueDrafts() {
    let count = 0;
    await issueDraftStore.iterate<LocalIssueDraft | { format?: string }, void>((draft) => {
        if (isLocalIssueDraft(draft) && !["CONFIRMED", "STOPPED"].includes(draft.delivery)) count += 1;
    });
    return count;
}

export async function reviewCenterRequest<T>(operation: string, payload: Record<string, string> = {}) {
    if (typeof window === "undefined" || !window.filmOSReviewCenterRequest) throw new Error("REVIEW_CENTER_DESKTOP_REQUIRED");
    return window.filmOSReviewCenterRequest(operation, payload) as Promise<T>;
}

async function deliverIssueDraft(draft: LocalIssueDraft) {
    if (!window.filmOSReviewIssueIntake) throw new Error("REVIEW_BUS_UNAVAILABLE");
    return window.filmOSReviewIssueIntake(draft);
}

async function persistDraft(draft: LocalIssueDraft) {
    await issueDraftStore.setItem(draft.localDraftId, draft);
    return draft;
}

async function recordDeliveryFailure(draft: LocalIssueDraft, error: unknown) {
    const persisted = await issueDraftStore.getItem<LocalIssueDraft>(draft.localDraftId);
    const current = persisted && isLocalIssueDraft(persisted) ? persisted : draft;
    const code = safeErrorCode(error);
    const retryCount = current.retryCount + 1;
    const stop = !isRetryableDeliveryError(code) || retryCount >= 5;
    return persistDraft({
        ...current,
        retryCount,
        lastErrorCode: code,
        lastDeliveryAt: new Date().toISOString(),
        delivery: stop ? "STOPPED" : current.delivery,
        ...(stop ? { stoppedReason: code } : {}),
    });
}

async function confirmAcceptedDraft(draft: LocalIssueDraft) {
    if (!draft.receipt || !draft.canonicalIssueId || !draft.captureHash) throw new Error("LOCAL_RECEIPT_INCOMPLETE");
    const projectId = boundProjectId(draft);
    if (!projectId) throw new Error("PROJECT_SCOPE_REQUIRED");
    const currentProjectId = currentDomainProjectId();
    if (currentProjectId && currentProjectId !== projectId) throw new Error("SUBMISSION_PROJECT_SCOPE_CONFLICT");
    const pending = expectObject(await reviewCenterRequest("list_pending_issues", { project_id: projectId }));
    const issues = Array.isArray(pending.issues) ? pending.issues : [];
    if (!issues.some((item) => expectOptionalObject(item)?.issue_id === draft.canonicalIssueId)) throw new Error("PROJECTION_READBACK_MISSING");
    await reviewCenterRequest("get_issue_evidence", { project_id: projectId, issue_id: draft.canonicalIssueId });
    const confirmation = expectObject(await reviewCenterRequest("get_intake_confirmation", { project_id: projectId, issue_id: draft.canonicalIssueId }));
    assertConfirmationMatches(draft, confirmation, projectId);
    if (confirmation.pending_read !== true || confirmation.evidence_read !== true) return draft;
    const confirmed = await persistDraft({ ...draft, delivery: "CONFIRMED", lastDeliveryAt: new Date().toISOString(), lastErrorCode: undefined, stoppedReason: undefined });
    if (draft.legacyLocalId) {
        const tombstone: MigrationTombstone = {
            schema_version: "filmos.review-intake-migration-tombstone.v1",
            legacy_local_id: draft.legacyLocalId,
            local_draft_id: draft.localDraftId,
            submission_id: draft.submissionId,
            canonical_issue_id: draft.canonicalIssueId,
            project_id: projectId,
            capture_hash: draft.captureHash,
            receipt_hash: draft.receipt.receipt_hash,
            projection_content_hash: draft.receipt.projection_content_hash,
            evidence_manifest_hash: draft.receipt.evidence_manifest_hash,
            confirmed_at: new Date().toISOString(),
        };
        await migrationTombstoneStore.setItem(draft.legacyLocalId, tombstone);
        await issueDraftStore.removeItem(draft.legacyLocalId);
    }
    return confirmed;
}

async function migrateStageALegacyDraft() {
    const legacyId = `FILMOS-ISSUE-${STAGE_A_BOOTSTRAP_UUID}`;
    const existing = await issueDraftStore.getItem<LegacyIssueDraft | LocalIssueDraft>(legacyId);
    if (!existing || existing.format !== "filmos.usage-issue-draft/v1") return;
    const localDraftId = `local-draft-${STAGE_A_BOOTSTRAP_UUID}`;
    if (await issueDraftStore.getItem(localDraftId)) return;
    const migrated: LocalIssueDraft = {
        format: ISSUE_DRAFT_FORMAT,
        localDraftId,
        submissionId: `FILMOS-SUBMISSION-${STAGE_A_BOOTSTRAP_UUID}`,
        legacyLocalId: legacyId,
        state: existing.state,
        occurred: existing.occurred,
        expected: existing.expected,
        blocking: existing.blocking,
        context: existing.context,
        contextSnapshot: existing.contextSnapshot,
        build: existing.build,
        attachments: existing.attachments,
        observedAt: existing.observedAt,
        delivery: "LOCAL_PENDING_REVIEW_BUS",
        retryCount: 0,
    };
    await persistDraft(migrated);
}

function captureIssueContextSnapshot(build: BuildIdentity): IssueContextSnapshot {
    const workbench = typeof window === "undefined" ? null : window.filmOSGetWorkbenchContext?.() ?? null;
    const host = typeof window === "undefined" ? null : window.filmOSChatGPTHostStatus ?? null;
    const activeBrainProfileId = typeof window === "undefined" ? undefined : window.localStorage.getItem("filmos.agent.activeBrainProfileId") || undefined;
    const agent = typeof window === "undefined" ? null : useCanvasAgentStore.getState();
    const contextReceiptId = workbench?.contextReceiptId;
    return {
        appCommit: build.commit,
        appTree: build.tree,
        buildId: build.buildId,
        ...(workbench?.projectId ? { projectId: workbench.projectId } : {}),
        ...(workbench?.domainProjectId ? { domainProjectId: workbench.domainProjectId } : {}),
        ...(workbench?.contentUnitId ? { contentUnitId: workbench.contentUnitId } : {}),
        ...(workbench?.sceneId ? { sceneId: workbench.sceneId } : {}),
        ...(workbench?.directorUnitId ? { directorUnitId: workbench.directorUnitId } : {}),
        ...(workbench?.shotId ? { shotId: workbench.shotId } : {}),
        ...(workbench?.canvasId ? { canvasId: workbench.canvasId } : {}),
        ...(workbench ? { canvasRevision: workbench.canvasRevision } : {}),
        ...(workbench?.canvasStateHash ? { canvasStateHash: workbench.canvasStateHash } : {}),
        selectedNodeIds: workbench?.selectedNodeIds ?? [],
        ...(activeBrainProfileId ? { activeBrainProfileId } : {}),
        ...(agent?.activeThreadId ? { brainSessionId: agent.activeThreadId } : {}),
        ...(contextReceiptId ? { contextReceiptId } : {}),
        recentAuditIds: (agent?.eventLogs ?? []).slice(-20).map((item) => item.id),
        recentErrorCodes: [...new Set([
            ...(host?.state && !["CONNECTED", "WAITING_FOR_CHATGPT"].includes(host.state) ? [host.state] : []),
            ...(agent?.connectError ? [agent.connectError] : []),
            ...(agent?.eventLogs ?? []).filter((item) => /error|错误|失败/i.test(`${item.title} ${item.text}`)).slice(-20).map((item) => item.title),
        ])],
        runtimeStatus: {
            canvasAgentConnected: agent?.connected ?? false,
            canvasAgentActivity: agent?.activity ?? "unavailable",
            ...(host ? { chatgptHostState: host.state, tunnelConnected: host.tunnelConnected, externalAccountConnected: host.externalAccountConnected } : {}),
        },
        providerStatus: { paidSubmitEnabled: build.externalPaidSubmitEnabled, activeBrainProfileId: activeBrainProfileId ?? null },
    };
}

function attachmentId(value: string) {
    const normalized = value.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 120);
    return `attachment-${normalized || crypto.randomUUID()}`;
}

function boundProjectId(draft: LocalIssueDraft) {
    return draft.contextSnapshot.domainProjectId || draft.contextSnapshot.projectId || draft.context.projectId;
}

function currentDomainProjectId() {
    const context = typeof window === "undefined" ? null : window.filmOSGetWorkbenchContext?.() ?? null;
    return context?.domainProjectId || context?.projectId || undefined;
}

function suggestedLane(risk: Record<string, boolean>) {
    if (risk.architecture_gap || risk.requires_schema_change || risk.requires_authority_change) return "architecture";
    if (risk.core_state || risk.data_loss || risk.security || risk.migration) return "core";
    return "fast";
}

function expectObject(value: unknown): Record<string, any> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("REVIEW_BUS_INVALID_RESPONSE");
    return value as Record<string, any>;
}

function expectOptionalObject(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function requireHash(value: unknown, code: string) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(code);
    return value;
}

function validateSubmissionReceipt(value: unknown, submissionId: string, projectId: string, captureHash: string): SubmissionReceipt {
    const receipt = expectObject(value);
    if (receipt.schema_version !== "filmos.review-submission.receipt.v1"
        || receipt.submission_id !== submissionId
        || receipt.project_id !== projectId
        || receipt.capture_hash !== captureHash
        || typeof receipt.formal_issue_id !== "string"
        || !/^FILMOS-(?:ISSUE|ARCH)-[A-Za-z0-9-]{1,120}$/.test(receipt.formal_issue_id)) throw new Error("REVIEW_BUS_INVALID_RECEIPT");
    requireHash(receipt.receipt_hash, "REVIEW_BUS_INVALID_RECEIPT");
    requireHash(receipt.projection_content_hash, "REVIEW_BUS_INVALID_RECEIPT");
    requireHash(receipt.evidence_manifest_hash, "REVIEW_BUS_INVALID_RECEIPT");
    if (typeof receipt.accepted_at !== "string" || !Number.isFinite(Date.parse(receipt.accepted_at))) throw new Error("REVIEW_BUS_INVALID_RECEIPT");
    return receipt as SubmissionReceipt;
}

function assertConfirmationMatches(draft: LocalIssueDraft, confirmation: Record<string, any>, projectId: string) {
    if (confirmation.submission_id !== draft.submissionId
        || confirmation.formal_issue_id !== draft.canonicalIssueId
        || confirmation.project_id !== projectId
        || confirmation.capture_hash !== draft.captureHash
        || confirmation.receipt_hash !== draft.receipt?.receipt_hash
        || confirmation.projection_content_hash !== draft.receipt?.projection_content_hash
        || confirmation.evidence_manifest_hash !== draft.receipt?.evidence_manifest_hash) throw new Error("READBACK_HASH_MISMATCH");
}

function safeErrorCode(error: unknown) {
    const message = error instanceof Error ? error.message : "REVIEW_BUS_DELIVERY_FAILED";
    return /^[A-Z0-9_]{1,96}$/.test(message) ? message : "REVIEW_BUS_DELIVERY_FAILED";
}

function isLocalIssueDraft(value: LocalIssueDraft | LegacyIssueDraft | { format?: string }): value is LocalIssueDraft {
    return value.format === ISSUE_DRAFT_FORMAT
        && "localDraftId" in value
        && "submissionId" in value
        && "delivery" in value
        && "retryCount" in value;
}

function isRetryableDeliveryError(code: string) {
    if (code === "SUBMISSION_PROJECT_SCOPE_CONFLICT" || code === "PROJECT_SCOPE_DENIED" || code === "PROJECT_SCOPE_REQUIRED") return false;
    if (/^(INVALID_|ATTACHMENT_|SUBMISSION_IDEMPOTENCY_CONFLICT|SUBMISSION_ATTACHMENT_UNDECLARED|SUBMISSION_ATTACHMENT_MISSING|FINALIZE_ALREADY_BOUND_CONFLICT|BOOTSTRAP_ALREADY_CONSUMED|INTAKE_PROTOCOL_UPGRADE_REQUIRED|READBACK_HASH_MISMATCH|LOCAL_RECEIPT_INCOMPLETE)/.test(code)) return false;
    return true;
}

async function blobSha256(blob: Blob) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function blobBase64(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("ATTACHMENT_READ_FAILED"));
        reader.onload = () => {
            const value = String(reader.result ?? "");
            const comma = value.indexOf(",");
            if (comma < 0) reject(new Error("ATTACHMENT_READ_FAILED"));
            else resolve(value.slice(comma + 1));
        };
        reader.readAsDataURL(blob);
    });
}

if (typeof window !== "undefined") {
    window.setTimeout(() => { void replayPendingIssueDrafts(); }, 1_000);
    window.addEventListener("online", () => { void replayPendingIssueDrafts(); });
    window.setInterval(() => { void replayPendingIssueDrafts(); }, 30_000);
}
