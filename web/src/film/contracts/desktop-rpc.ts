export const DESKTOP_RPC_REQUEST_ACTIONS = [
    "chatgptHostRequest",
    "reviewIssueRequest",
    "reviewIssueAttachmentRequest",
    "reviewIssueFinalizeRequest",
    "reviewCenterRequest",
] as const;

export type DesktopRpcRequestAction = (typeof DESKTOP_RPC_REQUEST_ACTIONS)[number];
export type DesktopRpcRetryClass = "retryable" | "non_retryable";

export type DesktopRpcErrorEnvelope = {
    code: string;
    retryClass: DesktopRpcRetryClass;
};

export type DesktopRpcRequest =
    | { action: "chatgptHostRequest"; operation: "publish_context" | "publish_handoff"; payload: Record<string, unknown> }
    | { action: "reviewIssueRequest"; payload: Record<string, unknown> }
    | { action: "reviewIssueAttachmentRequest"; submissionId: string; payload: Record<string, unknown> }
    | { action: "reviewIssueFinalizeRequest"; submissionId: string; payload: Record<string, unknown> }
    | { action: "reviewCenterRequest"; operation: string; payload: Record<string, string> };

export type DesktopRpcRequestOptions = {
    timeoutMs: number;
    timeoutCode: string;
    unavailableCode: string;
};

export const DESKTOP_RPC_MAX_PAYLOAD_BYTES: Record<DesktopRpcRequestAction, number> = {
    chatgptHostRequest: 256 * 1024,
    reviewIssueRequest: 512 * 1024,
    reviewIssueAttachmentRequest: 36 * 1024 * 1024,
    reviewIssueFinalizeRequest: 512 * 1024,
    reviewCenterRequest: 512 * 1024,
};

const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,96}$/;

export class DesktopRpcError extends Error {
    readonly code: string;
    readonly retryClass: DesktopRpcRetryClass;

    constructor(envelope: DesktopRpcErrorEnvelope) {
        super(envelope.code);
        this.name = "DesktopRpcError";
        this.code = envelope.code;
        this.retryClass = envelope.retryClass;
    }
}

export function normalizeDesktopRpcError(value: unknown, fallback = "DESKTOP_RPC_FAILED"): DesktopRpcErrorEnvelope {
    const rawCode = typeof value === "string"
        ? value
        : value && typeof value === "object" && !Array.isArray(value) && typeof (value as { code?: unknown }).code === "string"
            ? (value as { code: string }).code
            : fallback;
    const code = ERROR_CODE_PATTERN.test(rawCode) ? rawCode : fallback;
    return { code, retryClass: desktopRpcRetryClass(code) };
}

export function desktopRpcRetryClass(code: string): DesktopRpcRetryClass {
    return /(?:TIMEOUT|UNAVAILABLE|NOT_READY|CONNECTION|NETWORK|TEMPORARY|RETRY)/.test(code)
        ? "retryable"
        : "non_retryable";
}

export function desktopRpcPayloadSize(request: DesktopRpcRequest) {
    return new TextEncoder().encode(JSON.stringify(request.payload)).byteLength;
}

export function assertDesktopRpcPayloadSize(request: DesktopRpcRequest) {
    if (desktopRpcPayloadSize(request) > DESKTOP_RPC_MAX_PAYLOAD_BYTES[request.action]) {
        throw new DesktopRpcError({ code: "DESKTOP_RPC_PAYLOAD_TOO_LARGE", retryClass: "non_retryable" });
    }
}
