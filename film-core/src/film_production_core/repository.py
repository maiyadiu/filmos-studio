from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping
from typing import Any

from film_production_core.database import SQLiteDatabase
from film_production_core.errors import (
    EntityNotFound,
    HostMappingConflict,
    VersionConflict,
)
from film_production_core.models import EntityType


ENTITY_COLUMNS = """
film_entity_id, entity_type, version, content_hash,
host_project_id, host_unit_id, host_shot_id, host_asset_id,
host_asset_version_id, host_canvas_id, host_resource_id,
creative_stage, execution_state, review_state, lock_state,
delivery_state, stale_state, unit_kind, director_unit_ids_json,
created_at, updated_at
"""

AUDIT_COLUMNS = """
event_id, actor_kind, action, target_id, previous_version,
resulting_version, command_type, command_payload_json, recorded_at
"""


class FilmRepository:
    def __init__(self, database: SQLiteDatabase) -> None:
        self.database = database

    def health(self) -> tuple[int, str]:
        return self.database.health()

    def entity(self, film_entity_id: str) -> sqlite3.Row:
        with self.database.connect() as connection:
            row = connection.execute(
                f"SELECT {ENTITY_COLUMNS} FROM film_entities WHERE film_entity_id = ?",
                (film_entity_id,),
            ).fetchone()
        if row is None:
            raise EntityNotFound(film_entity_id)
        return row

    def entity_by_host(self, entity_type: EntityType | str, host_id: str) -> sqlite3.Row | None:
        entity_type_value = str(getattr(entity_type, "value", entity_type))
        column = {
            EntityType.FILM_PROJECT_EXTENSION.value: "host_project_id",
            EntityType.CONTENT_UNIT_EXTENSION.value: "host_unit_id",
            EntityType.SHOT_EXTENSION.value: "host_shot_id",
        }[entity_type_value]
        with self.database.connect() as connection:
            return connection.execute(
                f"SELECT {ENTITY_COLUMNS} FROM film_entities "
                f"WHERE entity_type = ? AND {column} = ?",
                (entity_type_value, host_id),
            ).fetchone()

    def project_context_rows(
        self, host_project_id: str
    ) -> tuple[sqlite3.Row | None, list[sqlite3.Row], list[sqlite3.Row], int]:
        with self.database.connect() as connection:
            rows = connection.execute(
                f"SELECT {ENTITY_COLUMNS} FROM film_entities "
                "WHERE host_project_id = ? ORDER BY entity_type, created_at, film_entity_id",
                (host_project_id,),
            ).fetchall()
            audit_row = connection.execute(
                "SELECT COUNT(*) AS count FROM audit_events "
                "WHERE target_id IN ("
                "SELECT film_entity_id FROM film_entities WHERE host_project_id = ?"
                ")",
                (host_project_id,),
            ).fetchone()
        project = next(
            (
                row
                for row in rows
                if row["entity_type"] == EntityType.FILM_PROJECT_EXTENSION.value
            ),
            None,
        )
        units = [
            row
            for row in rows
            if row["entity_type"] == EntityType.CONTENT_UNIT_EXTENSION.value
        ]
        shots = [
            row
            for row in rows
            if row["entity_type"] == EntityType.SHOT_EXTENSION.value
        ]
        return project, units, shots, int(audit_row["count"])

    def create_entity_with_audit(
        self,
        entity: Mapping[str, Any],
        audit: Mapping[str, Any],
    ) -> tuple[sqlite3.Row, sqlite3.Row]:
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                existing = self._mapping_row(connection, entity)
                if existing is not None:
                    raise HostMappingConflict(
                        existing["film_entity_id"], int(existing["version"])
                    )
                connection.execute(
                    """
                    INSERT INTO film_entities(
                        film_entity_id, entity_type, version, content_hash,
                        host_project_id, host_unit_id, host_shot_id, host_asset_id,
                        host_asset_version_id, host_canvas_id, host_resource_id,
                        creative_stage, execution_state, review_state, lock_state,
                        delivery_state, stale_state, unit_kind,
                        director_unit_ids_json, created_at, updated_at
                    ) VALUES (
                        :film_entity_id, :entity_type, :version, :content_hash,
                        :host_project_id, :host_unit_id, :host_shot_id, :host_asset_id,
                        :host_asset_version_id, :host_canvas_id, :host_resource_id,
                        :creative_stage, :execution_state, :review_state, :lock_state,
                        :delivery_state, :stale_state, :unit_kind,
                        :director_unit_ids_json, :created_at, :updated_at
                    )
                    """,
                    entity,
                )
                self._insert_audit(connection, audit)
                entity_row = connection.execute(
                    f"SELECT {ENTITY_COLUMNS} FROM film_entities WHERE film_entity_id = ?",
                    (entity["film_entity_id"],),
                ).fetchone()
                audit_row = connection.execute(
                    f"SELECT {AUDIT_COLUMNS} FROM audit_events WHERE event_id = ?",
                    (audit["event_id"],),
                ).fetchone()
                connection.execute("COMMIT")
                return entity_row, audit_row
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def update_states_with_audit(
        self,
        film_entity_id: str,
        expected_version: int,
        states: Mapping[str, str],
        content_hash: str,
        updated_at: str,
        audit: Mapping[str, Any],
    ) -> tuple[sqlite3.Row, sqlite3.Row]:
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                current = connection.execute(
                    f"SELECT {ENTITY_COLUMNS} FROM film_entities WHERE film_entity_id = ?",
                    (film_entity_id,),
                ).fetchone()
                if current is None:
                    raise EntityNotFound(film_entity_id)
                current_version = int(current["version"])
                if current_version != expected_version:
                    raise VersionConflict(
                        film_entity_id, expected_version, current_version
                    )
                resulting_version = expected_version + 1
                result = connection.execute(
                    """
                    UPDATE film_entities SET
                        version = ?, content_hash = ?, creative_stage = ?,
                        execution_state = ?, review_state = ?, lock_state = ?,
                        delivery_state = ?, stale_state = ?, updated_at = ?
                    WHERE film_entity_id = ? AND version = ?
                    """,
                    (
                        resulting_version,
                        content_hash,
                        states["creative_stage"],
                        states["execution_state"],
                        states["review_state"],
                        states["lock_state"],
                        states["delivery_state"],
                        states["stale_state"],
                        updated_at,
                        film_entity_id,
                        expected_version,
                    ),
                )
                if result.rowcount != 1:
                    latest = connection.execute(
                        "SELECT version FROM film_entities WHERE film_entity_id = ?",
                        (film_entity_id,),
                    ).fetchone()
                    if latest is None:
                        raise EntityNotFound(film_entity_id)
                    raise VersionConflict(
                        film_entity_id, expected_version, int(latest["version"])
                    )
                self._insert_audit(connection, audit)
                entity_row = connection.execute(
                    f"SELECT {ENTITY_COLUMNS} FROM film_entities WHERE film_entity_id = ?",
                    (film_entity_id,),
                ).fetchone()
                audit_row = connection.execute(
                    f"SELECT {AUDIT_COLUMNS} FROM audit_events WHERE event_id = ?",
                    (audit["event_id"],),
                ).fetchone()
                connection.execute("COMMIT")
                return entity_row, audit_row
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def audit_events(
        self, target_id: str | None = None, limit: int = 100
    ) -> list[sqlite3.Row]:
        limit = max(1, min(limit, 500))
        with self.database.connect() as connection:
            if target_id is None:
                return connection.execute(
                    f"SELECT {AUDIT_COLUMNS} FROM audit_events "
                    "ORDER BY recorded_at, event_id LIMIT ?",
                    (limit,),
                ).fetchall()
            return connection.execute(
                f"SELECT {AUDIT_COLUMNS} FROM audit_events WHERE target_id = ? "
                "ORDER BY recorded_at, event_id LIMIT ?",
                (target_id, limit),
            ).fetchall()

    def counts(self) -> tuple[int, int]:
        with self.database.connect() as connection:
            entity_count = connection.execute(
                "SELECT COUNT(*) AS count FROM film_entities"
            ).fetchone()["count"]
            audit_count = connection.execute(
                "SELECT COUNT(*) AS count FROM audit_events"
            ).fetchone()["count"]
        return int(entity_count), int(audit_count)

    def _mapping_row(
        self, connection: sqlite3.Connection, entity: Mapping[str, Any]
    ) -> sqlite3.Row | None:
        entity_type = entity["entity_type"]
        column = {
            EntityType.FILM_PROJECT_EXTENSION.value: "host_project_id",
            EntityType.CONTENT_UNIT_EXTENSION.value: "host_unit_id",
            EntityType.SHOT_EXTENSION.value: "host_shot_id",
        }[entity_type]
        return connection.execute(
            f"SELECT film_entity_id, version FROM film_entities "
            f"WHERE entity_type = ? AND {column} = ?",
            (entity_type, entity[column]),
        ).fetchone()

    @staticmethod
    def _insert_audit(
        connection: sqlite3.Connection, audit: Mapping[str, Any]
    ) -> None:
        connection.execute(
            """
            INSERT INTO audit_events(
                event_id, actor_kind, action, target_id, previous_version,
                resulting_version, command_type, command_payload_json, recorded_at
            ) VALUES (
                :event_id, :actor_kind, :action, :target_id, :previous_version,
                :resulting_version, :command_type, :command_payload_json, :recorded_at
            )
            """,
            audit,
        )


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
