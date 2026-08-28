import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const hash = (character: string) => character.repeat(64);
const ref = (entityType: string, contentHash: string) => ({
  filmEntityId: randomUUID(),
  entityType,
  version: 1,
  contentHash,
});

describe("Golden C local spatial projection", () => {
  test("binds three independent camera chains to one SceneTwin without formal apply", () => {
    const sceneTwin = {
      ...ref("scene_twin_version", hash("a")),
      coordinateSystem: "right_handed_y_up_meters",
      fixedArchitectureIds: ["wall-main", "door-frame"],
      fixedPropIds: ["table-fixed"],
      portalIds: ["portal-door"],
      walkableZoneIds: ["walk-room"],
      anchorIds: ["anchor-table", "anchor-door"],
      cameraZoneIds: ["zone-entry-wide", "zone-left-close", "zone-right-close"],
      approvedViewFamilyIds: ["entry-axis-wide", "axis-a-close", "axis-b-reverse"],
      passLineage: { rgb: hash("b"), depth: hash("c"), normal: hash("d"), object_id: hash("e") },
    };
    const plan = [
      ["zone-entry-wide", "entry-axis-wide"],
      ["zone-left-close", "axis-a-close"],
      ["zone-right-close", "axis-b-reverse"],
    ];
    const chains = plan.map(([cameraZoneId, approvedViewFamilyId], index) => {
      const shot = ref("shot_extension", hash("f"));
      const camera = {
        ...ref("camera_version", hash(String(index + 1))),
        sceneTwinId: sceneTwin.filmEntityId,
        positionAnchorId: "anchor-door",
        targetAnchorId: "anchor-table",
        axisId: "axis-main",
        cameraZoneId,
        approvedViewFamilyId,
      };
      const blocking = {
        ...ref("blocking_version", hash(String(index + 4))),
        sceneTwinId: sceneTwin.filmEntityId,
        cameraId: camera.filmEntityId,
        walkableZoneIds: ["walk-room"],
        anchorIds: index === 0 ? ["anchor-table"] : ["anchor-door"],
        actors: [{
          feetAnchorId: "anchor-table",
          torsoRotationDegrees: { x: 0, y: 90, z: 0 },
          faceTargetId: "character-b",
          gazeTargetId: "character-b",
          leftHandTargetId: null,
          rightHandTargetId: "table-fixed",
          targetPropIds: ["table-fixed"],
        }],
      };
      const composition = {
        ...ref("composition_version", hash(String(index + 7))),
        sceneTwinId: sceneTwin.filmEntityId,
        cameraId: camera.filmEntityId,
        blockingId: blocking.filmEntityId,
        safeArea: { left: 0.08, right: 0.08, top: 0.1, bottom: 0.12 },
        occlusionConstraints: [{ occluderId: "table-fixed", subjectId: "character-a", maxOcclusionRatio: 0.15 }],
      };
      return {
        shot,
        camera,
        blocking,
        composition,
        previs: {
          projectionId: randomUUID(),
          sourceHashes: {
            sceneTwin: sceneTwin.contentHash,
            camera: camera.contentHash,
            blocking: blocking.contentHash,
            composition: composition.contentHash,
          },
          outputHash: hash("9"),
          formalApply: false,
          approvalState: "not_approved",
        },
      };
    });
    const result = spawnSync("bun", ["tests/film-golden/golden_c_local.ts"], {
      cwd: ROOT,
      input: JSON.stringify({ sceneTwin, chains }),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.testStatus).toBe("PASSED");
    expect(receipt.formalApply).toBe(false);
    expect(receipt.externalProviderCalls).toBe(0);
    expect(receipt.fallbackMockUsed).toBe(false);
    expect(Object.values(receipt.checks).every(Boolean)).toBe(true);
    expect(receipt.receiptHash).toHaveLength(64);
  });
});
