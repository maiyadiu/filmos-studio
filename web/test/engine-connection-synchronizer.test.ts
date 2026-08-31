import { describe, expect, test } from "bun:test";

import {
    EngineConnectionSynchronizer,
    configuredEngineConnectionObservation,
    dreaminaConnectionObservation,
    flovaProjectSelectionObservation,
} from "@/film/generation-routing/engine-connection-synchronizer";
import { createLocalAccountBindingRefResolver } from "@/film/generation-routing/local-account-binding-ref";
import { defaultBrainGenerationRoutingConfig } from "@/film/generation-routing/user-config";

const observedAt = "2026-08-31T08:00:00.000Z";
const accountBindingRefResolver = createLocalAccountBindingRefResolver(async () => new Uint8Array(32).fill(7));

describe("real engine connection synchronization", () => {
    test("Dreamina authenticated Runtime rotates opaque binding and invalidates an old default route", async () => {
        const config = await defaultBrainGenerationRoutingConfig("2026-08-31T00:00:00.000Z");
        const current = config.engineConnections.find((item) => item.engineId === "dreamina_cli")!;
        config.generationDefaults.text_to_image = { engineId: current.engineId, connectionId: current.connectionId, modelId: "seedream-obsolete" };
        const observation = await dreaminaConnectionObservation({
            current,
            accountBindingRefResolver,
            runtimeConnected: true,
            moduleAvailable: true,
            observedAt,
            status: { provider: "dreamina-cli", state: "authenticated", installed: true, authenticated: true, accountBinding: "private-account-source", message: "ready" },
        });
        const result = await new EngineConnectionSynchronizer().synchronize(config, [observation]);
        expect(result.config.engineConnections.find((item) => item.engineId === "dreamina_cli")).toMatchObject({ status: "ready", lastCheckedAt: observedAt });
        expect(result.bindingRotatedConnectionIds).toEqual([current.connectionId]);
        expect(result.config.generationDefaults.text_to_image).toBeUndefined();
        expect(JSON.stringify(result.config)).not.toContain("private-account-source");
    });

    test("RunningHub and ComfyUI project their single source Doctor state without copying secrets", async () => {
        const config = await defaultBrainGenerationRoutingConfig("2026-08-31T00:00:00.000Z");
        const runningHub = config.engineConnections.find((item) => item.engineId === "runninghub")!;
        const comfy = config.engineConnections.find((item) => item.engineId === "comfyui")!;
        const observations = await Promise.all([
            configuredEngineConnectionObservation({ current: runningHub, configured: true, doctorPassed: true, accountSource: "runninghub-private-account", observedAt, accountBindingRefResolver }),
            configuredEngineConnectionObservation({ current: comfy, configured: true, doctorPassed: true, observedAt }),
        ]);
        const result = await new EngineConnectionSynchronizer().synchronize(config, observations);
        expect(result.config.engineConnections.find((item) => item.engineId === "runninghub")?.status).toBe("ready");
        expect(result.config.engineConnections.find((item) => item.engineId === "comfyui")?.status).toBe("ready");
        expect(JSON.stringify(result.config)).not.toContain("runninghub-private-account");
    });

    test("Flova remains non-routable until an existing Project and authenticated Doctor are both observed", async () => {
        const config = await defaultBrainGenerationRoutingConfig("2026-08-31T00:00:00.000Z");
        const current = config.engineConnections.find((item) => item.engineId === "flova_cli")!;
        const unselected = await flovaProjectSelectionObservation({ current, doctorPassed: false, observedAt });
        expect(unselected).toMatchObject({ status: "not_configured", errorCode: "READY_FOR_USER_SELECTION" });
        const selected = await flovaProjectSelectionObservation({ current, externalProjectId: "existing-project", doctorPassed: false, observedAt });
        expect(selected.status).toBe("auth_required");
        const ready = await flovaProjectSelectionObservation({ current, externalProjectId: "existing-project", doctorPassed: true, authenticatedAccountSource: "private-flova-account", observedAt, accountBindingRefResolver });
        const result = await new EngineConnectionSynchronizer().synchronize(config, [ready]);
        expect(result.config.engineConnections.find((item) => item.engineId === "flova_cli")?.status).toBe("ready");
        expect(JSON.stringify(result.config)).not.toContain("private-flova-account");
    });
});
