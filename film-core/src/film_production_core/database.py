from __future__ import annotations

import sqlite3
from pathlib import Path


SCHEMA_VERSION = 2

MIGRATION_001 = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS film_entities (
    film_entity_id TEXT PRIMARY KEY CHECK (
        length(film_entity_id) = 36
        AND film_entity_id = lower(film_entity_id)
        AND substr(film_entity_id, 9, 1) = '-'
        AND substr(film_entity_id, 14, 1) = '-'
        AND substr(film_entity_id, 15, 1) = '4'
        AND substr(film_entity_id, 19, 1) = '-'
        AND substr(film_entity_id, 20, 1) IN ('8', '9', 'a', 'b')
        AND substr(film_entity_id, 24, 1) = '-'
    ),
    entity_type TEXT NOT NULL CHECK (
        entity_type IN (
            'film_project_extension',
            'content_unit_extension',
            'shot_extension'
        )
    ),
    version INTEGER NOT NULL CHECK (version >= 1),
    content_hash TEXT NOT NULL CHECK (
        length(content_hash) = 64
        AND content_hash = lower(content_hash)
        AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
    host_project_id TEXT,
    host_unit_id TEXT,
    host_shot_id TEXT,
    host_asset_id TEXT,
    host_asset_version_id TEXT,
    host_canvas_id TEXT,
    host_resource_id TEXT,
    creative_stage TEXT NOT NULL CHECK (
        creative_stage IN ('draft', 'authored', 'reviewed', 'locked')
    ),
    execution_state TEXT NOT NULL CHECK (
        execution_state IN (
            'not_started', 'ready', 'queued', 'running',
            'succeeded', 'failed', 'cancelled'
        )
    ),
    review_state TEXT NOT NULL CHECK (
        review_state IN (
            'not_reviewed', 'pending', 'in_review', 'changes_requested',
            'rejected', 'passed', 'approved'
        )
    ),
    lock_state TEXT NOT NULL CHECK (
        lock_state IN ('unlocked', 'soft_locked', 'locked')
    ),
    delivery_state TEXT NOT NULL CHECK (
        delivery_state IN ('not_ready', 'ready', 'packaged', 'delivered', 'superseded')
    ),
    stale_state TEXT NOT NULL CHECK (
        stale_state IN ('fresh', 'stale', 'blocked')
    ),
    unit_kind TEXT CHECK (
        unit_kind IS NULL OR unit_kind IN (
            'chapter', 'episode', 'special', 'trailer', 'extra',
            'film', 'season', 'arc', 'volume'
        )
    ),
    director_unit_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (entity_type = 'film_project_extension' AND host_project_id IS NOT NULL)
        OR
        (entity_type = 'content_unit_extension' AND host_project_id IS NOT NULL AND host_unit_id IS NOT NULL AND unit_kind IS NOT NULL)
        OR
        (entity_type = 'shot_extension' AND host_project_id IS NOT NULL AND host_shot_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_film_project_host_mapping
ON film_entities(host_project_id)
WHERE entity_type = 'film_project_extension';

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_unit_host_mapping
ON film_entities(host_unit_id)
WHERE entity_type = 'content_unit_extension';

CREATE UNIQUE INDEX IF NOT EXISTS idx_shot_host_mapping
ON film_entities(host_shot_id)
WHERE entity_type = 'shot_extension';

CREATE INDEX IF NOT EXISTS idx_film_entities_host_project
ON film_entities(host_project_id, entity_type);

CREATE TABLE IF NOT EXISTS audit_events (
    event_id TEXT PRIMARY KEY CHECK (
        length(event_id) = 36
        AND event_id = lower(event_id)
        AND substr(event_id, 9, 1) = '-'
        AND substr(event_id, 14, 1) = '-'
        AND substr(event_id, 15, 1) = '4'
        AND substr(event_id, 19, 1) = '-'
        AND substr(event_id, 20, 1) IN ('8', '9', 'a', 'b')
        AND substr(event_id, 24, 1) = '-'
    ),
    actor_kind TEXT NOT NULL CHECK (
        actor_kind IN ('human', 'codex', 'deepseek', 'claude', 'local_model', 'system')
    ),
    action TEXT NOT NULL,
    target_id TEXT NOT NULL,
    previous_version INTEGER,
    resulting_version INTEGER NOT NULL CHECK (resulting_version >= 1),
    command_type TEXT NOT NULL,
    command_payload_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY(target_id) REFERENCES film_entities(film_entity_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_audit_events_target_recorded
ON audit_events(target_id, recorded_at, event_id);

CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'audit_events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'audit_events are append-only');
END;

"""

MIGRATION_002 = """
CREATE TABLE IF NOT EXISTS formal_records (
    film_entity_id TEXT PRIMARY KEY CHECK (
        length(film_entity_id) = 36
        AND film_entity_id = lower(film_entity_id)
        AND substr(film_entity_id, 9, 1) = '-'
        AND substr(film_entity_id, 14, 1) = '-'
        AND substr(film_entity_id, 15, 1) = '4'
        AND substr(film_entity_id, 19, 1) = '-'
        AND substr(film_entity_id, 20, 1) IN ('8', '9', 'a', 'b')
        AND substr(film_entity_id, 24, 1) = '-'
    ),
    entity_type TEXT NOT NULL CHECK (
        entity_type IN (
            'script_version', 'script_decision', 'director_unit', 'coverage_link',
            'visual_lock_set', 'asset_binding',
            'prompt_draft', 'prompt_draft_provenance',
            'generation_package', 'generation_attempt_evidence',
            'candidate', 'review', 'approval', 'continuity_check_result'
        )
    ),
    version INTEGER NOT NULL CHECK (version >= 1),
    content_hash TEXT NOT NULL CHECK (
        length(content_hash) = 64
        AND content_hash = lower(content_hash)
        AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_formal_records_type_created
ON formal_records(entity_type, created_at, film_entity_id);

CREATE TABLE IF NOT EXISTS formal_audit_events (
    event_id TEXT PRIMARY KEY CHECK (
        length(event_id) = 36
        AND event_id = lower(event_id)
        AND substr(event_id, 9, 1) = '-'
        AND substr(event_id, 14, 1) = '-'
        AND substr(event_id, 15, 1) = '4'
        AND substr(event_id, 19, 1) = '-'
        AND substr(event_id, 20, 1) IN ('8', '9', 'a', 'b')
        AND substr(event_id, 24, 1) = '-'
    ),
    actor_kind TEXT NOT NULL CHECK (
        actor_kind IN ('human', 'codex', 'deepseek', 'claude', 'local_model', 'system')
    ),
    action TEXT NOT NULL,
    target_id TEXT NOT NULL,
    previous_version INTEGER,
    resulting_version INTEGER NOT NULL CHECK (resulting_version >= 1),
    command_type TEXT NOT NULL,
    command_payload_json TEXT NOT NULL CHECK (json_valid(command_payload_json)),
    recorded_at TEXT NOT NULL,
    FOREIGN KEY(target_id) REFERENCES formal_records(film_entity_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_formal_audit_target_recorded
ON formal_audit_events(target_id, recorded_at, event_id);

CREATE TRIGGER IF NOT EXISTS formal_audit_events_no_update
BEFORE UPDATE ON formal_audit_events
BEGIN
    SELECT RAISE(ABORT, 'formal_audit_events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS formal_audit_events_no_delete
BEFORE DELETE ON formal_audit_events
BEGIN
    SELECT RAISE(ABORT, 'formal_audit_events are append-only');
END;
"""

MIGRATIONS = ((1, MIGRATION_001), (2, MIGRATION_002))


class SQLiteDatabase:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.migrate()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.path,
            timeout=5.0,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def migrate(self) -> None:
        with self.connect() as connection:
            for version, migration in MIGRATIONS:
                connection.executescript(migration)
                connection.execute(
                    "INSERT OR IGNORE INTO schema_migrations(version, applied_at) "
                    "VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                    (version,),
                )

    def health(self) -> tuple[int, str]:
        with self.connect() as connection:
            connection.execute("SELECT 1").fetchone()
            row = connection.execute(
                "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations"
            ).fetchone()
            journal_row = connection.execute("PRAGMA journal_mode").fetchone()
        return int(row["version"]), str(journal_row[0]).lower()
