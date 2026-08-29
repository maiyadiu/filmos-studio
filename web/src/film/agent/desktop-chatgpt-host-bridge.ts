type PendingDesktopRequest = {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingDesktopRequest>();

export function requestDesktopChatGPTHost(operation: "publish_context" | "publish_handoff", payload: Record<string, unknown>) {
    const handler = window.webkit?.messageHandlers?.filmosDesktop;
    if (!handler) return Promise.reject(new Error("CHATGPT_DESKTOP_SECURE_BRIDGE_UNAVAILABLE"));
    installResolver();
    const requestId = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("CHATGPT_DESKTOP_SECURE_BRIDGE_TIMEOUT"));
        }, 15_000);
        pending.set(requestId, { resolve, reject, timer });
        handler.postMessage({ action: "chatgptHostRequest", requestId, operation, payload });
    });
}

function installResolver() {
    if (window.filmOSResolveChatGPTHostRequest) return;
    window.filmOSResolveChatGPTHostRequest = (requestId, result, error) => {
        const request = pending.get(requestId);
        if (!request) return;
        pending.delete(requestId);
        clearTimeout(request.timer);
        if (error) request.reject(new Error(error));
        else request.resolve(result);
    };
}
