import type { AgentRuntimeAdapter, BrainProfile, BrainRuntimeStatus } from "./contracts.js";

export class BrainProfileRegistry {
    private readonly profiles = new Map<string, BrainProfile>();
    private readonly adapters = new Map<string, AgentRuntimeAdapter>();

    registerProfile(profile: BrainProfile) {
        if (!profile.id.trim()) throw new Error("Brain profile id is required");
        if (this.profiles.has(profile.id)) throw new Error(`Brain profile already registered: ${profile.id}`);
        this.profiles.set(profile.id, structuredClone(profile));
        return this.getProfile(profile.id);
    }

    registerAdapter(adapter: AgentRuntimeAdapter) {
        const profile = this.profiles.get(adapter.profileId);
        if (!profile) throw new Error(`Brain profile is not registered: ${adapter.profileId}`);
        if (adapter.connectionId !== profile.id) {
            throw new Error(`Adapter connection ${adapter.connectionId} does not match profile ${profile.id}`);
        }
        if (this.adapters.has(adapter.connectionId)) throw new Error(`Brain adapter already registered: ${adapter.connectionId}`);
        this.adapters.set(adapter.connectionId, adapter);
        return adapter;
    }

    getProfile(profileId: string) {
        const profile = this.profiles.get(profileId);
        if (!profile) throw new Error(`Unknown brain profile: ${profileId}`);
        return structuredClone(profile);
    }

    getAdapter(profileId: string) {
        const adapter = this.adapters.get(profileId);
        if (!adapter) throw new Error(`Brain adapter is unavailable: ${profileId}`);
        return adapter;
    }

    hasAdapter(profileId: string) {
        return this.adapters.has(profileId);
    }

    listProfiles() {
        return [...this.profiles.values()].map((profile) => structuredClone(profile));
    }

    async probe(profileId: string): Promise<BrainRuntimeStatus> {
        const status = await this.getAdapter(profileId).probe();
        if (status.profileId !== profileId) throw new Error(`Probe returned mismatched profile: ${status.profileId}`);
        return structuredClone(status);
    }

    async probeAll() {
        return await Promise.all(this.listProfiles().map(async (profile) => {
            try {
                return await this.probe(profile.id);
            } catch (error) {
                return {
                    profileId: profile.id,
                    status: "error" as const,
                    statusReason: error instanceof Error ? error.message : String(error),
                    checkedAt: new Date().toISOString(),
                };
            }
        }));
    }
}
