from __future__ import annotations

import hashlib
import json
from typing import Any, cast
from uuid import uuid4

from film_production_core.errors import (
    ContentHashConflict,
    DomainRuleViolation,
    EntityNotFound,
    VersionConflict,
)
from film_production_core.formal_models import (
    Approval,
    ApprovalBoundaryState,
    ApprovalCreateRequest,
    AssetBinding,
    BlockingVersion,
    BoundEntityReference,
    CameraVersion,
    Candidate,
    CompositionVersion,
    ContinuityBlocker,
    ContinuityCheckRequest,
    ContinuityCheckResult,
    CoverageLink,
    CreateAssetBindingPayload,
    CreateBlockingVersionPayload,
    CreateCameraVersionPayload,
    CreateCompositionVersionPayload,
    CreateCoverageLinkPayload,
    CreateDirectorUnitPayload,
    CreateGenerationPackagePayload,
    CreateScriptVersionPayload,
    CreateSceneTwinVersionPayload,
    CreateVisualLockSetPayload,
    DirectorUnit,
    EntityVersionGuard,
    FormalEntity,
    FormalRecordApplyResult,
    FormalRecordCreateRequest,
    GeneratedResultState,
    GenerationAttemptEvidence,
    GenerationPackage,
    ImportedOutputReference,
    ManualResultImportRequest,
    ManualResultImportResult,
    PromptCompileRequest,
    PromptCompileResult,
    PromptDraft,
    PromptDraftProvenance,
    ProviderSubmissionState,
    Review,
    ReviewCreateRequest,
    ReviewOutcome,
    ScriptDecision,
    ScriptVersion,
    ScriptVersionLockRequest,
    ScriptVersionLockResult,
    SceneTwinVersion,
    SpatialVersionApplyResult,
    SpatialVersionCreateRequest,
    SpatialVersion,
    SpatialVersionUpdateRequest,
    VersionSnapshot,
    VisualLockSet,
)
from film_production_core.models import (
    ActorKind,
    EntityType,
    FilmEntityRef,
    ContentUnitExtension,
    FormalStateAxes,
    HostReferences,
    ShotExtension,
)
from film_production_core.repository import FilmRepository, canonical_json
from film_production_core.service import utc_now


FORMAL_MODEL_BY_TYPE: dict[str, type[FormalEntity]] = {
    EntityType.SCRIPT_VERSION.value: ScriptVersion,
    EntityType.SCRIPT_DECISION.value: ScriptDecision,
    EntityType.DIRECTOR_UNIT.value: DirectorUnit,
    EntityType.COVERAGE_LINK.value: CoverageLink,
    EntityType.VISUAL_LOCK_SET.value: VisualLockSet,
    EntityType.ASSET_BINDING.value: AssetBinding,
    EntityType.PROMPT_DRAFT.value: PromptDraft,
    EntityType.PROMPT_DRAFT_PROVENANCE.value: PromptDraftProvenance,
    EntityType.GENERATION_PACKAGE.value: GenerationPackage,
    EntityType.GENERATION_ATTEMPT_EVIDENCE.value: GenerationAttemptEvidence,
    EntityType.CANDIDATE.value: Candidate,
    EntityType.REVIEW.value: Review,
    EntityType.APPROVAL.value: Approval,
    EntityType.CONTINUITY_CHECK_RESULT.value: ContinuityCheckResult,
    EntityType.SCENE_TWIN_VERSION.value: SceneTwinVersion,
    EntityType.CAMERA_VERSION.value: CameraVersion,
    EntityType.BLOCKING_VERSION.value: BlockingVersion,
    EntityType.COMPOSITION_VERSION.value: CompositionVersion,
}


def hash_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def hash_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class FormalService:
    def __init__(self, repository: FilmRepository) -> None:
        self.repository = repository

    def formal_record(self, film_entity_id: str) -> FormalEntity:
        return self._formal_from_row(self.repository.formal_record(film_entity_id))

    def spatial_version(self, film_entity_id: str) -> SpatialVersion:
        entity = self.formal_record(film_entity_id)
        if enum_value(entity.ref.entity_type) not in {
            EntityType.SCENE_TWIN_VERSION.value,
            EntityType.CAMERA_VERSION.value,
            EntityType.BLOCKING_VERSION.value,
            EntityType.COMPOSITION_VERSION.value,
        }:
            raise DomainRuleViolation(
                "spatial_version_required",
                f"Formal record {film_entity_id} is not a spatial version",
            )
        return cast(SpatialVersion, entity)

    def create_spatial_version(
        self, request: SpatialVersionCreateRequest
    ) -> SpatialVersionApplyResult:
        return self._apply_spatial_version(request, None)

    def update_spatial_version(
        self, film_entity_id: str, request: SpatialVersionUpdateRequest
    ) -> SpatialVersionApplyResult:
        if str(request.write.film_entity_id) != film_entity_id:
            raise DomainRuleViolation(
                "spatial_target_mismatch",
                "Path filmEntityId must equal write.film_entity_id",
            )
        return self._apply_spatial_version(request, film_entity_id)

    def _apply_spatial_version(
        self,
        request: SpatialVersionCreateRequest | SpatialVersionUpdateRequest,
        film_entity_id: str | None,
    ) -> SpatialVersionApplyResult:
        operation = "create" if film_entity_id is None else "update"
        request_payload = {
            "operation": operation,
            "film_entity_id": film_entity_id,
            "request": request.model_dump(mode="json"),
        }
        request_hash = hash_json(request_payload)
        replay = self.repository.spatial_version_receipt(
            request.idempotency_key, request_hash
        )
        if replay is not None:
            replay["replayed"] = True
            return SpatialVersionApplyResult.model_validate(replay)

        self._validate_spatial_states(request.payload.states)
        entity_type, body, parent_guards = self._spatial_body(request.payload)
        now = utc_now()
        target_id = film_entity_id or str(uuid4())
        resulting_version = (
            1
            if film_entity_id is None
            else cast(SpatialVersionUpdateRequest, request).write.expected_version + 1
        )
        content_hash = hash_json(body)
        event_id = str(uuid4())
        reference = FilmEntityRef(
            film_entity_id=target_id,
            entity_type=entity_type,
            version=resulting_version,
            content_hash=content_hash,
        )
        entity = FORMAL_MODEL_BY_TYPE[entity_type.value](ref=reference, **body)
        response = SpatialVersionApplyResult(
            entity=cast(
                SceneTwinVersion
                | CameraVersion
                | BlockingVersion
                | CompositionVersion,
                entity,
            ),
            audit_event_id=event_id,
            replayed=False,
        )
        record = {
            "film_entity_id": target_id,
            "entity_type": entity_type.value,
            "version": resulting_version,
            "content_hash": content_hash,
            "payload_json": canonical_json(body),
            "created_at": now,
            "updated_at": now,
        }
        audit = {
            "event_id": event_id,
            "actor_kind": enum_value(request.actor_kind),
            "action": f"{entity_type.value}.{operation}d",
            "target_id": target_id,
            "previous_version": None if film_entity_id is None else resulting_version - 1,
            "resulting_version": resulting_version,
            "command_type": f"spatial_version.{operation}",
            "command_payload_json": canonical_json(request_payload),
            "recorded_at": now,
        }
        update_guard = (
            None
            if film_entity_id is None
            else cast(SpatialVersionUpdateRequest, request).write.model_dump(mode="json")
        )
        persisted, replayed = self.repository.apply_spatial_version_with_receipt(
            idempotency_key=request.idempotency_key,
            request_hash=request_hash,
            response_json=response.model_dump_json(),
            record=record,
            audit=audit,
            parent_guards=[guard.model_dump(mode="json") for guard in parent_guards],
            update_guard=update_guard,
        )
        persisted["replayed"] = replayed
        return SpatialVersionApplyResult.model_validate(persisted)

    @staticmethod
    def _validate_spatial_states(states: FormalStateAxes) -> None:
        if (
            enum_value(states.review_state) == "approved"
            or enum_value(states.lock_state) == "locked"
            or enum_value(states.creative_stage) == "locked"
        ):
            raise DomainRuleViolation(
                "spatial_approval_action_required",
                "Spatial projection writes cannot directly claim approved or locked state",
            )

    def _spatial_body(self, payload):
        def snapshot(guard: EntityVersionGuard) -> dict[str, Any]:
            return VersionSnapshot(
                film_entity_id=guard.film_entity_id,
                version=guard.expected_version,
                content_hash=guard.expected_content_hash,
            ).model_dump(mode="json")

        if isinstance(payload, CreateSceneTwinVersionPayload):
            self._require_current(
                payload.project, {EntityType.FILM_PROJECT_EXTENSION.value}
            )
            self._require_current(
                payload.content_unit, {EntityType.CONTENT_UNIT_EXTENSION.value}
            )
            body = payload.model_dump(mode="json", exclude={"entity_type"})
            body["project"] = snapshot(payload.project)
            body["content_unit"] = snapshot(payload.content_unit)
            return EntityType.SCENE_TWIN_VERSION, body, [
                payload.project,
                payload.content_unit,
            ]

        if isinstance(payload, (CreateCameraVersionPayload, CreateBlockingVersionPayload)):
            shot = cast(
                ShotExtension,
                self._require_current(payload.shot, {EntityType.SHOT_EXTENSION.value}),
            )
            scene_twin = cast(
                SceneTwinVersion,
                self._require_current(
                    payload.scene_twin, {EntityType.SCENE_TWIN_VERSION.value}
                ),
            )
            self._validate_shot_scene_scope(shot, scene_twin)
            body = payload.model_dump(mode="json", exclude={"entity_type"})
            body["shot"] = snapshot(payload.shot)
            body["scene_twin"] = snapshot(payload.scene_twin)
            if isinstance(payload, CreateCameraVersionPayload):
                self._validate_camera_scene(payload, scene_twin)
                return EntityType.CAMERA_VERSION, body, [
                    payload.shot,
                    payload.scene_twin,
                ]
            self._validate_blocking_scene(payload, scene_twin)
            return EntityType.BLOCKING_VERSION, body, [
                payload.shot,
                payload.scene_twin,
            ]

        if isinstance(payload, CreateCompositionVersionPayload):
            shot = cast(
                ShotExtension,
                self._require_current(payload.shot, {EntityType.SHOT_EXTENSION.value}),
            )
            scene_twin = cast(
                SceneTwinVersion,
                self._require_current(
                    payload.scene_twin, {EntityType.SCENE_TWIN_VERSION.value}
                ),
            )
            camera = cast(
                CameraVersion,
                self._require_current(
                    payload.camera, {EntityType.CAMERA_VERSION.value}
                ),
            )
            blocking = cast(
                BlockingVersion,
                self._require_current(
                    payload.blocking, {EntityType.BLOCKING_VERSION.value}
                ),
            )
            self._validate_shot_scene_scope(shot, scene_twin)
            if camera.shot.film_entity_id != shot.ref.film_entity_id:
                raise DomainRuleViolation(
                    "camera_shot_mismatch", "CameraVersion must reference the same Shot"
                )
            if blocking.shot.film_entity_id != shot.ref.film_entity_id:
                raise DomainRuleViolation(
                    "blocking_shot_mismatch",
                    "BlockingVersion must reference the same Shot",
                )
            if (
                camera.scene_twin.film_entity_id != scene_twin.ref.film_entity_id
                or blocking.scene_twin.film_entity_id
                != scene_twin.ref.film_entity_id
            ):
                raise DomainRuleViolation(
                    "composition_scene_mismatch",
                    "CameraVersion and BlockingVersion must reference the same SceneTwin",
                )
            actor_ids = {actor.actor_id for actor in blocking.actors}
            subject_ids = {subject.subject_id for subject in payload.subjects}
            if not subject_ids <= actor_ids:
                raise DomainRuleViolation(
                    "composition_subject_mismatch",
                    "Composition subjects must be present in BlockingVersion actors",
                )
            scene_ids = {
                item.object_id
                for item in scene_twin.fixed_architecture + scene_twin.fixed_props
            } | actor_ids
            for constraint in payload.occlusion_constraints:
                if (
                    constraint.occluder_id not in scene_ids
                    or constraint.subject_id not in subject_ids
                ):
                    raise DomainRuleViolation(
                        "occlusion_reference_mismatch",
                        "Occlusion constraints must reference scene objects and composition subjects",
                    )
            if (
                payload.screen_direction != "neutral"
                and camera.screen_direction != "neutral"
                and payload.screen_direction != camera.screen_direction
            ):
                raise DomainRuleViolation(
                    "composition_axis_mismatch",
                    "Composition screen direction conflicts with CameraVersion axis contract",
                )
            body = payload.model_dump(mode="json", exclude={"entity_type"})
            body["shot"] = snapshot(payload.shot)
            body["scene_twin"] = snapshot(payload.scene_twin)
            body["camera"] = snapshot(payload.camera)
            body["blocking"] = snapshot(payload.blocking)
            return EntityType.COMPOSITION_VERSION, body, [
                payload.shot,
                payload.scene_twin,
                payload.camera,
                payload.blocking,
            ]
        raise TypeError("unsupported spatial version payload")

    def _validate_shot_scene_scope(
        self, shot: ShotExtension, scene_twin: SceneTwinVersion
    ) -> None:
        project = self._require_current(
            EntityVersionGuard(
                film_entity_id=scene_twin.project.film_entity_id,
                expected_version=scene_twin.project.version,
                expected_content_hash=scene_twin.project.content_hash,
            ),
            {EntityType.FILM_PROJECT_EXTENSION.value},
        )
        unit = cast(
            ContentUnitExtension,
            self._require_current(
                EntityVersionGuard(
                    film_entity_id=scene_twin.content_unit.film_entity_id,
                    expected_version=scene_twin.content_unit.version,
                    expected_content_hash=scene_twin.content_unit.content_hash,
                ),
                {EntityType.CONTENT_UNIT_EXTENSION.value},
            ),
        )
        if (
            shot.host.host_project_id != project.host.host_project_id
            or shot.host.host_unit_id != unit.host.host_unit_id
        ):
            raise DomainRuleViolation(
                "shot_scene_scope_mismatch",
                "Shot and SceneTwin must belong to the same Host project and unit",
            )

    @staticmethod
    def _validate_camera_scene(
        payload: CreateCameraVersionPayload, scene_twin: SceneTwinVersion
    ) -> None:
        anchor_ids = {item.anchor_id for item in scene_twin.anchors}
        camera_zone_ids = {item.zone_id for item in scene_twin.camera_zones}
        families = {
            item.family_id: set(item.camera_zone_ids)
            for item in scene_twin.approved_view_families
        }
        if (
            payload.position_anchor_id not in anchor_ids
            or payload.target_anchor_id not in anchor_ids
        ):
            raise DomainRuleViolation(
                "camera_anchor_mismatch", "Camera anchors must exist in SceneTwin"
            )
        if payload.camera_zone_id not in camera_zone_ids:
            raise DomainRuleViolation(
                "camera_zone_mismatch", "Camera zone must exist in SceneTwin"
            )
        if payload.approved_view_family_id not in families or payload.camera_zone_id not in families[payload.approved_view_family_id]:
            raise DomainRuleViolation(
                "view_family_mismatch",
                "Camera zone must belong to the approved view family",
            )

    @staticmethod
    def _validate_blocking_scene(
        payload: CreateBlockingVersionPayload, scene_twin: SceneTwinVersion
    ) -> None:
        anchor_ids = {item.anchor_id for item in scene_twin.anchors}
        prop_ids = {item.object_id for item in scene_twin.fixed_props}
        target_ids = anchor_ids | prop_ids | {actor.actor_id for actor in payload.actors}
        actor_ids = [actor.actor_id for actor in payload.actors]
        if len(actor_ids) != len(set(actor_ids)):
            raise DomainRuleViolation(
                "blocking_actor_duplicate", "Blocking actor ids must be unique"
            )
        for actor in payload.actors:
            if actor.feet_anchor_id not in anchor_ids:
                raise DomainRuleViolation(
                    "blocking_feet_anchor_mismatch",
                    "Actor feet_anchor_id must exist in SceneTwin",
                )
            targets = {
                actor.face_target_id,
                actor.gaze_target_id,
                actor.left_hand_target_id,
                actor.right_hand_target_id,
            } - {None}
            if not targets <= target_ids:
                raise DomainRuleViolation(
                    "blocking_target_mismatch",
                    "Face, gaze and hand targets must reference SceneTwin or blocking subjects",
                )
            if not (
                set(actor.prop_contact_in_ids) | set(actor.prop_contact_out_ids)
            ) <= prop_ids:
                raise DomainRuleViolation(
                    "blocking_prop_contact_mismatch",
                    "Prop contact ids must reference fixed SceneTwin props",
                )

    def create_record(
        self, request: FormalRecordCreateRequest
    ) -> FormalRecordApplyResult:
        payload = request.payload
        if isinstance(payload, CreateScriptVersionPayload):
            if (
                enum_value(payload.states.lock_state) != "unlocked"
                or enum_value(payload.states.creative_stage) == "locked"
            ):
                raise DomainRuleViolation(
                    "script_lock_action_required",
                    "ScriptVersion creation cannot directly claim a locked state",
                )
            body = {
                "host": payload.host.model_dump(mode="json", exclude_none=True),
                "states": payload.states.model_dump(mode="json"),
                "source_script_version_id": None,
                "script_text": payload.script_text,
                "script_text_hash": hash_text(payload.script_text),
            }
            entity_type = EntityType.SCRIPT_VERSION
        elif isinstance(payload, CreateDirectorUnitPayload):
            script_version = cast(
                ScriptVersion,
                self._require_current(
                    payload.script_version, {EntityType.SCRIPT_VERSION.value}
                ),
            )
            script_decision = cast(
                ScriptDecision,
                self._require_current(
                    payload.script_decision, {EntityType.SCRIPT_DECISION.value}
                ),
            )
            if (
                enum_value(script_version.states.lock_state) != "locked"
                or enum_value(script_version.states.creative_stage) != "locked"
            ):
                raise DomainRuleViolation(
                    "locked_script_required",
                    "DirectorUnit requires a locked ScriptVersion",
                )
            if (
                script_decision.decision != "approve_for_lock"
                or script_decision.locked_script_version_id
                != script_version.ref.film_entity_id
                or script_decision.locked_script_version_content_hash
                != script_version.ref.content_hash
            ):
                raise DomainRuleViolation(
                    "script_decision_mismatch",
                    "ScriptDecision must approve the current locked ScriptVersion hash",
                )
            if payload.director_ir_hash != hash_text(payload.director_ir_text):
                raise DomainRuleViolation(
                    "director_ir_hash_mismatch",
                    "director_ir_hash must equal sha256(director_ir_text)",
                )
            body = {
                "script_version_id": str(payload.script_version.film_entity_id),
                "states": payload.states.model_dump(mode="json"),
                "director_ir_text": payload.director_ir_text,
                "director_ir_hash": payload.director_ir_hash,
                "narrative_purpose": payload.narrative_purpose,
                "performance_beats": payload.performance_beats,
            }
            entity_type = EntityType.DIRECTOR_UNIT
        elif isinstance(payload, CreateCoverageLinkPayload):
            self._require_current(
                payload.director_unit, {EntityType.DIRECTOR_UNIT.value}
            )
            self._require_current(payload.shot, {EntityType.SHOT_EXTENSION.value})
            body = {
                "director_unit_id": str(payload.director_unit.film_entity_id),
                "shot_id": str(payload.shot.film_entity_id),
                "purpose": payload.purpose,
            }
            entity_type = EntityType.COVERAGE_LINK
        elif isinstance(payload, CreateVisualLockSetPayload):
            self._require_current(
                payload.project, {EntityType.FILM_PROJECT_EXTENSION.value}
            )
            self._require_current(payload.shot, {EntityType.SHOT_EXTENSION.value})
            if payload.visual_lock_hash != hash_text(payload.visual_lock_text):
                raise DomainRuleViolation(
                    "visual_lock_hash_mismatch",
                    "visual_lock_hash must equal sha256(visual_lock_text)",
                )
            body = {
                "project_id": str(payload.project.film_entity_id),
                "shot_id": str(payload.shot.film_entity_id),
                "states": payload.states.model_dump(mode="json"),
                "visual_lock_text": payload.visual_lock_text,
                "visual_lock_hash": payload.visual_lock_hash,
                "locks": payload.locks,
            }
            entity_type = EntityType.VISUAL_LOCK_SET
        elif isinstance(payload, CreateAssetBindingPayload):
            self._require_current(
                payload.project, {EntityType.FILM_PROJECT_EXTENSION.value}
            )
            body = {
                "project_id": str(payload.project.film_entity_id),
                "host": payload.host.model_dump(mode="json", exclude_none=True),
                "role": payload.role,
                "priority": payload.priority,
                "asset_content_hash": payload.asset_content_hash,
            }
            entity_type = EntityType.ASSET_BINDING
        elif isinstance(payload, CreateGenerationPackagePayload):
            prompt = cast(
                PromptDraft,
                self._require_current(
                    payload.prompt_draft, {EntityType.PROMPT_DRAFT.value}
                ),
            )
            parameters = payload.parameters
            parameter_hash = hash_json(parameters)
            prompt_hash = hash_text(prompt.prompt_text)
            input_hash = hash_json(
                {
                    "prompt_draft": payload.prompt_draft.model_dump(mode="json"),
                    "host_project_id": payload.host_project_id,
                    "provider_id": payload.provider_id,
                    "capability_id": payload.capability_id,
                    "parameter_hash": parameter_hash,
                    "prompt_hash": prompt_hash,
                }
            )
            body = {
                "prompt_draft_id": str(payload.prompt_draft.film_entity_id),
                "host_project_id": payload.host_project_id,
                "provider_id": payload.provider_id,
                "capability_id": payload.capability_id,
                "parameters": parameters,
                "parameter_hash": parameter_hash,
                "prompt_hash": prompt_hash,
                "input_hash": input_hash,
                "submission_state": ProviderSubmissionState.NOT_SUBMITTED.value,
            }
            entity_type = EntityType.GENERATION_PACKAGE
        else:  # pragma: no cover - discriminated Pydantic union is exhaustive
            raise TypeError("unsupported formal record payload")

        entities, event_ids = self._persist(
            [(entity_type, body)],
            actor_kind=request.actor_kind,
            command_type="formal_record.create",
            command_payload=request.model_dump(mode="json"),
        )
        return FormalRecordApplyResult(entity=entities[0], audit_event_id=event_ids[0])

    def lock_script_version(
        self, request: ScriptVersionLockRequest
    ) -> ScriptVersionLockResult:
        if enum_value(request.actor_kind) != ActorKind.HUMAN.value:
            raise DomainRuleViolation(
                "human_script_lock_required",
                "Only a human actor can approve and lock a ScriptVersion",
            )
        source = cast(
            ScriptVersion,
            self._require_current(
                request.source_script_version, {EntityType.SCRIPT_VERSION.value}
            ),
        )
        if (
            enum_value(source.states.lock_state) != "unlocked"
            or enum_value(source.states.creative_stage) == "locked"
        ):
            raise DomainRuleViolation(
                "unlocked_script_source_required",
                "Script lock requires an unlocked source ScriptVersion",
            )
        locked_id = str(uuid4())
        decision_id = str(uuid4())
        locked_states = source.states.model_dump(mode="json")
        locked_states.update(
            {
                "creative_stage": "locked",
                "review_state": "approved",
                "lock_state": "locked",
            }
        )
        locked_body = {
            "host": source.host.model_dump(mode="json", exclude_none=True),
            "states": locked_states,
            "source_script_version_id": str(source.ref.film_entity_id),
            "script_text": source.script_text,
            "script_text_hash": source.script_text_hash,
        }
        locked_content_hash = hash_json(locked_body)
        decision_body = {
            "source_script_version_id": str(source.ref.film_entity_id),
            "locked_script_version_id": locked_id,
            "locked_script_version_content_hash": locked_content_hash,
            "decision": "approve_for_lock",
            "approved_by": request.approved_by,
        }
        entities, event_ids = self._persist(
            [
                (EntityType.SCRIPT_VERSION, locked_body, locked_id),
                (EntityType.SCRIPT_DECISION, decision_body, decision_id),
            ],
            actor_kind=request.actor_kind,
            command_type="script_version.lock",
            command_payload=request.model_dump(mode="json"),
        )
        return ScriptVersionLockResult(
            locked_script_version=cast(ScriptVersion, entities[0]),
            decision=cast(ScriptDecision, entities[1]),
            audit_event_ids=event_ids,
        )

    def compile_prompt(self, request: PromptCompileRequest) -> PromptCompileResult:
        project = self._require_binding_current(
            request.project, {EntityType.FILM_PROJECT_EXTENSION.value}
        )
        shot = self._require_binding_current(
            request.shot, {EntityType.SHOT_EXTENSION.value}
        )
        director_unit = self._require_binding_current(
            request.director_unit, {EntityType.DIRECTOR_UNIT.value}
        )
        visual_lock = cast(
            VisualLockSet,
            self._require_binding_current(
                request.visual_lock, {EntityType.VISUAL_LOCK_SET.value}
            ),
        )
        assets = [
            cast(
                AssetBinding,
                self._require_binding_current(
                    asset.binding, {EntityType.ASSET_BINDING.value}
                ),
            )
            for asset in request.assets
        ]
        if request.director_ir_hash != director_unit.director_ir_hash:
            raise DomainRuleViolation(
                "director_ir_hash_mismatch",
                "director_ir_hash must equal the current DirectorUnit raw IR hash",
            )
        if request.visual_lock_hash != visual_lock.visual_lock_hash:
            raise DomainRuleViolation(
                "visual_lock_hash_mismatch",
                "visual_lock_hash must equal the current VisualLockSet raw text hash",
            )
        if visual_lock.project_id != request.project.film_entity_id:
            raise DomainRuleViolation(
                "visual_lock_project_mismatch",
                "VisualLockSet must belong to the prompt project",
            )
        if visual_lock.shot_id != request.shot.film_entity_id:
            raise DomainRuleViolation(
                "visual_lock_shot_mismatch",
                "VisualLockSet must belong to the prompt shot",
            )
        if any(
            asset.project_id != request.project.film_entity_id for asset in assets
        ):
            raise DomainRuleViolation(
                "asset_project_mismatch",
                "Every AssetBinding must belong to the prompt project",
            )
        if any(
            requested.asset_content_hash != persisted.asset_content_hash
            for requested, persisted in zip(request.assets, assets, strict=True)
        ):
            raise DomainRuleViolation(
                "asset_content_hash_mismatch",
                "Every asset_content_hash must match its current AssetBinding source hash",
            )
        project_host_id = project.host.host_project_id
        if shot.host.host_project_id != project_host_id:
            raise DomainRuleViolation(
                "shot_project_mismatch", "Shot must belong to the prompt project"
            )
        script = cast(
            ScriptVersion,
            self._require_current(
                EntityVersionGuard(
                    film_entity_id=director_unit.script_version_id,
                    expected_version=1,
                    expected_content_hash=self.formal_record(
                        str(director_unit.script_version_id)
                    ).ref.content_hash,
                ),
                {EntityType.SCRIPT_VERSION.value},
            ),
        )
        if script.host.host_project_id != project_host_id:
            raise DomainRuleViolation(
                "director_unit_project_mismatch",
                "DirectorUnit ScriptVersion must belong to the prompt project",
            )
        if (
            request.states.review_state != "not_reviewed"
            or request.states.execution_state != "not_started"
            or request.states.lock_state != "unlocked"
        ):
            raise DomainRuleViolation(
                "prompt_draft_state_invalid",
                "Prompt compile cannot create reviewed, executed, or locked state",
            )

        prompt_id = str(uuid4())
        provenance_id = str(uuid4())
        prompt_hash = hash_text(request.prompt_text)
        capability_hash = hash_json(
            request.capability_profile.model_dump(mode="json")
        )
        provenance_material = request.model_dump(
            mode="json",
            exclude={"draft_write", "provenance_write", "actor_kind"},
        )
        input_hash = hash_json(provenance_material)
        prompt_body = {
            "states": request.states.model_dump(mode="json"),
            "director_ir_hash": request.director_ir_hash,
            "visual_lock_hash": request.visual_lock_hash,
            "model_capability_profile": request.model_capability_profile,
            "prompt_text": request.prompt_text,
        }
        provenance_body = {
            "prompt_draft_id": prompt_id,
            "expected_version": request.draft_write.expected_version,
            "director_ir_hash": request.director_ir_hash,
            "visual_lock_hash": request.visual_lock_hash,
            "project": request.project.model_dump(mode="json"),
            "shot": request.shot.model_dump(mode="json"),
            "director_unit": request.director_unit.model_dump(mode="json"),
            "visual_lock": request.visual_lock.model_dump(mode="json"),
            "prompt_template": request.prompt_template.model_dump(mode="json"),
            "assets": [asset.model_dump(mode="json") for asset in request.assets],
            "capability_profile": request.capability_profile.model_dump(mode="json"),
            "provider_parameters": request.provider_parameters.model_dump(mode="json"),
            "input_hash": input_hash,
            "prompt_hash": prompt_hash,
            "capability_hash": capability_hash,
            "submission_state": ProviderSubmissionState.NOT_SUBMITTED.value,
            "generated_result_state": GeneratedResultState.CANDIDATE_ONLY.value,
            "approval_state": ApprovalBoundaryState.SEPARATE_HUMAN_ACTION_REQUIRED.value,
        }
        entities, event_ids = self._persist(
            [
                (EntityType.PROMPT_DRAFT, prompt_body, prompt_id),
                (
                    EntityType.PROMPT_DRAFT_PROVENANCE,
                    provenance_body,
                    provenance_id,
                ),
            ],
            actor_kind=request.actor_kind,
            command_type="prompt.compile",
            command_payload=request.model_dump(mode="json"),
        )
        return PromptCompileResult(
            prompt_draft=cast(PromptDraft, entities[0]),
            provenance=cast(PromptDraftProvenance, entities[1]),
            audit_event_ids=event_ids,
        )

    def import_manual_result(
        self, request: ManualResultImportRequest
    ) -> ManualResultImportResult:
        package = cast(
            GenerationPackage,
            self._require_current(
                request.generation_package,
                {EntityType.GENERATION_PACKAGE.value},
            ),
        )
        if package.submission_state != ProviderSubmissionState.NOT_SUBMITTED.value:
            raise DomainRuleViolation(
                "external_submission_forbidden",
                "Golden A accepts only NOT_SUBMITTED manual packages",
            )
        if any(output.output_kind != package.capability_id for output in request.outputs):
            raise DomainRuleViolation(
                "provider_result_capability_mismatch",
                "Manual result output kind must match GenerationPackage capability",
            )

        evidence_id = str(uuid4())
        candidate_id = str(uuid4())
        outputs = [
            ImportedOutputReference(
                film_representation_id=uuid4(),
                **output.model_dump(mode="json"),
            ).model_dump(mode="json")
            for output in request.outputs
        ]
        evidence_body = {
            "generation_package_id": str(package.ref.film_entity_id),
            "provider_id": package.provider_id,
            "provider_task_id": request.provider_task_id,
            "receipt_id": request.receipt.receipt_id,
            "receipt_hash": request.receipt.content_hash,
            "receipt_captured_at": request.receipt.model_dump(mode="json")[
                "captured_at"
            ],
            "parameter_hash": package.parameter_hash,
            "prompt_hash": package.prompt_hash,
            "input_hash": package.input_hash,
            "parameters": package.parameters,
            "manual_import_source_id": request.manual_source.source_id,
            "imported_by": request.manual_source.imported_by,
            "imported_at": request.manual_source.model_dump(mode="json")["imported_at"],
            "authorization_evidence_id": request.manual_source.authorization_evidence_id,
            "outputs": outputs,
        }
        candidate_body = {
            "generation_package_id": str(package.ref.film_entity_id),
            "generation_attempt_evidence_id": evidence_id,
            "host": {"host_project_id": package.host_project_id},
            "states": candidate_states().model_dump(mode="json"),
            "output_hash": hash_json(outputs),
        }
        entities, event_ids = self._persist(
            [
                (
                    EntityType.GENERATION_ATTEMPT_EVIDENCE,
                    evidence_body,
                    evidence_id,
                ),
                (EntityType.CANDIDATE, candidate_body, candidate_id),
            ],
            actor_kind=request.actor_kind,
            command_type="manual_result.import",
            command_payload=request.model_dump(mode="json"),
        )
        return ManualResultImportResult(
            evidence=cast(GenerationAttemptEvidence, entities[0]),
            candidate=cast(Candidate, entities[1]),
            audit_event_ids=event_ids,
        )

    def create_review(self, request: ReviewCreateRequest) -> Review:
        candidate = cast(
            Candidate,
            self._require_current(
                request.candidate, {EntityType.CANDIDATE.value}
            ),
        )
        body = {
            "target_id": str(candidate.ref.film_entity_id),
            "target_content_hash": candidate.ref.content_hash,
            "review_state": enum_value(request.review_state),
            "reviewer_kind": enum_value(request.reviewer_kind),
            "findings": request.findings,
        }
        entities, _ = self._persist(
            [(EntityType.REVIEW, body)],
            actor_kind=request.actor_kind,
            command_type="review.create",
            command_payload=request.model_dump(mode="json"),
        )
        return cast(Review, entities[0])

    def create_approval(self, request: ApprovalCreateRequest) -> Approval:
        if enum_value(request.actor_kind) != ActorKind.HUMAN.value:
            raise DomainRuleViolation(
                "human_approval_required", "Only a human actor can create Approval"
            )
        candidate = cast(
            Candidate,
            self._require_current(
                request.candidate, {EntityType.CANDIDATE.value}
            ),
        )
        review = cast(
            Review,
            self._require_current(request.passed_review, {EntityType.REVIEW.value}),
        )
        if (
            enum_value(review.review_state) != ReviewOutcome.PASSED.value
            or review.target_id != candidate.ref.film_entity_id
            or review.target_content_hash != candidate.ref.content_hash
        ):
            raise DomainRuleViolation(
                "passed_review_required",
                "Approval requires a passed Review bound to the current Candidate hash",
            )
        body = {
            "target_id": str(candidate.ref.film_entity_id),
            "review_id": str(review.ref.film_entity_id),
            "actor_kind": ActorKind.HUMAN.value,
            "approved_by": request.approved_by,
            "approved_content_hash": candidate.ref.content_hash,
        }
        entities, _ = self._persist(
            [(EntityType.APPROVAL, body)],
            actor_kind=request.actor_kind,
            command_type="approval.create",
            command_payload=request.model_dump(mode="json"),
        )
        return cast(Approval, entities[0])

    def check_continuity(
        self, request: ContinuityCheckRequest
    ) -> ContinuityCheckResult:
        current = self._require_current(
            request.current_shot, {EntityType.SHOT_EXTENSION.value}
        )
        previous = (
            self._require_current(
                request.previous_shot, {EntityType.SHOT_EXTENSION.value}
            )
            if request.previous_shot is not None
            else None
        )
        blockers = [
            ContinuityBlocker(
                code=f"{enum_value(check.dimension).upper()}_CONTINUITY_BROKEN",
                dimension=check.dimension,
                subject_id=check.subject_id,
                expected_value=check.expected_value,
                actual_value=check.actual_value,
            )
            for check in request.checks
            if check.expected_value != check.actual_value
        ]
        body = {
            "previous_shot_id": (
                str(previous.ref.film_entity_id) if previous is not None else None
            ),
            "current_shot_id": str(current.ref.film_entity_id),
            "passed": not blockers,
            "blockers": [blocker.model_dump(mode="json") for blocker in blockers],
        }
        entities, _ = self._persist(
            [(EntityType.CONTINUITY_CHECK_RESULT, body)],
            actor_kind=request.actor_kind,
            command_type="continuity.check",
            command_payload=request.model_dump(mode="json"),
        )
        return cast(ContinuityCheckResult, entities[0])

    def _require_binding_current(
        self, binding: BoundEntityReference, allowed_types: set[str]
    ) -> FormalEntity | Any:
        if binding.entity_type not in allowed_types:
            raise DomainRuleViolation(
                "source_entity_type_mismatch",
                f"Source entity type {binding.entity_type} is not allowed",
            )
        entity = self._require_current(
            EntityVersionGuard(
                film_entity_id=binding.film_entity_id,
                expected_version=binding.expected_version,
                expected_content_hash=binding.expected_content_hash,
            ),
            allowed_types,
        )
        actual_host = getattr(entity, "host", HostReferences())
        if binding.host.model_dump(mode="json", exclude_none=True) != actual_host.model_dump(
            mode="json", exclude_none=True
        ):
            raise DomainRuleViolation(
                "source_host_reference_mismatch",
                "Bound source Host references must match the persisted record",
            )
        return entity

    def _require_current(
        self, guard: EntityVersionGuard, allowed_types: set[str]
    ) -> FormalEntity | Any:
        film_entity_id = str(guard.film_entity_id)
        try:
            row = self.repository.formal_record(film_entity_id)
            entity = self._formal_from_row(row)
        except EntityNotFound:
            row = self.repository.entity(film_entity_id)
            entity = self._legacy_ref_entity(row)
        entity_type = enum_value(entity.ref.entity_type)
        if entity_type not in allowed_types:
            raise DomainRuleViolation(
                "source_entity_type_mismatch",
                f"Source entity {film_entity_id} has type {entity_type}",
            )
        if entity.ref.version != guard.expected_version:
            raise VersionConflict(
                film_entity_id, guard.expected_version, entity.ref.version
            )
        if entity.ref.content_hash != guard.expected_content_hash:
            raise ContentHashConflict(
                film_entity_id,
                guard.expected_content_hash,
                entity.ref.content_hash,
            )
        return entity

    def _persist(
        self,
        entries: list[
            tuple[EntityType, dict[str, Any]]
            | tuple[EntityType, dict[str, Any], str]
        ],
        *,
        actor_kind: ActorKind | str,
        command_type: str,
        command_payload: dict[str, Any],
    ) -> tuple[list[FormalEntity], list[str]]:
        now = utc_now()
        records: list[dict[str, Any]] = []
        audits: list[dict[str, Any]] = []
        for entry in entries:
            entity_type, body = entry[0], entry[1]
            film_entity_id = entry[2] if len(entry) == 3 else str(uuid4())
            event_id = str(uuid4())
            records.append(
                {
                    "film_entity_id": film_entity_id,
                    "entity_type": entity_type.value,
                    "version": 1,
                    "content_hash": hash_json(body),
                    "payload_json": canonical_json(body),
                    "created_at": now,
                    "updated_at": now,
                }
            )
            audits.append(
                {
                    "event_id": event_id,
                    "actor_kind": enum_value(actor_kind),
                    "action": f"{entity_type.value}.created",
                    "target_id": film_entity_id,
                    "previous_version": None,
                    "resulting_version": 1,
                    "command_type": command_type,
                    "command_payload_json": canonical_json(command_payload),
                    "recorded_at": now,
                }
            )
        rows, _ = self.repository.create_formal_records_with_audits(records, audits)
        return [self._formal_from_row(row) for row in rows], [a["event_id"] for a in audits]

    @staticmethod
    def _formal_from_row(row) -> FormalEntity:
        entity_type = str(row["entity_type"])
        model = FORMAL_MODEL_BY_TYPE.get(entity_type)
        if model is None:
            raise ValueError(f"Unsupported formal entity type: {entity_type}")
        reference = FilmEntityRef(
            film_entity_id=row["film_entity_id"],
            entity_type=entity_type,
            version=row["version"],
            content_hash=row["content_hash"],
        )
        payload = json.loads(row["payload_json"])
        return model(ref=reference, **payload)

    def _legacy_ref_entity(self, row):
        from film_production_core.service import FilmService

        return FilmService(self.repository)._entity_from_row(row)


def candidate_states() -> FormalStateAxes:
    return FormalStateAxes(
        creative_stage="authored",
        execution_state="succeeded",
        review_state="pending",
        lock_state="unlocked",
        delivery_state="not_ready",
        stale_state="fresh",
    )


def enum_value(value: Any) -> str:
    return str(getattr(value, "value", value))
