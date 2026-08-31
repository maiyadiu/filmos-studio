import localforage from "localforage";

import { currentBuildIdentity, type BuildIdentity } from "@/film/governance/build-identity";

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

export type IssueContext = {
    pathname: string;
    surface: IssueSurface;
    projectId?: string;
    contentUnitId?: string;
    canvasId?: string;
};

export type LocalIssueDraft = {
    format: typeof ISSUE_DRAFT_FORMAT;
    issueId: string;
    state: "OBSERVED_IN_USE";
    occurred: string;
    expected: string;
    blocking: boolean;
    context: IssueContext;
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
        filmOSResolveReviewIssue?: (requestId: string, result: unknown, error: string | null) => void;
        webkit?: { messageHandlers?: { filmosDesktop?: { postMessage: (message: unknown) => void } } };
    }
}

const nativeResolvers = new Map<string, { resolve: (value: { accepted: true }) => void; reject: (reason: Error) => void; timeout: number }>();
let replayTimer: number | null = null;

function installNativeReviewIssueIntake() {
    const handler = window.webkit?.messageHandlers?.filmosDesktop;
    if (!handler) return;
    window.filmOSResolveReviewIssue = (requestId, result, error) => {
        const pending = nativeResolvers.get(requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeout);
        nativeResolvers.delete(requestId);
        if (error) pending.reject(new Error(error));
        else if (result && typeof result === "object") pending.resolve({ accepted: true });
        else pending.reject(new Error("REVIEW_BUS_INVALID_RESPONSE"));
    };
    window.filmOSReviewIssueIntake = async (draft) => {
        const payload = await buildReviewIssuePayload(draft);
        return new Promise((resolve, reject) => {
            const requestId = crypto.randomUUID();
            const timeout = window.setTimeout(() => {
                nativeResolvers.delete(requestId);
                reject(new Error("REVIEW_BUS_TIMEOUT"));
            }, 30_000);
            nativeResolvers.set(requestId, { resolve, reject, timeout });
            handler.postMessage({ action: "reviewIssueRequest", requestId, payload });
        });
    };
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
    if (attachments.length > 5 || attachments.some((item) => item.size > 25 * 1024 * 1024)) {
        throw new Error("最多添加5个、单个不超过25MB的截图或录屏");
    }
    return {
        format: ISSUE_DRAFT_FORMAT,
        issueId,
        state: "OBSERVED_IN_USE",
        occurred: normalizedText(input.occurred, "发生了什么"),
        expected: normalizedText(input.expected, "期望达到什么"),
        blocking: input.blocking,
        context: contextFromPathname(
            dependencies.pathname ?? browserWindow?.location.pathname ?? "/",
            dependencies.surface ?? browserWindow?.filmOSIssueSurface,
        ),
        build: dependencies.build ?? currentBuildIdentity(),
        attachments,
        observedAt,
        delivery: "LOCAL_PENDING_REVIEW_BUS",
    };
}

export async function saveIssueDraft(draft: LocalIssueDraft) {
    await issueDraftStore.setItem(draft.issueId, draft);
    if (typeof window === "undefined" || !window.filmOSReviewIssueIntake) return draft;
    try {
        await window.filmOSReviewIssueIntake(draft);
        const accepted = { ...draft, delivery: "REVIEW_BUS_ACCEPTED" as const };
        await issueDraftStore.setItem(draft.issueId, accepted);
        return accepted;
    } catch {
        // Local durability is the Pilot fallback. Review Bus replay may happen later.
        scheduleIssueDraftReplay();
        return draft;
    }
}

export async function replayPendingIssueDrafts(intake = typeof window === "undefined" ? undefined : window.filmOSReviewIssueIntake) {
    if (!intake) return { pending: await countPendingIssueDrafts(), replayed: 0 };
    const drafts: LocalIssueDraft[] = [];
    await issueDraftStore.iterate<LocalIssueDraft, void>((draft) => {
        if (draft.delivery === "LOCAL_PENDING_REVIEW_BUS") drafts.push(draft);
    });
    let replayed = 0;
    for (const draft of drafts) {
        try {
            await intake(draft);
            await issueDraftStore.setItem(draft.issueId, { ...draft, delivery: "REVIEW_BUS_ACCEPTED" });
            replayed += 1;
        } catch {
            // Preserve the same immutable Issue ID for the next local retry.
        }
    }
    return { pending: drafts.length - replayed, replayed };
}

export async function buildReviewIssuePayload(draft: LocalIssueDraft) {
    const localEvidence = await Promise.all(draft.attachments.map(async (item) => {
        const bytes = new Uint8Array(await item.content.arrayBuffer());
        if (bytes.byteLength !== item.size) throw new Error("LOCAL_EVIDENCE_SIZE_MISMATCH");
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const evidenceUri = `filmos-evidence://${draft.issueId}/${item.id}`;
        return {
            evidence_id: item.id,
            media_type: item.mediaType || "application/octet-stream",
            size: bytes.byteLength,
            sha256: hexadecimal(new Uint8Array(digest)),
            evidence_uri: evidenceUri,
            data_base64: bytesToBase64(bytes),
        };
    }));
    const payload: Record<string, unknown> = {
        project_id: draft.context.projectId || "filmos-global",
        what_happened: draft.occurred,
        expected_result: draft.expected,
        location: `${draft.context.surface}:${draft.context.pathname}`,
        blocks_work: draft.blocking,
        screenshot_refs: localEvidence.map((item) => item.evidence_uri),
        local_evidence: localEvidence,
        issue_id: draft.issueId,
        route: draft.context.pathname,
    };
    if (draft.build.buildId !== "unknown") payload.app_build_id = draft.build.buildId;
    if (draft.build.tree !== "unknown") payload.app_tree = draft.build.tree;
    return payload;
}

export async function countPendingIssueDrafts() {
    let count = 0;
    await issueDraftStore.iterate<LocalIssueDraft, void>((draft) => {
        if (draft.delivery === "LOCAL_PENDING_REVIEW_BUS") count += 1;
    });
    return count;
}

function hexadecimal(bytes: Uint8Array) {
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array) {
    let value = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(value);
}

function scheduleIssueDraftReplay(delay = 30_000) {
    if (typeof window === "undefined" || !window.filmOSReviewIssueIntake || replayTimer !== null) return;
    replayTimer = window.setTimeout(async () => {
        replayTimer = null;
        const result = await replayPendingIssueDrafts();
        if (result.pending > 0) scheduleIssueDraftReplay(Math.min(delay * 2, 5 * 60_000));
    }, delay);
}

if (typeof window !== "undefined" && window.filmOSReviewIssueIntake) {
    queueMicrotask(async () => {
        const result = await replayPendingIssueDrafts();
        if (result.pending > 0) scheduleIssueDraftReplay();
    });
    window.addEventListener("online", () => scheduleIssueDraftReplay(0));
}
