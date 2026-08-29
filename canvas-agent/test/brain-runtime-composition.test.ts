import assert from "node:assert/strict";
import test from "node:test";

import { BrainAdapterFactory } from "../src/brains/adapter-factory.js";
import { BrowserChatGPTHostBridgeClient, BrowserModelRuntimePort, type BrowserRuntimeRequest, type BrowserRuntimeTransport } from "../src/brains/browser-runtime-port.js";
import { resolveAgentFeatureFlags } from "../src/brains/feature-flags.js";
import { BrainProfileRegistry } from "../src/brains/registry.js";
import { BrainRuntimeCompositionRoot } from "../src/brains/runtime-composition-root.js";
import { adapter } from "./brain-test-fixtures.js";

test("production composition registers one real adapter for every enabled profile", async () => {
    const requests: BrowserRuntimeRequest[] = [];
    const transport: BrowserRuntimeTransport = {
        hasConnectedBrowser: () => true,
        request: async <T>(input: BrowserRuntimeRequest) => {
            requests.push(input);
            if (input.channel === "chatgpt_host") return {
                ready: true,
                profileId: "chatgpt.subscription.host",
                billingMode: "subscription_host_no_extra_model_api",
                modelApiAdapterAvailable: false,
                fallbackEnabled: false,
            } as T;
            return { status: "ready" } as T;
        },
    };
    const flags = resolveAgentFeatureFlags({
        "film.agent_native_brain_selector": true,
        "film.agent_generic_runtime": true,
        "film.agent_context_broker": true,
        "film.agent_canonical_tool_manifest": true,
        "film.agent_canonical_tool_broker": true,
        "film.agent_codex_subscription": true,
        "film.agent_chatgpt_host": true,
        "film.agent_model_api_profiles": true,
        "film.agent_no_silent_api_fallback": true,
        "film.agent_request_scoped_identity": true,
    }, {});
    const registry = new BrainProfileRegistry();
    const browserModelRuntime = new BrowserModelRuntimePort(transport);
    const factory = new BrainAdapterFactory({
        codex: adapter("codex.subscription"),
        chatgptHost: new BrowserChatGPTHostBridgeClient(transport),
        browserModelRuntime,
        explicitlyEnabled: () => true,
    });
    const composed = new BrainRuntimeCompositionRoot(registry, factory, flags).compose();

    assert.deepEqual(new Set(composed.enabledProfileIds), new Set([
        "codex.subscription",
        "chatgpt.subscription.host",
        "openai.api",
        "anthropic.api",
        "deepseek.api",
        "local.model",
        "human.only",
    ]));
    for (const profileId of composed.enabledProfileIds) assert.equal(registry.hasAdapter(profileId), true, profileId);
    assert.equal((await registry.probe("chatgpt.subscription.host")).status, "ready");
    assert.equal((await registry.probe("openai.api")).status, "ready");
    assert.equal((await registry.probe("local.model")).status, "ready");
    assert.equal((await registry.probe("human.only")).status, "ready");
    assert.equal(requests.some((request) => request.channel === "chatgpt_host"), true);
    assert.equal(requests.some((request) => request.channel === "model" && request.profileId === "openai.api"), true);
});
