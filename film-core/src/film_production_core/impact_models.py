from __future__ import annotations

from typing import Annotated, Literal, TypeAlias

from pydantic import Field, UUID4, field_validator, model_validator

from film_production_core.formal_models import (
    HASH_PATTERN,
    CreateTargetGuard,
    EntityVersionGuard,
    require_opaque_id,
)
from film_production_core.models import ActorKind, FilmEntityRef, StrictModel


class ScriptSectionRange(StrictModel):
    section_id: UUID4
    start_order: int = Field(ge=0)
    end_order: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_range(self) -> ScriptSectionRange:
        if self.end_order < self.start_order:
            raise ValueError("section end_order must be >= start_order")
        return self


class ScriptCueEntry(StrictModel):
    cue_id: UUID4
    section_id: UUID4
    speaker: str = Field(min_length=1, max_length=256)
    order: int = Field(ge=0)
    cue_text_hash: str = Field(pattern=HASH_PATTERN)


class ScriptStructureMap(StrictModel):
    ref: FilmEntityRef
    script_version_id: UUID4
    script_version_version: int = Field(ge=1)
    script_version_content_hash: str = Field(pattern=HASH_PATTERN)
    sections: list[ScriptSectionRange] = Field(min_length=1)
    cues: list[ScriptCueEntry] = Field(min_length=1)


class ScriptStructureMapCreateRequest(StrictModel):
    write: CreateTargetGuard
    actor_kind: ActorKind
    script_version: EntityVersionGuard
    sections: list[ScriptSectionRange] = Field(min_length=1)
    cues: list[ScriptCueEntry] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_structure(self) -> ScriptStructureMapCreateRequest:
        section_ids = [section.section_id for section in self.sections]
        cue_ids = [cue.cue_id for cue in self.cues]
        cue_orders = [cue.order for cue in self.cues]
        if len(section_ids) != len(set(section_ids)):
            raise ValueError("section_id values must be unique")
        if len(cue_ids) != len(set(cue_ids)):
            raise ValueError("cue_id values must be unique")
        if len(cue_orders) != len(set(cue_orders)):
            raise ValueError("cue order values must be unique")
        ordered_sections = sorted(self.sections, key=lambda item: item.start_order)
        for previous, current in zip(
            ordered_sections, ordered_sections[1:], strict=False
        ):
            if current.start_order <= previous.end_order:
                raise ValueError("section ranges must not overlap")
        sections = {section.section_id: section for section in self.sections}
        populated: set[UUID4] = set()
        for cue in self.cues:
            section = sections.get(cue.section_id)
            if section is None:
                raise ValueError("cue section_id must reference a declared section")
            if not section.start_order <= cue.order <= section.end_order:
                raise ValueError("cue order must be inside its section range")
            populated.add(cue.section_id)
        if populated != set(section_ids):
            raise ValueError("every section must contain at least one cue")
        return self


class ScriptCueImpactScope(StrictModel):
    kind: Literal["script_cue"]
    cue_id: UUID4


class ScriptSectionImpactScope(StrictModel):
    kind: Literal["script_section"]
    section_id: UUID4


class VisualLockComponentImpactScope(StrictModel):
    kind: Literal["visual_lock_component"]
    component_key: str = Field(min_length=1, max_length=256)

    @field_validator("component_key")
    @classmethod
    def validate_component_key(cls, value: str) -> str:
        return require_opaque_id(value, "component_key")


class AssetBindingSourceImpactScope(StrictModel):
    kind: Literal["asset_binding_source"]
    asset_content_hash: str = Field(pattern=HASH_PATTERN)


class SpatialVersionComponentImpactScope(StrictModel):
    kind: Literal["spatial_version_component"]
    component_key: str = Field(min_length=1, max_length=256)

    @field_validator("component_key")
    @classmethod
    def validate_component_key(cls, value: str) -> str:
        return require_opaque_id(value, "component_key")


ImpactScope: TypeAlias = Annotated[
    ScriptCueImpactScope
    | ScriptSectionImpactScope
    | VisualLockComponentImpactScope
    | AssetBindingSourceImpactScope
    | SpatialVersionComponentImpactScope,
    Field(discriminator="kind"),
]


class ImpactEdge(StrictModel):
    ref: FilmEntityRef
    dependency_owner_id: UUID4
    dependency_owner_version: int = Field(ge=1)
    dependency_owner_content_hash: str = Field(pattern=HASH_PATTERN)
    source_id: UUID4
    source_version: int = Field(ge=1)
    source_content_hash: str = Field(pattern=HASH_PATTERN)
    target_id: UUID4
    target_version: int = Field(ge=1)
    target_content_hash: str = Field(pattern=HASH_PATTERN)
    dependency_key: str = Field(min_length=1, max_length=256)
    dependency_content_hash: str = Field(pattern=HASH_PATTERN)
    scope: ImpactScope
    relation: str = Field(min_length=1, max_length=128)
    propagates_stale: bool

    @field_validator("dependency_key", "relation")
    @classmethod
    def validate_opaque_fields(cls, value: str, info) -> str:
        return require_opaque_id(value, info.field_name)


class ImpactEdgeCreateRequest(StrictModel):
    write: CreateTargetGuard
    actor_kind: ActorKind
    dependency_owner: EntityVersionGuard
    script_structure_map: EntityVersionGuard | None = None
    source: EntityVersionGuard
    target: EntityVersionGuard
    dependency_key: str = Field(min_length=1, max_length=256)
    scope: ImpactScope
    relation: str = Field(min_length=1, max_length=128)
    propagates_stale: bool = True

    @field_validator("dependency_key", "relation")
    @classmethod
    def validate_opaque_fields(cls, value: str, info) -> str:
        return require_opaque_id(value, info.field_name)


class ImpactQueryResult(StrictModel):
    entity_id: UUID4
    incoming: list[ImpactEdge]
    outgoing: list[ImpactEdge]


class DependencyChange(StrictModel):
    dependency_key: str = Field(min_length=1, max_length=256)
    scope: ImpactScope
    previous_dependency_hash: str = Field(pattern=HASH_PATTERN)
    current_dependency_hash: str = Field(pattern=HASH_PATTERN)

    @field_validator("dependency_key")
    @classmethod
    def validate_dependency_key(cls, value: str) -> str:
        return require_opaque_id(value, "dependency_key")

    @model_validator(mode="after")
    def require_change(self) -> DependencyChange:
        if self.previous_dependency_hash == self.current_dependency_hash:
            raise ValueError("dependency hashes must differ")
        return self


class StalePropagationRequest(StrictModel):
    idempotency_key: str = Field(min_length=1, max_length=128)
    actor_kind: ActorKind
    dependency_owner: EntityVersionGuard
    script_structure_map: EntityVersionGuard | None = None
    changes: list[DependencyChange] = Field(min_length=1, max_length=128)

    @field_validator("idempotency_key")
    @classmethod
    def validate_idempotency_key(cls, value: str) -> str:
        return require_opaque_id(value, "idempotency_key")

    @model_validator(mode="after")
    def require_unique_changes(self) -> StalePropagationRequest:
        selectors = [
            (change.dependency_key, change.scope.model_dump_json())
            for change in self.changes
        ]
        if len(selectors) != len(set(selectors)):
            raise ValueError("dependency changes must be unique")
        return self


class StalePropagationResult(StrictModel):
    idempotency_key: str
    replayed: bool
    dependency_owner_id: UUID4
    stale_entity_ids: list[UUID4]
    already_stale_entity_ids: list[UUID4]
    unchanged_entity_ids: list[UUID4]
    unresolved_changes: list[DependencyChange]
    traversed_edge_ids: list[UUID4]
    audit_event_ids: list[UUID4]
