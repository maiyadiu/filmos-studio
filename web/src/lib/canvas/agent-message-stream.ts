import type { AgentChatItem } from "@/stores/canvas/use-canvas-agent-store";

type TextEvent = {
    type?: string;
    sessionId?: string;
    turnId?: string;
    streamId?: string;
    delta?: string;
    text?: string;
    item?: { id?: string; type?: string; text?: unknown };
};

export function scopedAgentStreamId(sessionId: string, streamId: string) {
    return JSON.stringify([sessionId, streamId]);
}

export function agentTextEvent(event: TextEvent): Omit<AgentChatItem, "id"> | null {
    if (event.type === "message.delta" || event.type === "message.completed") {
        const complete = event.type === "message.completed";
        const snapshot = typeof event.text === "string";
        const text = snapshot ? event.text! : event.delta;
        if (typeof text !== "string") return null;
        return {
            role: "assistant", title: "Codex", text,
            streamId: scopedAgentStreamId(event.sessionId || "", event.streamId || event.turnId || "message"),
            streamMode: complete ? "complete" : snapshot ? "snapshot" : "append",
        };
    }
    if ((event.type === "item.updated" || event.type === "item.completed") && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        return { role: "assistant", title: "Codex", text: event.item.text, streamId: event.item.id, streamMode: event.type === "item.completed" ? "complete" : "snapshot" };
    }
    return null;
}

/** Delta text is not prose to normalize: spaces, repeated tokens and Markdown breaks are data. */
export function appendAgentChatMessage(messages: AgentChatItem[], next: AgentChatItem): AgentChatItem[] {
    const index = messages.findIndex((item) => item.role === next.role && (item.id === next.id || Boolean(next.streamId && item.streamId === next.streamId)));
    if (index < 0) return [...messages, next].slice(-120);
    const previous = messages[index];
    if (previous.streamMode === "complete" && next.streamMode !== "complete") return messages;
    const text = next.streamMode === "append" ? previous.text + next.text : next.text;
    return messages.map((item, i) => i === index ? { ...item, ...next, id: item.id, text } : item);
}
