from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Annotated, Literal, TypeAlias
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    UUID4,
    model_serializer,
    model_validator,
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", use_enum_values=True)


class EntityType(str, Enum):
    FILM_PROJECT_EXTENSION = "film_project_extension"
    CONTENT_UNIT_EXTENSION = "content_unit_extension"
    SHOT_EXTENSION = "shot_extension"
    SCRIPT_VERSION = "script_version"
    SCRIPT_DECISION = "script_decision"
    DIRECTOR_UNIT = "director_unit"
    COVERAGE_LINK = "coverage_link"
    VISUAL_LOCK_SET = "visual_lock_set"
    ASSET_BINDING = "asset_binding"
    PROMPT_DRAFT = "prompt_draft"
    PROMPT_DRAFT_PROVENANCE = "prompt_draft_provenance"
    GENERATION_PACKAGE = "generation_package"
    GENERATION_ATTEMPT_EVIDENCE = "generation_attempt_evidence"
    CANDIDATE = "candidate"
    REVIEW = "review"
    APPROVAL = "approval"
    CONTINUITY_CHECK_RESULT = "continuity_check_result"


class CreativeStage(str, Enum):
    DRAFT = "draft"
    AUTHORED = "authored"
    REVIEWED = "reviewed"
    LOCKED = "locked"


class ExecutionState(str, Enum):
    NOT_STARTED = "not_started"
    READY = "ready"
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ReviewState(str, Enum):
    NOT_REVIEWED = "not_reviewed"
    PENDING = "pending"
    IN_REVIEW = "in_review"
    CHANGES_REQUESTED = "changes_requested"
    REJECTED = "rejected"
    PASSED = "passed"
    APPROVED = "approved"


class LockState(str, Enum):
    UNLOCKED = "unlocked"
    SOFT_LOCKED = "soft_locked"
    LOCKED = "locked"


class DeliveryState(str, Enum):
    NOT_READY = "not_ready"
    READY = "ready"
    PACKAGED = "packaged"
    DELIVERED = "delivered"
    SUPERSEDED = "superseded"


class StaleState(str, Enum):
    FRESH = "fresh"
    STALE = "stale"
    BLOCKED = "blocked"


class ActorKind(str, Enum):
    HUMAN = "human"
    CODEX = "codex"
    DEEPSEEK = "deepseek"
    CLAUDE = "claude"
    LOCAL_MODEL = "local_model"
    SYSTEM = "system"


class UnitKind(str, Enum):
    CHAPTER = "chapter"
    EPISODE = "episode"
    SPECIAL = "special"
    TRAILER = "trailer"
    EXTRA = "extra"
    FILM = "film"
    SEASON = "season"
    ARC = "arc"
    VOLUME = "volume"


class FormalStateAxes(StrictModel):
    creative_stage: CreativeStage
    execution_state: ExecutionState
    review_state: ReviewState
    lock_state: LockState
    delivery_state: DeliveryState
    stale_state: StaleState


class HostReferences(StrictModel):
    host_project_id: str | None = Field(default=None, min_length=1)
    host_unit_id: str | None = Field(default=None, min_length=1)
    host_shot_id: str | None = Field(default=None, min_length=1)
    host_asset_id: str | None = Field(default=None, min_length=1)
    host_asset_version_id: str | None = Field(default=None, min_length=1)
    host_canvas_id: str | None = Field(default=None, min_length=1)
    host_resource_id: str | None = Field(default=None, min_length=1)

    @model_serializer(mode="wrap")
    def omit_unmapped_host_ids(
        self, handler: SerializerFunctionWrapHandler
    ) -> dict[str, str]:
        value = handler(self)
        return {key: item for key, item in value.items() if item is not None}


class FilmEntityRef(StrictModel):
    film_entity_id: UUID4
    entity_type: EntityType
    version: int = Field(ge=1)
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")


class FilmProjectExtension(StrictModel):
    ref: FilmEntityRef
    host: HostReferences
    states: FormalStateAxes


class ContentUnitExtension(StrictModel):
    ref: FilmEntityRef
    host: HostReferences
    states: FormalStateAxes
    unit_kind: UnitKind


class ShotExtension(StrictModel):
    ref: FilmEntityRef
    host: HostReferences
    states: FormalStateAxes
    director_unit_ids: list[UUID4] = Field(default_factory=list)


FilmEntity: TypeAlias = FilmProjectExtension | ContentUnitExtension | ShotExtension


class CreateFilmProjectPayload(StrictModel):
    entity_type: Literal[EntityType.FILM_PROJECT_EXTENSION]
    host: HostReferences
    states: FormalStateAxes

    @model_validator(mode="after")
    def require_host_mapping(self) -> CreateFilmProjectPayload:
        if not self.host.host_project_id:
            raise ValueError("film_project_extension requires host_project_id")
        return self


class CreateContentUnitPayload(StrictModel):
    entity_type: Literal[EntityType.CONTENT_UNIT_EXTENSION]
    host: HostReferences
    states: FormalStateAxes
    unit_kind: UnitKind

    @model_validator(mode="after")
    def require_host_mapping(self) -> CreateContentUnitPayload:
        if not self.host.host_project_id or not self.host.host_unit_id:
            raise ValueError(
                "content_unit_extension requires host_project_id and host_unit_id"
            )
        return self


class CreateShotPayload(StrictModel):
    entity_type: Literal[EntityType.SHOT_EXTENSION]
    host: HostReferences
    states: FormalStateAxes
    director_unit_ids: list[UUID4] = Field(default_factory=list)

    @model_validator(mode="after")
    def require_host_mapping(self) -> CreateShotPayload:
        if not self.host.host_project_id or not self.host.host_shot_id:
            raise ValueError(
                "shot_extension requires host_project_id and host_shot_id"
            )
        return self


CreateEntityPayload: TypeAlias = Annotated[
    CreateFilmProjectPayload | CreateContentUnitPayload | CreateShotPayload,
    Field(discriminator="entity_type"),
]


class SetStatesPayload(StrictModel):
    states: FormalStateAxes


class CreateEntityCommand(StrictModel):
    command_type: Literal["entity.create"]
    target_id: None
    expected_version: Literal[0]
    actor_kind: ActorKind = ActorKind.HUMAN
    payload: CreateEntityPayload


class SetStatesCommand(StrictModel):
    command_type: Literal["entity.set_states"]
    target_id: UUID4
    expected_version: int = Field(ge=1)
    actor_kind: ActorKind = ActorKind.HUMAN
    payload: SetStatesPayload


Command: TypeAlias = Annotated[
    CreateEntityCommand | SetStatesCommand,
    Field(discriminator="command_type"),
]


class AuditEvent(StrictModel):
    event_id: UUID4
    actor_kind: ActorKind
    action: str = Field(min_length=1)
    target_id: UUID4
    recorded_at: datetime


class CommandPreviewResult(StrictModel):
    mode: Literal["preview"] = "preview"
    command_type: str
    target_id: UUID4 | None
    current_version: int
    resulting_version: int
    content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    changes: list[str]


class CommandApplyResult(StrictModel):
    mode: Literal["applied"] = "applied"
    entity: FilmEntity
    audit_event: AuditEvent


class FilmProjectContext(StrictModel):
    host_project_id: str = Field(min_length=1)
    host_authority: Literal["yingce"] = "yingce"
    film_authority: Literal["film_core_sidecar"] = "film_core_sidecar"
    film_project: FilmProjectExtension | None
    content_units: list[ContentUnitExtension]
    shots: list[ShotExtension]
    audit_event_count: int = Field(ge=0)


class HealthResult(StrictModel):
    status: Literal["ok"] = "ok"
    service: Literal["film-production-core"] = "film-production-core"
    schema_version: int = Field(ge=1)
    database: Literal["sqlite-sidecar"] = "sqlite-sidecar"
    journal_mode: str


class ErrorDetail(StrictModel):
    code: str
    message: str
    target_id: UUID | None = None
    expected_version: int | None = None
    current_version: int | None = None
    expected_content_hash: str | None = None
    current_content_hash: str | None = None


class ErrorResponse(StrictModel):
    detail: ErrorDetail
