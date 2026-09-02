import { requestDesktopRpc } from "@/film/adapters/yingce/desktop-rpc-client";

export function requestDesktopChatGPTHost(operation: "publish_context" | "publish_handoff", payload: Record<string, unknown>) {
    return requestDesktopRpc({ action: "chatgptHostRequest", operation, payload }, {
        timeoutMs: 15_000,
        timeoutCode: "CHATGPT_DESKTOP_SECURE_BRIDGE_TIMEOUT",
        unavailableCode: "CHATGPT_DESKTOP_SECURE_BRIDGE_UNAVAILABLE",
    });
}
