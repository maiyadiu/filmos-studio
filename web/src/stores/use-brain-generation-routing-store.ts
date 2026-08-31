import { create } from "zustand";
import type { BrainProfileBinding, GenerationTaskKind, UserSelectableBrainProfileId } from "@filmos/generation-contracts";

import {
    defaultBrainGenerationRoutingConfig,
    migrateLegacyAiConfig,
    normalizeBrainGenerationRoutingConfig,
    readBrainGenerationRoutingConfig,
    updateBrainBinding,
    writeBrainGenerationRoutingConfig,
    type BrainGenerationRoutingConfig,
    type DesktopUserConfigDocument,
} from "@/film/generation-routing/user-config";
import { EngineConnectionSynchronizer, type EngineConnectionObservation } from "@/film/generation-routing/engine-connection-synchronizer";
import type { AiConfig } from "@/stores/use-config-store";

type RoutingStore = {
    status: "idle" | "loading" | "ready" | "unavailable" | "saving" | "error";
    config: BrainGenerationRoutingConfig | null;
    document: DesktopUserConfigDocument | null;
    error: string;
    initialize(legacy: AiConfig): Promise<void>;
    setGlobalDefault(profileId: UserSelectableBrainProfileId): Promise<void>;
    updateBinding(profileId: UserSelectableBrainProfileId, patch: Partial<Pick<BrainProfileBinding, "enabled" | "channelId" | "modelId" | "providerKind" | "protocol" | "modelCapabilityEvidence">>): Promise<void>;
    setGenerationDefault(taskKind: GenerationTaskKind, route: { engineId: string; connectionId: string; modelId?: string; workflowId?: string; skillId?: string }): Promise<void>;
    synchronizeEngineConnections(observations: readonly EngineConnectionObservation[]): Promise<void>;
};

let initialization: Promise<void> | undefined;
const engineConnectionSynchronizer = new EngineConnectionSynchronizer();

export const useBrainGenerationRoutingStore = create<RoutingStore>((set, get) => {
    const save = async (next: BrainGenerationRoutingConfig) => {
        const document = get().document;
        if (!document) throw new Error("DESKTOP_USER_CONFIG_REPOSITORY_UNAVAILABLE");
        set({ status: "saving", error: "" });
        const saved = await writeBrainGenerationRoutingConfig(document, next);
        set({ status: "ready", config: next, document: saved, error: "" });
    };
    return {
        status: "idle",
        config: null,
        document: null,
        error: "",
        initialize: async (legacy) => {
            initialization ??= (async () => {
                set({ status: "loading", error: "" });
                try {
                    const document = await readBrainGenerationRoutingConfig();
                    if (document.payload.brain_generation_routing) {
                        const normalized = await normalizeBrainGenerationRoutingConfig(document.payload.brain_generation_routing);
                        if (normalized !== document.payload.brain_generation_routing) {
                            const saved = await writeBrainGenerationRoutingConfig(document, normalized);
                            set({ status: "ready", config: normalized, document: saved });
                            return;
                        }
                        set({ status: "ready", config: normalized, document });
                        return;
                    }
                    const migrated = legacy.channels.length ? await migrateLegacyAiConfig(legacy) : await defaultBrainGenerationRoutingConfig();
                    const saved = await writeBrainGenerationRoutingConfig(document, migrated);
                    set({ status: "ready", config: migrated, document: saved });
                } catch (error) {
                    // Source browser/dev mode can render defaults, but it is never presented as Desktop authority.
                    const fallback = await defaultBrainGenerationRoutingConfig();
                    set({ status: "unavailable", config: fallback, document: null, error: error instanceof Error ? error.message : "本地配置仓不可用" });
                }
            })();
            await initialization;
        },
        setGlobalDefault: async (profileId) => {
            const current = get().config;
            if (!current) throw new Error("BRAIN_ROUTING_CONFIG_NOT_READY");
            await save({ ...current, globalDefaultProfileId: profileId });
        },
        updateBinding: async (profileId, patch) => {
            const current = get().config;
            if (!current) throw new Error("BRAIN_ROUTING_CONFIG_NOT_READY");
            await save(await updateBrainBinding(current, profileId, patch));
        },
        setGenerationDefault: async (taskKind, route) => {
            const current = get().config;
            if (!current) throw new Error("BRAIN_ROUTING_CONFIG_NOT_READY");
            await save({ ...current, generationDefaults: { ...current.generationDefaults, [taskKind]: route } });
        },
        synchronizeEngineConnections: async (observations) => {
            const current = get().config;
            if (!current) throw new Error("BRAIN_ROUTING_CONFIG_NOT_READY");
            const synchronized = await engineConnectionSynchronizer.synchronize(current, observations);
            if (synchronized.config !== current) await save(synchronized.config);
        },
    };
});

export function exactBrainBinding(profileId: string): BrainProfileBinding | undefined {
    return useBrainGenerationRoutingStore.getState().config?.bindings.find((item) => item.profileId === profileId && item.enabled);
}
