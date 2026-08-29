import { canonicalAgentToolsByName } from "@filmos/agent-tool-contracts";

import type { AgentToolManifest, AgentToolSurfaceId } from "./contracts.js";
import { CANONICAL_AGENT_TOOL_METADATA } from "./tool-manifest-source.js";

export { CANONICAL_AGENT_TOOL_METADATA } from "./tool-manifest-source.js";

const generatedTools: ReadonlyMap<string, (typeof canonicalAgentToolsByName extends Map<unknown, infer Value> ? Value : never)> = canonicalAgentToolsByName;

export const CANONICAL_AGENT_TOOL_MANIFEST: readonly AgentToolManifest[] = CANONICAL_AGENT_TOOL_METADATA.map((metadata) => {
    const generated = generatedTools.get(metadata.name);
    if (!generated) throw new Error(`AGENT_TOOL_GENERATED_CONTRACT_MISSING:${metadata.name}`);
    if (generated.risk !== metadata.risk
        || generated.provider !== metadata.provider
        || generated.requires_fresh_context !== metadata.requiresFreshContext
        || generated.may_create_charges !== metadata.mayCreateCharges
        || !sameStrings(generated.surfaces, metadata.surfaces)) {
        throw new Error(`AGENT_TOOL_GENERATED_METADATA_STALE:${metadata.name}`);
    }
    return {
        ...metadata,
        inputSchema: structuredClone(generated.input_schema) as Record<string, unknown>,
    };
});

export class CanonicalAgentToolManifest {
    private readonly tools = new Map(CANONICAL_AGENT_TOOL_MANIFEST.map((tool) => [tool.name, tool]));

    get(name: string) {
        const tool = this.tools.get(name);
        if (!tool) throw new Error(`AGENT_TOOL_NOT_IN_CANONICAL_MANIFEST:${name}`);
        return structuredClone(tool);
    }

    list(surface?: AgentToolSurfaceId) {
        return [...this.tools.values()]
            .filter((tool) => !surface || tool.surfaces.includes(surface))
            .map((tool) => structuredClone(tool));
    }

    names(surface: AgentToolSurfaceId) {
        return this.list(surface).map((tool) => tool.name);
    }
}

function sameStrings(left: readonly string[], right: readonly string[]) {
    return [...left].sort().join("\n") === [...right].sort().join("\n");
}
