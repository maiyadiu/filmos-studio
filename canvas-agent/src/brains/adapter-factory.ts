import type { AgentRuntimeAdapter } from "./contracts.js";
import { ChatGPTHostedAdapter, type ChatGPTHostBridgeClient } from "./adapters/chatgpt-hosted-adapter.js";
import { HumanOnlyAdapter } from "./adapters/human-only-adapter.js";
import { LocalModelAdapter } from "./adapters/local-model-adapter.js";
import { ModelApiBrainAdapter, type ModelApiCompatibilityPort } from "./adapters/model-api-brain-adapter.js";

export type BrainAdapterFactoryOptions = {
    codex: AgentRuntimeAdapter;
    chatgptHost: ChatGPTHostBridgeClient;
    browserModelRuntime: ModelApiCompatibilityPort;
    explicitlyEnabled: (profileId: string) => boolean;
};

export class BrainAdapterFactory {
    constructor(private readonly options: BrainAdapterFactoryOptions) {}

    create(profileId: string): AgentRuntimeAdapter {
        if (profileId === "codex.subscription") {
            if (this.options.codex.profileId !== profileId || this.options.codex.connectionId !== profileId) throw new Error("CODEX_ADAPTER_IDENTITY_MISMATCH");
            return this.options.codex;
        }
        if (profileId === "chatgpt.subscription.host") return new ChatGPTHostedAdapter(this.options.chatgptHost);
        if (profileId === "local.model") return new LocalModelAdapter(this.options.browserModelRuntime);
        if (profileId === "human.only") return new HumanOnlyAdapter();
        if (["openai.api", "anthropic.api", "deepseek.api"].includes(profileId)) {
            return new ModelApiBrainAdapter({
                profileId,
                port: this.options.browserModelRuntime,
                explicitlyEnabled: () => this.options.explicitlyEnabled(profileId),
            });
        }
        throw new Error(`BRAIN_ADAPTER_FACTORY_UNSUPPORTED:${profileId}`);
    }
}
