import {
    DesktopRpcError,
    assertDesktopRpcPayloadSize,
    desktopRpcTimeoutMs,
    normalizeDesktopRpcError,
    type DesktopRpcRequest,
    type DesktopRpcRequestOptions,
} from "@/film/contracts/desktop-rpc";

type PendingDesktopRequest = {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: number;
};

export type DesktopRpcClientDependencies = {
    postMessage(message: unknown): void;
    randomUUID(): string;
    setTimer(callback: () => void, timeoutMs: number): number;
    clearTimer(timer: number): void;
};

export class DesktopRpcClient {
    private readonly pending = new Map<string, PendingDesktopRequest>();

    constructor(private readonly dependencies: DesktopRpcClientDependencies) {}

    request(request: DesktopRpcRequest, options: DesktopRpcRequestOptions): Promise<unknown> {
        assertDesktopRpcPayloadSize(request);
        const requestId = this.dependencies.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = this.dependencies.setTimer(() => {
                this.pending.delete(requestId);
                reject(new DesktopRpcError(normalizeDesktopRpcError(options.timeoutCode)));
            }, options.timeoutMs ?? desktopRpcTimeoutMs(request.action));
            this.pending.set(requestId, { resolve, reject, timer });
            try {
                this.dependencies.postMessage({ ...request, requestId });
            } catch (error) {
                this.pending.delete(requestId);
                this.dependencies.clearTimer(timer);
                reject(new DesktopRpcError(normalizeDesktopRpcError(error, options.unavailableCode)));
            }
        });
    }

    resolve(requestId: string, result: unknown, error?: unknown) {
        const request = this.pending.get(requestId);
        if (!request) return false;
        this.pending.delete(requestId);
        this.dependencies.clearTimer(request.timer);
        if (error) request.reject(new DesktopRpcError(normalizeDesktopRpcError(error)));
        else request.resolve(result);
        return true;
    }

    cancelAll(code = "DESKTOP_RPC_CANCELLED") {
        for (const [requestId, request] of this.pending) {
            this.pending.delete(requestId);
            this.dependencies.clearTimer(request.timer);
            request.reject(new DesktopRpcError(normalizeDesktopRpcError(code)));
        }
    }

    get pendingCount() {
        return this.pending.size;
    }
}

let browserClient: DesktopRpcClient | undefined;

function desktopMessageHandler() {
    return window.webkit?.messageHandlers?.filmosDesktop;
}

function getBrowserClient() {
    if (browserClient) return browserClient;
    const handler = desktopMessageHandler();
    if (!handler) return undefined;
    browserClient = new DesktopRpcClient({
        postMessage: (message) => handler.postMessage(message),
        randomUUID: () => crypto.randomUUID(),
        setTimer: (callback, timeoutMs) => window.setTimeout(callback, timeoutMs),
        clearTimer: (timer) => window.clearTimeout(timer),
    });
    installLegacyDesktopRpcResolvers(browserClient);
    return browserClient;
}

export function isDesktopRpcAvailable() {
    return typeof window !== "undefined" && Boolean(desktopMessageHandler());
}

export function requestDesktopRpc(request: DesktopRpcRequest, options: DesktopRpcRequestOptions) {
    if (typeof window === "undefined") {
        return Promise.reject(new DesktopRpcError(normalizeDesktopRpcError(options.unavailableCode)));
    }
    const client = getBrowserClient();
    if (!client) return Promise.reject(new DesktopRpcError(normalizeDesktopRpcError(options.unavailableCode)));
    return client.request(request, options);
}

export function postDesktopHostMessage(message: Record<string, unknown>) {
    if (typeof window === "undefined") return false;
    const handler = desktopMessageHandler();
    if (!handler) return false;
    handler.postMessage(message);
    return true;
}

function installLegacyDesktopRpcResolvers(client: DesktopRpcClient) {
    window.filmOSResolveChatGPTHostRequest = (requestId, result, error) => {
        client.resolve(requestId, result, error);
    };
    window.filmOSResolveReviewIssue = (requestId, result, error) => {
        client.resolve(requestId, result, error);
    };
}

declare global {
    interface Window {
        filmOSResolveChatGPTHostRequest?: (requestId: string, result?: unknown, error?: unknown) => void;
        filmOSResolveReviewIssue?: (requestId: string, result: unknown, error?: unknown) => void;
        webkit?: { messageHandlers?: { filmosDesktop?: { postMessage(message: unknown): void } } };
    }
}
