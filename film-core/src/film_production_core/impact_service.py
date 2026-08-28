from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

from film_production_core.errors import (
    ContentHashConflict,
    DomainRuleViolation,
    VersionConflict,
)
from film_production_core.formal_models import EntityVersionGuard
from film_production_core.formal_service import FormalService, enum_value, hash_json
from film_production_core.impact_models import (
    AssetBindingSourceImpactScope,
    ImpactEdge,
    ImpactEdgeCreateRequest,
    ImpactQueryResult,
    ScriptCueImpactScope,
    ScriptSectionImpactScope,
    ScriptStructureMap,
    ScriptStructureMapCreateRequest,
    StalePropagationRequest,
    StalePropagationResult,
    SpatialVersionComponentImpactScope,
    VisualLockComponentImpactScope,
)
from film_production_core.impact_repository import ImpactRepository
from film_production_core.models import EntityType, FilmEntityRef
from film_production_core.repository import canonical_json
from film_production_core.service import utc_now


IMPACT_OWNER_TYPES = {
    EntityType.SCRIPT_VERSION.value,
    EntityType.VISUAL_LOCK_SET.value,
    EntityType.ASSET_BINDING.value,
    EntityType.SCENE_TWIN_VERSION.value,
    EntityType.CAMERA_VERSION.value,
    EntityType.BLOCKING_VERSION.value,
    EntityType.COMPOSITION_VERSION.value,
}


def spatial_component_hashes(owner) -> dict[str, str]:
    owner_type = enum_value(owner.ref.entity_type)

    def dumped(value):
        if hasattr(value, "model_dump"):
            return value.model_dump(mode="json")
        if isinstance(value, list):
            return [dumped(item) for item in value]
        return value

    if owner_type == EntityType.SCENE_TWIN_VERSION.value:
        return {
            "coordinate_system": hash_json(dumped(owner.coordinate_system)),
            "geometry": owner.geometry_content_hash,
            "fixed_architecture": hash_json(dumped(owner.fixed_architecture)),
            "fixed_props": hash_json(dumped(owner.fixed_props)),
            "portals": hash_json(dumped(owner.portals)),
            "walkable_zones": hash_json(dumped(owner.walkable_zones)),
            "anchors": hash_json(dumped(owner.anchors)),
            "camera_zones": hash_json(dumped(owner.camera_zones)),
            "lighting_base": hash_json(owner.lighting_base),
            "approved_view_families": hash_json(
                dumped(owner.approved_view_families)
            ),
            "render_passes": hash_json(dumped(owner.render_passes)),
        }
    if owner_type == EntityType.CAMERA_VERSION.value:
        return {
            "scene_twin_ref": owner.scene_twin.content_hash,
            "position_anchor": hash_json(owner.position_anchor_id),
            "target_anchor": hash_json(owner.target_anchor_id),
            "axis_contract": hash_json(
                {
                    "axis_id": owner.axis_id,
                    "camera_side": owner.camera_side,
                    "screen_direction": owner.screen_direction,
                }
            ),
            "transform": hash_json(dumped(owner.transform)),
            "lens": hash_json(dumped(owner.lens)),
            "camera_zone": hash_json(owner.camera_zone_id),
            "approved_view_family": hash_json(owner.approved_view_family_id),
        }
    if owner_type == EntityType.BLOCKING_VERSION.value:
        result = {
            "scene_twin_ref": owner.scene_twin.content_hash,
            "beat": hash_json(owner.beat_id),
            "actors": hash_json(dumped(owner.actors)),
        }
        result.update(
            {
                f"actor:{actor.actor_id}": hash_json(dumped(actor))
                for actor in owner.actors
            }
        )
        return result
    if owner_type == EntityType.COMPOSITION_VERSION.value:
        return {
            "scene_twin_ref": owner.scene_twin.content_hash,
            "camera_ref": owner.camera.content_hash,
            "blocking_ref": owner.blocking.content_hash,
            "layout": hash_json(
                {
                    "aspect_ratio": owner.aspect_ratio,
                    "framing": owner.framing,
                    "screen_direction": owner.screen_direction,
                    "subjects": dumped(owner.subjects),
                }
            ),
            "occlusion_constraints": hash_json(
                dumped(owner.occlusion_constraints)
            ),
            "safe_area": hash_json(dumped(owner.safe_area)),
        }
    return {}


class ImpactService:
    def __init__(
        self, repository: ImpactRepository, formal_service: FormalService
    ) -> None:
        self.repository = repository
        self.formal_service = formal_service

    def script_structure_map(self, film_entity_id: str) -> ScriptStructureMap:
        return self._structure_from_row(
            self.repository.script_structure_map(film_entity_id)
        )

    def create_script_structure_map(
        self, request: ScriptStructureMapCreateRequest
    ) -> ScriptStructureMap:
        script = self.formal_service._require_current(  # noqa: SLF001
            request.script_version, {EntityType.SCRIPT_VERSION.value}
        )
        body = {
            "script_version_id": str(script.ref.film_entity_id),
            "script_version_version": script.ref.version,
            "script_version_content_hash": script.ref.content_hash,
            "sections": [
                section.model_dump(mode="json") for section in request.sections
            ],
            "cues": [cue.model_dump(mode="json") for cue in request.cues],
        }
        now = utc_now()
        film_entity_id = str(uuid4())
        record = {
            "film_entity_id": film_entity_id,
            "entity_type": EntityType.SCRIPT_STRUCTURE_MAP.value,
            "version": 1,
            "content_hash": hash_json(body),
            "script_version_id": str(script.ref.film_entity_id),
            "script_version_version": script.ref.version,
            "script_version_content_hash": script.ref.content_hash,
            "payload_json": canonical_json(body),
            "created_at": now,
            "updated_at": now,
        }
        audit = self._audit(
            actor_kind=request.actor_kind,
            action="script_structure_map.created",
            target_id=film_entity_id,
            resulting_version=1,
            command_type="script_structure_map.create",
            command_payload=request.model_dump(mode="json"),
            recorded_at=now,
        )
        row = self.repository.create_script_structure_map(
            record,
            audit,
            self._guard_values(request.script_version),
        )
        return self._structure_from_row(row)

    def impact_edge(self, film_entity_id: str) -> ImpactEdge:
        return self._impact_from_row(self.repository.impact_edge(film_entity_id))

    def impact_query(self, film_entity_id: str) -> ImpactQueryResult:
        self.repository.current_row(film_entity_id)
        incoming, outgoing = self.repository.impact_edges_for_entity(film_entity_id)
        return ImpactQueryResult(
            entity_id=film_entity_id,
            incoming=[self._impact_from_row(row) for row in incoming],
            outgoing=[self._impact_from_row(row) for row in outgoing],
        )

    def create_impact_edge(self, request: ImpactEdgeCreateRequest) -> ImpactEdge:
        owner = self.formal_service._require_current(  # noqa: SLF001
            request.dependency_owner, IMPACT_OWNER_TYPES
        )
        source = self._require_any_current(request.source)
        target = self._require_any_current(request.target)
        if source.ref.film_entity_id == target.ref.film_entity_id:
            raise DomainRuleViolation(
                "impact_self_edge", "ImpactEdge source and target must differ"
            )
        structure = self._optional_structure(request.script_structure_map)
        self._validate_structure_guard_usage(owner, structure)
        dependency_content_hash = self._validate_selector(
            owner,
            request.dependency_key,
            request.scope,
            structure,
            current_dependency_hash=None,
        )
        body = {
            "dependency_owner_id": str(owner.ref.film_entity_id),
            "dependency_owner_version": owner.ref.version,
            "dependency_owner_content_hash": owner.ref.content_hash,
            "source_id": str(source.ref.film_entity_id),
            "source_version": source.ref.version,
            "source_content_hash": source.ref.content_hash,
            "target_id": str(target.ref.film_entity_id),
            "target_version": target.ref.version,
            "target_content_hash": target.ref.content_hash,
            "dependency_key": request.dependency_key,
            "dependency_content_hash": dependency_content_hash,
            "scope": request.scope.model_dump(mode="json"),
            "relation": request.relation,
            "propagates_stale": request.propagates_stale,
        }
        now = utc_now()
        film_entity_id = str(uuid4())
        record = {
            "film_entity_id": film_entity_id,
            "entity_type": EntityType.IMPACT_EDGE.value,
            "version": 1,
            "content_hash": hash_json(body),
            "dependency_owner_id": str(owner.ref.film_entity_id),
            "dependency_owner_version": owner.ref.version,
            "dependency_owner_content_hash": owner.ref.content_hash,
            "source_id": str(source.ref.film_entity_id),
            "source_version": source.ref.version,
            "source_content_hash": source.ref.content_hash,
            "target_id": str(target.ref.film_entity_id),
            "target_version": target.ref.version,
            "target_content_hash": target.ref.content_hash,
            "dependency_key": request.dependency_key,
            "dependency_content_hash": dependency_content_hash,
            "scope_json": canonical_json(body["scope"]),
            "relation": request.relation,
            "propagates_stale": int(request.propagates_stale),
            "payload_json": canonical_json(body),
            "created_at": now,
            "updated_at": now,
        }
        audit = self._audit(
            actor_kind=request.actor_kind,
            action="impact_edge.created",
            target_id=film_entity_id,
            resulting_version=1,
            command_type="impact_edge.create",
            command_payload=request.model_dump(mode="json"),
            recorded_at=now,
        )
        guards = [
            self._guard_values(request.dependency_owner),
            self._guard_values(request.source),
            self._guard_values(request.target),
        ]
        structure_guard = (
            None
            if request.script_structure_map is None
            else self._guard_values(request.script_structure_map)
        )
        row = self.repository.create_impact_edge(
            record, audit, guards, structure_guard
        )
        return self._impact_from_row(row)

    def propagate_stale(
        self, request: StalePropagationRequest
    ) -> StalePropagationResult:
        payload = request.model_dump(mode="json")
        request_hash = hash_json(payload)
        replay = self.repository.propagation_replay(
            request.idempotency_key, request_hash
        )
        if replay is not None:
            return StalePropagationResult.model_validate(replay)
        owner = self.formal_service._require_current(  # noqa: SLF001
            request.dependency_owner, IMPACT_OWNER_TYPES
        )
        structure = self._optional_structure(request.script_structure_map)
        self._validate_structure_guard_usage(owner, structure)
        changes: list[dict[str, Any]] = []
        for change in request.changes:
            self._validate_selector(
                owner,
                change.dependency_key,
                change.scope,
                structure,
                current_dependency_hash=change.current_dependency_hash,
            )
            changes.append(
                {
                    "dependency_key": change.dependency_key,
                    "scope_json": canonical_json(
                        change.scope.model_dump(mode="json")
                    ),
                    "previous_dependency_hash": change.previous_dependency_hash,
                    "current_dependency_hash": change.current_dependency_hash,
                }
            )
        result = self.repository.propagate_stale(
            idempotency_key=request.idempotency_key,
            request_hash=request_hash,
            actor_kind=enum_value(request.actor_kind),
            owner_guard=self._guard_values(request.dependency_owner),
            structure_guard=(
                None
                if request.script_structure_map is None
                else self._guard_values(request.script_structure_map)
            ),
            changes=changes,
            command_payload_json=canonical_json(payload),
            recorded_at=utc_now(),
        )
        return StalePropagationResult.model_validate(result)

    def _optional_structure(
        self, guard: EntityVersionGuard | None
    ) -> ScriptStructureMap | None:
        if guard is None:
            return None
        structure = self.script_structure_map(str(guard.film_entity_id))
        if structure.ref.version != guard.expected_version:
            raise VersionConflict(
                guard.film_entity_id,
                guard.expected_version,
                structure.ref.version,
            )
        if structure.ref.content_hash != guard.expected_content_hash:
            raise ContentHashConflict(
                guard.film_entity_id,
                guard.expected_content_hash,
                structure.ref.content_hash,
            )
        return structure

    def _require_any_current(self, guard: EntityVersionGuard):
        kind, row = self.repository.current_row(str(guard.film_entity_id))
        entity = (
            self.formal_service._formal_from_row(row)  # noqa: SLF001
            if kind == "formal"
            else self.formal_service._legacy_ref_entity(row)  # noqa: SLF001
        )
        if entity.ref.version != guard.expected_version:
            raise VersionConflict(
                guard.film_entity_id, guard.expected_version, entity.ref.version
            )
        if entity.ref.content_hash != guard.expected_content_hash:
            raise ContentHashConflict(
                guard.film_entity_id,
                guard.expected_content_hash,
                entity.ref.content_hash,
            )
        return entity

    @staticmethod
    def _validate_structure_guard_usage(
        owner, structure: ScriptStructureMap | None
    ) -> None:
        is_script = enum_value(owner.ref.entity_type) == EntityType.SCRIPT_VERSION.value
        if not is_script and structure is not None:
            raise DomainRuleViolation(
                "script_structure_map_not_allowed",
                "Only ScriptVersion impact scopes accept a ScriptStructureMap guard",
            )

    @staticmethod
    def _validate_selector(
        owner,
        dependency_key: str,
        scope,
        structure: ScriptStructureMap | None,
        current_dependency_hash: str | None,
    ) -> str:
        owner_type = enum_value(owner.ref.entity_type)
        expected_hash: str
        if owner_type == EntityType.SCRIPT_VERSION.value:
            if not isinstance(scope, (ScriptCueImpactScope, ScriptSectionImpactScope)):
                raise DomainRuleViolation(
                    "script_impact_scope_required",
                    "ScriptVersion impacts require script_cue or script_section scope",
                )
            if structure is None:
                raise DomainRuleViolation(
                    "script_structure_map_required",
                    "ScriptVersion impacts require a guarded ScriptStructureMap",
                )
            if (
                structure.script_version_id != owner.ref.film_entity_id
                or structure.script_version_version != owner.ref.version
                or structure.script_version_content_hash != owner.ref.content_hash
            ):
                raise DomainRuleViolation(
                    "script_structure_map_mismatch",
                    "ScriptStructureMap must bind the current ScriptVersion version and hash",
                )
            if isinstance(scope, ScriptCueImpactScope):
                expected_key = f"cue:{scope.cue_id}"
                cue = next(
                    (item for item in structure.cues if item.cue_id == scope.cue_id),
                    None,
                )
                if cue is None:
                    raise DomainRuleViolation(
                        "script_cue_not_found", "Impact scope cue is not in the map"
                    )
                expected_hash = cue.cue_text_hash
            else:
                expected_key = f"section:{scope.section_id}"
                section = next(
                    (
                        item
                        for item in structure.sections
                        if item.section_id == scope.section_id
                    ),
                    None,
                )
                if section is None:
                    raise DomainRuleViolation(
                        "script_section_not_found",
                        "Impact scope section is not in the map",
                    )
                section_cues = [
                    {
                        "cue_id": str(cue.cue_id),
                        "cue_text_hash": cue.cue_text_hash,
                        "order": cue.order,
                    }
                    for cue in sorted(structure.cues, key=lambda item: item.order)
                    if cue.section_id == scope.section_id
                ]
                expected_hash = hash_json(
                    {
                        "section_id": str(section.section_id),
                        "start_order": section.start_order,
                        "end_order": section.end_order,
                        "cues": section_cues,
                    }
                )
            if dependency_key != expected_key:
                raise DomainRuleViolation(
                    "dependency_key_scope_mismatch",
                    f"Script scope requires dependency_key {expected_key}",
                )
        elif owner_type == EntityType.VISUAL_LOCK_SET.value:
            if not isinstance(scope, VisualLockComponentImpactScope):
                raise DomainRuleViolation(
                    "visual_lock_impact_scope_required",
                    "VisualLockSet impacts require visual_lock_component scope",
                )
            if dependency_key != scope.component_key:
                raise DomainRuleViolation(
                    "dependency_key_scope_mismatch",
                    "Visual lock dependency_key must equal scope.component_key",
                )
            hashes = owner.locks.get("dependency_hashes")
            if hashes is None:
                hashes = owner.locks.get("dependencyHashes")
            if not isinstance(hashes, dict) or dependency_key not in hashes:
                raise DomainRuleViolation(
                    "visual_lock_dependency_missing",
                    "VisualLockSet does not declare the requested dependency hash",
                )
            expected_hash = hashes[dependency_key]
            if (
                not isinstance(expected_hash, str)
                or len(expected_hash) != 64
                or any(
                    character not in "0123456789abcdef"
                    for character in expected_hash
                )
            ):
                raise DomainRuleViolation(
                    "visual_lock_dependency_hash_invalid",
                    "VisualLockSet dependency hash must be a sha256 string",
                )
        elif owner_type == EntityType.ASSET_BINDING.value:
            if not isinstance(scope, AssetBindingSourceImpactScope):
                raise DomainRuleViolation(
                    "asset_binding_impact_scope_required",
                    "AssetBinding impacts require asset_binding_source scope",
                )
            if dependency_key != "asset_source":
                raise DomainRuleViolation(
                    "dependency_key_scope_mismatch",
                    "AssetBinding source impacts use dependency_key asset_source",
                )
            if scope.asset_content_hash != owner.asset_content_hash:
                raise DomainRuleViolation(
                    "asset_source_hash_mismatch",
                    "Impact scope must bind the current AssetBinding source hash",
                )
            expected_hash = owner.asset_content_hash
        elif owner_type in {
            EntityType.SCENE_TWIN_VERSION.value,
            EntityType.CAMERA_VERSION.value,
            EntityType.BLOCKING_VERSION.value,
            EntityType.COMPOSITION_VERSION.value,
        }:
            if not isinstance(scope, SpatialVersionComponentImpactScope):
                raise DomainRuleViolation(
                    "spatial_version_impact_scope_required",
                    "Spatial version impacts require spatial_version_component scope",
                )
            if dependency_key != scope.component_key:
                raise DomainRuleViolation(
                    "dependency_key_scope_mismatch",
                    "Spatial dependency_key must equal scope.component_key",
                )
            components = spatial_component_hashes(owner)
            expected_hash = components.get(dependency_key, "")
            if not expected_hash:
                raise DomainRuleViolation(
                    "spatial_component_missing",
                    "Spatial version does not declare the requested exact component",
                )
        else:  # pragma: no cover - owner type is checked before this method
            raise DomainRuleViolation(
                "impact_owner_type_mismatch", "Unsupported impact dependency owner"
            )
        if current_dependency_hash is not None and current_dependency_hash != expected_hash:
            raise DomainRuleViolation(
                "current_dependency_hash_mismatch",
                "current_dependency_hash does not match the current dependency source",
            )
        return expected_hash

    @staticmethod
    def _structure_from_row(row) -> ScriptStructureMap:
        payload = json.loads(row["payload_json"])
        return ScriptStructureMap(
            ref=FilmEntityRef(
                film_entity_id=row["film_entity_id"],
                entity_type=row["entity_type"],
                version=row["version"],
                content_hash=row["content_hash"],
            ),
            **payload,
        )

    @staticmethod
    def _impact_from_row(row) -> ImpactEdge:
        payload = json.loads(row["payload_json"])
        return ImpactEdge(
            ref=FilmEntityRef(
                film_entity_id=row["film_entity_id"],
                entity_type=row["entity_type"],
                version=row["version"],
                content_hash=row["content_hash"],
            ),
            **payload,
        )

    @staticmethod
    def _guard_values(guard: EntityVersionGuard) -> dict[str, Any]:
        return {
            "film_entity_id": str(guard.film_entity_id),
            "expected_version": guard.expected_version,
            "expected_content_hash": guard.expected_content_hash,
        }

    @staticmethod
    def _audit(
        *,
        actor_kind,
        action: str,
        target_id: str,
        resulting_version: int,
        command_type: str,
        command_payload: dict[str, Any],
        recorded_at: str,
    ) -> dict[str, Any]:
        return {
            "event_id": str(uuid4()),
            "actor_kind": enum_value(actor_kind),
            "action": action,
            "target_id": target_id,
            "previous_version": None,
            "resulting_version": resulting_version,
            "command_type": command_type,
            "command_payload_json": canonical_json(command_payload),
            "recorded_at": recorded_at,
        }
