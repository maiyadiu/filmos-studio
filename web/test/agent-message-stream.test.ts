import { expect, test } from "bun:test";
import { agentTextEvent, appendAgentChatMessage, scopedAgentStreamId } from "../src/lib/canvas/agent-message-stream";
import type { AgentChatItem } from "../src/stores/canvas/use-canvas-agent-store";

function ingest(messages: AgentChatItem[], event: Parameters<typeof agentTextEvent>[0]) {
    const item = agentTextEvent(event);
    expect(item).not.toBeNull();
    return appendAgentChatMessage(messages, { ...item!, id: `message-${messages.length}` });
}

test("repeated non-stream history IDs are merged once while distinct local errors remain", () => {
    const receipt: AgentChatItem = { id: "receipt", role: "tool", text: "原请求已保存" };
    const error: AgentChatItem = { id: "error", role: "error", text: "授权到期" };
    const once = [receipt, error].reduce((items, item) => appendAgentChatMessage(items, item), [receipt]);
    const twice = once.reduce((items, item) => appendAgentChatMessage(items, item), [receipt]);
    expect(once).toEqual([receipt, error]);
    expect(twice).toEqual(once);
    expect(appendAgentChatMessage(twice, { ...receipt, id: "different-receipt" })).toHaveLength(3);
});

test("raw deltas retain whitespace, repeated tokens and Markdown tables without heuristic deduplication", () => {
    let messages: AgentChatItem[] = [];
    const parts = ["## 剧本", "\n\n", "哈", "哈", "\n\n", "| 镜头 | 状态 |", "\n", "| --- | --- |", "\n", "| 10 | 已保存 |", "  ", "\n"];
    for (const delta of parts) messages = ingest(messages, { type: "message.delta", sessionId: "a", turnId: "t", delta });
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe(parts.join(""));
});

test("snapshots replay once and authoritative completion repairs interim text without merging distinct items", () => {
    const event = { sessionId: "a", turnId: "t", streamId: '["provider-t","item-1"]' };
    let messages = ingest([], { ...event, type: "message.delta", delta: "稿", text: "初稿" });
    messages = ingest(messages, { ...event, type: "message.delta", delta: "稿", text: "初稿" });
    expect(messages[0].text).toBe("初稿");
    messages = ingest(messages, { ...event, type: "message.completed", text: "最终\n\n正文\n" });
    messages = ingest(messages, { ...event, type: "message.delta", delta: "迟到", text: "初稿迟到" });
    expect(messages[0].text).toBe("最终\n\n正文\n");
    messages = ingest(messages, { ...event, streamId: "item-2", type: "message.completed", text: "另一个消息" });
    messages = ingest(messages, { ...event, sessionId: "b", type: "message.completed", text: "另一会话" });
    expect(messages).toHaveLength(3);
    expect(messages[0].id).toBe("message-0");
    expect(messages[0].streamId).toBe(scopedAgentStreamId("a", event.streamId));
});

test("recovered provider history and final event share one scoped stream, with exact empty completion", () => {
    const key = scopedAgentStreamId("a", "native-id");
    const history: AgentChatItem[] = [{ id: "history", role: "assistant", text: "原\n\n文", streamId: key, streamMode: "complete" }];
    const messages = ingest(history, { type: "message.completed", sessionId: "a", turnId: "t", streamId: "native-id", text: "" });
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("history");
    expect(messages[0].text).toBe("");
    expect(appendAgentChatMessage(messages, { id: "separate", role: "assistant", text: "单独回复" })).toHaveLength(2);
});

test("legacy item snapshots preserve paragraph breaks and final text", () => {
    let messages = ingest([], { type: "item.updated", item: { id: "legacy", type: "agent_message", text: "第一段\n\n" } });
    messages = ingest(messages, { type: "item.completed", item: { id: "legacy", type: "agent_message", text: "第一段\n\n第二段" } });
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("第一段\n\n第二段");
});
