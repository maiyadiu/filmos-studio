from __future__ import annotations

import hashlib
import json
import sqlite3
from collections import defaultdict
from collections.abc import Mapping, Sequence
from typing import Any
from uuid import uuid4

from film_production_core.database import SQLiteDatabase
from film_production_core.errors import (
    ContentHashConflict,
    DomainRuleViolation,
    EntityNotFound,
    VersionConflict,
)
from film_production_core.repository import (
    ENTITY_COLUMNS,
    FORMAL_COLUMNS,
    canonical_json,
)


STRUCTURE_COLUMNS = """
film_entity_id, entity_type, version, content_hash,
script_version_id, script_version_version, script_version_content_hash,
payload_json, created_at, updated_at
"""

IMPACT_COLUMNS = """
film_entity_id, entity_type, version, content_hash,
dependency_owner_id, dependency_owner_version, dependency_owner_content_hash,
source_id, source_version, source_content_hash,
target_id, target_version, target_content_hash,
dependency_key, dependency_content_hash, scope_json, relation, propagates_stale,
payload_json, created_at, updated_at
"""

MAX_IMPACT_NODES = 1000
MAX_IMPACT_DEPTH = 64


class ImpactRepository:
    def __init__(self, database: SQLiteDatabase) -> None:
        self.database = database

    def script_structure_map(self, film_entity_id: str) -> sqlite3.Row:
        with self.database.connect() as connection:
            row = connection.execute(
                f"SELECT {STRUCTURE_COLUMNS} FROM script_structure_maps "
                "WHERE film_entity_id = ?",
                (film_entity_id,),
            ).fetchone()
        if row is None:
            raise EntityNotFound(film_entity_id)
        return row

    def impact_edge(self, film_entity_id: str) -> sqlite3.Row:
        with self.database.connect() as connection:
            row = connection.execute(
                f"SELECT {IMPACT_COLUMNS} FROM impact_edges WHERE film_entity_id = ?",
                (film_entity_id,),
            ).fetchone()
        if row is None:
            raise EntityNotFound(film_entity_id)
        return row

    def impact_edges_for_entity(
        self, film_entity_id: str
    ) -> tuple[list[sqlite3.Row], list[sqlite3.Row]]:
        with self.database.connect() as connection:
            incoming = connection.execute(
                f"SELECT {IMPACT_COLUMNS} FROM impact_edges WHERE target_id = ? "
                "ORDER BY created_at, film_entity_id",
                (film_entity_id,),
            ).fetchall()
            outgoing = connection.execute(
                f"SELECT {IMPACT_COLUMNS} FROM impact_edges WHERE source_id = ? "
                "ORDER BY created_at, film_entity_id",
                (film_entity_id,),
            ).fetchall()
        return list(incoming), list(outgoing)

    def current_row(self, film_entity_id: str) -> tuple[str, sqlite3.Row]:
        with self.database.connect() as connection:
            return self._current_row(connection, film_entity_id)

    def propagation_replay(
        self, idempotency_key: str, request_hash: str
    ) -> dict[str, Any] | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT request_hash, response_json FROM impact_propagations "
                "WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
        if row is None:
            return None
        if row["request_hash"] != request_hash:
            raise DomainRuleViolation(
                "idempotency_conflict",
                "The idempotency key is already bound to another request",
            )
        result = json.loads(row["response_json"])
        result["replayed"] = True
        return result

    def create_script_structure_map(
        self,
        record: Mapping[str, Any],
        audit: Mapping[str, Any],
        script_guard: Mapping[str, Any],
    ) -> sqlite3.Row:
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                kind, current = self._require_current(connection, script_guard)
                if kind != "formal" or current["entity_type"] != "script_version":
                    raise DomainRuleViolation(
                        "script_version_required",
                        "ScriptStructureMap requires a current ScriptVersion",
                    )
                connection.execute(
                    """
                    INSERT INTO script_structure_maps(
                        film_entity_id, entity_type, version, content_hash,
                        script_version_id, script_version_version,
                        script_version_content_hash, payload_json,
                        created_at, updated_at
                    ) VALUES (
                        :film_entity_id, :entity_type, :version, :content_hash,
                        :script_version_id, :script_version_version,
                        :script_version_content_hash, :payload_json,
                        :created_at, :updated_at
                    )
                    """,
                    record,
                )
                self._insert_impact_audit(connection, audit)
                row = connection.execute(
                    f"SELECT {STRUCTURE_COLUMNS} FROM script_structure_maps "
                    "WHERE film_entity_id = ?",
                    (record["film_entity_id"],),
                ).fetchone()
                connection.execute("COMMIT")
                return row
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def create_impact_edge(
        self,
        record: Mapping[str, Any],
        audit: Mapping[str, Any],
        guards: Sequence[Mapping[str, Any]],
        structure_guard: Mapping[str, Any] | None,
    ) -> sqlite3.Row:
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                for guard in guards:
                    self._require_current(connection, guard)
                if structure_guard is not None:
                    self._require_structure_current(connection, structure_guard)

                selector_rows = connection.execute(
                    f"SELECT {IMPACT_COLUMNS} FROM impact_edges "
                    "WHERE dependency_owner_id = ? AND dependency_key = ? "
                    "AND scope_json = ? ORDER BY created_at, film_entity_id",
                    (
                        record["dependency_owner_id"],
                        record["dependency_key"],
                        record["scope_json"],
                    ),
                ).fetchall()
                graph = [
                    (row["film_entity_id"], row["source_id"], row["target_id"])
                    for row in selector_rows
                ]
                owner_id = str(record["dependency_owner_id"])
                source_id = str(record["source_id"])
                if source_id != owner_id:
                    reachable, _ = walk_impact_graph(graph, owner_id)
                    if source_id not in reachable:
                        raise DomainRuleViolation(
                            "impact_source_not_anchored",
                            "ImpactEdge source must already be reachable from its dependency owner",
                        )
                graph.append(
                    (
                        str(record["film_entity_id"]),
                        source_id,
                        str(record["target_id"]),
                    )
                )
                walk_impact_graph(graph, owner_id)

                try:
                    connection.execute(
                        """
                        INSERT INTO impact_edges(
                            film_entity_id, entity_type, version, content_hash,
                            dependency_owner_id, dependency_owner_version,
                            dependency_owner_content_hash,
                            source_id, source_version, source_content_hash,
                            target_id, target_version, target_content_hash,
                            dependency_key, dependency_content_hash, scope_json, relation,
                            propagates_stale, payload_json, created_at, updated_at
                        ) VALUES (
                            :film_entity_id, :entity_type, :version, :content_hash,
                            :dependency_owner_id, :dependency_owner_version,
                            :dependency_owner_content_hash,
                            :source_id, :source_version, :source_content_hash,
                            :target_id, :target_version, :target_content_hash,
                            :dependency_key, :dependency_content_hash, :scope_json, :relation,
                            :propagates_stale, :payload_json, :created_at, :updated_at
                        )
                        """,
                        record,
                    )
                except sqlite3.IntegrityError as error:
                    if "UNIQUE constraint failed" in str(error):
                        raise DomainRuleViolation(
                            "impact_edge_exists",
                            "The exact ImpactEdge declaration already exists",
                        ) from error
                    raise
                self._insert_impact_audit(connection, audit)
                row = connection.execute(
                    f"SELECT {IMPACT_COLUMNS} FROM impact_edges WHERE film_entity_id = ?",
                    (record["film_entity_id"],),
                ).fetchone()
                connection.execute("COMMIT")
                return row
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def propagate_stale(
        self,
        *,
        idempotency_key: str,
        request_hash: str,
        actor_kind: str,
        owner_guard: Mapping[str, Any],
        structure_guard: Mapping[str, Any] | None,
        changes: Sequence[Mapping[str, Any]],
        command_payload_json: str,
        recorded_at: str,
    ) -> dict[str, Any]:
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                replay = connection.execute(
                    "SELECT request_hash, response_json FROM impact_propagations "
                    "WHERE idempotency_key = ?",
                    (idempotency_key,),
                ).fetchone()
                if replay is not None:
                    if replay["request_hash"] != request_hash:
                        raise DomainRuleViolation(
                            "idempotency_conflict",
                            "The idempotency key is already bound to another request",
                        )
                    result = json.loads(replay["response_json"])
                    result["replayed"] = True
                    connection.execute("COMMIT")
                    return result

                _, owner = self._require_current(connection, owner_guard)
                if structure_guard is not None:
                    self._require_structure_current(connection, structure_guard)

                owner_id = str(owner_guard["film_entity_id"])
                traversed_edge_ids: list[str] = []
                descendant_ids: list[str] = []
                seen_descendants: set[str] = set()
                unresolved_changes: list[dict[str, Any]] = []
                for change in changes:
                    rows = connection.execute(
                        f"SELECT {IMPACT_COLUMNS} FROM impact_edges "
                        "WHERE dependency_owner_id = ? AND dependency_key = ? "
                        "AND scope_json = ? AND propagates_stale = 1 "
                        "ORDER BY created_at, film_entity_id",
                        (owner_id, change["dependency_key"], change["scope_json"]),
                    ).fetchall()
                    graph = [
                        (row["film_entity_id"], row["source_id"], row["target_id"])
                        for row in rows
                    ]
                    reachable, edge_ids = walk_impact_graph(graph, owner_id)
                    if not edge_ids:
                        unresolved_changes.append(
                            {
                                "dependency_key": change["dependency_key"],
                                "scope": json.loads(change["scope_json"]),
                                "previous_dependency_hash": change[
                                    "previous_dependency_hash"
                                ],
                                "current_dependency_hash": change[
                                    "current_dependency_hash"
                                ],
                            }
                        )
                    for edge_id in edge_ids:
                        if edge_id not in traversed_edge_ids:
                            traversed_edge_ids.append(edge_id)
                    for entity_id in reachable:
                        if entity_id == owner_id or entity_id in seen_descendants:
                            continue
                        seen_descendants.add(entity_id)
                        descendant_ids.append(entity_id)

                stale_entity_ids: list[str] = []
                already_stale_entity_ids: list[str] = []
                unchanged_entity_ids: list[str] = []
                audit_event_ids: list[str] = []
                for entity_id in descendant_ids:
                    kind, row = self._current_row(connection, entity_id)
                    update = self._stale_update(connection, kind, row, recorded_at)
                    if update is None:
                        unchanged_entity_ids.append(entity_id)
                        continue
                    if update == "already_stale":
                        already_stale_entity_ids.append(entity_id)
                        continue
                    previous_version, resulting_version = update
                    event_id = str(uuid4())
                    self._insert_impact_audit(
                        connection,
                        {
                            "event_id": event_id,
                            "actor_kind": actor_kind,
                            "action": "entity.stale_marked",
                            "target_id": entity_id,
                            "previous_version": previous_version,
                            "resulting_version": resulting_version,
                            "command_type": "impact.propagate_stale",
                            "command_payload_json": command_payload_json,
                            "recorded_at": recorded_at,
                        },
                    )
                    stale_entity_ids.append(entity_id)
                    audit_event_ids.append(event_id)

                owner_event_id = str(uuid4())
                self._insert_impact_audit(
                    connection,
                    {
                        "event_id": owner_event_id,
                        "actor_kind": actor_kind,
                        "action": "impact.propagated",
                        "target_id": owner_id,
                        "previous_version": int(owner["version"]),
                        "resulting_version": int(owner["version"]),
                        "command_type": "impact.propagate_stale",
                        "command_payload_json": command_payload_json,
                        "recorded_at": recorded_at,
                    },
                )
                audit_event_ids.append(owner_event_id)
                result = {
                    "idempotency_key": idempotency_key,
                    "replayed": False,
                    "dependency_owner_id": owner_id,
                    "stale_entity_ids": stale_entity_ids,
                    "already_stale_entity_ids": already_stale_entity_ids,
                    "unchanged_entity_ids": unchanged_entity_ids,
                    "unresolved_changes": unresolved_changes,
                    "traversed_edge_ids": traversed_edge_ids,
                    "audit_event_ids": audit_event_ids,
                }
                connection.execute(
                    "INSERT INTO impact_propagations("
                    "idempotency_key, request_hash, response_json, created_at"
                    ") VALUES (?, ?, ?, ?)",
                    (
                        idempotency_key,
                        request_hash,
                        canonical_json(result),
                        recorded_at,
                    ),
                )
                connection.execute("COMMIT")
                return result
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def counts(self) -> tuple[int, int, int, int]:
        with self.database.connect() as connection:
            return tuple(
                int(
                    connection.execute(
                        f"SELECT COUNT(*) AS count FROM {table}"
                    ).fetchone()["count"]
                )
                for table in (
                    "script_structure_maps",
                    "impact_edges",
                    "impact_propagations",
                    "impact_audit_events",
                )
            )

    @staticmethod
    def _current_row(
        connection: sqlite3.Connection, film_entity_id: str
    ) -> tuple[str, sqlite3.Row]:
        row = connection.execute(
            f"SELECT {FORMAL_COLUMNS} FROM formal_records WHERE film_entity_id = ?",
            (film_entity_id,),
        ).fetchone()
        if row is not None:
            return "formal", row
        row = connection.execute(
            f"SELECT {ENTITY_COLUMNS} FROM film_entities WHERE film_entity_id = ?",
            (film_entity_id,),
        ).fetchone()
        if row is not None:
            return "legacy", row
        raise EntityNotFound(film_entity_id)

    @classmethod
    def _require_current(
        cls, connection: sqlite3.Connection, guard: Mapping[str, Any]
    ) -> tuple[str, sqlite3.Row]:
        kind, row = cls._current_row(connection, str(guard["film_entity_id"]))
        expected_version = int(guard["expected_version"])
        if int(row["version"]) != expected_version:
            raise VersionConflict(
                str(guard["film_entity_id"]), expected_version, int(row["version"])
            )
        expected_hash = str(guard["expected_content_hash"])
        if row["content_hash"] != expected_hash:
            raise ContentHashConflict(
                str(guard["film_entity_id"]), expected_hash, row["content_hash"]
            )
        return kind, row

    @staticmethod
    def _require_structure_current(
        connection: sqlite3.Connection, guard: Mapping[str, Any]
    ) -> sqlite3.Row:
        row = connection.execute(
            f"SELECT {STRUCTURE_COLUMNS} FROM script_structure_maps "
            "WHERE film_entity_id = ?",
            (str(guard["film_entity_id"]),),
        ).fetchone()
        if row is None:
            raise EntityNotFound(str(guard["film_entity_id"]))
        expected_version = int(guard["expected_version"])
        if int(row["version"]) != expected_version:
            raise VersionConflict(
                str(guard["film_entity_id"]), expected_version, int(row["version"])
            )
        expected_hash = str(guard["expected_content_hash"])
        if row["content_hash"] != expected_hash:
            raise ContentHashConflict(
                str(guard["film_entity_id"]), expected_hash, row["content_hash"]
            )
        return row

    @staticmethod
    def _stale_update(
        connection: sqlite3.Connection,
        kind: str,
        row: sqlite3.Row,
        recorded_at: str,
    ) -> tuple[int, int] | str | None:
        previous_version = int(row["version"])
        resulting_version = previous_version + 1
        if kind == "formal":
            payload = json.loads(row["payload_json"])
            states = payload.get("states")
            if not isinstance(states, dict):
                return None
            if states.get("stale_state") == "stale":
                return "already_stale"
            if states.get("stale_state") != "fresh":
                return None
            states = dict(states)
            states["stale_state"] = "stale"
            payload["states"] = states
            payload_json = canonical_json(payload)
            content_hash = hashlib.sha256(payload_json.encode("utf-8")).hexdigest()
            updated = connection.execute(
                """
                UPDATE formal_records
                SET version = ?, content_hash = ?, payload_json = ?, updated_at = ?
                WHERE film_entity_id = ? AND version = ?
                """,
                (
                    resulting_version,
                    content_hash,
                    payload_json,
                    recorded_at,
                    row["film_entity_id"],
                    previous_version,
                ),
            )
            if updated.rowcount != 1:
                raise VersionConflict(
                    row["film_entity_id"], previous_version, previous_version
                )
            return previous_version, resulting_version

        stale_state = str(row["stale_state"])
        if stale_state == "stale":
            return "already_stale"
        if stale_state != "fresh":
            return None
        states = {
            "creative_stage": row["creative_stage"],
            "execution_state": row["execution_state"],
            "review_state": row["review_state"],
            "lock_state": row["lock_state"],
            "delivery_state": row["delivery_state"],
            "stale_state": "stale",
        }
        host = {
            key: row[key]
            for key in (
                "host_project_id",
                "host_unit_id",
                "host_shot_id",
                "host_asset_id",
                "host_asset_version_id",
                "host_canvas_id",
                "host_resource_id",
            )
            if row[key] is not None
        }
        body: dict[str, Any] = {
            "entity_type": row["entity_type"],
            "host": host,
            "states": states,
        }
        if row["entity_type"] == "content_unit_extension":
            body["unit_kind"] = row["unit_kind"]
        if row["entity_type"] == "shot_extension":
            body["director_unit_ids"] = json.loads(row["director_unit_ids_json"])
        content_hash = hashlib.sha256(
            canonical_json(body).encode("utf-8")
        ).hexdigest()
        updated = connection.execute(
            """
            UPDATE film_entities
            SET version = ?, content_hash = ?, stale_state = ?, updated_at = ?
            WHERE film_entity_id = ? AND version = ?
            """,
            (
                resulting_version,
                content_hash,
                "stale",
                recorded_at,
                row["film_entity_id"],
                previous_version,
            ),
        )
        if updated.rowcount != 1:
            raise VersionConflict(
                row["film_entity_id"], previous_version, previous_version
            )
        return previous_version, resulting_version

    @staticmethod
    def _insert_impact_audit(
        connection: sqlite3.Connection, audit: Mapping[str, Any]
    ) -> None:
        connection.execute(
            """
            INSERT INTO impact_audit_events(
                event_id, actor_kind, action, target_id, previous_version,
                resulting_version, command_type, command_payload_json, recorded_at
            ) VALUES (
                :event_id, :actor_kind, :action, :target_id, :previous_version,
                :resulting_version, :command_type, :command_payload_json, :recorded_at
            )
            """,
            audit,
        )


def walk_impact_graph(
    edges: Sequence[tuple[str, str, str]],
    root_id: str,
    *,
    max_nodes: int = MAX_IMPACT_NODES,
    max_depth: int = MAX_IMPACT_DEPTH,
) -> tuple[list[str], list[str]]:
    adjacency: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for edge_id, source_id, target_id in edges:
        adjacency[source_id].append((edge_id, target_id))
    for values in adjacency.values():
        values.sort()

    visiting: set[str] = set()
    visited: set[str] = set()
    nodes: list[str] = []
    edge_ids: list[str] = []

    def visit(node_id: str, depth: int) -> None:
        if depth > max_depth:
            raise DomainRuleViolation(
                "impact_graph_depth_exceeded",
                f"Impact traversal exceeds the {max_depth}-edge depth limit",
            )
        if node_id in visiting:
            raise DomainRuleViolation(
                "impact_graph_cycle", "Impact graph must be acyclic"
            )
        if node_id in visited:
            return
        if len(visited) + len(visiting) >= max_nodes:
            raise DomainRuleViolation(
                "impact_graph_node_limit_exceeded",
                f"Impact traversal exceeds the {max_nodes}-node limit",
            )
        visiting.add(node_id)
        nodes.append(node_id)
        for edge_id, target_id in adjacency.get(node_id, []):
            edge_ids.append(edge_id)
            visit(target_id, depth + 1)
        visiting.remove(node_id)
        visited.add(node_id)

    visit(root_id, 0)
    return nodes, edge_ids
