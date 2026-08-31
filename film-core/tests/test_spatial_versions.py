from __future__ import annotations

import hashlib
import json
import sqlite3
from copy import deepcopy
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator, FormatChecker

from film_production_core.api import create_app
from film_production_core.contracts import repository_root
from film_production_core.database import (
    MIGRATION_001,
    MIGRATION_002,
    MIGRATION_003,
    SQLiteDatabase,
)
from film_production_core.repository import canonical_json


ZERO_HASH = "0" * 64
HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64
HASH_D = "d" * 64
HASH_E = "e" * 64


def create_guard() -> dict:
    return {
        "target_id": None,
        "expected_version": 0,
        "expected_content_hash": ZERO_HASH,
    }


def version_guard(entity: dict) -> dict:
    return {
        "film_entity_id": entity["ref"]["film_entity_id"],
        "expected_version": entity["ref"]["version"],
        "expected_content_hash": entity["ref"]["content_hash"],
    }


def json_hash(value) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def validate_contract(definition: str, value: dict) -> None:
    schema = json.loads(
        (repository_root() / "film-contracts" / "schemas" / "core.schema.json").read_text(
            encoding="utf-8"
        )
    )
    Draft202012Validator(
        {"$ref": f"#/$defs/{definition}", "$defs": schema["$defs"]},
        format_checker=FormatChecker(),
    ).validate(value)


def create_legacy(client: TestClient, states: dict, entity_type: str, host: dict, **extra) -> dict:
    response = client.post(
        "/commands/apply",
        json={
            "command_type": "entity.create",
            "target_id": None,
            "expected_version": 0,
            "actor_kind": "human",
            "payload": {
                "entity_type": entity_type,
                "host": host,
                "states": states,
                **extra,
            },
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["entity"]


def spatial_write(
    client: TestClient,
    key: str,
    payload: dict,
    *,
    current: dict | None = None,
) -> dict:
    if current is None:
        response = client.post(
            "/spatial-versions",
            json={
                "idempotency_key": key,
                "write": create_guard(),
                "actor_kind": "codex",
                "payload": payload,
            },
        )
    else:
        target_id = current["ref"]["film_entity_id"]
        response = client.put(
            f"/spatial-versions/{target_id}",
            json={
                "idempotency_key": key,
                "write": version_guard(current),
                "actor_kind": "codex",
                "payload": payload,
            },
        )
    assert response.status_code == 200, response.text
    return response.json()


def transform(x: float, y: float, z: float) -> dict:
    return {
        "position": {"x": x, "y": y, "z": z},
        "rotation_degrees": {"x": 0, "y": 0, "z": 0},
    }


def make_scope(client: TestClient, states: dict) -> dict[str, dict]:
    project = create_legacy(
        client,
        states,
        "film_project_extension",
        {"host_project_id": "golden-c-project"},
    )
    unit = create_legacy(
        client,
        states,
        "content_unit_extension",
        {
            "host_project_id": "golden-c-project",
            "host_unit_id": "golden-c-unit",
        },
        unit_kind="episode",
    )
    shot = create_legacy(
        client,
        states,
        "shot_extension",
        {
            "host_project_id": "golden-c-project",
            "host_unit_id": "golden-c-unit",
            "host_shot_id": "golden-c-shot",
        },
        director_unit_ids=[],
    )
    return {"project": project, "unit": unit, "shot": shot}


def scene_payload(scope: dict, states: dict) -> dict:
    review_states = {**states, "creative_stage": "reviewed", "review_state": "pending"}
    return {
        "entity_type": "scene_twin_version",
        "project": version_guard(scope["project"]),
        "content_unit": version_guard(scope["unit"]),
        "states": review_states,
        "coordinate_system": {
            "units": "meters",
            "handedness": "right_handed",
            "up_axis": "z",
            "origin_anchor_id": "origin",
        },
        "geometry_content_hash": HASH_A,
        "fixed_architecture": [
            {
                "object_id": "wall-north",
                "geometry_content_hash": HASH_B,
                "transform": transform(0, 5, 0),
            }
        ],
        "fixed_props": [
            {
                "object_id": "hero-cup",
                "geometry_content_hash": HASH_C,
                "transform": transform(1, 1, 1),
            }
        ],
        "portals": [
            {
                "portal_id": "door-main",
                "from_anchor_id": "origin",
                "to_anchor_id": "target-a",
                "passable": True,
            }
        ],
        "walkable_zones": [
            {
                "zone_id": "walk-main",
                "polygon": [
                    {"x": 0, "y": 0, "z": 0},
                    {"x": 4, "y": 0, "z": 0},
                    {"x": 4, "y": 4, "z": 0},
                ],
            }
        ],
        "anchors": [
            {"anchor_id": "origin", "position": {"x": 0, "y": 0, "z": 0}},
            {"anchor_id": "camera-a", "position": {"x": -2, "y": 1, "z": 1.6}},
            {"anchor_id": "target-a", "position": {"x": 1, "y": 1, "z": 1.5}},
            {"anchor_id": "feet-a", "position": {"x": 0.5, "y": 1, "z": 0}},
        ],
        "camera_zones": [
            {
                "zone_id": "camera-zone-a",
                "polygon": [
                    {"x": -3, "y": 0, "z": 0},
                    {"x": -1, "y": 0, "z": 0},
                    {"x": -1, "y": 3, "z": 0},
                ],
            }
        ],
        "lighting_base": {"key": "warm", "ratio": 2.0},
        "approved_view_families": [
            {
                "family_id": "view-family-a",
                "camera_zone_ids": ["camera-zone-a"],
                "screen_direction": "left_to_right",
            }
        ],
        "render_passes": [
            {"pass_kind": "rgb", "host_resource_id": "res-rgb", "content_hash": HASH_A},
            {"pass_kind": "depth", "host_resource_id": "res-depth", "content_hash": HASH_B},
            {"pass_kind": "normal", "host_resource_id": "res-normal", "content_hash": HASH_C},
            {"pass_kind": "object_id", "host_resource_id": "res-object", "content_hash": HASH_D},
        ],
    }


def camera_payload(scope: dict, scene: dict, states: dict) -> dict:
    return {
        "entity_type": "camera_version",
        "shot": version_guard(scope["shot"]),
        "scene_twin": version_guard(scene),
        "states": states,
        "camera_id": "camera-master",
        "position_anchor_id": "camera-a",
        "target_anchor_id": "target-a",
        "camera_side": "left",
        "axis_id": "axis-main",
        "screen_direction": "left_to_right",
        "transform": transform(-2, 1, 1.6),
        "lens": {
            "focal_length_mm": 35,
            "sensor_width_mm": 36,
            "focus_distance_m": 3,
            "aperture_f": 2.8,
        },
        "camera_zone_id": "camera-zone-a",
        "approved_view_family_id": "view-family-a",
    }


def blocking_payload(scope: dict, scene: dict, states: dict) -> dict:
    return {
        "entity_type": "blocking_version",
        "shot": version_guard(scope["shot"]),
        "scene_twin": version_guard(scene),
        "states": states,
        "beat_id": "beat-reach",
        "actors": [
            {
                "actor_id": "actor-a",
                "feet_anchor_id": "feet-a",
                "position": {"x": 0.5, "y": 1, "z": 0},
                "torso_rotation_degrees": {"x": 0, "y": 0, "z": 20},
                "face_target_id": "target-a",
                "gaze_target_id": "hero-cup",
                "left_hand_target_id": None,
                "right_hand_target_id": "hero-cup",
                "action_in": "hand_free",
                "action_out": "cup_held",
                "axis_side_in": "left",
                "axis_side_out": "left",
                "prop_contact_in_ids": [],
                "prop_contact_out_ids": ["hero-cup"],
            }
        ],
    }


def composition_payload(
    scope: dict, scene: dict, camera: dict, blocking: dict, states: dict
) -> dict:
    return {
        "entity_type": "composition_version",
        "shot": version_guard(scope["shot"]),
        "scene_twin": version_guard(scene),
        "camera": version_guard(camera),
        "blocking": version_guard(blocking),
        "states": states,
        "aspect_ratio": "16:9",
        "framing": "medium-wide",
        "screen_direction": "left_to_right",
        "subjects": [
            {
                "subject_id": "actor-a",
                "frame_x": 0.35,
                "frame_y": 0.25,
                "frame_width": 0.25,
                "frame_height": 0.65,
            }
        ],
        "occlusion_constraints": [
            {
                "occluder_id": "wall-north",
                "subject_id": "actor-a",
                "max_occlusion_ratio": 0.1,
            }
        ],
        "safe_area": {"left": 0.05, "right": 0.05, "top": 0.05, "bottom": 0.08},
    }


def make_chain(client: TestClient, states: dict) -> dict[str, dict]:
    scope = make_scope(client, states)
    scene = spatial_write(client, "scene-create", scene_payload(scope, states))["entity"]
    camera = spatial_write(client, "camera-create", camera_payload(scope, scene, states))["entity"]
    blocking = spatial_write(client, "blocking-create", blocking_payload(scope, scene, states))["entity"]
    composition = spatial_write(
        client,
        "composition-create",
        composition_payload(scope, scene, camera, blocking, states),
    )["entity"]
    return {**scope, "scene": scene, "camera": camera, "blocking": blocking, "composition": composition}


def test_spatial_versions_are_guarded_versioned_audited_and_idempotent(client, states) -> None:
    chain = make_chain(client, states)
    for name in ("scene", "camera", "blocking", "composition"):
        entity = chain[name]
        assert UUID(entity["ref"]["film_entity_id"]).version == 4
        assert len(entity["states"]) == 6
        read = client.get(f"/spatial-versions/{entity['ref']['film_entity_id']}")
        assert read.status_code == 200
        assert read.json() == entity
        validate_contract(
            {
                "scene": "SceneTwinVersion",
                "camera": "CameraVersion",
                "blocking": "BlockingVersion",
                "composition": "CompositionVersion",
            }[name],
            entity,
        )

    camera_update_payload = camera_payload(chain, chain["scene"], states)
    camera_update_payload["lens"]["focal_length_mm"] = 50
    request = {
        "idempotency_key": "camera-update-1",
        "write": version_guard(chain["camera"]),
        "actor_kind": "codex",
        "payload": camera_update_payload,
    }
    target_id = chain["camera"]["ref"]["film_entity_id"]
    updated = client.put(f"/spatial-versions/{target_id}", json=request)
    assert updated.status_code == 200, updated.text
    result = updated.json()
    assert result["entity"]["ref"]["film_entity_id"] == target_id
    assert result["entity"]["ref"]["version"] == 2
    assert result["replayed"] is False

    counts = client.app.state.formal_service.repository.formal_counts()
    replay = client.put(f"/spatial-versions/{target_id}", json=request)
    assert replay.status_code == 200
    assert replay.json()["replayed"] is True
    assert replay.json()["audit_event_id"] == result["audit_event_id"]
    assert client.app.state.formal_service.repository.formal_counts() == counts

    conflict = deepcopy(request)
    conflict["payload"]["lens"]["focal_length_mm"] = 85
    conflict_response = client.put(f"/spatial-versions/{target_id}", json=conflict)
    assert conflict_response.status_code == 409
    assert conflict_response.json()["detail"]["code"] == "idempotency_conflict"
    assert client.app.state.formal_service.repository.formal_counts() == counts

    stale = deepcopy(request)
    stale["idempotency_key"] = "camera-stale-version"
    stale_response = client.put(f"/spatial-versions/{target_id}", json=stale)
    assert stale_response.status_code == 409
    assert stale_response.json()["detail"]["code"] == "version_conflict"
    assert client.app.state.formal_service.repository.formal_counts() == counts

    stale_hash = deepcopy(request)
    stale_hash["idempotency_key"] = "camera-stale-hash"
    stale_hash["write"]["expected_version"] = 2
    stale_hash["write"]["expected_content_hash"] = HASH_A
    stale_hash_response = client.put(
        f"/spatial-versions/{target_id}", json=stale_hash
    )
    assert stale_hash_response.status_code == 409
    assert stale_hash_response.json()["detail"]["code"] == "content_hash_conflict"
    assert client.app.state.formal_service.repository.formal_counts() == counts


def test_spatial_reference_and_review_boundaries_fail_closed(client, states) -> None:
    scope = make_scope(client, states)
    invalid_scene = scene_payload(scope, states)
    invalid_scene["anchors"].append(deepcopy(invalid_scene["anchors"][0]))
    duplicate = client.post(
        "/spatial-versions",
        json={
            "idempotency_key": "scene-duplicate-anchor",
            "write": create_guard(),
            "actor_kind": "codex",
            "payload": invalid_scene,
        },
    )
    assert duplicate.status_code == 422

    incomplete_passes = scene_payload(scope, states)
    incomplete_passes["render_passes"] = incomplete_passes["render_passes"][:3]
    incomplete = client.post(
        "/spatial-versions",
        json={
            "idempotency_key": "scene-incomplete-passes",
            "write": create_guard(),
            "actor_kind": "codex",
            "payload": incomplete_passes,
        },
    )
    assert incomplete.status_code == 422

    scene = spatial_write(client, "valid-scene", scene_payload(scope, states))["entity"]
    bad_camera = camera_payload(scope, scene, states)
    bad_camera["position_anchor_id"] = "missing-anchor"
    camera_response = client.post(
        "/spatial-versions",
        json={
            "idempotency_key": "camera-bad-anchor",
            "write": create_guard(),
            "actor_kind": "codex",
            "payload": bad_camera,
        },
    )
    assert camera_response.status_code == 409
    assert camera_response.json()["detail"]["code"] == "camera_anchor_mismatch"

    bad_blocking = blocking_payload(scope, scene, states)
    bad_blocking["actors"][0]["prop_contact_out_ids"] = ["missing-prop"]
    blocking_response = client.post(
        "/spatial-versions",
        json={
            "idempotency_key": "blocking-bad-prop",
            "write": create_guard(),
            "actor_kind": "codex",
            "payload": bad_blocking,
        },
    )
    assert blocking_response.status_code == 409
    assert blocking_response.json()["detail"]["code"] == "blocking_prop_contact_mismatch"

    camera = spatial_write(
        client, "valid-camera-for-composition", camera_payload(scope, scene, states)
    )["entity"]
    blocking = spatial_write(
        client, "valid-blocking-for-composition", blocking_payload(scope, scene, states)
    )["entity"]
    out_of_frame = composition_payload(scope, scene, camera, blocking, states)
    out_of_frame["subjects"][0]["frame_x"] = 0.9
    composition_response = client.post(
        "/spatial-versions",
        json={
            "idempotency_key": "composition-out-of-frame",
            "write": create_guard(),
            "actor_kind": "codex",
            "payload": out_of_frame,
        },
    )
    assert composition_response.status_code == 422

    approved = scene_payload(scope, states)
    approved["states"] = {**approved["states"], "review_state": "approved"}
    approved_response = client.post(
        "/spatial-versions",
        json={
            "idempotency_key": "scene-direct-approved",
            "write": create_guard(),
            "actor_kind": "human",
            "payload": approved,
        },
    )
    assert approved_response.status_code == 409
    assert approved_response.json()["detail"]["code"] == "spatial_approval_action_required"


def test_spatial_exact_component_impact_only_stales_matching_descendants(client, states) -> None:
    chain = make_chain(client, states)
    edge = client.post(
        "/impacts",
        json={
            "write": create_guard(),
            "actor_kind": "codex",
            "dependency_owner": version_guard(chain["scene"]),
            "source": version_guard(chain["scene"]),
            "target": version_guard(chain["camera"]),
            "dependency_key": "geometry",
            "scope": {
                "kind": "spatial_version_component",
                "component_key": "geometry",
            },
            "relation": "spatial_geometry_dependency",
            "propagates_stale": True,
        },
    )
    assert edge.status_code == 200, edge.text

    lighting_payload = scene_payload(chain, states)
    previous_lighting_hash = json_hash(lighting_payload["lighting_base"])
    lighting_payload["lighting_base"] = {"key": "cool", "ratio": 1.5}
    current_lighting_hash = json_hash(lighting_payload["lighting_base"])
    scene_v2 = spatial_write(
        client, "scene-lighting-update", lighting_payload, current=chain["scene"]
    )["entity"]
    unmatched = client.post(
        "/impacts/propagate-stale",
        json={
            "idempotency_key": "scene-lighting-unmapped",
            "actor_kind": "codex",
            "dependency_owner": version_guard(scene_v2),
            "changes": [
                {
                    "dependency_key": "lighting_base",
                    "scope": {
                        "kind": "spatial_version_component",
                        "component_key": "lighting_base",
                    },
                    "previous_dependency_hash": previous_lighting_hash,
                    "current_dependency_hash": current_lighting_hash,
                }
            ],
        },
    )
    assert unmatched.status_code == 200, unmatched.text
    assert len(unmatched.json()["unresolved_changes"]) == 1
    camera_read = client.get(
        f"/spatial-versions/{chain['camera']['ref']['film_entity_id']}"
    ).json()
    assert camera_read["states"]["stale_state"] == "fresh"

    geometry_payload = scene_payload(chain, states)
    geometry_payload["lighting_base"] = lighting_payload["lighting_base"]
    geometry_payload["geometry_content_hash"] = HASH_E
    scene_v3 = spatial_write(
        client, "scene-geometry-update", geometry_payload, current=scene_v2
    )["entity"]
    wrong_previous = client.post(
        "/impacts/propagate-stale",
        json={
            "idempotency_key": "scene-geometry-wrong-previous",
            "actor_kind": "codex",
            "dependency_owner": version_guard(scene_v3),
            "changes": [
                {
                    "dependency_key": "geometry",
                    "scope": {
                        "kind": "spatial_version_component",
                        "component_key": "geometry",
                    },
                    "previous_dependency_hash": HASH_B,
                    "current_dependency_hash": HASH_E,
                }
            ],
        },
    )
    assert wrong_previous.status_code == 200, wrong_previous.text
    assert len(wrong_previous.json()["unresolved_changes"]) == 1
    camera_read = client.get(
        f"/spatial-versions/{chain['camera']['ref']['film_entity_id']}"
    ).json()
    assert camera_read["states"]["stale_state"] == "fresh"

    matched = client.post(
        "/impacts/propagate-stale",
        json={
            "idempotency_key": "scene-geometry-mapped",
            "actor_kind": "codex",
            "dependency_owner": version_guard(scene_v3),
            "changes": [
                {
                    "dependency_key": "geometry",
                    "scope": {
                        "kind": "spatial_version_component",
                        "component_key": "geometry",
                    },
                    "previous_dependency_hash": HASH_A,
                    "current_dependency_hash": HASH_E,
                }
            ],
        },
    )
    assert matched.status_code == 200, matched.text
    assert matched.json()["stale_entity_ids"] == [
        chain["camera"]["ref"]["film_entity_id"]
    ]
    camera_read = client.get(
        f"/spatial-versions/{chain['camera']['ref']['film_entity_id']}"
    ).json()
    assert camera_read["states"]["stale_state"] == "stale"


def test_spatial_write_failure_rolls_back_and_retry_recovers(client, states) -> None:
    scope = make_scope(client, states)
    repository = client.app.state.formal_service.repository
    before = repository.formal_counts()
    with repository.database.connect() as connection:
        connection.execute(
            """
            CREATE TRIGGER fail_spatial_receipt
            BEFORE INSERT ON spatial_version_receipts
            BEGIN
                SELECT RAISE(ABORT, 'injected receipt failure');
            END
            """
        )
    request = {
        "idempotency_key": "scene-retry-after-rollback",
        "write": create_guard(),
        "actor_kind": "codex",
        "payload": scene_payload(scope, states),
    }
    try:
        with pytest.raises(sqlite3.IntegrityError, match="injected receipt failure"):
            client.post("/spatial-versions", json=request)
    finally:
        with repository.database.connect() as connection:
            connection.execute("DROP TRIGGER fail_spatial_receipt")
    assert repository.formal_counts() == before

    recovered = client.post("/spatial-versions", json=request)
    assert recovered.status_code == 200
    assert recovered.json()["replayed"] is False
    assert repository.formal_counts() == (before[0] + 1, before[1] + 1)


def test_restart_and_sqlite_backup_restore_preserve_versions_and_receipts(tmp_path, states) -> None:
    source_path = tmp_path / "source.sqlite"
    with TestClient(create_app(source_path), raise_server_exceptions=False) as client:
        chain = make_chain(client, states)
        replay_request = {
            "idempotency_key": "composition-create",
            "write": create_guard(),
            "actor_kind": "codex",
            "payload": composition_payload(
                chain,
                chain["scene"],
                chain["camera"],
                chain["blocking"],
                states,
            ),
        }
        composition_id = chain["composition"]["ref"]["film_entity_id"]

    with TestClient(create_app(source_path)) as restarted:
        read = restarted.get(f"/spatial-versions/{composition_id}")
        assert read.status_code == 200
        replay = restarted.post("/spatial-versions", json=replay_request)
        assert replay.status_code == 200
        assert replay.json()["replayed"] is True
        with restarted.app.state.formal_service.repository.database.connect() as source:
            source.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    backup_path = tmp_path / "restored.sqlite"
    with sqlite3.connect(source_path) as source, sqlite3.connect(backup_path) as target:
        source.backup(target)

    with TestClient(create_app(backup_path)) as restored:
        read = restored.get(f"/spatial-versions/{composition_id}")
        assert read.status_code == 200
        replay = restored.post("/spatial-versions", json=replay_request)
        assert replay.status_code == 200
        assert replay.json()["replayed"] is True
        with restored.app.state.formal_service.repository.database.connect() as connection:
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_v3_to_latest_migration_preserves_history_fk_indexes_and_triggers(tmp_path) -> None:
    path = tmp_path / "v3.sqlite"
    entity_id = str(uuid4())
    event_id = str(uuid4())
    body = {
        "host": {"host_project_id": "legacy-project", "host_unit_id": "legacy-unit"},
        "states": {
            "creative_stage": "draft",
            "execution_state": "not_started",
            "review_state": "not_reviewed",
            "lock_state": "unlocked",
            "delivery_state": "not_ready",
            "stale_state": "fresh",
        },
        "source_script_version_id": None,
        "script_text": "legacy v3",
        "script_text_hash": hashlib.sha256(b"legacy v3").hexdigest(),
    }
    content_hash = hashlib.sha256(canonical_json(body).encode()).hexdigest()
    with sqlite3.connect(path, isolation_level=None) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        for version, migration in (
            (1, MIGRATION_001),
            (2, MIGRATION_002),
            (3, MIGRATION_003),
        ):
            connection.executescript(migration)
            connection.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, 'now')",
                (version,),
            )
        connection.execute(
            "INSERT INTO formal_records VALUES (?, 'script_version', 1, ?, ?, 'now', 'now')",
            (entity_id, content_hash, canonical_json(body)),
        )
        connection.execute(
            "INSERT INTO formal_audit_events VALUES (?, 'human', 'script_version.created', ?, NULL, 1, 'formal_record.create', '{}', 'now')",
            (event_id, entity_id),
        )

    database = SQLiteDatabase(path)
    with database.connect() as connection:
        preserved = connection.execute(
            "SELECT entity_type, version, content_hash FROM formal_records WHERE film_entity_id = ?",
            (entity_id,),
        ).fetchone()
        assert tuple(preserved) == ("script_version", 1, content_hash)
        assert connection.execute(
            "SELECT target_id FROM formal_audit_events WHERE event_id = ?", (event_id,)
        ).fetchone()["target_id"] == entity_id
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        indexes = {
            row["name"] for row in connection.execute("PRAGMA index_list(formal_records)")
        }
        assert "idx_formal_records_type_created" in indexes
        triggers = {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'trigger'"
            )
        }
        assert {
            "formal_audit_events_no_update",
            "formal_audit_events_no_delete",
            "spatial_version_receipts_no_update",
            "spatial_version_receipts_no_delete",
        } <= triggers
        assert connection.execute(
            "SELECT MAX(version) AS version FROM schema_migrations"
        ).fetchone()["version"] == 7

    SQLiteDatabase(path)
    with database.connect() as connection:
        assert connection.execute(
            "SELECT COUNT(*) AS count FROM formal_records"
        ).fetchone()["count"] == 1
        try:
            connection.execute(
                "UPDATE formal_audit_events SET action = 'tampered' WHERE event_id = ?",
                (event_id,),
            )
        except sqlite3.IntegrityError as error:
            assert "append-only" in str(error)
        else:  # pragma: no cover
            raise AssertionError("formal audit update unexpectedly succeeded")
