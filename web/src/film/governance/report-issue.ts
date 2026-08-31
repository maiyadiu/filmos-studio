import localforage from "localforage";

import { currentBuildIdentity, type BuildIdentity } from "@/film/governance/build-identity";
import { inferIssueRoutingRisk } from "@/film/governance/issue-lane";
import { useCanvasAgentStore } from "@/stores/canvas/use-canvas-agent-store";

export const ISSUE_DRAFT_FORMAT = "filmos.usage-issue-draft/v1";
export const ISSUE_DRAFT_STORE = "filmos-usage-issue-drafts";

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
    issueId: string;
    state: "OBSERVED_IN_USE";
    occurred: string;
    expected: string;
    blocking: boolean;
    context: IssueContext;
    contextSnapshot: IssueContextSnapshot;
    build: BuildIdentity;
    attachments: IssueAttachment[];
    observedAt: string;
    delivery: "LOCAL_PENDING_REVIEW_BUS" | "REVIEW_BUS_ACCEPTED";
};

export type IssueDraftInput = {
    occurred: string;
    expected: string;
    blocking: boolean;
    attachments?: IssueAttachment[];
};

declare global {
    interface Window {
        filmOSIssueSurface?: IssueSurface;
        filmOSReportIssue?: (surface?: IssueSurface) => void;
        filmOSReviewIssueIntake?: (draft: LocalIssueDraft) => Promise<{ accepted: true }>;
        filmOSReviewCenterRequest?: (operation: string, payload?: Record<string, string>) => Promise<unknown>;
        filmOSResolveReviewIssue?: (requestId: string, result: unknown, error: string | null) => void;
        webkit?: { messageHandlers?: { filmosDesktop?: { postMessage: (message: unknown) => void } } };
    }
}

const nativeResolvers = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout: number }>();
const replayAttempts = new Map<string, number>();

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
    const nativeRequest = (action: "reviewIssueRequest" | "reviewIssueAttachmentRequest", payload: Record<string, unknown>, issueId?: string) => new Promise<unknown>((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timeout = window.setTimeout(() => {
            nativeResolvers.delete(requestId);
            reject(new Error("REVIEW_BUS_TIMEOUT"));
        }, action === "reviewIssueAttachmentRequest" ? 60_000 : 15_000);
        nativeResolvers.set(requestId, { resolve, reject, timeout });
        handler.postMessage({ action, requestId, ...(issueId ? { issueId } : {}), payload });
    });
    window.filmOSReviewIssueIntake = async (draft) => {
        const snapshot = draft.contextSnapshot ?? captureIssueContextSnapshot(draft.build);
        const payload: Record<string, unknown> = {
            project_id: snapshot.domainProjectId || snapshot.projectId || draft.context.projectId || "filmos-governance-global",
            what_happened: draft.occurred,
            expected_result: draft.expected,
            location: `${draft.context.surface}:${draft.context.pathname}`,
            blocks_work: draft.blocking,
            risk: inferIssueRoutingRisk({
                occurred: draft.occurred,
                expected: draft.expected,
                blocking: draft.blocking,
                context: draft.context,
            }),
            screenshot_refs: [],
            issue_id: draft.issueId,
            route: draft.context.pathname,
            context_snapshot: snapshot,
        };
        if (draft.build.buildId !== "unknown") payload.app_build_id = draft.build.buildId;
        if (draft.build.tree !== "unknown") payload.app_tree = draft.build.tree;
        await nativeRequest("reviewIssueRequest", payload);
        for (const item of draft.attachments) {
            await nativeRequest("reviewIssueAttachmentRequest", {
                attachment_id: attachmentId(item.id),
                media_type: item.mediaType,
                original_name: item.name,
                base64: await blobBase64(item.content),
                captured_at: draft.observedAt,
            }, draft.issueId);
        }
        return { accepted: true };
    };
    window.filmOSReviewCenterRequest = (operation, payload = {}) => new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timeout = window.setTimeout(() => { nativeResolvers.delete(requestId); reject(new Error("REVIEW_CENTER_TIMEOUT")); }, 15_000);
        nativeResolvers.set(requestId, { resolve, reject, timeout });
        handler.postMessage({ action: "reviewCenterRequest", requestId, operation, payload });
    });
}

if (typeof window !== "undefined") installNativeReviewIssueIntake();

const issueDraftStore = localforage.createInstance({
    name: "FilmOS Studio",
    storeName: ISSUE_DRAFT_STORE,
    description: "Local-only usage observations waiting for the FilmOS Review Bus",
});

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
        issueId?: string;
        now?: string;
    } = {},
): LocalIssueDraft {
    const browserWindow = typeof window === "undefined" ? undefined : window;
    const issueId = dependencies.issueId || `FILMOS-ISSUE-${crypto.randomUUID()}`;
    const observedAt = dependencies.now || new Date().toISOString();
    if (!/^FILMOS-ISSUE-[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$/.test(issueId)) {
        throw new Error("问题ID无效");
    }
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
        issueId,
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
    };
}

export async function saveIssueDraft(draft: LocalIssueDraft) {
    await issueDraftStore.setItem(draft.issueId, draft);
    if (typeof window === "undefined" || !window.filmOSReviewIssueIntake) return draft;
    try {
        await deliverIssueDraft(draft);
        const accepted = { ...draft, delivery: "REVIEW_BUS_ACCEPTED" as const };
        await issueDraftStore.setItem(draft.issueId, accepted);
        return accepted;
    } catch {
        // Local durability is the Pilot fallback. Review Bus replay may happen later.
        return draft;
    }
}

export async function replayPendingIssueDrafts() {
    if (typeof window === "undefined" || !window.filmOSReviewIssueIntake) return { delivered: 0, pending: await countPendingIssueDrafts() };
    const pending: LocalIssueDraft[] = [];
    await issueDraftStore.iterate<LocalIssueDraft, void>((draft) => {
        if (draft.delivery === "LOCAL_PENDING_REVIEW_BUS" && (replayAttempts.get(draft.issueId) ?? 0) < 5) pending.push(draft);
    });
    let delivered = 0;
    for (const draft of pending) {
        try {
            await deliverIssueDraft(draft);
            await issueDraftStore.setItem(draft.issueId, { ...draft, delivery: "REVIEW_BUS_ACCEPTED" as const });
            replayAttempts.delete(draft.issueId);
            delivered += 1;
        } catch (error) {
            replayAttempts.set(draft.issueId, (replayAttempts.get(draft.issueId) ?? 0) + 1);
            window.dispatchEvent(new CustomEvent("filmos:review-issue-replay", { detail: { issueId: draft.issueId, error: error instanceof Error ? error.message : "REVIEW_BUS_REPLAY_FAILED" } }));
        }
    }
    return { delivered, pending: await countPendingIssueDrafts() };
}

export async function countPendingIssueDrafts() {
    let count = 0;
    await issueDraftStore.iterate<LocalIssueDraft, void>((draft) => {
        if (draft.delivery === "LOCAL_PENDING_REVIEW_BUS") count += 1;
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

function captureIssueContextSnapshot(build: BuildIdentity): IssueContextSnapshot {
    const workbench = typeof window === "undefined" ? null : window.filmOSGetWorkbenchContext?.() ?? null;
    const host = typeof window === "undefined" ? null : window.filmOSChatGPTHostStatus ?? null;
    const activeBrainProfileId = typeof window === "undefined" ? undefined : window.localStorage.getItem("filmos.agent.activeBrainProfileId") || undefined;
    const agent = typeof window === "undefined" ? null : useCanvasAgentStore.getState();
    const contextReceiptId = workbench ? `film:${workbench.filmExpectedVersion ?? 0}:${workbench.filmContentHash || "unavailable"}:canvas:${workbench.canvasId}` : undefined;
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
        ...(workbench?.filmExpectedVersion !== undefined ? { canvasRevision: workbench.filmExpectedVersion } : {}),
        ...(workbench?.filmContentHash ? { canvasStateHash: workbench.filmContentHash } : {}),
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
