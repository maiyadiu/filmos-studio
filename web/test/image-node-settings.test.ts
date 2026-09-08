import { expect, test } from "bun:test";
import { defaultConfig, effectiveConfigWithDreamina, normalizeModelOptionValue, selectableModelsByCapability } from "../src/stores/use-config-store";
import { modelCapabilityConfigFor } from "../src/lib/model-capabilities";
import { resolveCanvasGenerationModel, buildGenerationConfig } from "../src/lib/canvas/canvas-project-generation";
import { resolveModelGenerationDefaults } from "../src/lib/model-selection";
import { CanvasNodeType } from "../src/types/canvas";
import type { DreaminaLocalModel } from "../src/services/local-dreamina-model-catalog";
import { imageSettingsPopoverLayout } from "../src/components/canvas/canvas-image-settings-popover";
import { generationFailureMetadata } from "../src/lib/generation-error";

const model: DreaminaLocalModel = { provider: "dreamina-cli", id: "4.7", displayName: "4.7", modality: "image", adapterSupported: true, accountEntitlement: "unknown", currentlyObservedAvailable: "unknown", operations: ["text-to-image", "image-to-image"], settings: { aliases: [], aspects: ["1:1", "16:9", "9:16"], tiers: ["1k", "2k", "4k"], maxReferenceImages: 10 }, source: "runtime-execution-contract" };
const config = effectiveConfigWithDreamina({ ...defaultConfig, channels: [], models: [], imageModel: "", model: "" }, "ready", [model]);
const selected = "local:dreamina-cli:4.7";

test("Dreamina selection retains the exact catalog ID across normalization and canvas resolution", () => {
  expect(selectableModelsByCapability(config, "image")).toEqual([selected]);
  for (const input of [selected, "4.7", "local:dreamina-cli::4.7"]) {
    expect(normalizeModelOptionValue(input, config.channels)).toBe(selected);
    expect(resolveCanvasGenerationModel(config, input, "image")).toBe(selected);
  }
  expect(resolveCanvasGenerationModel(config, selected, "video")).toBe("");
  expect(normalizeModelOptionValue("local:dreamina-cli:missing", config.channels)).toBe("");
});

test("Dreamina image controls use the local catalog contract, not generic API PNG/pixel defaults", () => {
  const image = modelCapabilityConfigFor(config, selected).image!;
  expect(image.size).toEqual({ parameter: "aspect_ratio", values: model.settings.aspects, default: "1:1", allowCustom: false });
  expect(image.quality.values).toEqual(["auto", "1k", "2k", "4k"]);
  expect(image.transparentBackground.supported).toBe(false);
  expect(image.references.maxImages).toBe(10);
});

test("supported ratio survives switch and generation config; unsupported settings are normalized", () => {
  const params = resolveModelGenerationDefaults(config, selected, "image", { size: "16:9", quality: "2k", count: "2" });
  expect(params).toMatchObject({ size: "16:9", quality: "2k", count: "2" });
  const node = { id: "image-fixture", type: CanvasNodeType.Image, title: "fixture", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { model: selected, ...params, count: 2 } };
  expect(buildGenerationConfig(config, node, "image")).toMatchObject({ model: selected, size: "16:9", quality: "2k", count: "2" });
  expect(resolveModelGenerationDefaults(config, selected, "image", { size: "999x111", quality: "high", transparentBackground: "true" })).toMatchObject({ size: "1:1", quality: "auto", transparentBackground: "false" });
});

test("settings popover flips and stays within narrow or short viewports", () => {
  for (const viewport of [{ width: 360, height: 640 }, { width: 1200, height: 240 }]) {
    for (const y of [16, 120, viewport.height - 40]) {
      const layout = imageSettingsPopoverLayout({ left: 500, right: 700, width: 200, top: y, bottom: y + 28 }, viewport);
      expect(layout.left).toBeGreaterThanOrEqual(12);
      expect(layout.left + layout.width).toBeLessThanOrEqual(viewport.width - 12);
      expect(layout.maxHeight).toBeGreaterThanOrEqual(0);
      const edge = "top" in layout ? layout.top! : layout.bottom!;
      expect(edge).toBeGreaterThanOrEqual(12);
      expect(edge + layout.maxHeight).toBeLessThanOrEqual(viewport.height - 12);
    }
  }
});

test("failure metadata preserves stable policy codes with clear copy, never raw provider body", () => {
  const error = Object.assign(new Error("unsafe-provider-body"), { code: "dreamina_external_paid_submit_disabled" });
  const metadata = generationFailureMetadata(error, "fixture");
  expect(metadata.generationErrorCode).toBe(error.code);
  expect(metadata.errorDetails).toContain("尚未开放外部生成");
  expect(metadata.errorDetails).not.toContain("unsafe-provider-body");
});
