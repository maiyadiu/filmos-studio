import { createHash } from "node:crypto";

type Ref = {
  filmEntityId: string;
  entityType: string;
  version: number;
  contentHash: string;
};

type CameraChain = {
  shot: Ref;
  camera: Ref & {
    sceneTwinId: string;
    positionAnchorId: string;
    targetAnchorId: string;
    axisId: string;
    cameraZoneId: string;
    approvedViewFamilyId: string;
  };
  blocking: Ref & {
    sceneTwinId: string;
    cameraId: string;
    walkableZoneIds: string[];
    anchorIds: string[];
    actors: Array<{
      feetAnchorId: string;
      torsoRotationDegrees: Record<string, number>;
      faceTargetId: string;
      gazeTargetId: string;
      leftHandTargetId: string | null;
      rightHandTargetId: string | null;
      targetPropIds: string[];
    }>;
  };
  composition: Ref & {
    sceneTwinId: string;
    cameraId: string;
    blockingId: string;
    safeArea: Record<"left" | "right" | "top" | "bottom", number>;
    occlusionConstraints: Array<{ occluderId: string; subjectId: string; maxOcclusionRatio: number }>;
  };
  previs: {
    projectionId: string;
    sourceHashes: Record<string, string>;
    outputHash: string;
    formalApply: false;
    approvalState: "not_approved";
  };
};

type GoldenCLocalInput = {
  sceneTwin: Ref & {
    coordinateSystem: string;
    fixedArchitectureIds: string[];
    fixedPropIds: string[];
    portalIds: string[];
    walkableZoneIds: string[];
    anchorIds: string[];
    cameraZoneIds: string[];
    approvedViewFamilyIds: string[];
    passLineage: Record<"rgb" | "depth" | "normal" | "object_id", string>;
  };
  chains: CameraChain[];
};

const raw = await Bun.stdin.text();
const input = JSON.parse(raw) as GoldenCLocalInput;
const ids = (items: Ref[]) => new Set(items.map((item) => item.filmEntityId));
const allIndependent =
  ids(input.chains.map((item) => item.camera)).size === input.chains.length &&
  ids(input.chains.map((item) => item.blocking)).size === input.chains.length &&
  ids(input.chains.map((item) => item.composition)).size === input.chains.length;
const currentSceneBound = input.chains.every((chain) =>
  [chain.camera.sceneTwinId, chain.blocking.sceneTwinId, chain.composition.sceneTwinId]
    .every((value) => value === input.sceneTwin.filmEntityId),
);
const cameraZonesValid = input.chains.every((chain) =>
  input.sceneTwin.cameraZoneIds.includes(chain.camera.cameraZoneId),
);
const cameraAxisAndAnchorsValid = input.chains.every((chain) =>
  chain.camera.axisId.length > 0 &&
  input.sceneTwin.anchorIds.includes(chain.camera.positionAnchorId) &&
  input.sceneTwin.anchorIds.includes(chain.camera.targetAnchorId),
);
const viewFamiliesValid = input.chains.every((chain) =>
  input.sceneTwin.approvedViewFamilyIds.includes(chain.camera.approvedViewFamilyId),
);
const blockingValid = input.chains.every((chain) =>
  chain.blocking.cameraId === chain.camera.filmEntityId &&
  chain.blocking.walkableZoneIds.every((value) => input.sceneTwin.walkableZoneIds.includes(value)) &&
  chain.blocking.anchorIds.every((value) => input.sceneTwin.anchorIds.includes(value)),
);
const blockingInteractionChainComplete = input.chains.every((chain) =>
  chain.blocking.actors.length > 0 && chain.blocking.actors.every((actor) =>
    input.sceneTwin.anchorIds.includes(actor.feetAnchorId) &&
    Object.keys(actor.torsoRotationDegrees).length === 3 &&
    actor.faceTargetId.length > 0 &&
    actor.gazeTargetId.length > 0 &&
    (actor.leftHandTargetId !== null || actor.rightHandTargetId !== null) &&
    actor.targetPropIds.length > 0
  ),
);
const compositionValid = input.chains.every((chain) =>
  chain.composition.cameraId === chain.camera.filmEntityId &&
  chain.composition.blockingId === chain.blocking.filmEntityId,
);
const compositionSafetyValid = input.chains.every((chain) =>
  Object.values(chain.composition.safeArea).every((margin) => margin >= 0 && margin < 0.5) &&
  chain.composition.occlusionConstraints.length > 0 &&
  chain.composition.occlusionConstraints.every((item) => item.maxOcclusionRatio >= 0 && item.maxOcclusionRatio <= 1),
);
const previsBound = input.chains.every((chain) => {
  const expected = {
    sceneTwin: input.sceneTwin.contentHash,
    camera: chain.camera.contentHash,
    blocking: chain.blocking.contentHash,
    composition: chain.composition.contentHash,
  };
  return JSON.stringify(chain.previs.sourceHashes) === JSON.stringify(expected) &&
    chain.previs.formalApply === false &&
    chain.previs.approvalState === "not_approved";
});
const passLineageComplete = ["rgb", "depth", "normal", "object_id"].every(
  (key) => /^[0-9a-f]{64}$/.test(input.sceneTwin.passLineage[key as keyof typeof input.sceneTwin.passLineage]),
);
const requiredCollectionsPresent = [
  input.sceneTwin.fixedArchitectureIds,
  input.sceneTwin.fixedPropIds,
  input.sceneTwin.portalIds,
  input.sceneTwin.walkableZoneIds,
  input.sceneTwin.anchorIds,
  input.sceneTwin.cameraZoneIds,
  input.sceneTwin.approvedViewFamilyIds,
].every((items) => items.length > 0);

const checks = {
  threeCameraChains: input.chains.length === 3,
  independentVersions: allIndependent,
  currentSceneBound,
  cameraZonesValid,
  cameraAxisAndAnchorsValid,
  viewFamiliesValid,
  blockingValid,
  blockingInteractionChainComplete,
  compositionValid,
  compositionSafetyValid,
  previsBound,
  passLineageComplete,
  requiredCollectionsPresent,
};
const receiptHash = createHash("sha256")
  .update(JSON.stringify({ sceneTwin: input.sceneTwin.filmEntityId, checks }))
  .digest("hex");

process.stdout.write(JSON.stringify({
  goldenId: "GOLDEN-C-LOCAL",
  testStatus: Object.values(checks).every(Boolean) ? "PASSED" : "FAILED",
  formalApply: false,
  externalProviderCalls: 0,
  fallbackMockUsed: false,
  checks,
  receiptHash,
}));
