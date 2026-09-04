from __future__ import annotations

import hashlib
import importlib.util
import sqlite3
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from film_production_core.database import SQLiteDatabase


def test_health_performs_sqlite_round_trip(client) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "film-production-core",
        "schema_version": 7,
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


def test_read_only_database_and_external_launcher_are_exact_and_zero_write(
    client, project_create_command, states, monkeypatch
) -> None:
    project = client.post("/commands/apply", json=project_create_command).json()[
        "entity"
    ]
    unit_command = {
        "command_type": "entity.create",
        "target_id": None,
        "expected_version": 0,
        "actor_kind": "human",
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
    assert client.post("/commands/apply", json=unit_command).status_code == 200
    writable_database = client.app.state.film_service.repository.database
    with writable_database.connect() as connection:
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    database_path = writable_database.path
    wal_path = Path(f"{database_path}-wal")
    if not wal_path.exists():
        wal_path.touch(mode=0o600)

    expected_identity = {
        "path": str(database_path),
        **_file_identity(database_path),
        "wal": _file_identity(wal_path),
    }
    before = {
        "main": _file_identity(database_path),
        "wal": _file_identity(wal_path),
    }
    database = SQLiteDatabase(
        database_path,
        read_only=True,
        expected_identity=expected_identity,
    )
    assert database.health() == (7, "wal")
    with database.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM film_entities").fetchone()[0] == 2
        with pytest.raises(sqlite3.DatabaseError):
            connection.execute("UPDATE film_entities SET version = version")

    launcher_path = (
        Path(__file__).resolve().parents[2]
        / "desktop/macos/runtime/film-core-launcher.py"
    )
    spec = importlib.util.spec_from_file_location("filmos_external_core", launcher_path)
    assert spec and spec.loader
    launcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(launcher)
    external_configuration = {
        "database_path": str(database_path),
        "database_identity": expected_identity,
        "project_id": "host-project-1",
        "project_mapping": {
            "film_entity_id": project["ref"]["film_entity_id"],
            "version": project["ref"]["version"],
            "content_hash": project["ref"]["content_hash"],
            "project_count": 1,
            "content_unit_count": 1,
            "shot_count": 0,
        },
    }
    monkeypatch.setenv("FILMOS_CORE_RUNTIME_MODE", "external-read")
    monkeypatch.setenv("FILMOS_CORE_DB_PATH", str(database_path))
    app = launcher.build_app(external_read_test_only=external_configuration)
    with TestClient(app) as external:
        health = external.get("/health")
        assert health.status_code == 200
        assert health.json()["runtime_mode"] == "external-read"
        context = external.get("/film/projects/host-project-1/context")
        assert context.status_code == 200
        assert context.json()["film_project"] == project
        denied = external.post(
            "/film/projects/host-project-1/context",
            content="{",
            headers={"content-type": "application/json"},
        )
        assert denied.status_code == 404
        assert denied.json()["code"] == "FILM_CORE_EXTERNAL_READ_ROUTE_DENIED"
        assert external.get("/openapi.json").status_code == 404

    after = {
        "main": _file_identity(database_path),
        "wal": _file_identity(wal_path),
    }
    assert after == before
    with pytest.raises(ValueError, match="FILM_CORE_READ_ONLY_DATABASE_MISMATCH"):
        SQLiteDatabase(
            database_path,
            read_only=True,
            expected_identity={**expected_identity, "sha256": "0" * 64},
        )
    alias = database_path.parent / "film-core-alias.sqlite"
    alias.symlink_to(database_path)
    with pytest.raises(ValueError, match="FILM_CORE_READ_ONLY_DATABASE_REQUIRED"):
        SQLiteDatabase(alias, read_only=True, expected_identity=expected_identity)

    missing = database_path.parent / "missing-film-core.sqlite"
    with pytest.raises(ValueError, match="FILM_CORE_READ_ONLY_DATABASE_REQUIRED"):
        SQLiteDatabase(
            missing,
            read_only=True,
            expected_identity={**expected_identity, "path": str(missing)},
        )
    monkeypatch.setenv("FILMOS_CORE_DB_PATH", str(missing))
    with pytest.raises(ValueError, match="FILM_CORE_READ_ONLY_DATABASE_REQUIRED"):
        launcher.build_app(
            external_read_test_only={
                **external_configuration,
                "database_path": str(missing),
                "database_identity": {**expected_identity, "path": str(missing)},
            }
        )

    replaced = database_path.parent / "replaced-film-core.sqlite"
    replaced_wal = Path(f"{replaced}-wal")
    original_bytes = database_path.read_bytes()
    replaced.write_bytes(original_bytes)
    replaced_wal.touch(mode=0o600)
    replaced_identity = {
        "path": str(replaced),
        **_file_identity(replaced),
        "wal": _file_identity(replaced_wal),
    }
    replacement_candidate = database_path.parent / "replacement-candidate.sqlite"
    replacement_candidate.write_bytes(original_bytes)
    replacement_candidate.replace(replaced)
    assert _file_identity(replaced)["inode"] != replaced_identity["inode"]
    with pytest.raises(ValueError, match="FILM_CORE_READ_ONLY_DATABASE_MISMATCH"):
        SQLiteDatabase(replaced, read_only=True, expected_identity=replaced_identity)
    replaced_before = {
        "main": _file_identity(replaced),
        "wal": _file_identity(replaced_wal),
    }
    monkeypatch.setenv("FILMOS_CORE_DB_PATH", str(replaced))
    with pytest.raises(ValueError, match="FILM_CORE_READ_ONLY_DATABASE_MISMATCH"):
        launcher.build_app(
            external_read_test_only={
                **external_configuration,
                "database_path": str(replaced),
                "database_identity": replaced_identity,
            }
        )
    assert {
        "main": _file_identity(replaced),
        "wal": _file_identity(replaced_wal),
    } == replaced_before

    wrong_schema = database_path.parent / "wrong-schema-film-core.sqlite"
    with sqlite3.connect(wrong_schema) as connection:
        connection.execute(
            "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
        )
        connection.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES(6, '2026-09-04T00:00:00Z')"
        )
    wrong_schema_wal = Path(f"{wrong_schema}-wal")
    wrong_schema_wal.touch(mode=0o600)
    wrong_schema_identity = {
        "path": str(wrong_schema),
        **_file_identity(wrong_schema),
        "wal": _file_identity(wrong_schema_wal),
    }
    wrong_schema_before = {
        "main": _file_identity(wrong_schema),
        "wal": _file_identity(wrong_schema_wal),
    }
    with pytest.raises(ValueError, match="FILM_CORE_READ_ONLY_SCHEMA_MISMATCH"):
        SQLiteDatabase(
            wrong_schema,
            read_only=True,
            expected_identity=wrong_schema_identity,
        )
    monkeypatch.setenv("FILMOS_CORE_DB_PATH", str(wrong_schema))
    with pytest.raises(ValueError, match="FILM_CORE_READ_ONLY_SCHEMA_MISMATCH"):
        launcher.build_app(
            external_read_test_only={
                **external_configuration,
                "database_path": str(wrong_schema),
                "database_identity": wrong_schema_identity,
            }
        )
    assert {
        "main": _file_identity(wrong_schema),
        "wal": _file_identity(wrong_schema_wal),
    } == wrong_schema_before

    monkeypatch.setenv("FILMOS_CORE_DB_PATH", str(missing))
    with pytest.raises(RuntimeError, match="FILM_CORE_READ_ONLY_DATABASE_REQUIRED"):
        launcher.build_app(external_read_test_only=external_configuration)


def _file_identity(path: Path) -> dict[str, int | str]:
    metadata = path.stat()
    return {
        "device": metadata.st_dev,
        "inode": metadata.st_ino,
        "size": metadata.st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }
