export type BrowserRuntimeRequest = {
    requestId: string;
    channel: "model" | "chatgpt_host";
    operation: "probe" | "create_session" | "resume_session" | "send_turn" | "cancel_turn" | "close_session" | "prepare_handoff";
    profileId: string;
    sessionId?: string;
    turnId?: string;
    payload: Record<string, unknown>;
};

type BrowserRuntimeHandler = (request: BrowserRuntimeRequest) => Promise<unknown>;

let activeHandler: BrowserRuntimeHandler | undefined;

export function registerBrowserRuntimeHandler(handler: BrowserRuntimeHandler) {
    activeHandler = handler;
    return () => {
        if (activeHandler === handler) activeHandler = undefined;
    };
}

export async function dispatchBrowserRuntimeRequest(request: BrowserRuntimeRequest) {
    if (!activeHandler) throw new Error("BROWSER_RUNTIME_HANDLER_UNAVAILABLE");
    return await activeHandler(request);
}
