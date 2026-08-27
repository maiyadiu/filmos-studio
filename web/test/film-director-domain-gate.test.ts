import { describe, expect, test } from "bun:test";

import { FILM_DIRECTOR_DEFAULT_ENABLED, buildDirectorProjection, evaluateDirectorDomainGate, selectDirectorResolution, type DirectorDomainGateInput } from "../src/film/director/director-domain-gate";

const ID = {
    director1: "11111111-1111-4111-8111-111111111111",
    director2: "22222222-2222-4222-8222-222222222222",
    shot1: "33333333-3333-4333-8333-333333333333",
    shot2: "44444444-4444-4444-8444-444444444444",
    coverage1: "55555555-5555-4555-8555-555555555551",
    coverage2: "55555555-5555-4555-8555-555555555552",
    coverage3: "55555555-5555-4555-8555-555555555553",
    sceneTwin: "66666666-6666-4666-8666-666666666666",
    blocking: "77777777-7777-4777-8777-777777777777",
    axis: "88888888-8888-4888-8888-888888888888",
    anchorA: "99999999-9999-4999-8999-999999999991",
    anchorB: "99999999-9999-4999-8999-999999999992",
    anchorC: "99999999-9999-4999-8999-999999999993",
    camera: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    actor: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    prop: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    interaction: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};

describe("Film director domain gate", () => {
    test("defaults off", () => {
        expect(FILM_DIRECTOR_DEFAULT_ENABLED).toBe(false);
        expect(evaluateDirectorDomainGate({ ...validInput(), enabled: undefined })).toEqual({ state: "disabled", issues: [] });
    });

    test("accepts many-to-many DirectorUnit/Shot coverage", () => {
        const input = validInput();
        input.directorUnitIds.push(ID.director2);
        input.coverage.push(
            { coverageId: ID.coverage2, directorUnitId: ID.director1, shotId: ID.shot2, purpose: "同一导演节拍覆盖反应镜头" },
            { coverageId: ID.coverage3, directorUnitId: ID.director2, shotId: ID.shot2, purpose: "同一镜头承接第二导演节拍" },
        );
        expect(evaluateDirectorDomainGate(input)).toEqual({ state: "ready", issues: [] });
    });

    test("blocks auto approval and projection writes", () => {
        const input = validInput();
        input.write = { ...input.write, sourceAuthority: "three_d_projection", formalApply: true, reviewIntent: "approved" };
        const result = evaluateDirectorDomainGate(input);
        expect(result.state).toBe("blocked");
        expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining(["AUTO_APPROVAL_FORBIDDEN", "PROJECTION_CANNOT_WRITE_FACTS"]));
    });

    test("requires UUIDv4, expected_version and content hash", () => {
        const input = validInput();
        input.write = { ...input.write, directorUnitId: "director-1", expectedVersion: -1, expectedContentHash: "bad" };
        const codes = evaluateDirectorDomainGate(input).issues.map((item) => item.code);
        expect(codes).toEqual(expect.arrayContaining(["FILM_UUID_V4_REQUIRED", "EXPECTED_VERSION_INVALID", "EXPECTED_HASH_INVALID", "DIRECTOR_UNIT_NOT_IN_GRAPH"]));
    });

    test("blocks an undeclared axis crossing and broken feet-to-prop interaction chain", () => {
        const input = validInput();
        input.continuity.continuityIn = {
            axisId: ID.axis,
            cameraSide: "right",
            actors: [
                {
                    actorId: ID.actor,
                    feetAnchorId: ID.anchorB,
                    torsoFacingTargetId: ID.anchorB,
                    faceTargetId: ID.anchorB,
                    gazeTargetId: ID.anchorB,
                    leftHandTargetId: ID.prop,
                    actionState: "拿住茶杯",
                    axisSide: "left",
                },
            ],
            props: [{ propId: ID.prop, contactState: "左手持有" }],
        };
        input.continuity.actors[0] = {
            ...input.continuity.actors[0],
            feetStateInAnchorId: ID.anchorA,
            leftHandTargetId: undefined,
        };
        const codes = evaluateDirectorDomainGate(input).issues.map((item) => item.code);
        expect(codes).toEqual(expect.arrayContaining(["UNDECLARED_AXIS_CROSSING", "FEET_CONTINUITY_BROKEN", "LEFT_HAND_CONTINUITY_BROKEN", "HAND_PROP_CHAIN_BROKEN"]));
    });

    test("3D/Canvas output is projection-only and cannot approve", () => {
        const projection = buildDirectorProjection(validInput());
        expect(projection).toMatchObject({ authority: "projection_only", formalMutationAllowed: false, approvalAllowed: false });
        expect(projection.targetRenderPasses).toEqual(["rgb", "depth", "normal", "object_id"]);
        expect(projection.objectIdPassState).toBe("MISSING_NOT_IMPLEMENTED");
        expect(Object.keys(projection)).not.toContain("approved");
    });

    test("projection builder cannot bypass the default-off feature gate", () => {
        const input = validInput();
        input.enabled = undefined;
        expect(() => buildDirectorProjection(input)).toThrow("导演领域门禁未通过");
    });

    test("rejects ambiguous prop state and non-lowercase formal identities", () => {
        const input = validInput();
        input.continuity.propInteractions.push({ ...input.continuity.propInteractions[0]!, interactionId: ID.coverage2 });
        input.continuity.camera.cameraVersionId = ID.camera.toUpperCase();
        const codes = evaluateDirectorDomainGate(input).issues.map((item) => item.code);
        expect(codes).toEqual(expect.arrayContaining(["AMBIGUOUS_PROP_INTERACTION", "FILM_UUID_V4_REQUIRED"]));
    });

    test("selects R0-R4 without launching Blender", () => {
        expect(selectDirectorResolution({ hasSceneTwin: false, stateCount: 0, actorCount: 0, requiresComplexBlenderSpace: false })).toBe("R0");
        expect(selectDirectorResolution({ hasSceneTwin: true, stateCount: 1, actorCount: 1, requiresComplexBlenderSpace: false })).toBe("R1");
        expect(selectDirectorResolution({ hasSceneTwin: true, stateCount: 2, actorCount: 1, requiresComplexBlenderSpace: false })).toBe("R2");
        expect(selectDirectorResolution({ hasSceneTwin: true, stateCount: 3, actorCount: 2, requiresComplexBlenderSpace: false })).toBe("R3");
        expect(selectDirectorResolution({ hasSceneTwin: true, stateCount: 2, actorCount: 1, requiresComplexBlenderSpace: true })).toBe("R4");
    });
});

function validInput(): DirectorDomainGateInput {
    return {
        enabled: true,
        write: {
            directorUnitId: ID.director1,
            expectedVersion: 4,
            expectedContentHash: "e".repeat(64),
            sourceAuthority: "film_core",
            formalApply: true,
            reviewIntent: "review_required",
        },
        directorUnitIds: [ID.director1],
        shotIds: [ID.shot1, ID.shot2],
        coverage: [{ coverageId: ID.coverage1, directorUnitId: ID.director1, shotId: ID.shot1, purpose: "覆盖进入、停顿与视线转移" }],
        continuity: {
            sceneTwinId: ID.sceneTwin,
            blockingVersionId: ID.blocking,
            axis: { axisId: ID.axis, fromAnchorId: ID.anchorA, toAnchorId: ID.anchorB, cameraSide: "left", crossing: "locked" },
            camera: { cameraVersionId: ID.camera, positionAnchorId: ID.anchorC, targetAnchorId: ID.anchorB, cameraSide: "left", lensMm: 50, fovDegrees: 39.6 },
            actors: [
                {
                    actorId: ID.actor,
                    feetStateInAnchorId: ID.anchorA,
                    feetStateOutAnchorId: ID.anchorB,
                    torsoFacingTargetId: ID.anchorB,
                    faceTargetId: ID.anchorB,
                    gazeTargetId: ID.anchorB,
                    leftHandTargetId: ID.prop,
                    actionStateIn: "伸手接杯",
                    actionStateOut: "拿住茶杯",
                    axisSideIn: "left",
                    axisSideOut: "left",
                },
            ],
            propInteractions: [
                {
                    interactionId: ID.interaction,
                    actorId: ID.actor,
                    propId: ID.prop,
                    targetAnchorId: ID.anchorB,
                    hand: "left",
                    action: "左手握住杯柄",
                    contactStateIn: "桌面静置",
                    contactStateOut: "左手持有",
                },
            ],
        },
    };
}
