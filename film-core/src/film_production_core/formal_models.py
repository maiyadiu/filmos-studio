from __future__ import annotations

import re
from datetime import datetime
from enum import Enum
from typing import Annotated, Any, Literal, TypeAlias

from pydantic import Field, UUID4, field_validator, model_validator

from film_production_core.models import (
    ActorKind,
    EntityType,
    FilmEntityRef,
    FormalStateAxes,
    HostReferences,
    StrictModel,
)


ZERO_CONTENT_HASH = "0" * 64
HASH_PATTERN = r"^[0-9a-f]{64}$"
OPAQUE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
PROVIDER_ID_PATTERN = r"^[a-z][a-z0-9._-]{2,63}$"
CAPABILITY_ID_PATTERN = r"^[a-z][a-z0-9._-]{1,63}$"
MIME_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9.+-]*/[A-Za-z0-9][A-Za-z0-9.+-]*$"
SECRET_KEY_PATTERN = re.compile(
    r"(?:api[_-]?key|secret|token|cookie|authorization|password|credential)",
    re.IGNORECASE,
)
LOCATOR_KEY_PATTERN = re.compile(
    r"(?:^|[_-])(?:url|uri|path|file|filename|upload|base64|binary)(?:$|[_-])",
    re.IGNORECASE,
)
FORBIDDEN_LOCATOR_PATTERN = re.compile(
    r"^(?:data:|blob:|file:|https?://|/|~/|[A-Za-z]:[\\/])",
    re.IGNORECASE,
)


class ProviderSubmissionState(str, Enum):
    NOT_SUBMITTED = "NOT_SUBMITTED"


class GeneratedResultState(str, Enum):
    CANDIDATE_ONLY = "CANDIDATE_ONLY"


class ApprovalBoundaryState(str, Enum):
    SEPARATE_HUMAN_ACTION_REQUIRED = "SEPARATE_HUMAN_ACTION_REQUIRED"


class ReviewKind(str, Enum):
    HUMAN = "human"
    AGENT = "agent"
    AUTOMATED_QC = "automated_qc"


class ReviewOutcome(str, Enum):
    CHANGES_REQUESTED = "changes_requested"
    REJECTED = "rejected"
    PASSED = "passed"


class ManualSourceKind(str, Enum):
    PROVIDER_CONSOLE = "provider_console"
    MANUAL_DOWNLOAD = "manual_download"
    LOCAL_RUNTIME_EXPORT = "local_runtime_export"
    OTHER_AUTHORIZED = "other_authorized"


class OutputKind(str, Enum):
    TEXT = "text"
    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"
    WORKFLOW = "workflow"
    THREE_D = "three_d"


class ContinuityDimension(str, Enum):
    AXIS = "axis"
    EYELINE = "eyeline"
    ACTION = "action"
    PROP_CONTACT = "prop_contact"
    BLOCKING = "blocking"


class CreateTargetGuard(StrictModel):
    target_id: None
    expected_version: Literal[0]
    expected_content_hash: str = Field(pattern=HASH_PATTERN)

    @field_validator("expected_content_hash")
    @classmethod
    def require_zero_hash(cls, value: str) -> str:
        if value != ZERO_CONTENT_HASH:
            raise ValueError("create target expected_content_hash must be all-zero")
        return value


class EntityVersionGuard(StrictModel):
    film_entity_id: UUID4
    expected_version: int = Field(ge=1)
    expected_content_hash: str = Field(pattern=HASH_PATTERN)


class BoundEntityReference(StrictModel):
    film_entity_id: UUID4
    entity_type: str = Field(min_length=1, max_length=64)
    expected_version: int = Field(ge=1)
    expected_content_hash: str = Field(pattern=HASH_PATTERN)
    host: HostReferences


class ScriptVersion(StrictModel):
    ref: FilmEntityRef
    host: HostReferences
    states: FormalStateAxes
    source_script_version_id: UUID4 | None
    script_text: str
    script_text_hash: str = Field(pattern=HASH_PATTERN)


class ScriptDecision(StrictModel):
    ref: FilmEntityRef
    source_script_version_id: UUID4
    locked_script_version_id: UUID4
    locked_script_version_content_hash: str = Field(pattern=HASH_PATTERN)
    decision: Literal["approve_for_lock"]
    approved_by: str = Field(min_length=1, max_length=256)


class DirectorUnit(StrictModel):
    ref: FilmEntityRef
    script_version_id: UUID4
    states: FormalStateAxes
    director_ir_text: str = Field(min_length=1)
    director_ir_hash: str = Field(pattern=HASH_PATTERN)
    narrative_purpose: str = Field(min_length=1)
    performance_beats: list[str] = Field(default_factory=list)


class CoverageLink(StrictModel):
    ref: FilmEntityRef
    director_unit_id: UUID4
    shot_id: UUID4
    purpose: str = Field(min_length=1)


class VisualLockSet(StrictModel):
    ref: FilmEntityRef
    project_id: UUID4
    shot_id: UUID4
    states: FormalStateAxes
    visual_lock_text: str = Field(min_length=1)
    visual_lock_hash: str = Field(pattern=HASH_PATTERN)
    locks: dict[str, Any]

    @field_validator("locks")
    @classmethod
    def validate_locks(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_safe_json_object(value, "locks")


class AssetBinding(StrictModel):
    ref: FilmEntityRef
    project_id: UUID4
    host: HostReferences
    role: str = Field(min_length=1, max_length=128)
    priority: int = Field(ge=0, le=100)
    asset_content_hash: str = Field(pattern=HASH_PATTERN)


class PromptDraft(StrictModel):
    ref: FilmEntityRef
    states: FormalStateAxes
    director_ir_hash: str = Field(pattern=HASH_PATTERN)
    visual_lock_hash: str = Field(pattern=HASH_PATTERN)
    model_capability_profile: str = Field(min_length=1)
    prompt_text: str = Field(min_length=1)


class PromptTemplateBinding(StrictModel):
    host_prompt_template_id: str = Field(min_length=1, max_length=256)
    operation: str = Field(min_length=1, max_length=128)
    version: int = Field(ge=1)
    content_hash: str = Field(pattern=HASH_PATTERN)

    @field_validator("host_prompt_template_id")
    @classmethod
    def validate_host_id(cls, value: str) -> str:
        return require_opaque_id(value, "host_prompt_template_id")


class PromptAssetBinding(StrictModel):
    binding: BoundEntityReference
    asset_content_hash: str = Field(pattern=HASH_PATTERN)


class ProviderCapabilityProfile(StrictModel):
    profile_id: str = Field(min_length=1, max_length=128)
    profile_version: int = Field(ge=1)
    provider_id: str = Field(pattern=PROVIDER_ID_PATTERN)
    output_kind: OutputKind
    dialect: str = Field(min_length=1, max_length=128)
    capabilities: dict[str, Any]

    @field_validator("capabilities")
    @classmethod
    def validate_capabilities(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_safe_json_object(value, "capabilities")


class ProviderParameters(StrictModel):
    aspect_ratio: str | None
    duration_seconds: float | None
    seed: int | None
    negative_prompt: str | None

    @model_validator(mode="after")
    def validate_values(self) -> ProviderParameters:
        if self.aspect_ratio is not None and not self.aspect_ratio.strip():
            raise ValueError("aspect_ratio must be null or non-empty")
        if self.duration_seconds is not None and self.duration_seconds <= 0:
            raise ValueError("duration_seconds must be null or positive")
        return self


class PromptDraftProvenance(StrictModel):
    ref: FilmEntityRef
    prompt_draft_id: UUID4
    expected_version: int = Field(ge=0)
    director_ir_hash: str = Field(pattern=HASH_PATTERN)
    visual_lock_hash: str = Field(pattern=HASH_PATTERN)
    project: BoundEntityReference
    shot: BoundEntityReference
    director_unit: BoundEntityReference
    visual_lock: BoundEntityReference
    prompt_template: PromptTemplateBinding
    assets: list[PromptAssetBinding]
    capability_profile: ProviderCapabilityProfile
    provider_parameters: ProviderParameters
    input_hash: str = Field(pattern=HASH_PATTERN)
    prompt_hash: str = Field(pattern=HASH_PATTERN)
    capability_hash: str = Field(pattern=HASH_PATTERN)
    submission_state: Literal[ProviderSubmissionState.NOT_SUBMITTED]
    generated_result_state: Literal[GeneratedResultState.CANDIDATE_ONLY]
    approval_state: Literal[
        ApprovalBoundaryState.SEPARATE_HUMAN_ACTION_REQUIRED
    ]


class GenerationExecutionEvidenceBinding(StrictModel):
    """Immutable V2.4 execution evidence bound into the existing GenerationPackage authority."""

    generation_attempt_id: str = Field(min_length=1, max_length=256)
    route_snapshot_id: str = Field(min_length=1, max_length=256)
    route_snapshot_content_hash: str = Field(pattern=HASH_PATTERN)
    route_content_hash: str = Field(pattern=HASH_PATTERN)
    descriptor_receipt_id: str = Field(min_length=1, max_length=256)
    descriptor_receipt_content_hash: str = Field(pattern=HASH_PATTERN)
    descriptor_semantic_hash: str = Field(pattern=HASH_PATTERN)
    catalog_validation_receipt_id: str = Field(min_length=1, max_length=256)
    catalog_validation_receipt_content_hash: str = Field(pattern=HASH_PATTERN)
    catalog_validation_semantic_hash: str = Field(pattern=HASH_PATTERN)
    provider_input_authorization_snapshot_id: str = Field(min_length=1, max_length=256)
    provider_input_authorization_content_hash: str = Field(pattern=HASH_PATTERN)
    authorization_scope_hash: str = Field(pattern=HASH_PATTERN)
    authorized_submission_id: str = Field(min_length=1, max_length=256)
    authorized_submission_content_hash: str = Field(pattern=HASH_PATTERN)
    authorized_submission_semantic_hash: str = Field(pattern=HASH_PATTERN)
    idempotency_key: str = Field(pattern=HASH_PATTERN)

    @field_validator(
        "generation_attempt_id",
        "route_snapshot_id",
        "descriptor_receipt_id",
        "catalog_validation_receipt_id",
        "provider_input_authorization_snapshot_id",
        "authorized_submission_id",
    )
    @classmethod
    def validate_opaque_ids(cls, value: str, info) -> str:
        return require_opaque_id(value, info.field_name)


class GenerationPackage(StrictModel):
    ref: FilmEntityRef
    prompt_draft_id: UUID4
    host_project_id: str = Field(min_length=1, max_length=256)
    provider_id: str = Field(pattern=PROVIDER_ID_PATTERN)
    capability_id: str = Field(pattern=CAPABILITY_ID_PATTERN)
    parameters: dict[str, Any]
    parameter_hash: str = Field(pattern=HASH_PATTERN)
    prompt_hash: str = Field(pattern=HASH_PATTERN)
    input_hash: str = Field(pattern=HASH_PATTERN)
    submission_state: Literal[ProviderSubmissionState.NOT_SUBMITTED]
    execution_evidence: GenerationExecutionEvidenceBinding | None = None

    @field_validator("host_project_id")
    @classmethod
    def validate_project_id(cls, value: str) -> str:
        return require_opaque_id(value, "host_project_id")

    @field_validator("parameters")
    @classmethod
    def validate_parameters(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_safe_json_object(value, "parameters")


class ImportedOutputReference(StrictModel):
    film_representation_id: UUID4
    host_resource_id: str = Field(min_length=1, max_length=256)
    output_kind: OutputKind
    content_hash: str = Field(pattern=HASH_PATTERN)
    mime_type: str = Field(pattern=MIME_PATTERN)
    bytes: int = Field(ge=0)

    @field_validator("host_resource_id")
    @classmethod
    def validate_resource_id(cls, value: str) -> str:
        return require_opaque_id(value, "host_resource_id")


class GenerationAttemptEvidence(StrictModel):
    ref: FilmEntityRef
    generation_package_id: UUID4
    provider_id: str = Field(pattern=PROVIDER_ID_PATTERN)
    provider_task_id: str = Field(min_length=1, max_length=256)
    receipt_id: str = Field(min_length=1, max_length=256)
    receipt_hash: str = Field(pattern=HASH_PATTERN)
    receipt_captured_at: datetime
    parameter_hash: str = Field(pattern=HASH_PATTERN)
    prompt_hash: str = Field(pattern=HASH_PATTERN)
    input_hash: str = Field(pattern=HASH_PATTERN)
    parameters: dict[str, Any]
    manual_import_source_id: str = Field(min_length=1, max_length=256)
    imported_by: str = Field(min_length=1, max_length=256)
    imported_at: datetime
    authorization_evidence_id: str = Field(min_length=1, max_length=256)
    outputs: list[ImportedOutputReference] = Field(min_length=1)

    @field_validator(
        "provider_task_id",
        "receipt_id",
        "manual_import_source_id",
        "imported_by",
        "authorization_evidence_id",
    )
    @classmethod
    def validate_opaque_ids(cls, value: str, info) -> str:
        return require_opaque_id(value, info.field_name)

    @field_validator("parameters")
    @classmethod
    def validate_parameters(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_safe_json_object(value, "parameters")


class Candidate(StrictModel):
    ref: FilmEntityRef
    generation_package_id: UUID4
    generation_attempt_evidence_id: UUID4
    host: HostReferences
    states: FormalStateAxes
    output_hash: str = Field(pattern=HASH_PATTERN)


class Review(StrictModel):
    ref: FilmEntityRef
    target_id: UUID4
    target_content_hash: str = Field(pattern=HASH_PATTERN)
    review_state: ReviewOutcome
    reviewer_kind: ReviewKind
    findings: list[str]


class Approval(StrictModel):
    ref: FilmEntityRef
    target_id: UUID4
    review_id: UUID4
    actor_kind: Literal[ActorKind.HUMAN]
    approved_by: str = Field(min_length=1)
    approved_content_hash: str = Field(pattern=HASH_PATTERN)


class ContinuityBlocker(StrictModel):
    code: str = Field(min_length=1, max_length=128)
    dimension: ContinuityDimension
    subject_id: str = Field(min_length=1, max_length=256)
    expected_value: str
    actual_value: str


class ContinuityCheckResult(StrictModel):
    ref: FilmEntityRef
    previous_shot_id: UUID4 | None
    current_shot_id: UUID4
    passed: bool
    blockers: list[ContinuityBlocker]


class VersionSnapshot(StrictModel):
    film_entity_id: UUID4
    version: int = Field(ge=1)
    content_hash: str = Field(pattern=HASH_PATTERN)


class Vector3(StrictModel):
    x: float = Field(ge=-1_000_000, le=1_000_000)
    y: float = Field(ge=-1_000_000, le=1_000_000)
    z: float = Field(ge=-1_000_000, le=1_000_000)


class EulerDegrees(StrictModel):
    x: float = Field(ge=-360_000, le=360_000)
    y: float = Field(ge=-360_000, le=360_000)
    z: float = Field(ge=-360_000, le=360_000)


class SpatialTransform(StrictModel):
    position: Vector3
    rotation_degrees: EulerDegrees


class CoordinateSystem(StrictModel):
    units: Literal["meters"] = "meters"
    handedness: Literal["right_handed", "left_handed"]
    up_axis: Literal["y", "z"]
    origin_anchor_id: str = Field(min_length=1, max_length=256)

    @field_validator("origin_anchor_id")
    @classmethod
    def validate_origin_anchor_id(cls, value: str) -> str:
        return require_opaque_id(value, "origin_anchor_id")


class SpatialObject(StrictModel):
    object_id: str = Field(min_length=1, max_length=256)
    geometry_content_hash: str = Field(pattern=HASH_PATTERN)
    transform: SpatialTransform

    @field_validator("object_id")
    @classmethod
    def validate_object_id(cls, value: str) -> str:
        return require_opaque_id(value, "object_id")


class SpatialAnchor(StrictModel):
    anchor_id: str = Field(min_length=1, max_length=256)
    position: Vector3

    @field_validator("anchor_id")
    @classmethod
    def validate_anchor_id(cls, value: str) -> str:
        return require_opaque_id(value, "anchor_id")


class SpatialPortal(StrictModel):
    portal_id: str = Field(min_length=1, max_length=256)
    from_anchor_id: str = Field(min_length=1, max_length=256)
    to_anchor_id: str = Field(min_length=1, max_length=256)
    passable: bool

    @field_validator("portal_id", "from_anchor_id", "to_anchor_id")
    @classmethod
    def validate_portal_ids(cls, value: str, info) -> str:
        return require_opaque_id(value, info.field_name)


class SpatialZone(StrictModel):
    zone_id: str = Field(min_length=1, max_length=256)
    polygon: list[Vector3] = Field(min_length=3)

    @field_validator("zone_id")
    @classmethod
    def validate_zone_id(cls, value: str) -> str:
        return require_opaque_id(value, "zone_id")


class ApprovedViewFamily(StrictModel):
    family_id: str = Field(min_length=1, max_length=256)
    camera_zone_ids: list[str] = Field(min_length=1)
    screen_direction: Literal["left_to_right", "right_to_left", "neutral"]

    @field_validator("family_id")
    @classmethod
    def validate_family_id(cls, value: str) -> str:
        return require_opaque_id(value, "family_id")

    @field_validator("camera_zone_ids")
    @classmethod
    def validate_camera_zone_ids(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("camera_zone_ids must be unique")
        return [require_opaque_id(item, "camera_zone_ids") for item in value]


class SceneRenderPass(StrictModel):
    pass_kind: Literal["rgb", "depth", "normal", "object_id"]
    host_resource_id: str = Field(min_length=1, max_length=256)
    content_hash: str = Field(pattern=HASH_PATTERN)

    @field_validator("host_resource_id")
    @classmethod
    def validate_resource_id(cls, value: str) -> str:
        return require_opaque_id(value, "host_resource_id")


class SceneTwinVersion(StrictModel):
    ref: FilmEntityRef
    project: VersionSnapshot
    content_unit: VersionSnapshot
    states: FormalStateAxes
    coordinate_system: CoordinateSystem
    geometry_content_hash: str = Field(pattern=HASH_PATTERN)
    fixed_architecture: list[SpatialObject]
    fixed_props: list[SpatialObject]
    portals: list[SpatialPortal]
    walkable_zones: list[SpatialZone]
    anchors: list[SpatialAnchor]
    camera_zones: list[SpatialZone]
    lighting_base: dict[str, Any]
    approved_view_families: list[ApprovedViewFamily]
    render_passes: list[SceneRenderPass]

    @field_validator("lighting_base")
    @classmethod
    def validate_lighting_base(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_safe_json_object(value, "lighting_base")

    @model_validator(mode="after")
    def validate_scene_graph(self) -> SceneTwinVersion:
        validate_scene_twin_graph(self)
        return self


class CameraLens(StrictModel):
    focal_length_mm: float = Field(gt=0, le=2000)
    sensor_width_mm: float = Field(gt=0, le=500)
    focus_distance_m: float = Field(gt=0, le=1_000_000)
    aperture_f: float = Field(gt=0, le=128)


class CameraVersion(StrictModel):
    ref: FilmEntityRef
    shot: VersionSnapshot
    scene_twin: VersionSnapshot
    states: FormalStateAxes
    camera_id: str = Field(min_length=1, max_length=256)
    position_anchor_id: str = Field(min_length=1, max_length=256)
    target_anchor_id: str = Field(min_length=1, max_length=256)
    camera_side: Literal["left", "right", "on_axis"]
    axis_id: str = Field(min_length=1, max_length=256)
    screen_direction: Literal["left_to_right", "right_to_left", "neutral"]
    transform: SpatialTransform
    lens: CameraLens
    camera_zone_id: str = Field(min_length=1, max_length=256)
    approved_view_family_id: str = Field(min_length=1, max_length=256)

    @field_validator(
        "camera_id",
        "position_anchor_id",
        "target_anchor_id",
        "axis_id",
        "camera_zone_id",
        "approved_view_family_id",
    )
    @classmethod
    def validate_camera_ids(cls, value: str, info) -> str:
        return require_opaque_id(value, info.field_name)


class BlockingActorState(StrictModel):
    actor_id: str = Field(min_length=1, max_length=256)
    feet_anchor_id: str = Field(min_length=1, max_length=256)
    position: Vector3
    torso_rotation_degrees: EulerDegrees
    face_target_id: str = Field(min_length=1, max_length=256)
    gaze_target_id: str = Field(min_length=1, max_length=256)
    left_hand_target_id: str | None = Field(default=None, min_length=1, max_length=256)
    right_hand_target_id: str | None = Field(default=None, min_length=1, max_length=256)
    action_in: str = Field(min_length=1, max_length=256)
    action_out: str = Field(min_length=1, max_length=256)
    axis_side_in: Literal["left", "right", "on_axis"]
    axis_side_out: Literal["left", "right", "on_axis"]
    prop_contact_in_ids: list[str] = Field(default_factory=list)
    prop_contact_out_ids: list[str] = Field(default_factory=list)

    @field_validator(
        "actor_id",
        "feet_anchor_id",
        "face_target_id",
        "gaze_target_id",
        "left_hand_target_id",
        "right_hand_target_id",
    )
    @classmethod
    def validate_actor_ids(cls, value: str | None, info) -> str | None:
        return None if value is None else require_opaque_id(value, info.field_name)

    @field_validator("prop_contact_in_ids", "prop_contact_out_ids")
    @classmethod
    def validate_prop_ids(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("prop contact ids must be unique")
        return [require_opaque_id(item, "prop_contact_ids") for item in value]


class BlockingVersion(StrictModel):
    ref: FilmEntityRef
    shot: VersionSnapshot
    scene_twin: VersionSnapshot
    states: FormalStateAxes
    beat_id: str = Field(min_length=1, max_length=256)
    actors: list[BlockingActorState] = Field(min_length=1)

    @field_validator("beat_id")
    @classmethod
    def validate_beat_id(cls, value: str) -> str:
        return require_opaque_id(value, "beat_id")


class CompositionSubject(StrictModel):
    subject_id: str = Field(min_length=1, max_length=256)
    frame_x: float = Field(ge=0, le=1)
    frame_y: float = Field(ge=0, le=1)
    frame_width: float = Field(gt=0, le=1)
    frame_height: float = Field(gt=0, le=1)

    @field_validator("subject_id")
    @classmethod
    def validate_subject_id(cls, value: str) -> str:
        return require_opaque_id(value, "subject_id")

    @model_validator(mode="after")
    def validate_inside_frame(self) -> CompositionSubject:
        if self.frame_x + self.frame_width > 1 or self.frame_y + self.frame_height > 1:
            raise ValueError("composition subject bounds must stay inside the frame")
        return self


class OcclusionConstraint(StrictModel):
    occluder_id: str = Field(min_length=1, max_length=256)
    subject_id: str = Field(min_length=1, max_length=256)
    max_occlusion_ratio: float = Field(ge=0, le=1)

    @field_validator("occluder_id", "subject_id")
    @classmethod
    def validate_occlusion_ids(cls, value: str, info) -> str:
        return require_opaque_id(value, info.field_name)


class FrameSafeArea(StrictModel):
    left: float = Field(ge=0, lt=0.5)
    right: float = Field(ge=0, lt=0.5)
    top: float = Field(ge=0, lt=0.5)
    bottom: float = Field(ge=0, lt=0.5)

    @model_validator(mode="after")
    def validate_non_empty_area(self) -> FrameSafeArea:
        if self.left + self.right >= 1 or self.top + self.bottom >= 1:
            raise ValueError("safe area margins must leave a visible frame")
        return self


class CompositionVersion(StrictModel):
    ref: FilmEntityRef
    shot: VersionSnapshot
    scene_twin: VersionSnapshot
    camera: VersionSnapshot
    blocking: VersionSnapshot
    states: FormalStateAxes
    aspect_ratio: str = Field(pattern=r"^[1-9][0-9]{0,3}:[1-9][0-9]{0,3}$")
    framing: str = Field(min_length=1, max_length=256)
    screen_direction: Literal["left_to_right", "right_to_left", "neutral"]
    subjects: list[CompositionSubject] = Field(min_length=1)
    occlusion_constraints: list[OcclusionConstraint]
    safe_area: FrameSafeArea


SpatialVersion: TypeAlias = (
    SceneTwinVersion | CameraVersion | BlockingVersion | CompositionVersion
)


FormalEntity: TypeAlias = (
    ScriptVersion
    | ScriptDecision
    | DirectorUnit
    | CoverageLink
    | VisualLockSet
    | AssetBinding
    | PromptDraft
    | PromptDraftProvenance
    | GenerationPackage
    | GenerationAttemptEvidence
    | Candidate
    | Review
    | Approval
    | ContinuityCheckResult
    | SceneTwinVersion
    | CameraVersion
    | BlockingVersion
    | CompositionVersion
)


class CreateScriptVersionPayload(StrictModel):
    entity_type: Literal[EntityType.SCRIPT_VERSION]
    host: HostReferences
    states: FormalStateAxes
    script_text: str

    @model_validator(mode="after")
    def require_host_scope(self) -> CreateScriptVersionPayload:
        if not self.host.host_project_id or not self.host.host_unit_id:
            raise ValueError("script_version requires host_project_id and host_unit_id")
        return self


class CreateDirectorUnitPayload(StrictModel):
    entity_type: Literal[EntityType.DIRECTOR_UNIT]
    script_version: EntityVersionGuard
    script_decision: EntityVersionGuard
    states: FormalStateAxes
    director_ir_text: str = Field(min_length=1)
    director_ir_hash: str = Field(pattern=HASH_PATTERN)
    narrative_purpose: str = Field(min_length=1)
    performance_beats: list[str] = Field(default_factory=list)


class CreateCoverageLinkPayload(StrictModel):
    entity_type: Literal[EntityType.COVERAGE_LINK]
    director_unit: EntityVersionGuard
    shot: EntityVersionGuard
    purpose: str = Field(min_length=1)


class CreateVisualLockSetPayload(StrictModel):
    entity_type: Literal[EntityType.VISUAL_LOCK_SET]
    project: EntityVersionGuard
    shot: EntityVersionGuard
    states: FormalStateAxes
    visual_lock_text: str = Field(min_length=1)
    visual_lock_hash: str = Field(pattern=HASH_PATTERN)
    locks: dict[str, Any]

    @field_validator("locks")
    @classmethod
    def validate_locks(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_safe_json_object(value, "locks")


class CreateAssetBindingPayload(StrictModel):
    entity_type: Literal[EntityType.ASSET_BINDING]
    project: EntityVersionGuard
    host: HostReferences
    role: str = Field(min_length=1, max_length=128)
    priority: int = Field(ge=0, le=100)
    asset_content_hash: str = Field(pattern=HASH_PATTERN)

    @model_validator(mode="after")
    def require_opaque_host_asset(self) -> CreateAssetBindingPayload:
        required = {
            "host_project_id": self.host.host_project_id,
            "host_asset_id": self.host.host_asset_id,
        }
        for field, value in required.items():
            if value is None:
                raise ValueError(f"asset_binding requires {field}")
        for field, value in self.host.model_dump(
            mode="json", exclude_none=True
        ).items():
            require_opaque_id(value, field)
        return self


class CreateGenerationPackagePayload(StrictModel):
    entity_type: Literal[EntityType.GENERATION_PACKAGE]
    prompt_draft: EntityVersionGuard
    host_project_id: str = Field(min_length=1, max_length=256)
    provider_id: str = Field(pattern=PROVIDER_ID_PATTERN)
    capability_id: str = Field(pattern=CAPABILITY_ID_PATTERN)
    parameters: dict[str, Any]
    execution_evidence: GenerationExecutionEvidenceBinding | None = None

    @field_validator("host_project_id")
    @classmethod
    def validate_project_id(cls, value: str) -> str:
        return require_opaque_id(value, "host_project_id")

    @field_validator("parameters")
    @classmethod
    def validate_parameters(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_safe_json_object(value, "parameters")


class CreateSceneTwinVersionPayload(StrictModel):
    entity_type: Literal[EntityType.SCENE_TWIN_VERSION]
    project: EntityVersionGuard
    content_unit: EntityVersionGuard
    states: FormalStateAxes
    coordinate_system: CoordinateSystem
    geometry_content_hash: str = Field(pattern=HASH_PATTERN)
    fixed_architecture: list[SpatialObject]
    fixed_props: list[SpatialObject]
    portals: list[SpatialPortal]
    walkable_zones: list[SpatialZone]
    anchors: list[SpatialAnchor]
    camera_zones: list[SpatialZone]
    lighting_base: dict[str, Any]
    approved_view_families: list[ApprovedViewFamily]
    render_passes: list[SceneRenderPass]

    @field_validator("lighting_base")
    @classmethod
    def validate_lighting_base(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_safe_json_object(value, "lighting_base")

    @model_validator(mode="after")
    def validate_scene_graph(self) -> CreateSceneTwinVersionPayload:
        validate_scene_twin_graph(self)
        return self


class CreateCameraVersionPayload(StrictModel):
    entity_type: Literal[EntityType.CAMERA_VERSION]
    shot: EntityVersionGuard
    scene_twin: EntityVersionGuard
    states: FormalStateAxes
    camera_id: str = Field(min_length=1, max_length=256)
    position_anchor_id: str = Field(min_length=1, max_length=256)
    target_anchor_id: str = Field(min_length=1, max_length=256)
    camera_side: Literal["left", "right", "on_axis"]
    axis_id: str = Field(min_length=1, max_length=256)
    screen_direction: Literal["left_to_right", "right_to_left", "neutral"]
    transform: SpatialTransform
    lens: CameraLens
    camera_zone_id: str = Field(min_length=1, max_length=256)
    approved_view_family_id: str = Field(min_length=1, max_length=256)

    @field_validator(
        "camera_id",
        "position_anchor_id",
        "target_anchor_id",
        "axis_id",
        "camera_zone_id",
        "approved_view_family_id",
    )
    @classmethod
    def validate_camera_ids(cls, value: str, info) -> str:
        return require_opaque_id(value, info.field_name)


class CreateBlockingVersionPayload(StrictModel):
    entity_type: Literal[EntityType.BLOCKING_VERSION]
    shot: EntityVersionGuard
    scene_twin: EntityVersionGuard
    states: FormalStateAxes
    beat_id: str = Field(min_length=1, max_length=256)
    actors: list[BlockingActorState] = Field(min_length=1)

    @field_validator("beat_id")
    @classmethod
    def validate_beat_id(cls, value: str) -> str:
        return require_opaque_id(value, "beat_id")


class CreateCompositionVersionPayload(StrictModel):
    entity_type: Literal[EntityType.COMPOSITION_VERSION]
    shot: EntityVersionGuard
    scene_twin: EntityVersionGuard
    camera: EntityVersionGuard
    blocking: EntityVersionGuard
    states: FormalStateAxes
    aspect_ratio: str = Field(pattern=r"^[1-9][0-9]{0,3}:[1-9][0-9]{0,3}$")
    framing: str = Field(min_length=1, max_length=256)
    screen_direction: Literal["left_to_right", "right_to_left", "neutral"]
    subjects: list[CompositionSubject] = Field(min_length=1)
    occlusion_constraints: list[OcclusionConstraint]
    safe_area: FrameSafeArea


SpatialVersionPayload: TypeAlias = Annotated[
    CreateSceneTwinVersionPayload
    | CreateCameraVersionPayload
    | CreateBlockingVersionPayload
    | CreateCompositionVersionPayload,
    Field(discriminator="entity_type"),
]


class SpatialVersionCreateRequest(StrictModel):
    idempotency_key: str = Field(min_length=1, max_length=128)
    write: CreateTargetGuard
    actor_kind: ActorKind
    payload: SpatialVersionPayload

    @field_validator("idempotency_key")
    @classmethod
    def validate_idempotency_key(cls, value: str) -> str:
        return require_opaque_id(value, "idempotency_key")


class SpatialVersionUpdateRequest(StrictModel):
    idempotency_key: str = Field(min_length=1, max_length=128)
    write: EntityVersionGuard
    actor_kind: ActorKind
    payload: SpatialVersionPayload

    @field_validator("idempotency_key")
    @classmethod
    def validate_idempotency_key(cls, value: str) -> str:
        return require_opaque_id(value, "idempotency_key")


class SpatialVersionApplyResult(StrictModel):
    entity: SpatialVersion
    audit_event_id: UUID4
    replayed: bool


FormalRecordPayload: TypeAlias = Annotated[
    CreateScriptVersionPayload
    | CreateDirectorUnitPayload
    | CreateCoverageLinkPayload
    | CreateVisualLockSetPayload
    | CreateAssetBindingPayload
    | CreateGenerationPackagePayload,
    Field(discriminator="entity_type"),
]


class FormalRecordCreateRequest(StrictModel):
    write: CreateTargetGuard
    actor_kind: ActorKind
    payload: FormalRecordPayload


class FormalRecordApplyResult(StrictModel):
    entity: FormalEntity
    audit_event_id: UUID4


class ScriptVersionLockRequest(StrictModel):
    locked_write: CreateTargetGuard
    decision_write: CreateTargetGuard
    actor_kind: ActorKind
    source_script_version: EntityVersionGuard
    approved_by: str = Field(min_length=1, max_length=256)


class ScriptVersionLockResult(StrictModel):
    locked_script_version: ScriptVersion
    decision: ScriptDecision
    audit_event_ids: list[UUID4]


class PromptCompileRequest(StrictModel):
    draft_write: CreateTargetGuard
    provenance_write: CreateTargetGuard
    actor_kind: ActorKind
    states: FormalStateAxes
    director_ir_hash: str = Field(pattern=HASH_PATTERN)
    visual_lock_hash: str = Field(pattern=HASH_PATTERN)
    model_capability_profile: str = Field(min_length=1)
    prompt_text: str = Field(min_length=1)
    project: BoundEntityReference
    shot: BoundEntityReference
    director_unit: BoundEntityReference
    visual_lock: BoundEntityReference
    prompt_template: PromptTemplateBinding
    assets: list[PromptAssetBinding] = Field(min_length=1)
    capability_profile: ProviderCapabilityProfile
    provider_parameters: ProviderParameters


class PromptCompileResult(StrictModel):
    prompt_draft: PromptDraft
    provenance: PromptDraftProvenance
    audit_event_ids: list[UUID4]


class ManualReceiptInput(StrictModel):
    receipt_id: str = Field(min_length=1, max_length=256)
    content_hash: str = Field(pattern=HASH_PATTERN)
    captured_at: datetime

    @field_validator("receipt_id")
    @classmethod
    def validate_receipt_id(cls, value: str) -> str:
        return require_opaque_id(value, "receipt_id")


class ManualSourceInput(StrictModel):
    source_id: str = Field(min_length=1, max_length=256)
    source_kind: ManualSourceKind
    imported_by: str = Field(min_length=1, max_length=256)
    imported_at: datetime
    authorization_evidence_id: str = Field(min_length=1, max_length=256)

    @field_validator("source_id", "imported_by", "authorization_evidence_id")
    @classmethod
    def validate_opaque_ids(cls, value: str, info) -> str:
        return require_opaque_id(value, info.field_name)


class ManualImportOutputInput(StrictModel):
    host_resource_id: str = Field(min_length=1, max_length=256)
    output_kind: OutputKind
    content_hash: str = Field(pattern=HASH_PATTERN)
    mime_type: str = Field(pattern=MIME_PATTERN)
    bytes: int = Field(ge=0)

    @field_validator("host_resource_id")
    @classmethod
    def validate_resource_id(cls, value: str) -> str:
        return require_opaque_id(value, "host_resource_id")


class ManualResultImportRequest(StrictModel):
    evidence_write: CreateTargetGuard
    candidate_write: CreateTargetGuard
    actor_kind: ActorKind
    generation_package: EntityVersionGuard
    provider_task_id: str = Field(min_length=1, max_length=256)
    receipt: ManualReceiptInput
    manual_source: ManualSourceInput
    outputs: list[ManualImportOutputInput] = Field(min_length=1)

    @field_validator("provider_task_id")
    @classmethod
    def validate_task_id(cls, value: str) -> str:
        return require_opaque_id(value, "provider_task_id")


class ManualResultImportResult(StrictModel):
    evidence: GenerationAttemptEvidence
    candidate: Candidate
    audit_event_ids: list[UUID4]


class ReviewCreateRequest(StrictModel):
    write: CreateTargetGuard
    actor_kind: ActorKind
    candidate: EntityVersionGuard
    review_state: ReviewOutcome
    reviewer_kind: ReviewKind
    findings: list[str]


class ApprovalCreateRequest(StrictModel):
    write: CreateTargetGuard
    actor_kind: ActorKind
    candidate: EntityVersionGuard
    passed_review: EntityVersionGuard
    approved_by: str = Field(min_length=1, max_length=256)


class ContinuityCheckInput(StrictModel):
    dimension: ContinuityDimension
    subject_id: str = Field(min_length=1, max_length=256)
    expected_value: str
    actual_value: str


class ContinuityCheckRequest(StrictModel):
    write: CreateTargetGuard
    actor_kind: ActorKind
    previous_shot: EntityVersionGuard | None = None
    current_shot: EntityVersionGuard
    checks: list[ContinuityCheckInput] = Field(min_length=1)


def validate_scene_twin_graph(value: Any) -> None:
    def unique(items: list[str], field: str) -> set[str]:
        if len(items) != len(set(items)):
            raise ValueError(f"{field} ids must be unique")
        return set(items)

    anchor_ids = unique([item.anchor_id for item in value.anchors], "anchor")
    object_ids = unique(
        [item.object_id for item in value.fixed_architecture + value.fixed_props],
        "fixed object",
    )
    del object_ids
    unique([item.portal_id for item in value.portals], "portal")
    walkable_zone_ids = unique(
        [item.zone_id for item in value.walkable_zones], "walkable zone"
    )
    camera_zone_ids = unique(
        [item.zone_id for item in value.camera_zones], "camera zone"
    )
    if walkable_zone_ids & camera_zone_ids:
        raise ValueError("walkable zone and camera zone ids must not overlap")
    family_ids = unique(
        [item.family_id for item in value.approved_view_families],
        "approved view family",
    )
    del family_ids
    if value.coordinate_system.origin_anchor_id not in anchor_ids:
        raise ValueError("coordinate system origin_anchor_id must reference an anchor")
    for portal in value.portals:
        if (
            portal.from_anchor_id not in anchor_ids
            or portal.to_anchor_id not in anchor_ids
        ):
            raise ValueError("portal endpoints must reference anchors")
    for family in value.approved_view_families:
        if not set(family.camera_zone_ids) <= camera_zone_ids:
            raise ValueError("approved view family must reference camera zones")
    pass_kinds = [item.pass_kind for item in value.render_passes]
    unique(pass_kinds, "render pass")
    review_ready = (
        enum_string(value.states.review_state) != "not_reviewed"
        or enum_string(value.states.creative_stage) in {"reviewed", "locked"}
    )
    if review_ready and set(pass_kinds) != {"rgb", "depth", "normal", "object_id"}:
        raise ValueError(
            "review-ready SceneTwin requires rgb/depth/normal/object_id render passes"
        )


def enum_string(value: Any) -> str:
    return str(getattr(value, "value", value))


def require_opaque_id(value: str, field: str) -> str:
    if not OPAQUE_ID_PATTERN.fullmatch(value):
        raise ValueError(f"{field} must be an opaque identifier, not a path or URL")
    return value


def validate_safe_json_object(value: dict[str, Any], field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be a JSON object")
    _validate_safe_json(value, field, set())
    return value


def _validate_safe_json(value: Any, field: str, ancestors: set[int]) -> None:
    if value is None or isinstance(value, (str, bool)):
        if isinstance(value, str) and FORBIDDEN_LOCATOR_PATTERN.match(value.strip()):
            raise ValueError(f"{field} contains a URL, data payload, or file path")
        return
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            raise ValueError(f"{field} contains a non-finite number")
        return
    if not isinstance(value, (dict, list)):
        raise ValueError(f"{field} contains a non-JSON value")
    identity = id(value)
    if identity in ancestors:
        raise ValueError(f"{field} contains a cycle")
    ancestors.add(identity)
    if isinstance(value, list):
        for index, item in enumerate(value):
            _validate_safe_json(item, f"{field}[{index}]", ancestors)
    else:
        for key, item in value.items():
            if SECRET_KEY_PATTERN.search(key):
                raise ValueError(f"{field}.{key} is a sensitive field")
            if LOCATOR_KEY_PATTERN.search(key):
                raise ValueError(f"{field}.{key} must use an audited reference")
            _validate_safe_json(item, f"{field}.{key}", ancestors)
    ancestors.remove(identity)
