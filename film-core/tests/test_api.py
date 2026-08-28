from __future__ import annotations

import sqlite3
from uuid import UUID, uuid4

import pytest


def test_health_performs_sqlite_round_trip(client) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "film-production-core",
        "schema_version": 3,
        "database": "sqlite-sidecar",
        "journal_mode": "wal",
    }


def test_preview_is_read_only_and_apply_generates_stable_uuid4(
    client, project_create_command
) -> None:
    repository = client.app.state.film_service.repository

    preview = client.post("/commands/preview", json=project_create_command)

    assert preview.status_code == 200
    assert preview.json()["current_version"] == 0
    assert preview.json()["resulting_version"] == 1
    assert preview.json()["target_id"] is None
    assert repository.counts() == (0, 0)

    applied = client.post("/commands/apply", json=project_create_command)

    assert applied.status_code == 200
    body = applied.json()
    film_id = body["entity"]["ref"]["film_entity_id"]
    event_id = body["audit_event"]["event_id"]
    assert UUID(film_id).version == 4
    assert UUID(event_id).version == 4
    assert body["entity"]["ref"]["version"] == 1
    assert body["entity"]["host"] == {"host_project_id": "host-project-1"}
    assert len(body["entity"]["ref"]["content_hash"]) == 64
    assert repository.counts() == (1, 1)

    read = client.get(f"/entities/{film_id}")
    context = client.get("/projects/host-project-1/context")
    audit = client.get(f"/audit-events?targetId={film_id}")

    assert read.status_code == 200
    assert read.json() == body["entity"]
    assert context.status_code == 200
    assert context.json()["film_project"] == body["entity"]
    assert context.json()["host_authority"] == "yingce"
    assert context.json()["film_authority"] == "film_core_sidecar"
    assert context.json()["audit_event_count"] == 1
    assert audit.status_code == 200
    assert audit.json() == [body["audit_event"]]


def test_expected_version_conflict_never_overwrites_or_appends_audit(
    client, project_create_command, states
) -> None:
    created = client.post("/commands/apply", json=project_create_command).json()
    film_id = created["entity"]["ref"]["film_entity_id"]
    next_states = {**states, "creative_stage": "authored", "stale_state": "stale"}
    update = {
        "command_type": "entity.set_states",
        "target_id": film_id,
        "expected_version": 1,
        "actor_kind": "codex",
        "payload": {"states": next_states},
    }

    preview = client.post("/commands/preview", json=update)
    applied = client.post("/commands/apply", json=update)
    conflict = client.post("/commands/apply", json=update)

    assert preview.status_code == 200
    assert preview.json()["resulting_version"] == 2
    assert applied.status_code == 200
    updated = applied.json()["entity"]
    assert updated["ref"]["film_entity_id"] == film_id
    assert updated["ref"]["version"] == 2
    assert (
        updated["ref"]["content_hash"]
        != created["entity"]["ref"]["content_hash"]
    )
    assert updated["states"]["creative_stage"] == "authored"
    assert updated["states"]["stale_state"] == "stale"
    assert conflict.status_code == 409
    assert conflict.json()["detail"] == {
        "code": "version_conflict",
        "message": "expected_version does not match current version",
        "target_id": film_id,
        "expected_version": 1,
        "current_version": 2,
    }
    assert client.app.state.film_service.repository.counts() == (1, 2)
    assert client.get(f"/entities/{film_id}").json() == updated


def test_host_mapping_is_unique(client, project_create_command) -> None:
    first = client.post("/commands/apply", json=project_create_command)
    duplicate_preview = client.post(
        "/commands/preview", json=project_create_command
    )
    duplicate_apply = client.post("/commands/apply", json=project_create_command)

    assert first.status_code == 200
    first_id = first.json()["entity"]["ref"]["film_entity_id"]
    for response in (duplicate_preview, duplicate_apply):
        assert response.status_code == 409
        assert response.json()["detail"]["target_id"] == first_id
        assert response.json()["detail"]["expected_version"] == 0
        assert response.json()["detail"]["current_version"] == 1
    assert client.app.state.film_service.repository.counts() == (1, 1)


def test_unit_and_shot_reads_only_return_film_extensions(client, states) -> None:
    unit_command = {
        "command_type": "entity.create",
        "target_id": None,
        "expected_version": 0,
        "payload": {
            "entity_type": "content_unit_extension",
            "host": {
                "host_project_id": "host-project-1",
                "host_unit_id": "host-unit-1",
            },
            "states": states,
            "unit_kind": "episode",
        },
    }
    director_id = str(uuid4())
    shot_command = {
        "command_type": "entity.create",
        "target_id": None,
        "expected_version": 0,
        "payload": {
            "entity_type": "shot_extension",
            "host": {
                "host_project_id": "host-project-1",
                "host_unit_id": "host-unit-1",
                "host_shot_id": "host-shot-1",
            },
            "states": states,
            "director_unit_ids": [director_id],
        },
    }

    unit = client.post("/commands/apply", json=unit_command)
    shot = client.post("/commands/apply", json=shot_command)

    assert unit.status_code == 200
    assert shot.status_code == 200
    unit_read = client.get("/units/host-unit-1")
    shot_read = client.get("/shots/host-shot-1")
    context = client.get("/projects/host-project-1/context").json()
    assert unit_read.json() == unit.json()["entity"]
    assert shot_read.json() == shot.json()["entity"]
    assert shot_read.json()["director_unit_ids"] == [director_id]
    assert len(context["content_units"]) == 1
    assert len(context["shots"]) == 1
    assert context["film_project"] is None
    assert client.get("/units/missing").status_code == 404
    assert client.get("/shots/missing").status_code == 404


def test_six_state_axes_and_core_generated_identity_are_enforced(
    client, project_create_command
) -> None:
    missing_axis = {
        **project_create_command,
        "payload": {
            **project_create_command["payload"],
            "states": {
                key: value
                for key, value in project_create_command["payload"]["states"].items()
                if key != "stale_state"
            },
        },
    }
    client_selected_id = {
        **project_create_command,
        "target_id": str(uuid4()),
    }
    invalid_axis = {
        **project_create_command,
        "payload": {
            **project_create_command["payload"],
            "states": {
                **project_create_command["payload"]["states"],
                "lock_state": "maybe_locked",
            },
        },
    }

    assert client.post("/commands/apply", json=missing_axis).status_code == 422
    assert client.post("/commands/apply", json=client_selected_id).status_code == 422
    assert client.post("/commands/apply", json=invalid_axis).status_code == 422
    assert client.app.state.film_service.repository.counts() == (0, 0)


def test_audit_events_are_append_only_at_database_boundary(
    client, project_create_command
) -> None:
    applied = client.post("/commands/apply", json=project_create_command).json()
    event_id = applied["audit_event"]["event_id"]
    database = client.app.state.film_service.repository.database

    with database.connect() as connection:
        try:
            with pytest.raises(sqlite3.DatabaseError, match="append-only"):
                connection.execute(
                    "UPDATE audit_events SET action = 'tampered' WHERE event_id = ?",
                    (event_id,),
                )
            with pytest.raises(sqlite3.DatabaseError, match="append-only"):
                connection.execute(
                    "DELETE FROM audit_events WHERE event_id = ?", (event_id,)
                )
        finally:
            connection.rollback()

    assert client.app.state.film_service.repository.counts() == (1, 1)
