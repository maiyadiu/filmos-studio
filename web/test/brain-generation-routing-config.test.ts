import { describe, expect, test } from "bun:test";

import {
    defaultBrainGenerationRoutingConfig,
    migrateLegacyAiConfig,
    normalizeBrainGenerationRoutingConfig,
} from "../src/film/generation-routing/user-config";
import { createModelChannel, defaultConfig } from "../src/stores/use-config-store";

const at = "2026-08-30T00:00:00.000Z";

describe("LOCAL-CONFIG-NO-LOGIN-DEPENDENCY-001", () => {
    test("default repository exposes six brains and five generation engines without secrets", async () => {
        const value = await defaultBrainGenerationRoutingConfig(at);
        expect(value.bindings.map((item) => item.profileId).sort()).toEqual([
            "anthropic.api", "chatgpt.subscription.host", "codex.subscription",
            "deepseek.api", "local.model", "openai.api",
        ]);
        expect(value.engineConnections.map((item) => item.engineId).sort()).toEqual([
            "comfyui", "dreamina_cli", "flova_cli", "manual_web", "runninghub",
        ]);
        expect(value.engineConnections.every((item) => /^filmos_instance_[0-9a-f-]{36}$/.test(item.connectionInstanceRef))).toBe(true);
        expect(JSON.stringify(value)).not.toMatch(/apiKey|runtimeKey|cookie|password|aliasMapping/i);
    });

    test("legacy migration binds only protocol-proven Claude and never guesses OpenAI or DeepSeek from names or URLs", async () => {
        const misleading = createModelChannel({ id: "misleading", name: "DeepSeek", baseUrl: "https://example.invalid/deepseek", apiKey: "not-persisted", apiFormat: "openai", models: ["deepseek-looking-name"] });
        const claude = { ...createModelChannel({ id: "claude-exact", name: "Neutral", baseUrl: "https://example.invalid", apiKey: "not-persisted", apiFormat: "claude", models: ["claude-exact-model"], providerKind: "anthropic", agentProtocol: "anthropic_messages", agentModelCapabilities: { "claude-exact-model": { text: true, toolCalling: true, structuredOutput: true, evidenceSource: "legacy-channel-contract", evidenceRevision: "v1" } } }), interfaceType: "claude-api" as const };
        const migrated = await migrateLegacyAiConfig({ ...defaultConfig, channels: [misleading, claude] }, at);
        expect(migrated.migration.status).toBe("SKIPPED_NEEDS_CONFIGURATION");
        expect(migrated.migration.ambiguousProfileIds).toEqual(["deepseek.api", "openai.api"]);
        expect(migrated.bindings.find((item) => item.profileId === "anthropic.api")).toMatchObject({ channelId: "claude-exact", modelId: "claude-exact-model", enabled: true });
        expect(migrated.bindings.find((item) => item.profileId === "deepseek.api")?.channelId).toBeUndefined();
        expect(JSON.stringify(migrated)).not.toContain("not-persisted");
    });

    test("schema normalization is idempotent after the one-time engine migration", async () => {
        const initial = await defaultBrainGenerationRoutingConfig(at);
        const legacyShape = { ...initial, engineConnections: [] };
        const migrated = await normalizeBrainGenerationRoutingConfig(legacyShape, at);
        expect(migrated.migration.status).toBe("MIGRATED_AUTOMATICALLY");
        expect(await normalizeBrainGenerationRoutingConfig(migrated, at)).toBe(migrated);
    });

    test("legacy enabled API/local bindings and ready account engines fail closed without exact evidence", async () => {
        const initial = await defaultBrainGenerationRoutingConfig(at);
        const openai = initial.bindings.find((item) => item.profileId === "openai.api")!;
        const dreamina = initial.engineConnections.find((item) => item.engineId === "dreamina_cli")!;
        const normalized = await normalizeBrainGenerationRoutingConfig({
            ...initial,
            bindings: initial.bindings.map((item) => item.profileId === "openai.api" ? { ...openai, enabled: true, channelId: "legacy-channel", modelId: "legacy-model" } : item),
            engineConnections: initial.engineConnections.map((item) => item.engineId === "dreamina_cli" ? { ...dreamina, status: "ready" } : item),
        }, at);
        expect(normalized.bindings.find((item) => item.profileId === "openai.api")).toMatchObject({ enabled: false });
        expect(normalized.engineConnections.find((item) => item.engineId === "dreamina_cli")).toMatchObject({ status: "not_configured" });
        expect(normalized.migration.status).toBe("SKIPPED_NEEDS_CONFIGURATION");
    });
});
