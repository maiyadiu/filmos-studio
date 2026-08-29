import { describe, expect, test } from "bun:test";

import { MODEL_API_AGENT_TOOLS, MODEL_API_AGENT_TOOL_MANIFEST, MODEL_API_READ_TOOL_NAMES } from "./model-api-tool-manifest.ts";

describe("Model API compatibility tool manifest", () => {
    test("converts one manifest into provider tools and risk decisions", () => {
        expect(MODEL_API_AGENT_TOOLS.length).toBe(MODEL_API_AGENT_TOOL_MANIFEST.length);
        expect(new Set(MODEL_API_AGENT_TOOLS.map((tool) => tool.function.name)).size).toBe(MODEL_API_AGENT_TOOLS.length);
        expect(MODEL_API_READ_TOOL_NAMES.has("canvas_get_context")).toBe(true);
        expect(MODEL_API_READ_TOOL_NAMES.has("canvas_validate_ops")).toBe(true);
        expect(MODEL_API_READ_TOOL_NAMES.has("canvas_delete_nodes")).toBe(false);
        expect(MODEL_API_AGENT_TOOL_MANIFEST.find((entry) => entry.tool.function.name === "canvas_generate_image")?.risk).toBe("paid");
        expect(MODEL_API_AGENT_TOOL_MANIFEST.find((entry) => entry.tool.function.name === "canvas_delete_nodes")?.risk).toBe("destructive");
    });

    test("the React panel no longer owns a parallel provider tool schema", async () => {
        const source = await Bun.file(new URL("../../components/canvas/canvas-assistant-panel.tsx", import.meta.url)).text();
        expect(source.includes("ONLINE_AGENT_TOOLS")).toBe(false);
        expect(source.includes("function toolDefinition")).toBe(false);
        expect(source.includes("MODEL_API_AGENT_TOOLS")).toBe(true);
    });
});
