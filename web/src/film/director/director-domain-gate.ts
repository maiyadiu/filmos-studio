export const FILM_DIRECTOR_DEFAULT_ENABLED = false;

export type FilmReviewIntent = "draft" | "candidate" | "review_required" | "approved";
export type AxisSide = "left" | "right" | "on_axis";
export type InteractionHand = "left" | "right" | "both";
export type DirectorResolutionLevel = "R0" | "R1" | "R2" | "R3" | "R4";

export type DirectorWriteIntent = {
    directorUnitId: string;
    expectedVersion: number;
    expectedContentHash: string;
    sourceAuthority: "film_core" | "canvas_projection" | "three_d_projection";
    formalApply: boolean;
    reviewIntent: FilmReviewIntent;
};

export type DirectorShotCoverage = {
    coverageId: string;
    directorUnitId: string;
    shotId: string;
    purpose: string;
};

export type DirectorAxisContract = {
    axisId: string;
    fromAnchorId: string;
    toAnchorId: string;
    cameraSide: AxisSide;
    crossing: "locked" | "declared";
};

export type ActorBlocking = {
    actorId: string;
    feetStateInAnchorId: string;
    feetStateOutAnchorId: string;
    torsoFacingTargetId: string;
    faceTargetId: string;
    gazeTargetId: string;
    leftHandTargetId?: string;
    rightHandTargetId?: string;
    actionStateIn: string;
    actionStateOut: string;
    axisSideIn: AxisSide;
    axisSideOut: AxisSide;
};

export type PropInteraction = {
    interactionId: string;
    actorId: string;
    propId: string;
    targetAnchorId: string;
    hand: InteractionHand;
    action: string;
    contactStateIn: string;
    contactStateOut: string;
};

export type CameraContract = {
    cameraVersionId: string;
    positionAnchorId: string;
    targetAnchorId: string;
    cameraSide: AxisSide;
    lensMm: number;
    fovDegrees: number;
};

export type ActorContinuityOut = {
    actorId: string;
    feetAnchorId: string;
    torsoFacingTargetId: string;
    faceTargetId: string;
    gazeTargetId: string;
    leftHandTargetId?: string;
    rightHandTargetId?: string;
    actionState: string;
    axisSide: AxisSide;
};

export type PropContinuityOut = {
    propId: string;
    contactState: string;
};

export type DirectorContinuityIn = {
    axisId: string;
    cameraSide: AxisSide;
    actors: ActorContinuityOut[];
    props: PropContinuityOut[];
};

export type DirectorContinuityContract = {
    sceneTwinId: string;
    blockingVersionId: string;
    axis: DirectorAxisContract;
    camera: CameraContract;
    actors: ActorBlocking[];
    propInteractions: PropInteraction[];
    continuityIn?: DirectorContinuityIn;
};

export type DirectorDomainGateInput = {
    enabled?: boolean;
    write: DirectorWriteIntent;
    directorUnitIds: string[];
    shotIds: string[];
    coverage: DirectorShotCoverage[];
    continuity: DirectorContinuityContract;
};

export type DirectorGateIssue = {
    code: string;
    path: string;
    message: string;
};

export type DirectorGateResult = {
    state: "disabled" | "blocked" | "ready";
    issues: DirectorGateIssue[];
};

export type DirectorProjection = {
    authority: "projection_only";
    formalMutationAllowed: false;
    approvalAllowed: false;
    source: {
        directorUnitId: string;
        sceneTwinId: string;
        blockingVersionId: string;
        cameraVersionId: string;
        expectedVersion: number;
        expectedContentHash: string;
    };
    entityIds: string[];
    coverageIds: string[];
    renderPasses: readonly ["rgb", "depth", "normal", "object_id"];
};

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;

export function isFilmDirectorEnabled(explicit?: boolean) {
    return explicit ?? FILM_DIRECTOR_DEFAULT_ENABLED;
}

export function evaluateDirectorDomainGate(input: DirectorDomainGateInput): DirectorGateResult {
    if (!isFilmDirectorEnabled(input.enabled)) return { state: "disabled", issues: [] };
    const issues: DirectorGateIssue[] = [];

    validateWriteIntent(input.write, issues);
    const directorUnitIds = validateUuidSet(input.directorUnitIds, "directorUnitIds", issues);
    const shotIds = validateUuidSet(input.shotIds, "shotIds", issues);
    validateCoverage(input.coverage, directorUnitIds, shotIds, issues);
    validateContinuity(input.continuity, issues);

    if (!directorUnitIds.has(input.write.directorUnitId)) {
        issue(issues, "DIRECTOR_UNIT_NOT_IN_GRAPH", "write.directorUnitId", "写入目标不在本次 DirectorUnit 图中");
    }
    return { state: issues.length ? "blocked" : "ready", issues };
}

export function buildDirectorProjection(input: DirectorDomainGateInput): DirectorProjection {
    const gate = evaluateDirectorDomainGate({ ...input, enabled: true });
    if (gate.state !== "ready") {
        throw new Error(`导演领域门禁未通过：${gate.issues.map((item) => item.code).join(", ")}`);
    }
    return {
        authority: "projection_only",
        formalMutationAllowed: false,
        approvalAllowed: false,
        source: {
            directorUnitId: input.write.directorUnitId,
            sceneTwinId: input.continuity.sceneTwinId,
            blockingVersionId: input.continuity.blockingVersionId,
            cameraVersionId: input.continuity.camera.cameraVersionId,
            expectedVersion: input.write.expectedVersion,
            expectedContentHash: input.write.expectedContentHash,
        },
        entityIds: Array.from(new Set([...input.directorUnitIds, ...input.shotIds, ...input.continuity.actors.map((actor) => actor.actorId), ...input.continuity.propInteractions.map((interaction) => interaction.propId)])).sort(),
        coverageIds: input.coverage.map((item) => item.coverageId).sort(),
        renderPasses: ["rgb", "depth", "normal", "object_id"],
    };
}

export function selectDirectorResolution(input: { hasSceneTwin: boolean; stateCount: number; actorCount: number; requiresComplexBlenderSpace: boolean }): DirectorResolutionLevel {
    if (!input.hasSceneTwin) return "R0";
    if (input.requiresComplexBlenderSpace) return "R4";
    if (input.stateCount > 2 || input.actorCount > 1) return "R3";
    if (input.stateCount === 2) return "R2";
    return "R1";
}

function validateWriteIntent(write: DirectorWriteIntent, issues: DirectorGateIssue[]) {
    requireUuid(write.directorUnitId, "write.directorUnitId", issues);
    if (!Number.isSafeInteger(write.expectedVersion) || write.expectedVersion < 0) {
        issue(issues, "EXPECTED_VERSION_INVALID", "write.expectedVersion", "正式写入必须携带非负 expected_version");
    }
    if (!SHA_256_PATTERN.test(write.expectedContentHash)) {
        issue(issues, "EXPECTED_HASH_INVALID", "write.expectedContentHash", "正式写入必须携带小写 SHA-256 content hash");
    }
    if (write.reviewIntent === "approved") {
        issue(issues, "AUTO_APPROVAL_FORBIDDEN", "write.reviewIntent", "导演台、3D 或 Canvas 结果不得自动进入 Approved");
    }
    if (write.sourceAuthority !== "film_core" && (write.formalApply || write.reviewIntent !== "candidate")) {
        issue(issues, "PROJECTION_CANNOT_WRITE_FACTS", "write.sourceAuthority", "3D/Canvas 只能提交 Candidate 投影，不能写正式影视事实");
    }
}

function validateUuidSet(ids: string[], path: string, issues: DirectorGateIssue[]) {
    const result = new Set<string>();
    ids.forEach((id, index) => {
        requireUuid(id, `${path}[${index}]`, issues);
        if (result.has(id)) issue(issues, "DUPLICATE_ID", `${path}[${index}]`, "同一实体 ID 不得重复");
        result.add(id);
    });
    return result;
}

function validateCoverage(coverage: DirectorShotCoverage[], directorUnitIds: Set<string>, shotIds: Set<string>, issues: DirectorGateIssue[]) {
    const pairs = new Set<string>();
    coverage.forEach((item, index) => {
        const path = `coverage[${index}]`;
        requireUuid(item.coverageId, `${path}.coverageId`, issues);
        requireUuid(item.directorUnitId, `${path}.directorUnitId`, issues);
        requireUuid(item.shotId, `${path}.shotId`, issues);
        requireText(item.purpose, `${path}.purpose`, "Coverage 必须声明叙事/表演覆盖目的", issues);
        if (!directorUnitIds.has(item.directorUnitId)) issue(issues, "UNKNOWN_DIRECTOR_UNIT", `${path}.directorUnitId`, "Coverage 引用了未知 DirectorUnit");
        if (!shotIds.has(item.shotId)) issue(issues, "UNKNOWN_SHOT", `${path}.shotId`, "Coverage 引用了未知 Shot");
        const pair = `${item.directorUnitId}:${item.shotId}`;
        if (pairs.has(pair)) issue(issues, "DUPLICATE_COVERAGE", path, "同一 DirectorUnit/Shot Coverage 不得重复");
        pairs.add(pair);
    });
}

function validateContinuity(contract: DirectorContinuityContract, issues: DirectorGateIssue[]) {
    requireUuid(contract.sceneTwinId, "continuity.sceneTwinId", issues);
    requireUuid(contract.blockingVersionId, "continuity.blockingVersionId", issues);
    validateAxis(contract.axis, issues);
    validateCamera(contract.camera, contract.axis, issues);

    const actors = new Map<string, ActorBlocking>();
    contract.actors.forEach((actor, index) => {
        validateActor(actor, `continuity.actors[${index}]`, issues);
        if (actors.has(actor.actorId)) issue(issues, "DUPLICATE_ACTOR_BLOCKING", `continuity.actors[${index}].actorId`, "同一演员只能有一条当前 Blocking 链");
        actors.set(actor.actorId, actor);
    });
    contract.propInteractions.forEach((interaction, index) => validatePropInteraction(interaction, actors, `continuity.propInteractions[${index}]`, issues));
    if (contract.continuityIn) validateContinuityIn(contract, actors, issues);
}

function validateAxis(axis: DirectorAxisContract, issues: DirectorGateIssue[]) {
    requireUuid(axis.axisId, "continuity.axis.axisId", issues);
    requireUuid(axis.fromAnchorId, "continuity.axis.fromAnchorId", issues);
    requireUuid(axis.toAnchorId, "continuity.axis.toAnchorId", issues);
    if (axis.fromAnchorId === axis.toAnchorId) issue(issues, "AXIS_DEGENERATE", "continuity.axis", "轴线起点与终点不能相同");
}

function validateCamera(camera: CameraContract, axis: DirectorAxisContract, issues: DirectorGateIssue[]) {
    requireUuid(camera.cameraVersionId, "continuity.camera.cameraVersionId", issues);
    requireUuid(camera.positionAnchorId, "continuity.camera.positionAnchorId", issues);
    requireUuid(camera.targetAnchorId, "continuity.camera.targetAnchorId", issues);
    if (!Number.isFinite(camera.lensMm) || camera.lensMm <= 0) issue(issues, "LENS_INVALID", "continuity.camera.lensMm", "镜头焦距必须大于 0");
    if (!Number.isFinite(camera.fovDegrees) || camera.fovDegrees <= 0 || camera.fovDegrees >= 180) issue(issues, "FOV_INVALID", "continuity.camera.fovDegrees", "FOV 必须在 0 到 180 度之间");
    if (camera.cameraSide !== axis.cameraSide) issue(issues, "CAMERA_AXIS_SIDE_MISMATCH", "continuity.camera.cameraSide", "CameraVersion 与轴线合同的机位侧不一致");
}

function validateActor(actor: ActorBlocking, path: string, issues: DirectorGateIssue[]) {
    requireUuid(actor.actorId, `${path}.actorId`, issues);
    requireUuid(actor.feetStateInAnchorId, `${path}.feetStateInAnchorId`, issues);
    requireUuid(actor.feetStateOutAnchorId, `${path}.feetStateOutAnchorId`, issues);
    requireUuid(actor.torsoFacingTargetId, `${path}.torsoFacingTargetId`, issues);
    requireUuid(actor.faceTargetId, `${path}.faceTargetId`, issues);
    requireUuid(actor.gazeTargetId, `${path}.gazeTargetId`, issues);
    if (actor.leftHandTargetId) requireUuid(actor.leftHandTargetId, `${path}.leftHandTargetId`, issues);
    if (actor.rightHandTargetId) requireUuid(actor.rightHandTargetId, `${path}.rightHandTargetId`, issues);
    requireText(actor.actionStateIn, `${path}.actionStateIn`, "必须声明动作入状态", issues);
    requireText(actor.actionStateOut, `${path}.actionStateOut`, "必须声明动作出状态", issues);
}

function validatePropInteraction(interaction: PropInteraction, actors: Map<string, ActorBlocking>, path: string, issues: DirectorGateIssue[]) {
    requireUuid(interaction.interactionId, `${path}.interactionId`, issues);
    requireUuid(interaction.actorId, `${path}.actorId`, issues);
    requireUuid(interaction.propId, `${path}.propId`, issues);
    requireUuid(interaction.targetAnchorId, `${path}.targetAnchorId`, issues);
    requireText(interaction.action, `${path}.action`, "道具交互必须声明动作", issues);
    requireText(interaction.contactStateIn, `${path}.contactStateIn`, "道具交互必须声明接触入状态", issues);
    requireText(interaction.contactStateOut, `${path}.contactStateOut`, "道具交互必须声明接触出状态", issues);
    const actor = actors.get(interaction.actorId);
    if (!actor) {
        issue(issues, "INTERACTION_ACTOR_MISSING", `${path}.actorId`, "道具交互演员没有 Blocking 链");
        return;
    }
    const leftMatches = actor.leftHandTargetId === interaction.propId;
    const rightMatches = actor.rightHandTargetId === interaction.propId;
    const handMatches = interaction.hand === "left" ? leftMatches : interaction.hand === "right" ? rightMatches : leftMatches && rightMatches;
    if (!handMatches) issue(issues, "HAND_PROP_CHAIN_BROKEN", `${path}.hand`, "手部目标与交互道具不一致，人物-手-目标道具链不完整");
}

function validateContinuityIn(contract: DirectorContinuityContract, actors: Map<string, ActorBlocking>, issues: DirectorGateIssue[]) {
    const previous = contract.continuityIn!;
    requireUuid(previous.axisId, "continuity.continuityIn.axisId", issues);
    if (previous.axisId !== contract.axis.axisId) issue(issues, "AXIS_ID_CHANGED", "continuity.continuityIn.axisId", "连续 Shot 必须显式沿用同一轴线，或建立新的连续性段");
    if (previous.cameraSide !== contract.camera.cameraSide && contract.axis.crossing !== "declared") {
        issue(issues, "UNDECLARED_AXIS_CROSSING", "continuity.axis.crossing", "机位跨轴必须显式声明");
    }
    previous.actors.forEach((out, index) => {
        const path = `continuity.continuityIn.actors[${index}]`;
        requireUuid(out.actorId, `${path}.actorId`, issues);
        requireUuid(out.feetAnchorId, `${path}.feetAnchorId`, issues);
        requireUuid(out.torsoFacingTargetId, `${path}.torsoFacingTargetId`, issues);
        requireUuid(out.faceTargetId, `${path}.faceTargetId`, issues);
        requireUuid(out.gazeTargetId, `${path}.gazeTargetId`, issues);
        if (out.leftHandTargetId) requireUuid(out.leftHandTargetId, `${path}.leftHandTargetId`, issues);
        if (out.rightHandTargetId) requireUuid(out.rightHandTargetId, `${path}.rightHandTargetId`, issues);
        requireText(out.actionState, `${path}.actionState`, "上一 Shot 必须提供动作出状态", issues);
        const actor = actors.get(out.actorId);
        if (!actor) {
            issue(issues, "CONTINUITY_ACTOR_MISSING", `${path}.actorId`, "上一 Shot 的演员在当前 Blocking 中缺失");
            return;
        }
        compareContinuity(out.feetAnchorId, actor.feetStateInAnchorId, "FEET_CONTINUITY_BROKEN", `${path}.feetAnchorId`, issues);
        compareContinuity(out.torsoFacingTargetId, actor.torsoFacingTargetId, "TORSO_CONTINUITY_BROKEN", `${path}.torsoFacingTargetId`, issues);
        compareContinuity(out.faceTargetId, actor.faceTargetId, "FACE_CONTINUITY_BROKEN", `${path}.faceTargetId`, issues);
        compareContinuity(out.gazeTargetId, actor.gazeTargetId, "EYELINE_CONTINUITY_BROKEN", `${path}.gazeTargetId`, issues);
        compareContinuity(out.leftHandTargetId, actor.leftHandTargetId, "LEFT_HAND_CONTINUITY_BROKEN", `${path}.leftHandTargetId`, issues);
        compareContinuity(out.rightHandTargetId, actor.rightHandTargetId, "RIGHT_HAND_CONTINUITY_BROKEN", `${path}.rightHandTargetId`, issues);
        compareContinuity(out.actionState, actor.actionStateIn, "ACTION_CONTINUITY_BROKEN", `${path}.actionState`, issues);
        compareContinuity(out.axisSide, actor.axisSideIn, "ACTOR_AXIS_SIDE_BROKEN", `${path}.axisSide`, issues);
    });
    const interactionsByProp = new Map(contract.propInteractions.map((item) => [item.propId, item]));
    previous.props.forEach((out, index) => {
        requireUuid(out.propId, `continuity.continuityIn.props[${index}].propId`, issues);
        requireText(out.contactState, `continuity.continuityIn.props[${index}].contactState`, "上一 Shot 必须提供道具接触出状态", issues);
        const interaction = interactionsByProp.get(out.propId);
        if (interaction && interaction.contactStateIn !== out.contactState) {
            issue(issues, "PROP_STATE_CONTINUITY_BROKEN", `continuity.continuityIn.props[${index}].contactState`, "道具上一 Shot 出状态与当前交互入状态不一致");
        }
    });
}

function compareContinuity(previous: string | undefined, current: string | undefined, code: string, path: string, issues: DirectorGateIssue[]) {
    if (previous !== current) issue(issues, code, path, "上一 Shot 出状态与当前 Shot 入状态不一致");
}

function requireUuid(value: string, path: string, issues: DirectorGateIssue[]) {
    if (!UUID_V4_PATTERN.test(value)) issue(issues, "FILM_UUID_V4_REQUIRED", path, "正式身份必须是 Film Core UUIDv4");
}

function requireText(value: string, path: string, message: string, issues: DirectorGateIssue[]) {
    if (!value.trim()) issue(issues, "REQUIRED_TEXT_MISSING", path, message);
}

function issue(issues: DirectorGateIssue[], code: string, path: string, message: string) {
    issues.push({ code, path, message });
}
