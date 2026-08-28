from __future__ import annotations

import hashlib
import sqlite3
from uuid import UUID, uuid4

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from film_production_core.contracts import repository_root
from film_production_core.formal_service import hash_json
from film_production_core.impact_repository import walk_impact_graph


ZERO_HASH = "0" * 64
HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64
HASH_D = "d" * 64
HASH_E = "e" * 64


def validate_contract(definition: str, value: dict) -> None:
    import json

    schema = json.loads(
        (
            repository_root()
            / "film-contracts"
            / "schemas"
            / "core.schema.json"
        ).read_text(encoding="utf-8")
    )
    Draft202012Validator(
        {"$ref": f"#/$defs/{definition}", "$defs": schema["$defs"]},
        format_checker=FormatChecker(),
    ).validate(value)


def create_guard() -> dict:
    return {
        "target_id": None,
        "expected_version": 0,
        "expected_content_hash": ZERO_HASH,
    }


def guard(entity: dict) -> dict:
    return {
        "film_entity_id": entity["ref"]["film_entity_id"],
        "expected_version": entity["ref"]["version"],
        "expected_content_hash": entity["ref"]["content_hash"],
    }


def create_legacy(client, states: dict, entity_type: str, host: dict, **extra) -> dict:
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


def create_formal(client, entity_type: str, **payload) -> dict:
    response = client.post(
        "/formal-records",
        json={
            "write": create_guard(),
            "actor_kind": "codex",
            "payload": {"entity_type": entity_type, **payload},
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["entity"]


def fresh_script(client, states: dict, suffix: str) -> dict:
    return create_formal(
        client,
        "script_version",
        host={
            "host_project_id": f"host-project-{suffix}",
            "host_unit_id": f"host-unit-{suffix}",
        },
        states=states,
        script_text=f"INT. ROOM - DAY\n{suffix}",
    )


def visual_owner(client, states: dict, dependency_hashes: dict[str, str]) -> dict:
    suffix = str(uuid4())
    project = create_legacy(
        client,
        states,
        "film_project_extension",
        {"host_project_id": f"host-project-{suffix}"},
    )
    shot = create_legacy(
        client,
        states,
        "shot_extension",
        {
            "host_project_id": f"host-project-{suffix}",
            "host_shot_id": f"host-shot-{suffix}",
        },
        director_unit_ids=[],
    )
    lock_text = f"visual-lock-{suffix}"
    owner = create_formal(
        client,
        "visual_lock_set",
        project=guard(project),
        shot=guard(shot),
        states=states,
        visual_lock_text=lock_text,
        visual_lock_hash=hashlib.sha256(lock_text.encode()).hexdigest(),
        locks={"dependencyHashes": dependency_hashes},
    )
    return owner


def create_edge(
    client,
    *,
    owner: dict,
    source: dict,
    target: dict,
    dependency_key: str,
    scope: dict,
    structure: dict | None = None,
    propagates_stale: bool = True,
) -> dict:
    response = client.post(
        "/impacts",
        json={
            "write": create_guard(),
            "actor_kind": "codex",
            "dependency_owner": guard(owner),
            "script_structure_map": None if structure is None else guard(structure),
            "source": guard(source),
            "target": guard(target),
            "dependency_key": dependency_key,
            "scope": scope,
            "relation": "depends_on",
            "propagates_stale": propagates_stale,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def propagate(
    client,
    *,
    owner: dict,
    changes: list[dict],
    idempotency_key: str,
    structure: dict | None = None,
):
    return client.post(
        "/impacts/propagate-stale",
        json={
            "idempotency_key": idempotency_key,
            "actor_kind": "system",
            "dependency_owner": guard(owner),
            "script_structure_map": None if structure is None else guard(structure),
            "changes": changes,
        },
    )


def assert_stale_only(before: dict, after: dict) -> None:
    assert after["ref"]["version"] == before["ref"]["version"] + 1
    assert after["states"]["stale_state"] == "stale"
    for axis in (
        "creative_stage",
        "execution_state",
        "review_state",
        "lock_state",
        "delivery_state",
    ):
        assert after["states"][axis] == before["states"][axis]


def test_script_structure_map_is_guarded_companion_without_script_body(
    client, states
) -> None:
    script = fresh_script(client, states, "structure")
    section_id = str(uuid4())
    cue_id = str(uuid4())
    cue_hash = hashlib.sha256(b"A: Leave now.").hexdigest()
    request = {
        "write": create_guard(),
        "actor_kind": "codex",
        "script_version": guard(script),
        "sections": [
            {"section_id": section_id, "start_order": 10, "end_order": 19}
        ],
        "cues": [
            {
                "cue_id": cue_id,
                "section_id": section_id,
                "speaker": "A",
                "order": 10,
                "cue_text_hash": cue_hash,
            }
        ],
    }
    response = client.post("/script-structure-maps", json=request)
    assert response.status_code == 200, response.text
    structure = response.json()
    validate_contract("ScriptStructureMap", structure)
    assert UUID(structure["ref"]["film_entity_id"]).version == 4
    assert structure["script_version_id"] == script["ref"]["film_entity_id"]
    assert structure["script_version_version"] == script["ref"]["version"]
    assert structure["script_version_content_hash"] == script["ref"]["content_hash"]
    assert "script_text" not in structure
    assert "cue_text" not in structure["cues"][0]
    fetched = client.get(
        f"/script-structure-maps/{structure['ref']['film_entity_id']}"
    )
    assert fetched.status_code == 200
    assert fetched.json() == structure

    stale = {**request, "script_version": {**guard(script), "expected_version": 2}}
    conflict = client.post("/script-structure-maps", json=stale)
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "version_conflict"


def test_visual_lock_impacts_propagate_only_exact_declared_scopes(client) -> None:
    states = {
        "creative_stage": "authored",
        "execution_state": "succeeded",
        "review_state": "passed",
        "lock_state": "unlocked",
        "delivery_state": "ready",
        "stale_state": "fresh",
    }
    prop_id = str(uuid4())
    character_id = str(uuid4())
    leaf_key = f"propStateVersions:{prop_id}"
    character_key = f"characterIdentityVersions:{character_id}"
    owner = visual_owner(
        client,
        states,
        {
            "propStateVersions": HASH_B,
            leaf_key: HASH_C,
            character_key: HASH_D,
            "cameraVersion": HASH_E,
            "lightingVersion": HASH_A,
        },
    )
    all_props = fresh_script(client, states, "all-props")
    leaf = fresh_script(client, states, "leaf")
    descendant = fresh_script(client, states, "descendant")
    character = fresh_script(client, states, "character")
    camera = fresh_script(client, states, "camera")
    legacy_target = create_legacy(
        client,
        states,
        "film_project_extension",
        {"host_project_id": f"host-project-impact-{uuid4()}"},
    )
    all_scope = {"kind": "visual_lock_component", "component_key": "propStateVersions"}
    leaf_scope = {"kind": "visual_lock_component", "component_key": leaf_key}
    character_scope = {
        "kind": "visual_lock_component",
        "component_key": character_key,
    }
    camera_scope = {"kind": "visual_lock_component", "component_key": "cameraVersion"}
    create_edge(
        client,
        owner=owner,
        source=owner,
        target=all_props,
        dependency_key="propStateVersions",
        scope=all_scope,
    )
    create_edge(
        client,
        owner=owner,
        source=owner,
        target=legacy_target,
        dependency_key="propStateVersions",
        scope=all_scope,
    )
    leaf_edge = create_edge(
        client,
        owner=owner,
        source=owner,
        target=leaf,
        dependency_key=leaf_key,
        scope=leaf_scope,
    )
    validate_contract("ImpactEdge", leaf_edge)
    assert leaf_edge["dependency_content_hash"] == HASH_C
    create_edge(
        client,
        owner=owner,
        source=leaf,
        target=descendant,
        dependency_key=leaf_key,
        scope=leaf_scope,
    )
    create_edge(
        client,
        owner=owner,
        source=owner,
        target=character,
        dependency_key=character_key,
        scope=character_scope,
    )
    create_edge(
        client,
        owner=owner,
        source=owner,
        target=camera,
        dependency_key="cameraVersion",
        scope=camera_scope,
    )

    query = client.get(f"/impacts/{owner['ref']['film_entity_id']}")
    assert query.status_code == 200
    validate_contract("ImpactQueryResult", query.json())
    assert len(query.json()["outgoing"]) == 5
    incoming = client.get(f"/impacts/{leaf['ref']['film_entity_id']}")
    assert incoming.json()["incoming"][0]["ref"] == leaf_edge["ref"]

    changes = [
        {
            "dependency_key": "propStateVersions",
            "scope": all_scope,
            "previous_dependency_hash": HASH_A,
            "current_dependency_hash": HASH_B,
        },
        {
            "dependency_key": leaf_key,
            "scope": leaf_scope,
            "previous_dependency_hash": HASH_B,
            "current_dependency_hash": HASH_C,
        },
        {
            "dependency_key": "lightingVersion",
            "scope": {
                "kind": "visual_lock_component",
                "component_key": "lightingVersion",
            },
            "previous_dependency_hash": HASH_E,
            "current_dependency_hash": HASH_A,
        },
    ]
    response = propagate(
        client,
        owner=owner,
        changes=changes,
        idempotency_key="visual-lock-change-1",
    )
    assert response.status_code == 200, response.text
    result = response.json()
    validate_contract("StalePropagationResult", result)
    assert result["replayed"] is False
    assert result["unresolved_changes"] == [changes[2]]
    assert set(result["stale_entity_ids"]) == {
        all_props["ref"]["film_entity_id"],
        leaf["ref"]["film_entity_id"],
        descendant["ref"]["film_entity_id"],
        legacy_target["ref"]["film_entity_id"],
    }
    assert len(result["traversed_edge_ids"]) == 4
    for before in (all_props, leaf, descendant):
        after = client.get(f"/formal-records/{before['ref']['film_entity_id']}").json()
        assert_stale_only(before, after)
    for fresh in (character, camera):
        after = client.get(f"/formal-records/{fresh['ref']['film_entity_id']}").json()
        assert after == fresh
    assert_stale_only(
        legacy_target,
        client.get(f"/entities/{legacy_target['ref']['film_entity_id']}").json(),
    )

    audit_before_replay = len(client.get("/audit-events?limit=500").json())
    replay = propagate(
        client,
        owner=owner,
        changes=changes,
        idempotency_key="visual-lock-change-1",
    )
    assert replay.status_code == 200
    assert replay.json()["replayed"] is True
    assert replay.json()["unresolved_changes"] == [changes[2]]
    assert len(client.get("/audit-events?limit=500").json()) == audit_before_replay
    conflict_changes = [{**changes[0], "previous_dependency_hash": HASH_E}]
    conflict = propagate(
        client,
        owner=owner,
        changes=conflict_changes,
        idempotency_key="visual-lock-change-1",
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "idempotency_conflict"


def test_script_and_asset_scopes_require_current_source_hashes(client, states) -> None:
    script = fresh_script(client, states, "script-impact")
    section_id = str(uuid4())
    cue_id = str(uuid4())
    cue_hash = HASH_C
    structure_response = client.post(
        "/script-structure-maps",
        json={
            "write": create_guard(),
            "actor_kind": "codex",
            "script_version": guard(script),
            "sections": [
                {"section_id": section_id, "start_order": 0, "end_order": 0}
            ],
            "cues": [
                {
                    "cue_id": cue_id,
                    "section_id": section_id,
                    "speaker": "A",
                    "order": 0,
                    "cue_text_hash": cue_hash,
                }
            ],
        },
    )
    assert structure_response.status_code == 200, structure_response.text
    structure = structure_response.json()
    target = fresh_script(client, states, "cue-target")
    cue_scope = {"kind": "script_cue", "cue_id": cue_id}
    create_edge(
        client,
        owner=script,
        source=script,
        target=target,
        dependency_key=f"cue:{cue_id}",
        scope=cue_scope,
        structure=structure,
    )
    wrong = propagate(
        client,
        owner=script,
        structure=structure,
        idempotency_key="cue-change-wrong",
        changes=[
            {
                "dependency_key": f"cue:{cue_id}",
                "scope": cue_scope,
                "previous_dependency_hash": HASH_A,
                "current_dependency_hash": HASH_B,
            }
        ],
    )
    assert wrong.status_code == 409
    assert wrong.json()["detail"]["code"] == "current_dependency_hash_mismatch"
    assert client.get(f"/formal-records/{target['ref']['film_entity_id']}").json() == target
    applied = propagate(
        client,
        owner=script,
        structure=structure,
        idempotency_key="cue-change-ok",
        changes=[
            {
                "dependency_key": f"cue:{cue_id}",
                "scope": cue_scope,
                "previous_dependency_hash": HASH_A,
                "current_dependency_hash": cue_hash,
            }
        ],
    )
    assert applied.status_code == 200, applied.text

    suffix = str(uuid4())
    project = create_legacy(
        client,
        states,
        "film_project_extension",
        {"host_project_id": f"host-project-asset-{suffix}"},
    )
    asset = create_formal(
        client,
        "asset_binding",
        project=guard(project),
        host={
            "host_project_id": f"host-project-asset-{suffix}",
            "host_asset_id": "host-asset-opaque",
            "host_asset_version_id": "host-asset-version-opaque",
        },
        role="hero_prop",
        priority=10,
        asset_content_hash=HASH_D,
    )
    asset_target = fresh_script(client, states, "asset-target")
    asset_scope = {
        "kind": "asset_binding_source",
        "asset_content_hash": HASH_D,
    }
    create_edge(
        client,
        owner=asset,
        source=asset,
        target=asset_target,
        dependency_key="asset_source",
        scope=asset_scope,
    )
    stale_owner = {**asset, "ref": {**asset["ref"], "content_hash": HASH_A}}
    guarded = propagate(
        client,
        owner=stale_owner,
        idempotency_key="asset-change-stale-owner",
        changes=[
            {
                "dependency_key": "asset_source",
                "scope": asset_scope,
                "previous_dependency_hash": HASH_C,
                "current_dependency_hash": HASH_D,
            }
        ],
    )
    assert guarded.status_code == 409
    assert guarded.json()["detail"]["code"] == "content_hash_conflict"


def test_cycle_and_unanchored_edges_fail_without_partial_write(client, states) -> None:
    key = "cameraVersion"
    scope = {"kind": "visual_lock_component", "component_key": key}
    owner = visual_owner(client, states, {key: HASH_A})
    first = fresh_script(client, states, "cycle-first")
    second = fresh_script(client, states, "cycle-second")
    create_edge(
        client,
        owner=owner,
        source=owner,
        target=first,
        dependency_key=key,
        scope=scope,
    )
    create_edge(
        client,
        owner=owner,
        source=first,
        target=second,
        dependency_key=key,
        scope=scope,
    )
    cycle = client.post(
        "/impacts",
        json={
            "write": create_guard(),
            "actor_kind": "codex",
            "dependency_owner": guard(owner),
            "script_structure_map": None,
            "source": guard(second),
            "target": guard(owner),
            "dependency_key": key,
            "scope": scope,
            "relation": "depends_on",
            "propagates_stale": True,
        },
    )
    assert cycle.status_code == 409
    assert cycle.json()["detail"]["code"] == "impact_graph_cycle"
    unrelated = fresh_script(client, states, "unanchored")
    unanchored = client.post(
        "/impacts",
        json={
            "write": create_guard(),
            "actor_kind": "codex",
            "dependency_owner": guard(owner),
            "script_structure_map": None,
            "source": guard(unrelated),
            "target": guard(second),
            "dependency_key": key,
            "scope": scope,
            "relation": "depends_on",
            "propagates_stale": True,
        },
    )
    assert unanchored.status_code == 409
    assert unanchored.json()["detail"]["code"] == "impact_source_not_anchored"
    assert len(client.get(f"/impacts/{owner['ref']['film_entity_id']}").json()["outgoing"]) == 1


def test_propagation_rolls_back_state_audit_and_idempotency_together(client, states) -> None:
    key = "cameraVersion"
    scope = {"kind": "visual_lock_component", "component_key": key}
    owner = visual_owner(client, states, {key: HASH_B})
    first = fresh_script(client, states, "rollback-first")
    second = fresh_script(client, states, "rollback-second")
    for target in (first, second):
        create_edge(
            client,
            owner=owner,
            source=owner,
            target=target,
            dependency_key=key,
            scope=scope,
        )
    impact_repository = client.app.state.impact_service.repository
    with impact_repository.database.connect() as connection:
        connection.execute(
            f"""
            CREATE TRIGGER reject_second_stale
            BEFORE UPDATE ON formal_records
            WHEN OLD.film_entity_id = '{second['ref']['film_entity_id']}'
            BEGIN
                SELECT RAISE(ABORT, 'test rollback');
            END;
            """
        )
    with pytest.raises(sqlite3.IntegrityError, match="test rollback"):
        propagate(
            client,
            owner=owner,
            idempotency_key="rollback-change",
            changes=[
                {
                    "dependency_key": key,
                    "scope": scope,
                    "previous_dependency_hash": HASH_A,
                    "current_dependency_hash": HASH_B,
                }
            ],
        )
    for entity in (first, second):
        assert client.get(f"/formal-records/{entity['ref']['film_entity_id']}").json() == entity
    assert impact_repository.counts()[2] == 0
    owner_audits = client.get(
        f"/audit-events?targetId={owner['ref']['film_entity_id']}&limit=500"
    ).json()
    assert all(event["action"] != "impact.propagated" for event in owner_audits)


def test_impact_tables_are_immutable_and_traversal_is_bounded(client, states) -> None:
    script = fresh_script(client, states, "immutable-map")
    section_id = str(uuid4())
    cue_id = str(uuid4())
    structure = client.post(
        "/script-structure-maps",
        json={
            "write": create_guard(),
            "actor_kind": "codex",
            "script_version": guard(script),
            "sections": [
                {"section_id": section_id, "start_order": 0, "end_order": 0}
            ],
            "cues": [
                {
                    "cue_id": cue_id,
                    "section_id": section_id,
                    "speaker": "A",
                    "order": 0,
                    "cue_text_hash": HASH_A,
                }
            ],
        },
    ).json()
    database = client.app.state.impact_service.repository.database
    with database.connect() as connection:
        with pytest.raises(sqlite3.DatabaseError, match="immutable"):
            connection.execute(
                "UPDATE script_structure_maps SET updated_at = updated_at "
                "WHERE film_entity_id = ?",
                (structure["ref"]["film_entity_id"],),
            )
        with pytest.raises(sqlite3.DatabaseError, match="append-only"):
            connection.execute("DELETE FROM impact_audit_events")

    cycle = [("edge-a", "root", "a"), ("edge-b", "a", "root")]
    with pytest.raises(Exception, match="acyclic"):
        walk_impact_graph(cycle, "root")
    deep = [
        (f"edge-{index}", f"node-{index}", f"node-{index + 1}")
        for index in range(3)
    ]
    with pytest.raises(Exception, match="depth limit"):
        walk_impact_graph(deep, "node-0", max_depth=2)


def test_script_section_dependency_hash_is_canonical(client, states) -> None:
    script = fresh_script(client, states, "section-impact")
    section_id = str(uuid4())
    cue_one = {"cue_id": str(uuid4()), "cue_text_hash": HASH_A, "order": 4}
    cue_two = {"cue_id": str(uuid4()), "cue_text_hash": HASH_B, "order": 5}
    structure = client.post(
        "/script-structure-maps",
        json={
            "write": create_guard(),
            "actor_kind": "codex",
            "script_version": guard(script),
            "sections": [
                {"section_id": section_id, "start_order": 4, "end_order": 5}
            ],
            "cues": [
                {**cue_one, "section_id": section_id, "speaker": "A"},
                {**cue_two, "section_id": section_id, "speaker": "B"},
            ],
        },
    ).json()
    target = fresh_script(client, states, "section-target")
    scope = {"kind": "script_section", "section_id": section_id}
    create_edge(
        client,
        owner=script,
        source=script,
        target=target,
        dependency_key=f"section:{section_id}",
        scope=scope,
        structure=structure,
    )
    section_hash = hash_json(
        {
            "section_id": section_id,
            "start_order": 4,
            "end_order": 5,
            "cues": [cue_one, cue_two],
        }
    )
    result = propagate(
        client,
        owner=script,
        structure=structure,
        idempotency_key="section-change",
        changes=[
            {
                "dependency_key": f"section:{section_id}",
                "scope": scope,
                "previous_dependency_hash": HASH_C,
                "current_dependency_hash": section_hash,
            }
        ],
    )
    assert result.status_code == 200, result.text
    assert result.json()["stale_entity_ids"] == [target["ref"]["film_entity_id"]]
