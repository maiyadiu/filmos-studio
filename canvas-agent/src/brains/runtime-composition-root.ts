import { BrainAdapterFactory } from "./adapter-factory.js";
import type { AgentFeatureFlags } from "./feature-flags.js";
import { enabledAgentProfileIds } from "./feature-flags.js";
import { registerBuiltinBrainProfiles } from "./profiles.js";
import { BrainProfileRegistry } from "./registry.js";

export class BrainRuntimeCompositionRoot {
    constructor(
        private readonly registry: BrainProfileRegistry,
        private readonly factory: BrainAdapterFactory,
        private readonly featureFlags: AgentFeatureFlags,
    ) {}

    compose() {
        const enabled = enabledAgentProfileIds(this.featureFlags);
        registerBuiltinBrainProfiles(this.registry, enabled);
        for (const profileId of enabled) this.registry.registerAdapter(this.factory.create(profileId));
        const missing = [...enabled].filter((profileId) => !this.registry.hasAdapter(profileId));
        if (missing.length) throw new Error(`BRAIN_RUNTIME_COMPOSITION_INCOMPLETE:${missing.join(",")}`);
        return { enabledProfileIds: [...enabled], adapterProfileIds: [...enabled] };
    }
}
