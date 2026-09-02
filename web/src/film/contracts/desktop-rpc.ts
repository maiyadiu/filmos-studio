import {
    REVIEW_DESKTOP_ACTIONS,
    REVIEW_ERROR_CODE_PATTERN,
    REVIEW_RETRYABLE_SIGNAL_PATTERN,
} from "./generated-review-contract";

export const DESKTOP_RPC_REQUEST_ACTIONS = Object.freeze(Object.keys(REVIEW_DESKTOP_ACTIONS) as DesktopRpcRequestAction[]);
export type DesktopRpcRequestAction = keyof typeof REVIEW_DESKTOP_ACTIONS;
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
    timeoutMs?: number;
    timeoutCode: string;
    unavailableCode: string;
};

export const DESKTOP_RPC_MAX_PAYLOAD_BYTES = Object.freeze(Object.fromEntries(
    Object.entries(REVIEW_DESKTOP_ACTIONS).map(([action, value]) => [action, value.maximum_payload_bytes]),
) as Record<DesktopRpcRequestAction, number>);

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
    const code = REVIEW_ERROR_CODE_PATTERN.test(rawCode) ? rawCode : fallback;
    return { code, retryClass: desktopRpcRetryClass(code) };
}

export function desktopRpcRetryClass(code: string): DesktopRpcRetryClass {
    return REVIEW_RETRYABLE_SIGNAL_PATTERN.test(code)
        ? "retryable"
        : "non_retryable";
}

export function desktopRpcTimeoutMs(action: DesktopRpcRequestAction) {
    return REVIEW_DESKTOP_ACTIONS[action].timeout_ms;
}

export function desktopRpcPayloadSize(request: DesktopRpcRequest) {
    return new TextEncoder().encode(JSON.stringify(request.payload)).byteLength;
}

export function assertDesktopRpcPayloadSize(request: DesktopRpcRequest) {
    if (desktopRpcPayloadSize(request) > DESKTOP_RPC_MAX_PAYLOAD_BYTES[request.action]) {
        throw new DesktopRpcError({ code: "DESKTOP_RPC_PAYLOAD_TOO_LARGE", retryClass: "non_retryable" });
    }
}
