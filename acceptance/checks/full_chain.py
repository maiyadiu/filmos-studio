#!/usr/bin/env python3
"""Reproduce the fixed FilmOS Local-first acceptance chain in one real Sidecar.

This check deliberately uses the local/manual Provider boundary. It proves the
formal Provider-to-Candidate import contract without making an external call;
the independently gated real CLI generation drill must not be inferred from
this receipt.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[2]
GOLDEN_ROOT = ROOT / "tests" / "film-golden"
FIXTURE = ROOT / "acceptance" / "FilmOS_Acceptance_Project" / "项目.json"
if str(GOLDEN_ROOT) not in sys.path:
    sys.path.insert(0, str(GOLDEN_ROOT))

from golden_a_real import (  # noqa: E402
    FORMAL_STATES,
    HASH_A,
    FilmCoreHttpClient,
    CoreHttpError,
    bound,
    continuity_check,
    create_formal,
    create_guard,
    create_legacy,
    expect_core_error,
    require_uuid4,
    sha256_text,
    version_guard,
)
from golden_b_real import LOCKED_APPROVED_STATES  # noqa: E402
from golden_c_real import (  # noqa: E402
    camera_payload,
    composition_payload,
    database_fingerprint,
    scene_payload,
    sha256_json,
    spatial_create_request,
    spatial_update_request,
    start_sidecar,
    stop_sidecar,
)


GOLDEN_ID = "ACCEPTANCE-FULL-CHAIN-001"
HOST_PROJECT_ID = "accept-project-001"
HOST_UNIT_ID = "accept-unit-001"
HOST_SHOT_ID = "accept-shot-001"
OCCURRED_AT = "2026-08-28T12:00:00Z"
EXPECTED_KINDS = (
    "Project",
    "ContentUnit",
    "Script",
    "Scene",
    "DirectorUnit",
    "Shot",
    "Asset",
    "SceneTwin",
    "Prompt",
    "Provider",
    "Candidate",
    "QC",
    "Approved",
)


class AcceptanceChainError(RuntimeError):
    pass


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()


def create_structure_map(
    client: FilmCoreHttpClient, script: dict[str, Any]
) -> tuple[dict[str, Any], str]:
    section_id = str(uuid4())
    cue_id = str(uuid4())
    structure = client.post(
        "/script-structure-maps",
        {
            "write": create_guard(),
            "actor_kind": "codex",
            "script_version": version_guard(script),
            "sections": [
                {"section_id": section_id, "start_order": 1, "end_order": 1}
            ],
            "cues": [
                {
                    "cue_id": cue_id,
                    "section_id": section_id,
                    "speaker": "A",
                    "order": 1,
                    "cue_text_hash": sha256_text("我们从这个镜头开始。"),
                }
            ],
        },
    )
    require_uuid4(structure["ref"]["film_entity_id"], "script_structure_map")
    return structure, section_id


def create_blocking_payload(
    shot: dict[str, Any], scene: dict[str, Any]
) -> dict[str, Any]:
    return {
        "entity_type": "blocking_version",
        "shot": version_guard(shot),
        "scene_twin": version_guard(scene),
        "states": FORMAL_STATES,
        "beat_id": "acceptance-beat-001",
        "actors": [
            {
                "actor_id": "character-a",
                "feet_anchor_id": "anchor-table",
                "position": {"x": -0.5, "y": 0, "z": 1},
                "torso_rotation_degrees": {"x": 0, "y": 90, "z": 0},
                "face_target_id": "character-b",
                "gaze_target_id": "character-b",
                "left_hand_target_id": None,
                "right_hand_target_id": "table-fixed",
                "action_in": "feet-planted",
                "action_out": "right-hand-reaches-target-prop",
                "axis_side_in": "left",
                "axis_side_out": "left",
                "prop_contact_in_ids": [],
                "prop_contact_out_ids": ["table-fixed"],
            },
            {
                "actor_id": "character-b",
                "feet_anchor_id": "anchor-table",
                "position": {"x": 0.5, "y": 0, "z": 1},
                "torso_rotation_degrees": {"x": 0, "y": -90, "z": 0},
                "face_target_id": "character-a",
                "gaze_target_id": "character-a",
                "left_hand_target_id": "table-fixed",
                "right_hand_target_id": None,
                "action_in": "feet-planted",
                "action_out": "left-hand-holds-target-prop",
                "axis_side_in": "right",
                "axis_side_out": "right",
                "prop_contact_in_ids": ["table-fixed"],
                "prop_contact_out_ids": ["table-fixed"],
            },
        ],
    }


def create_spatial_impact(
    client: FilmCoreHttpClient,
    owner: dict[str, Any],
    target: dict[str, Any],
) -> dict[str, Any]:
    return client.post(
        "/impacts",
        {
            "write": create_guard(),
            "actor_kind": "codex",
            "dependency_owner": version_guard(owner),
            "script_structure_map": None,
            "source": version_guard(owner),
            "target": version_guard(target),
            "dependency_key": "lighting_base",
            "scope": {
                "kind": "spatial_version_component",
                "component_key": "lighting_base",
            },
            "relation": "acceptance_spatial_prompt_dependency",
            "propagates_stale": True,
        },
    )


def ref_evidence(entity: dict[str, Any]) -> dict[str, Any]:
    return {
        "runtime_id": entity["ref"]["film_entity_id"],
        "entity_type": entity["ref"]["entity_type"],
        "version": entity["ref"]["version"],
        "content_hash": entity["ref"]["content_hash"],
    }


def read_named_refs(
    client: FilmCoreHttpClient, expected: dict[str, dict[str, Any]]
) -> bool:
    for name, expected_ref in expected.items():
        try:
            current = client.get(
                f"/formal-records/{expected_ref['film_entity_id']}"
            )
        except CoreHttpError as error:
            raise AcceptanceChainError(
                f"restart read failed for {name}: HTTP {error.status}"
            ) from error
        if current["ref"] != expected_ref:
            return False
    return True


def validate_fixture(
    fixture: dict[str, Any], runtime_objects: dict[str, dict[str, Any]]
) -> None:
    objects = fixture.get("objects")
    if not isinstance(objects, list):
        raise AcceptanceChainError("acceptance fixture objects must be a list")
    if tuple(item.get("kind") for item in objects) != EXPECTED_KINDS:
        raise AcceptanceChainError("acceptance fixture chain order changed")
    aliases = [str(item.get("stable_id", "")) for item in objects]
    if len(aliases) != len(set(aliases)) or set(aliases) != set(runtime_objects):
        raise AcceptanceChainError("fixture aliases do not match runtime evidence")
    for item in objects:
        alias = str(item["stable_id"])
        parent = item.get("parent")
        if parent is not None and parent not in runtime_objects:
            raise AcceptanceChainError(f"fixture parent is missing: {alias} -> {parent}")


def run_full_chain() -> dict[str, Any]:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    python = os.environ.get("FILMOS_CORE_PYTHON", "").strip() or sys.executable
    with tempfile.TemporaryDirectory(prefix="filmos-acceptance-full-chain-") as root:
        database_path = Path(root) / "film-core.sqlite"
        process, client = start_sidecar(database_path, python)
        try:
            health = client.get("/health")
            project = create_legacy(
                client,
                "film_project_extension",
                {"host_project_id": HOST_PROJECT_ID},
            )
            unit = create_legacy(
                client,
                "content_unit_extension",
                {
                    "host_project_id": HOST_PROJECT_ID,
                    "host_unit_id": HOST_UNIT_ID,
                },
                unit_kind="episode",
            )
            shot = create_legacy(
                client,
                "shot_extension",
                {
                    "host_project_id": HOST_PROJECT_ID,
                    "host_unit_id": HOST_UNIT_ID,
                    "host_shot_id": HOST_SHOT_ID,
                },
                director_unit_ids=[],
            )

            source_script = create_formal(
                client,
                "script_version",
                host={
                    "host_project_id": HOST_PROJECT_ID,
                    "host_unit_id": HOST_UNIT_ID,
                },
                states=FORMAL_STATES,
                script_text="INT. ACCEPTANCE ROOM - DAY\nA：我们从这个镜头开始。",
            )
            locked = client.post(
                "/script-versions/lock",
                {
                    "locked_write": create_guard(),
                    "decision_write": create_guard(),
                    "actor_kind": "human",
                    "source_script_version": version_guard(source_script),
                    "approved_by": "acceptance-human-director",
                },
            )
            script = locked["locked_script_version"]
            script_decision = locked["decision"]
            structure, section_id = create_structure_map(client, script)

            scene_v1 = client.post(
                "/spatial-versions",
                spatial_create_request(
                    "acceptance-scene-twin-v1",
                    scene_payload(project, unit, lighting_intensity=0.8),
                ),
            )["entity"]
            camera = client.post(
                "/spatial-versions",
                spatial_create_request(
                    "acceptance-camera-v1",
                    camera_payload(
                        shot,
                        scene_v1,
                        "acceptance-camera",
                        "zone-entry-wide",
                        "entry-axis-wide",
                        0,
                        camera_side="left",
                        screen_direction="left_to_right",
                        position_anchor_id="anchor-door-outside",
                    ),
                ),
            )["entity"]
            blocking = client.post(
                "/spatial-versions",
                spatial_create_request(
                    "acceptance-blocking-v1",
                    create_blocking_payload(shot, scene_v1),
                ),
            )["entity"]
            composition = client.post(
                "/spatial-versions",
                spatial_create_request(
                    "acceptance-composition-v1",
                    composition_payload(
                        shot, scene_v1, camera, blocking, 1, framing="wide"
                    ),
                ),
            )["entity"]

            director_text = "固定门口主轴，A 从画面左侧伸手，B 在桌边保持反应。"
            director = create_formal(
                client,
                "director_unit",
                script_version=version_guard(script),
                script_decision=version_guard(script_decision),
                states=LOCKED_APPROVED_STATES,
                director_ir_text=director_text,
                director_ir_hash=sha256_text(director_text),
                narrative_purpose="验证固定验收项目的单链路生产边界",
                performance_beats=["停步", "伸手", "反应"],
            )
            coverage = create_formal(
                client,
                "coverage_link",
                director_unit=version_guard(director),
                shot=version_guard(shot),
                purpose="acceptance master coverage",
            )
            asset = create_formal(
                client,
                "asset_binding",
                project=version_guard(project),
                host={
                    "host_project_id": HOST_PROJECT_ID,
                    "host_asset_id": "accept-asset-001",
                    "host_asset_version_id": "accept-asset-version-001",
                    "host_resource_id": "accept-resource-001",
                },
                role="scene_twin_reference",
                priority=100,
                asset_content_hash=scene_v1["ref"]["content_hash"],
            )
            lock_text = "FilmOS Acceptance SceneTwin/camera/blocking/composition hash lock"
            visual_lock = create_formal(
                client,
                "visual_lock_set",
                project=version_guard(project),
                shot=version_guard(shot),
                states=LOCKED_APPROVED_STATES,
                visual_lock_text=lock_text,
                visual_lock_hash=sha256_text(lock_text),
                locks={
                    "sceneTwinVersion": scene_v1["ref"]["content_hash"],
                    "cameraVersion": camera["ref"]["content_hash"],
                    "blockingVersion": blocking["ref"]["content_hash"],
                    "compositionVersion": composition["ref"]["content_hash"],
                },
            )
            compiled = client.post(
                "/prompts/compile",
                {
                    "draft_write": create_guard(),
                    "provenance_write": create_guard(),
                    "actor_kind": "codex",
                    "states": FORMAL_STATES,
                    "director_ir_hash": director["director_ir_hash"],
                    "visual_lock_hash": visual_lock["visual_lock_hash"],
                    "model_capability_profile": "manual.video.v1",
                    "prompt_text": "使用锁定空间与轴线生成 9:16 六秒候选视频。",
                    "project": bound(project),
                    "shot": bound(shot),
                    "director_unit": bound(director),
                    "visual_lock": bound(visual_lock),
                    "prompt_template": {
                        "host_prompt_template_id": "accept-prompt-template-001",
                        "operation": "film.prompt.compile",
                        "version": 1,
                        "content_hash": HASH_A,
                    },
                    "assets": [
                        {
                            "binding": bound(asset),
                            "asset_content_hash": asset["asset_content_hash"],
                        }
                    ],
                    "capability_profile": {
                        "profile_id": "manual-video-v1",
                        "profile_version": 1,
                        "provider_id": "manual_web",
                        "output_kind": "video",
                        "dialect": "plain_zh",
                        "capabilities": {
                            "reference_assets": True,
                            "negative_prompt": True,
                            "camera_control": True,
                        },
                    },
                    "provider_parameters": {
                        "aspect_ratio": "9:16",
                        "duration_seconds": 6,
                        "seed": None,
                        "negative_prompt": "越轴，视线漂移，道具错位",
                    },
                },
            )
            prompt = compiled["prompt_draft"]
            prompt_provenance = compiled["provenance"]
            provider = create_formal(
                client,
                "generation_package",
                prompt_draft=version_guard(prompt),
                host_project_id=HOST_PROJECT_ID,
                provider_id="manual_web",
                capability_id="video",
                parameters={
                    "aspect_ratio": "9:16",
                    "duration_seconds": 6,
                    "local_fixture_only": True,
                },
            )
            imported = client.post(
                "/manual-results/import",
                {
                    "evidence_write": create_guard(),
                    "candidate_write": create_guard(),
                    "actor_kind": "human",
                    "generation_package": version_guard(provider),
                    "provider_task_id": "accept-local-task-001",
                    "receipt": {
                        "receipt_id": "accept-local-receipt-001",
                        "content_hash": "d" * 64,
                        "captured_at": OCCURRED_AT,
                    },
                    "manual_source": {
                        "source_id": "accept-local-source-001",
                        "source_kind": "local_runtime_export",
                        "imported_by": "acceptance-human-operator",
                        "imported_at": OCCURRED_AT,
                        "authorization_evidence_id": "accept-local-authorization-001",
                    },
                    "outputs": [
                        {
                            "host_resource_id": "accept-candidate-resource-001",
                            "output_kind": "video",
                            "content_hash": "7" * 64,
                            "mime_type": "video/mp4",
                            "bytes": 4097,
                        }
                    ],
                },
            )
            attempt = imported["evidence"]
            candidate = imported["candidate"]
            continuity = client.post(
                "/continuity/check",
                {
                    "write": create_guard(),
                    "actor_kind": "codex",
                    "previous_shot": None,
                    "current_shot": version_guard(shot),
                    "checks": [
                        continuity_check("axis", "axis-main", "left_to_right"),
                        continuity_check("eyeline", "character-a", "character-b"),
                        continuity_check("blocking", "character-a", "walk-room"),
                        continuity_check("action", "character-a", "reaches-prop"),
                        continuity_check("prop_contact", "table-fixed", "right_hand"),
                    ],
                },
            )
            review = client.post(
                "/reviews",
                {
                    "write": create_guard(),
                    "actor_kind": "codex",
                    "candidate": version_guard(candidate),
                    "review_state": "passed",
                    "reviewer_kind": "automated_qc",
                    "findings": [],
                },
            )
            nonhuman_approval = expect_core_error(
                lambda: client.post(
                    "/approvals",
                    {
                        "write": create_guard(),
                        "actor_kind": "codex",
                        "candidate": version_guard(candidate),
                        "passed_review": version_guard(review),
                        "approved_by": "acceptance-human-director",
                    },
                ),
                status=409,
                code="human_approval_required",
            )
            approval = client.post(
                "/approvals",
                {
                    "write": create_guard(),
                    "actor_kind": "human",
                    "candidate": version_guard(candidate),
                    "passed_review": version_guard(review),
                    "approved_by": "acceptance-human-director",
                },
            )
            persisted_candidate = client.get(
                f"/formal-records/{candidate['ref']['film_entity_id']}"
            )

            edge = create_spatial_impact(client, scene_v1, prompt)
            scene_update = spatial_update_request(
                "acceptance-scene-twin-v2",
                scene_v1,
                scene_payload(project, unit, lighting_intensity=0.85),
            )
            scene_v2 = client.request(
                "PUT",
                f"/spatial-versions/{scene_v1['ref']['film_entity_id']}",
                scene_update,
            )["entity"]
            stale_payload = {
                "idempotency_key": "acceptance-precise-stale-001",
                "actor_kind": "codex",
                "dependency_owner": version_guard(scene_v2),
                "script_structure_map": None,
                "changes": [
                    {
                        "dependency_key": "lighting_base",
                        "scope": {
                            "kind": "spatial_version_component",
                            "component_key": "lighting_base",
                        },
                        "previous_dependency_hash": sha256_json(
                            {"profile": "warm-interior", "intensity": 0.8}
                        ),
                        "current_dependency_hash": sha256_json(
                            {"profile": "warm-interior", "intensity": 0.85}
                        ),
                    }
                ],
            }
            stale_result = client.post("/impacts/propagate-stale", stale_payload)
            stale_replay = client.post("/impacts/propagate-stale", stale_payload)
            stale_prompt = client.get(
                f"/formal-records/{prompt['ref']['film_entity_id']}"
            )
            fresh_candidate = client.get(
                f"/formal-records/{candidate['ref']['film_entity_id']}"
            )

            formal_entities = {
                "project": project,
                "content_unit": unit,
                "shot": shot,
                "source_script": source_script,
                "script": script,
                "script_decision": script_decision,
                "structure": structure,
                "scene_twin": scene_v2,
                "camera": camera,
                "blocking": blocking,
                "composition": composition,
                "director": director,
                "coverage": coverage,
                "asset": asset,
                "visual_lock": visual_lock,
                "prompt": stale_prompt,
                "prompt_provenance": prompt_provenance,
                "provider": provider,
                "attempt": attempt,
                "candidate": fresh_candidate,
                "continuity": continuity,
                "review": review,
                "approval": approval,
                "impact": edge,
            }
            for name, entity in formal_entities.items():
                require_uuid4(entity["ref"]["film_entity_id"], name)

            runtime_objects = {
                "accept-project-001": ref_evidence(project),
                "accept-unit-001": ref_evidence(unit),
                "accept-script-001": ref_evidence(script),
                "accept-scene-001": {
                    "runtime_id": section_id,
                    "entity_type": "script_section",
                    "version": structure["ref"]["version"],
                    "content_hash": canonical_hash(structure["sections"][0]),
                    "container_id": structure["ref"]["film_entity_id"],
                },
                "accept-director-001": ref_evidence(director),
                "accept-shot-001": ref_evidence(shot),
                "accept-asset-001": ref_evidence(asset),
                "accept-scene-twin-001": ref_evidence(scene_v2),
                "accept-prompt-001": ref_evidence(stale_prompt),
                "accept-provider-local-001": {
                    **ref_evidence(provider),
                    "provider_id": provider["provider_id"],
                    "execution_boundary": "LOCAL_MANUAL_CANDIDATE_IMPORT",
                },
                "accept-candidate-001": ref_evidence(fresh_candidate),
                "accept-qc-001": ref_evidence(review),
                "accept-approval-001": ref_evidence(approval),
            }
            validate_fixture(fixture, runtime_objects)
            expected_refs = {
                name: entity["ref"]
                for name, entity in formal_entities.items()
                if name not in {"project", "content_unit", "shot", "structure", "impact"}
            }
            expected_legacy_refs = {
                name: formal_entities[name]["ref"]
                for name in ("project", "content_unit", "shot")
            }
            before_restart = database_fingerprint(database_path)

            chain_passed = all(
                (
                    health.get("status") == "ok",
                    continuity["passed"] is True,
                    review["review_state"] == "passed",
                    nonhuman_approval.status == 409,
                    approval["actor_kind"] == "human",
                    approval["approved_content_hash"]
                    == candidate["ref"]["content_hash"],
                    persisted_candidate == candidate,
                    stale_result["stale_entity_ids"]
                    == [prompt["ref"]["film_entity_id"]],
                    stale_prompt["states"]["stale_state"] == "stale",
                    fresh_candidate["states"]["stale_state"] == "fresh",
                    stale_replay["replayed"] is True,
                    edge["dependency_content_hash"]
                    == stale_payload["changes"][0]["previous_dependency_hash"],
                )
            )
        finally:
            stop_sidecar(process)

        process, client = start_sidecar(database_path, python)
        try:
            after_restart = database_fingerprint(database_path)
            restart_refs_exact = read_named_refs(client, expected_refs)
            restart_legacy_refs_exact = all(
                client.get(f"/entities/{ref['film_entity_id']}")["ref"] == ref
                for ref in expected_legacy_refs.values()
            )
            restart_structure_exact = (
                client.get(
                    f"/script-structure-maps/{structure['ref']['film_entity_id']}"
                )
                == structure
            )
            stale_replay_after_restart = client.post(
                "/impacts/propagate-stale", stale_payload
            )
        finally:
            stop_sidecar(process)

        restart_exact = (
            before_restart == after_restart
            and restart_refs_exact
            and restart_legacy_refs_exact
            and restart_structure_exact
            and stale_replay_after_restart["replayed"] is True
        )
        passed = chain_passed and restart_exact
        return {
            "golden_id": GOLDEN_ID,
            "test_status": "PASSED" if passed else "FAILED",
            "fixture_project_id": fixture["project_id"],
            "mode": fixture["mode"],
            "chain": [
                {"kind": item["kind"], "stable_id": item["stable_id"]}
                for item in fixture["objects"]
            ],
            "runtime_objects": runtime_objects,
            "proof": {
                "same_sidecar_chain": chain_passed,
                "scene_is_locked_script_section": True,
                "coverage_link_id": coverage["ref"]["film_entity_id"],
                "scene_twin_spatial_versions": {
                    "scene_twin": scene_v2["ref"]["version"],
                    "camera": camera["ref"]["version"],
                    "blocking": blocking["ref"]["version"],
                    "composition": composition["ref"]["version"],
                },
                "candidate_unchanged_after_approval": persisted_candidate == candidate,
                "human_only_approval_enforced": nonhuman_approval.status == 409,
                "precise_stale_target_ids": stale_result["stale_entity_ids"],
                "candidate_remained_fresh": fresh_candidate["states"]["stale_state"]
                == "fresh",
                "restart_exact": restart_exact,
            },
            "provider": {
                "provider_id": "manual_web",
                "execution_boundary": "LOCAL_MANUAL_CANDIDATE_IMPORT",
                "external_provider_calls": 0,
                "real_cli_generation_proved": False,
            },
            "fallback_mock_used": False,
        }


def main() -> int:
    try:
        result = run_full_chain()
    except (AcceptanceChainError, CoreHttpError, OSError, ValueError) as error:
        print(
            json.dumps(
                {
                    "golden_id": GOLDEN_ID,
                    "test_status": "FAILED",
                    "error_type": type(error).__name__,
                    "error": str(error),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        )
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["test_status"] == "PASSED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
