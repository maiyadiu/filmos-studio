import { describe, expect, test } from "bun:test";

import { BRAIN_PROFILE_PRESENTATIONS, brainProfilePresentation, normalizeBrainProfileId } from "./brain-profiles.ts";
import { readActiveBrainProfile, writeActiveBrainProfile } from "@/pages/canvas/use-canvas-assistant-visibility.ts";
import { useCanvasAgentStore } from "@/stores/canvas/use-canvas-agent-store.ts";

describe("native Brain selector", () => {
    test("lists the six product profiles with truthful billing and interaction surfaces", () => {
        expect(BRAIN_PROFILE_PRESENTATIONS.map((item) => item.label)).toEqual(["Codex", "ChatGPT", "OpenAI", "Claude", "DeepSeek", "Local"]);
        expect(brainProfilePresentation("codex.subscription").billing).toBe("订阅");
        expect(brainProfilePresentation("chatgpt.subscription.host").interaction).toBe("hosted");
        expect(brainProfilePresentation("openai.api").billing).toBe("API 计费");
    });

    test("migrates old website/local preferences and persists the selected profile", () => {
        const values = new Map([["filmos.agent.activeBrainProfileId", "local"]]);
        const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
        expect(readActiveBrainProfile(storage)).toBe("codex.subscription");
        expect(writeActiveBrainProfile("deepseek.api", storage)).toBe("deepseek.api");
        expect(values.get("filmos.agent.activeBrainProfileId")).toBe("deepseek.api");
        expect(normalizeBrainProfileId("online")).toBe("openai.api");
    });

    test("keeps per-project and per-profile session histories isolated", () => {
        const first = [{ id: "codex-chat", title: "Codex", messages: [], createdAt: "2026-08-29T00:00:00Z", updatedAt: "2026-08-29T00:00:00Z" }];
        const second = [{ id: "api-chat", title: "API", messages: [], createdAt: "2026-08-29T00:00:00Z", updatedAt: "2026-08-29T00:00:00Z" }];
        useCanvasAgentStore.getState().saveProfileSessions("project-a:codex.subscription", first, "codex-chat");
        useCanvasAgentStore.getState().saveProfileSessions("project-a:openai.api", second, "api-chat");
        const state = useCanvasAgentStore.getState().profileSessions;
        expect(state["project-a:codex.subscription"].activeSessionId).toBe("codex-chat");
        expect(state["project-a:openai.api"].activeSessionId).toBe("api-chat");
        expect(state["project-a:codex.subscription"].sessions[0].id).not.toBe(state["project-a:openai.api"].sessions[0].id);
    });
});
