#!/usr/bin/env python3
"""Real local Golden C and recovery adapter.

The adapter uses a temporary Film Core SQLite database over real HTTP. Previs
and video inputs are local, hash-bound fixtures: no external Provider is called
and no in-memory formal-store fallback is permitted.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
from pathlib import Path
from typing import Any
from uuid import uuid4

from golden_a_real import (
    FILM_CORE_SOURCE,
    FORMAL_STATES,
    HASH_A,
    HASH_B,
    HASH_C,
    REPOSITORY_ROOT,
    CoreHttpError,
    FilmCoreHttpClient,
    GoldenARealError,
    available_loopback_port,
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
from golden_b_real import LOCKED_APPROVED_STATES, compile_prompt


REQUIRED_GOLDEN_C_OPERATIONS = (
    ("POST", "/spatial-versions"),
    ("GET", "/spatial-versions/{filmEntityId}"),
    ("PUT", "/spatial-versions/{filmEntityId}"),
    ("POST", "/formal-records"),
    ("GET", "/formal-records/{filmEntityId}"),
    ("POST", "/script-versions/lock"),
    ("POST", "/prompts/compile"),
    ("POST", "/manual-results/import"),
    ("POST", "/continuity/check"),
    ("POST", "/impacts"),
    ("POST", "/impacts/propagate-stale"),
)
OCCURRED_AT = "2026-08-28T12:00:00Z"
ZERO_HASH = "0" * 64


def run_real_golden_c(*, python_executable: str | None = None) -> dict[str, Any]:
    executable = (
        python_executable
        or os.environ.get("FILMOS_CORE_PYTHON", "").strip()
        or sys.executable
    )
    trace_id = str(uuid4())
    with tempfile.TemporaryDirectory(prefix="filmos-golden-c-") as directory:
        root = Path(directory)
        database_path = root / "film-core.sqlite"
        process, client = start_sidecar(database_path, executable)
        try:
            health = client.get("/health")
            operations = client.operations()
            missing = missing_golden_c_operations(operations)
            if missing:
                return blocked_receipt(trace_id, health, missing)

            project = create_legacy(
                client,
                "film_project_extension",
                {"host_project_id": "host-project-golden-c"},
            )
            unit = create_legacy(
                client,
                "content_unit_extension",
                {
                    "host_project_id": "host-project-golden-c",
                    "host_unit_id": "host-unit-golden-c",
                },
                unit_kind="episode",
            )
            shots = [
                create_legacy(
                    client,
                    "shot_extension",
                    {
                        "host_project_id": "host-project-golden-c",
                        "host_unit_id": "host-unit-golden-c",
                        "host_shot_id": f"host-shot-golden-c-{index}",
                    },
                    director_unit_ids=[],
                )
                for index in range(1, 4)
            ]

            scene_request = spatial_create_request(
                f"golden-c-scene-{trace_id}",
                scene_payload(project, unit, lighting_intensity=0.8),
            )
            scene_first = client.post("/spatial-versions", scene_request)
            scene_replay = client.post("/spatial-versions", scene_request)
            scene_v1 = scene_first["entity"]
            scene_for_chain = scene_v1

            cameras: list[dict[str, Any]] = []
            blockings: list[dict[str, Any]] = []
            compositions: list[dict[str, Any]] = []
            plans = (
                ("cam-master", "zone-entry-wide", "entry-axis-wide", "on_axis", "left_to_right", "anchor-door-outside", 0.0),
                ("cam-a", "zone-left-close", "axis-a-close", "left", "left_to_right", "anchor-origin", -2.5),
                ("cam-b", "zone-right-close", "axis-b-reverse", "right", "right_to_left", "anchor-origin", 2.5),
            )
            for index, (
                camera_id,
                zone_id,
                view_id,
                camera_side,
                screen_direction,
                position_anchor_id,
                x,
            ) in enumerate(plans, 1):
                camera = create_spatial(
                    client,
                    f"golden-c-camera-{index}-{trace_id}",
                    camera_payload(
                        shots[index - 1],
                        scene_for_chain,
                        camera_id,
                        zone_id,
                        view_id,
                        x,
                        camera_side=camera_side,
                        screen_direction=screen_direction,
                        position_anchor_id=position_anchor_id,
                    ),
                )
                blocking = create_spatial(
                    client,
                    f"golden-c-blocking-{index}-{trace_id}",
                    blocking_payload(shots[index - 1], scene_for_chain, index),
                )
                composition = create_spatial(
                    client,
                    f"golden-c-composition-{index}-{trace_id}",
                    composition_payload(
                        shots[index - 1], scene_for_chain, camera, blocking, index
                    ),
                )
                cameras.append(camera)
                blockings.append(blocking)
                compositions.append(composition)

            stale_before = database_snapshot(database_path)
            stale_payload = spatial_update_request(
                f"golden-c-stale-guard-{trace_id}",
                compositions[0],
                composition_payload(
                    shots[0], scene_for_chain, cameras[0], blockings[0], 1, framing="medium"
                ),
            )
            stale_payload["write"]["expected_content_hash"] = HASH_C
            stale_error = expect_core_error(
                lambda: client.request(
                    "PUT",
                    f"/spatial-versions/{compositions[0]['ref']['film_entity_id']}",
                    stale_payload,
                ),
                status=409,
                code="content_hash_conflict",
            )
            stale_after = database_snapshot(database_path)

            transaction_before = database_snapshot(database_path)
            install_failure_trigger(database_path)
            transaction_request = spatial_create_request(
                f"golden-c-transaction-{trace_id}",
                camera_payload(
                    shots[0],
                    scene_for_chain,
                    "cam-rollback",
                    "zone-entry-wide",
                    "entry-axis-wide",
                    0.5,
                    camera_side="on_axis",
                    screen_direction="left_to_right",
                    position_anchor_id="anchor-door-outside",
                ),
            )
            transaction_failed = False
            try:
                client.post("/spatial-versions", transaction_request)
            except CoreHttpError as error:
                transaction_failed = error.status == 500
            finally:
                drop_failure_trigger(database_path)
            transaction_after = database_snapshot(database_path)
            recovered_transaction = client.post("/spatial-versions", transaction_request)

            script, decision = create_locked_script(client)
            director = create_formal(
                client,
                "director_unit",
                script_version=version_guard(script),
                script_decision=version_guard(decision),
                states=LOCKED_APPROVED_STATES,
                director_ir_text="三机位保持门口主轴，人物只在 walk-room 内移动。",
                director_ir_hash=sha256_text(
                    "三机位保持门口主轴，人物只在 walk-room 内移动。"
                ),
                narrative_purpose="验证复杂空间跨镜连续性",
                performance_beats=["入门", "桌边停步", "反打回应"],
            )
            asset = create_formal(
                client,
                "asset_binding",
                project=version_guard(project),
                host={
                    "host_project_id": "host-project-golden-c",
                    "host_asset_id": "host-asset-golden-c-space",
                    "host_asset_version_id": "host-asset-version-golden-c-space",
                    "host_resource_id": "host-resource-golden-c-space",
                },
                role="scene_twin_reference",
                priority=100,
                asset_content_hash=scene_for_chain["ref"]["content_hash"],
            )

            prompts: list[dict[str, Any]] = []
            packages: list[dict[str, Any]] = []
            candidates: list[dict[str, Any]] = []
            visual_locks: list[dict[str, Any]] = []
            continuity_results: list[dict[str, Any]] = []
            for index, shot in enumerate(shots, 1):
                lock_text = f"Golden C Shot {index}: SceneTwin/camera/blocking/composition hash lock"
                visual_lock = create_formal(
                    client,
                    "visual_lock_set",
                    project=version_guard(project),
                    shot=version_guard(shot),
                    states=LOCKED_APPROVED_STATES,
                    visual_lock_text=lock_text,
                    visual_lock_hash=sha256_text(lock_text),
                    locks={
                        "sceneTwinVersion": scene_for_chain["ref"]["content_hash"],
                        "cameraVersion": cameras[index - 1]["ref"]["content_hash"],
                        "blockingVersion": blockings[index - 1]["ref"]["content_hash"],
                        "compositionVersion": compositions[index - 1]["ref"]["content_hash"],
                    },
                )
                prompt = compile_prompt(
                    client,
                    project,
                    shot,
                    director,
                    visual_lock,
                    asset,
                    f"使用 SceneTwin 固定空间生成 Shot {index} 本地候选视频",
                )
                package = create_formal(
                    client,
                    "generation_package",
                    prompt_draft=version_guard(prompt),
                    host_project_id="host-project-golden-c",
                    provider_id="manual_web",
                    capability_id="video",
                    parameters={
                        "aspect_ratio": "9:16",
                        "duration_seconds": 6,
                        "local_fixture_only": True,
                    },
                )
                candidate = import_video_candidate(client, package, index)
                visual_locks.append(visual_lock)
                prompts.append(prompt)
                packages.append(package)
                candidates.append(candidate)
                if index > 1:
                    continuity_results.append(
                        client.post(
                            "/continuity/check",
                            {
                                "write": create_guard(),
                                "actor_kind": "codex",
                                "previous_shot": version_guard(shots[index - 2]),
                                "current_shot": version_guard(shot),
                                "checks": [
                                    continuity_check("axis", "axis-main", "left_to_right"),
                                    continuity_check("eyeline", "character-a", "character-b"),
                                    continuity_check("blocking", "character-a", "walk-room"),
                                    continuity_check("action", "character-a", "continues-turn"),
                                    continuity_check("prop_contact", "table-fixed", "untouched"),
                                ],
                            },
                        )
                    )

            lighting_edge = create_spatial_impact(
                client,
                scene_for_chain,
                prompts[0],
                "lighting_base",
                "spatial_prompt_dependency",
            )
            geometry_edge = create_spatial_impact(
                client,
                scene_for_chain,
                prompts[1],
                "geometry",
                "spatial_prompt_dependency",
            )
            prompt_zero_before_stale = prompts[0]
            prompt_one_before_stale = prompts[1]
            scene_update_request = spatial_update_request(
                f"golden-c-scene-update-{trace_id}",
                scene_v1,
                scene_payload(project, unit, lighting_intensity=0.85),
            )
            scene_updated = client.request(
                "PUT",
                f"/spatial-versions/{scene_v1['ref']['film_entity_id']}",
                scene_update_request,
            )
            scene_update_replay = client.request(
                "PUT",
                f"/spatial-versions/{scene_v1['ref']['film_entity_id']}",
                scene_update_request,
            )
            scene = scene_updated["entity"]
            spatial_stale_payload = {
                "idempotency_key": f"golden-c-spatial-stale-{trace_id}",
                "actor_kind": "codex",
                "dependency_owner": version_guard(scene),
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
            spatial_stale = client.post(
                "/impacts/propagate-stale", spatial_stale_payload
            )
            spatial_stale_replay = client.post(
                "/impacts/propagate-stale", spatial_stale_payload
            )
            prompts[0] = client.get(
                f"/formal-records/{prompts[0]['ref']['film_entity_id']}"
            )
            prompts[1] = client.get(
                f"/formal-records/{prompts[1]['ref']['film_entity_id']}"
            )
            candidates_after_stale = [
                client.get(f"/formal-records/{item['ref']['film_entity_id']}")
                for item in candidates
            ]
            spatial_stale_precise = (
                set(spatial_stale["stale_entity_ids"])
                == {prompts[0]["ref"]["film_entity_id"]}
                and prompts[0]["states"]["stale_state"] == "stale"
                and prompts[1]["states"]["stale_state"] == "fresh"
                and all(
                    item["states"]["stale_state"] == "fresh"
                    for item in candidates_after_stale
                )
                and prompts[0]["states"]["review_state"]
                == prompt_zero_before_stale["states"]["review_state"]
                and prompts[0]["states"]["lock_state"]
                == prompt_zero_before_stale["states"]["lock_state"]
                and prompts[1]["ref"] == prompt_one_before_stale["ref"]
            )
            spatial_change_ordered = (
                lighting_edge["dependency_owner_version"] == 1
                and lighting_edge["dependency_owner_content_hash"]
                == scene_v1["ref"]["content_hash"]
                and lighting_edge["dependency_content_hash"]
                == spatial_stale_payload["changes"][0]["previous_dependency_hash"]
                and scene["ref"]["film_entity_id"]
                == scene_v1["ref"]["film_entity_id"]
                and scene["ref"]["version"] == 2
            )

            local = run_local_spatial_segment(
                scene_for_chain, shots, cameras, blockings, compositions
            )
            formal_entities = [
                scene,
                *cameras,
                *blockings,
                *compositions,
                recovered_transaction["entity"],
                script,
                decision,
                director,
                asset,
                *visual_locks,
                *prompts,
                *packages,
                *candidates,
                *continuity_results,
            ]
            for entity in formal_entities:
                require_uuid4(
                    entity["ref"]["film_entity_id"], entity["ref"]["entity_type"]
                )
            for edge in (lighting_edge, geometry_edge):
                require_uuid4(edge["ref"]["film_entity_id"], "impact_edge")

            expected_records = {
                entity["ref"]["film_entity_id"]: entity["ref"]
                for entity in formal_entities
            }
            before_restart = database_fingerprint(database_path)
        finally:
            stop_sidecar(process)

        process, client = start_sidecar(database_path, executable)
        try:
            after_restart = database_fingerprint(database_path)
            restart_records = read_refs(client, expected_records)
            restart_scene_replay = client.request(
                "PUT",
                f"/spatial-versions/{scene_v1['ref']['film_entity_id']}",
                scene_update_request,
            )
        finally:
            stop_sidecar(process)

        backup_path = root / "backup.sqlite"
        backup_sqlite(database_path, backup_path)
        restored_path = root / "restored.sqlite"
        backup_sqlite(backup_path, restored_path)
        process, client = start_sidecar(restored_path, executable)
        try:
            after_restore = database_fingerprint(restored_path)
            restored_records = read_refs(client, expected_records)
            restored_scene_replay = client.request(
                "PUT",
                f"/spatial-versions/{scene_v1['ref']['film_entity_id']}",
                scene_update_request,
            )
        finally:
            stop_sidecar(process)

        independent_ids = len(
            {
                item["ref"]["film_entity_id"]
                for item in [*cameras, *blockings, *compositions]
            }
        ) == 9
        candidates_unapproved = all(
            item["states"]["review_state"] != "approved" for item in candidates
        )
        recovery = {
            "restart_exact": before_restart == after_restart,
            "restart_refs_exact": restart_records,
            "backup_restore_exact": before_restart == after_restore,
            "backup_restore_refs_exact": restored_records,
            "receipt_survives_restart": restart_scene_replay["replayed"] is True,
            "receipt_survives_restore": restored_scene_replay["replayed"] is True,
            "transaction_failure_observed": transaction_failed,
            "transaction_failure_zero_partial_writes": transaction_before == transaction_after,
            "transaction_retry_succeeded": recovered_transaction["replayed"] is False,
            "stale_guard_zero_partial_writes": stale_before == stale_after,
            "stale_guard_blocked": stale_error.status == 409,
        }
        passed = all(
            (
                scene_replay["replayed"] is True,
                scene_update_replay["replayed"] is True,
                scene["ref"]["version"] == 2,
                len(cameras) == len(blockings) == len(compositions) == 3,
                independent_ids,
                local["testStatus"] == "PASSED",
                all(item["passed"] for item in continuity_results),
                len(candidates) == 3,
                candidates_unapproved,
                spatial_change_ordered,
                spatial_stale_precise,
                spatial_stale_replay["replayed"] is True,
                all(recovery.values()),
            )
        )
        return {
            "golden_id": "GOLDEN-C-REAL",
            "test_status": "PASSED" if passed else "FAILED",
            "prepared": True,
            "persisted": passed,
            "reviewed": all(item["passed"] for item in continuity_results),
            "approved": False,
            "external_provider_calls": 0,
            "fallback_mock_used": False,
            "trace_id": trace_id,
            "sidecar": {
                "health": health["status"],
                "service": health["service"],
                "database": "temporary_sqlite_sidecar",
            },
            "scene_twin": {
                "id": scene["ref"]["film_entity_id"],
                "version": scene["ref"]["version"],
                "create_replayed": scene_replay["replayed"],
                "update_replayed": scene_update_replay["replayed"],
                "render_passes": sorted(
                    item["pass_kind"] for item in scene["render_passes"]
                ),
            },
            "spatial_versions": {
                "cameras": len(cameras),
                "blockings": len(blockings),
                "compositions": len(compositions),
                "independent_ids": independent_ids,
            },
            "previs": {
                "projections": 3,
                "formal_apply": local["formalApply"],
                "checks": local["checks"],
            },
            "video": {
                "candidates": len(candidates),
                "all_candidate_only": candidates_unapproved,
            },
            "continuity": {
                "core_checks": len(continuity_results),
                "core_passed": all(item["passed"] for item in continuity_results),
                "local_spatial_passed": local["testStatus"] == "PASSED",
            },
            "stale": {
                "edge_before_update": spatial_change_ordered,
                "edge_owner_version": lighting_edge["dependency_owner_version"],
                "updated_owner_version": scene["ref"]["version"],
                "precise": spatial_stale_precise,
                "changed_component": "lighting_base",
                "stale_target_ids": spatial_stale["stale_entity_ids"],
                "unrelated_prompt_fresh": prompts[1]["states"]["stale_state"]
                == "fresh",
                "candidates_fresh": all(
                    item["states"]["stale_state"] == "fresh"
                    for item in candidates_after_stale
                ),
                "state_axes_preserved": prompts[0]["states"]["review_state"]
                == prompt_zero_before_stale["states"]["review_state"]
                and prompts[0]["states"]["lock_state"]
                == prompt_zero_before_stale["states"]["lock_state"],
                "replayed": spatial_stale_replay["replayed"],
            },
            "recovery": recovery,
            "operations": [
                f"{method} {path}" for method, path in REQUIRED_GOLDEN_C_OPERATIONS
            ],
        }


def blocked_receipt(
    trace_id: str, health: dict[str, Any], missing: list[str]
) -> dict[str, Any]:
    return {
        "golden_id": "GOLDEN-C-REAL",
        "test_status": "BLOCKED_MISSING_CORE_OPERATION",
        "prepared": False,
        "persisted": False,
        "reviewed": False,
        "approved": False,
        "external_provider_calls": 0,
        "fallback_mock_used": False,
        "missing_operations": missing,
        "trace_id": trace_id,
        "sidecar": {
            "health": health["status"],
            "service": health["service"],
            "database": "temporary_sqlite_sidecar",
        },
    }


def missing_golden_c_operations(
    operations: dict[tuple[str, str], Any]
) -> list[str]:
    return [
        f"{method} {path}"
        for method, path in REQUIRED_GOLDEN_C_OPERATIONS
        if (method, path) not in operations
    ]


def spatial_create_request(key: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "idempotency_key": key,
        "write": create_guard(),
        "actor_kind": "codex",
        "payload": payload,
    }


def spatial_update_request(
    key: str, entity: dict[str, Any], payload: dict[str, Any]
) -> dict[str, Any]:
    return {
        "idempotency_key": key,
        "write": version_guard(entity),
        "actor_kind": "codex",
        "payload": payload,
    }


def create_spatial(
    client: FilmCoreHttpClient, key: str, payload: dict[str, Any]
) -> dict[str, Any]:
    result = client.post("/spatial-versions", spatial_create_request(key, payload))
    entity = result["entity"]
    require_uuid4(entity["ref"]["film_entity_id"], entity["ref"]["entity_type"])
    return entity


def create_spatial_impact(
    client: FilmCoreHttpClient,
    owner: dict[str, Any],
    target: dict[str, Any],
    component_key: str,
    relation: str,
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
            "dependency_key": component_key,
            "scope": {
                "kind": "spatial_version_component",
                "component_key": component_key,
            },
            "relation": relation,
            "propagates_stale": True,
        },
    )


def sha256_json(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    ).hexdigest()


def snapshot(entity: dict[str, Any]) -> dict[str, Any]:
    return version_guard(entity)


def vector(x: float, y: float, z: float) -> dict[str, float]:
    return {"x": x, "y": y, "z": z}


def transform(x: float, y: float, z: float, yaw: float = 0) -> dict[str, Any]:
    return {
        "position": vector(x, y, z),
        "rotation_degrees": {"x": 0, "y": yaw, "z": 0},
    }


def polygon(x: float, z: float, width: float, depth: float) -> list[dict[str, float]]:
    return [
        vector(x, 0, z),
        vector(x + width, 0, z),
        vector(x + width, 0, z + depth),
        vector(x, 0, z + depth),
    ]


def scene_payload(
    project: dict[str, Any], unit: dict[str, Any], *, lighting_intensity: float
) -> dict[str, Any]:
    return {
        "entity_type": "scene_twin_version",
        "project": snapshot(project),
        "content_unit": snapshot(unit),
        "states": FORMAL_STATES,
        "coordinate_system": {
            "units": "meters",
            "handedness": "right_handed",
            "up_axis": "y",
            "origin_anchor_id": "anchor-origin",
        },
        "geometry_content_hash": HASH_A,
        "fixed_architecture": [
            {
                "object_id": "wall-main",
                "geometry_content_hash": HASH_B,
                "transform": transform(0, 0, 0),
            },
            {
                "object_id": "door-frame",
                "geometry_content_hash": HASH_C,
                "transform": transform(0, 0, 4),
            },
        ],
        "fixed_props": [
            {
                "object_id": "table-fixed",
                "geometry_content_hash": "d" * 64,
                "transform": transform(0, 0, 0),
            }
        ],
        "portals": [
            {
                "portal_id": "portal-door",
                "from_anchor_id": "anchor-door-outside",
                "to_anchor_id": "anchor-door-inside",
                "passable": True,
            }
        ],
        "walkable_zones": [
            {"zone_id": "walk-room", "polygon": polygon(-3, -2, 6, 6)}
        ],
        "anchors": [
            {"anchor_id": "anchor-origin", "position": vector(0, 0, 0)},
            {"anchor_id": "anchor-table", "position": vector(0, 0, 1)},
            {"anchor_id": "anchor-door-outside", "position": vector(0, 0, 5)},
            {"anchor_id": "anchor-door-inside", "position": vector(0, 0, 3.5)},
        ],
        "camera_zones": [
            {"zone_id": "zone-entry-wide", "polygon": polygon(-1, -4, 2, 1)},
            {"zone_id": "zone-left-close", "polygon": polygon(-3, 0, 1, 2)},
            {"zone_id": "zone-right-close", "polygon": polygon(2, 0, 1, 2)},
        ],
        "lighting_base": {"profile": "warm-interior", "intensity": lighting_intensity},
        "approved_view_families": [
            {
                "family_id": "entry-axis-wide",
                "camera_zone_ids": ["zone-entry-wide"],
                "screen_direction": "left_to_right",
            },
            {
                "family_id": "axis-a-close",
                "camera_zone_ids": ["zone-left-close"],
                "screen_direction": "left_to_right",
            },
            {
                "family_id": "axis-b-reverse",
                "camera_zone_ids": ["zone-right-close"],
                "screen_direction": "right_to_left",
            },
        ],
        "render_passes": [
            {
                "pass_kind": kind,
                "host_resource_id": f"host-resource-golden-c-{kind}",
                "content_hash": character * 64,
            }
            for kind, character in (
                ("rgb", "a"),
                ("depth", "b"),
                ("normal", "c"),
                ("object_id", "d"),
            )
        ],
    }


def camera_payload(
    shot: dict[str, Any],
    scene: dict[str, Any],
    camera_id: str,
    zone_id: str,
    view_id: str,
    x: float,
    *,
    camera_side: str,
    screen_direction: str,
    position_anchor_id: str,
) -> dict[str, Any]:
    return {
        "entity_type": "camera_version",
        "shot": snapshot(shot),
        "scene_twin": snapshot(scene),
        "states": FORMAL_STATES,
        "camera_id": camera_id,
        "position_anchor_id": position_anchor_id,
        "target_anchor_id": "anchor-table",
        "camera_side": camera_side,
        "axis_id": "axis-main",
        "screen_direction": screen_direction,
        "transform": transform(
            x,
            1.6,
            -3.5 if zone_id == "zone-entry-wide" else 1.0,
            0,
        ),
        "lens": {
            "focal_length_mm": 35 if camera_id == "cam-master" else 50,
            "sensor_width_mm": 36,
            "focus_distance_m": 4,
            "aperture_f": 2.8,
        },
        "camera_zone_id": zone_id,
        "approved_view_family_id": view_id,
    }


def blocking_payload(
    shot: dict[str, Any], scene: dict[str, Any], index: int
) -> dict[str, Any]:
    return {
        "entity_type": "blocking_version",
        "shot": snapshot(shot),
        "scene_twin": snapshot(scene),
        "states": FORMAL_STATES,
        "beat_id": f"beat-{index}",
        "actors": [
            {
                "actor_id": "character-a",
                "feet_anchor_id": "anchor-table" if index == 1 else "anchor-door-inside",
                "position": vector(-0.5, 0, 1 if index == 1 else 3.25),
                "torso_rotation_degrees": {"x": 0, "y": 90, "z": 0},
                "face_target_id": "character-b",
                "gaze_target_id": "character-b",
                "left_hand_target_id": None,
                "right_hand_target_id": "table-fixed",
                "action_in": "feet-planted-torso-turning",
                "action_out": "face-and-gaze-held-right-hand-reaches-target-prop",
                "axis_side_in": "left",
                "axis_side_out": "left",
                "prop_contact_in_ids": [],
                "prop_contact_out_ids": ["table-fixed"],
            },
            {
                "actor_id": "character-b",
                "feet_anchor_id": "anchor-table",
                "position": vector(0.5, 0, 1),
                "torso_rotation_degrees": {"x": 0, "y": -90, "z": 0},
                "face_target_id": "character-a",
                "gaze_target_id": "character-a",
                "left_hand_target_id": "table-fixed",
                "right_hand_target_id": None,
                "action_in": "feet-planted-torso-stable",
                "action_out": "face-and-gaze-held-left-hand-on-target-prop",
                "axis_side_in": "right",
                "axis_side_out": "right",
                "prop_contact_in_ids": ["table-fixed"],
                "prop_contact_out_ids": ["table-fixed"],
            },
        ],
    }


def composition_payload(
    shot: dict[str, Any],
    scene: dict[str, Any],
    camera: dict[str, Any],
    blocking: dict[str, Any],
    index: int,
    *,
    framing: str | None = None,
) -> dict[str, Any]:
    return {
        "entity_type": "composition_version",
        "shot": snapshot(shot),
        "scene_twin": snapshot(scene),
        "camera": snapshot(camera),
        "blocking": snapshot(blocking),
        "states": FORMAL_STATES,
        "aspect_ratio": "9:16",
        "framing": framing or ("wide" if index == 1 else "close"),
        "screen_direction": "left_to_right" if index < 3 else "right_to_left",
        "subjects": [
            {
                "subject_id": "character-a" if index < 3 else "character-b",
                "frame_x": 0.25 if index < 3 else 0.55,
                "frame_y": 0.2,
                "frame_width": 0.35,
                "frame_height": 0.7,
            }
        ],
        "occlusion_constraints": [
            {
                "occluder_id": "table-fixed",
                "subject_id": "character-a" if index < 3 else "character-b",
                "max_occlusion_ratio": 0.15,
            }
        ],
        "safe_area": {"left": 0.08, "right": 0.08, "top": 0.1, "bottom": 0.12},
    }


def create_locked_script(
    client: FilmCoreHttpClient,
) -> tuple[dict[str, Any], dict[str, Any]]:
    unlocked = create_formal(
        client,
        "script_version",
        host={
            "host_project_id": "host-project-golden-c",
            "host_unit_id": "host-unit-golden-c",
        },
        states=FORMAL_STATES,
        script_text="INT. COMPLEX ROOM - DAY\nA crosses the portal; B holds at table.",
    )
    result = client.post(
        "/script-versions/lock",
        {
            "locked_write": create_guard(),
            "decision_write": create_guard(),
            "actor_kind": "human",
            "source_script_version": version_guard(unlocked),
            "approved_by": "golden-c-director",
        },
    )
    return result["locked_script_version"], result["decision"]


def import_video_candidate(
    client: FilmCoreHttpClient, package: dict[str, Any], index: int
) -> dict[str, Any]:
    result = client.post(
        "/manual-results/import",
        {
            "evidence_write": create_guard(),
            "candidate_write": create_guard(),
            "actor_kind": "human",
            "generation_package": version_guard(package),
            "provider_task_id": f"golden-c-local-task-{index}",
            "receipt": {
                "receipt_id": f"golden-c-local-receipt-{index}",
                "content_hash": ("d", "e", "f")[index - 1] * 64,
                "captured_at": OCCURRED_AT,
            },
            "manual_source": {
                "source_id": f"golden-c-local-source-{index}",
                "source_kind": "local_runtime_export",
                "imported_by": "golden-c-human",
                "imported_at": OCCURRED_AT,
                "authorization_evidence_id": f"golden-c-local-authorization-{index}",
            },
            "outputs": [
                {
                    "host_resource_id": f"host-resource-golden-c-video-{index}",
                    "output_kind": "video",
                    "content_hash": ("7", "8", "9")[index - 1] * 64,
                    "mime_type": "video/mp4",
                    "bytes": 4096 + index,
                }
            ],
        },
    )
    return result["candidate"]


def run_local_spatial_segment(
    scene: dict[str, Any],
    shots: list[dict[str, Any]],
    cameras: list[dict[str, Any]],
    blockings: list[dict[str, Any]],
    compositions: list[dict[str, Any]],
) -> dict[str, Any]:
    payload = {
        "sceneTwin": {
            **web_ref(scene),
            "coordinateSystem": "right_handed_y_up_meters",
            "fixedArchitectureIds": [item["object_id"] for item in scene["fixed_architecture"]],
            "fixedPropIds": [item["object_id"] for item in scene["fixed_props"]],
            "portalIds": [item["portal_id"] for item in scene["portals"]],
            "walkableZoneIds": [item["zone_id"] for item in scene["walkable_zones"]],
            "anchorIds": [item["anchor_id"] for item in scene["anchors"]],
            "cameraZoneIds": [item["zone_id"] for item in scene["camera_zones"]],
            "approvedViewFamilyIds": [
                item["family_id"] for item in scene["approved_view_families"]
            ],
            "passLineage": {
                item["pass_kind"]: item["content_hash"] for item in scene["render_passes"]
            },
        },
        "chains": [],
    }
    for index, (shot, camera, blocking, composition) in enumerate(
        zip(shots, cameras, blockings, compositions, strict=True), 1
    ):
        payload["chains"].append(
            {
                "shot": web_ref(shot),
                "camera": {
                    **web_ref(camera),
                    "sceneTwinId": str(camera["scene_twin"]["film_entity_id"]),
                    "positionAnchorId": camera["position_anchor_id"],
                    "targetAnchorId": camera["target_anchor_id"],
                    "axisId": camera["axis_id"],
                    "cameraZoneId": camera["camera_zone_id"],
                    "approvedViewFamilyId": camera["approved_view_family_id"],
                },
                "blocking": {
                    **web_ref(blocking),
                    "sceneTwinId": str(blocking["scene_twin"]["film_entity_id"]),
                    "cameraId": camera["ref"]["film_entity_id"],
                    "walkableZoneIds": ["walk-room"],
                    "anchorIds": sorted(
                        {
                            actor["feet_anchor_id"]
                            for actor in blocking["actors"]
                        }
                    ),
                    "actors": [
                        {
                            "feetAnchorId": actor["feet_anchor_id"],
                            "torsoRotationDegrees": actor["torso_rotation_degrees"],
                            "faceTargetId": actor["face_target_id"],
                            "gazeTargetId": actor["gaze_target_id"],
                            "leftHandTargetId": actor["left_hand_target_id"],
                            "rightHandTargetId": actor["right_hand_target_id"],
                            "targetPropIds": sorted(
                                set(actor["prop_contact_in_ids"])
                                | set(actor["prop_contact_out_ids"])
                            ),
                        }
                        for actor in blocking["actors"]
                    ],
                },
                "composition": {
                    **web_ref(composition),
                    "sceneTwinId": str(composition["scene_twin"]["film_entity_id"]),
                    "cameraId": str(composition["camera"]["film_entity_id"]),
                    "blockingId": str(composition["blocking"]["film_entity_id"]),
                    "safeArea": composition["safe_area"],
                    "occlusionConstraints": [
                        {
                            "occluderId": item["occluder_id"],
                            "subjectId": item["subject_id"],
                            "maxOcclusionRatio": item["max_occlusion_ratio"],
                        }
                        for item in composition["occlusion_constraints"]
                    ],
                },
                "previs": {
                    "projectionId": str(uuid4()),
                    "sourceHashes": {
                        "sceneTwin": scene["ref"]["content_hash"],
                        "camera": camera["ref"]["content_hash"],
                        "blocking": blocking["ref"]["content_hash"],
                        "composition": composition["ref"]["content_hash"],
                    },
                    "outputHash": hashlib.sha256(
                        f"golden-c-previs-{index}".encode()
                    ).hexdigest(),
                    "formalApply": False,
                    "approvalState": "not_approved",
                },
            }
        )
    process = subprocess.run(
        ["bun", "tests/film-golden/golden_c_local.ts"],
        cwd=REPOSITORY_ROOT,
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if process.returncode != 0:
        raise GoldenARealError(
            f"Golden C local spatial segment failed: {process.stderr.strip()}"
        )
    return json.loads(process.stdout)


def web_ref(entity: dict[str, Any]) -> dict[str, Any]:
    return {
        "filmEntityId": entity["ref"]["film_entity_id"],
        "entityType": entity["ref"]["entity_type"],
        "version": entity["ref"]["version"],
        "contentHash": entity["ref"]["content_hash"],
    }


def start_sidecar(
    database_path: Path, python_executable: str
) -> tuple[subprocess.Popen[str], FilmCoreHttpClient]:
    port = available_loopback_port()
    environment = os.environ.copy()
    environment["FILMOS_CORE_DB_PATH"] = str(database_path)
    environment["PYTHONPATH"] = str(FILM_CORE_SOURCE)
    process = subprocess.Popen(
        [
            python_executable,
            "-m",
            "uvicorn",
            "film_production_core.api:create_app",
            "--factory",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=REPOSITORY_ROOT / "film-core",
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    client = FilmCoreHttpClient(f"http://127.0.0.1:{port}")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stderr = process.stderr.read() if process.stderr else ""
            raise GoldenARealError(
                f"temporary Film Core exited before health check: {stderr.strip()}"
            )
        try:
            health = client.get("/health")
            if health.get("status") == "ok":
                return process, client
        except (OSError, urllib.error.URLError, CoreHttpError, json.JSONDecodeError):
            pass
        time.sleep(0.05)
    stop_sidecar(process)
    raise GoldenARealError("temporary Film Core did not become healthy")


def stop_sidecar(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if process.stdout is not None:
        process.stdout.close()
    if process.stderr is not None:
        process.stderr.close()


def database_snapshot(path: Path) -> dict[str, int]:
    with sqlite3.connect(path) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        return {
            table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
            for table in sorted(tables)
        }


def database_fingerprint(path: Path) -> str:
    with sqlite3.connect(path) as connection:
        tables = [
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
        payload: dict[str, list[list[Any]]] = {}
        for table in tables:
            rows = connection.execute(f'SELECT * FROM "{table}"').fetchall()
            payload[table] = [list(row) for row in rows]
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def install_failure_trigger(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute(
            "CREATE TRIGGER golden_c_force_transaction_failure "
            "BEFORE INSERT ON formal_audit_events BEGIN "
            "SELECT RAISE(ABORT, 'golden-c injected audit failure'); END"
        )


def drop_failure_trigger(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute("DROP TRIGGER IF EXISTS golden_c_force_transaction_failure")


def backup_sqlite(source_path: Path, destination_path: Path) -> None:
    with sqlite3.connect(source_path) as source, sqlite3.connect(destination_path) as destination:
        source.backup(destination)


def read_refs(
    client: FilmCoreHttpClient, expected: dict[str, dict[str, Any]]
) -> bool:
    for entity_id, expected_ref in expected.items():
        current = client.get(f"/formal-records/{entity_id}")
        if current["ref"] != expected_ref:
            return False
    return True
