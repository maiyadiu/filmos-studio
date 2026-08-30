import { describe, expect, test } from "bun:test";

import {
    buildGenerationRoutePreviewProjection,
    createGenerationRoutePreviewHash,
} from "../src/film/generation-routing/preview-contract";

describe("Generation Composer preview contract", () => {
    test("manual route omits absent descriptor fields instead of hashing undefined", async () => {
        const input = {
            engineId: "manual_web",
            connectionId: "manual",
            mode: "image",
            prompt: "zero-cost preview",
            nativeSize: "9:16",
            deliveryResolution: "native",
            draftVersion: 1,
        };
        const projection = buildGenerationRoutePreviewProjection(input);
        expect(projection).not.toHaveProperty("modelId");
        expect(projection).not.toHaveProperty("workflowId");
        expect(await createGenerationRoutePreviewHash(input)).toMatch(/^[0-9a-f]{64}$/);
    });

    test("exact selected descriptor is retained when present", async () => {
        const projection = buildGenerationRoutePreviewProjection({
            engineId: "dreamina_cli",
            connectionId: "dreamina-local",
            mode: "video",
            modelId: "dreamina-video-exact",
            prompt: "exact descriptor",
            nativeSize: "16:9",
            deliveryResolution: "1080p",
            draftVersion: 2,
        });
        expect(projection).toMatchObject({ modelId: "dreamina-video-exact" });
        expect(projection).not.toHaveProperty("workflowId");
    });
});
