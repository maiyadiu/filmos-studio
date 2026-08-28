from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from frozen_upstream import (  # type: ignore
    LOCAL_CANDIDATE_REF,
    LOCAL_STABLE_REF,
    load_frozen_contract,
)


FROZEN_UPSTREAM = load_frozen_contract()
STABLE_REF = FROZEN_UPSTREAM["stable"]["source_ref"]
STABLE_COMMIT = FROZEN_UPSTREAM["stable"]["commit"]
CANDIDATE_REF = FROZEN_UPSTREAM["candidate"]["source_ref"]
CANDIDATE_COMMIT = FROZEN_UPSTREAM["candidate"]["commit"]
SANDBOX_MARKER = ".filmos-rc-candidate-sandbox"
FIXTURE_MARKER = "filmos-rc-candidate-schema-fixture"
APPLICATION_ID = 0x46524336

MODEL_PATHS = (
    "backend/internal/model/models_channel.go",
    "backend/internal/model/models_platform.go",
    "backend/internal/model/models_plugin.go",
)
MIGRATION_PATHS = (
    "backend/internal/database/schema.go",
    "backend/cmd/migrate-sqlite-postgres/main.go",
)
EXPECTED_STRUCTS = (
    "PluginPlatformState",
    "StorageLocation",
    "UserPluginState",
)
EXPECTED_MIGRATION_TABLES = (
    "channel_model_price_tiers",
    "id_sequences",
    "logical_models",
    "logical_model_revisions",
    "logical_model_routes",
    "route_attempts",
    "plugin_platform_states",
    "user_plugin_states",
    "ark_private_asset_bindings",
    "storage_locations",
    "resource_deletion_jobs",
    "project_asset_folders",
    "comfy_bridges",
    "comfy_bridge_requests",
)


class CandidateAdapterError(RuntimeError):
    pass


class CandidateFaultInjected(CandidateAdapterError):
    pass


def canonical_json(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@contextmanager
def managed_sqlite(path: Path, *, isolation_level: str | None = ""):
    connection = sqlite3.connect(path, isolation_level=isolation_level)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def sqlite_backup(source: Path, target: Path) -> None:
    if target.exists() or target.is_symlink():
        raise CandidateAdapterError("backup target must be a new regular path")
    with managed_sqlite(source) as source_db, managed_sqlite(target) as target_db:
        source_db.backup(target_db)


def _git(repo_root: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments],
        cwd=repo_root,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise CandidateAdapterError(result.stderr.strip() or "git inspection failed")
    return result.stdout


def inspect_pinned_diff(repo_root: str | Path) -> dict[str, Any]:
    root = Path(repo_root).resolve(strict=True)
    stable = _git(root, "rev-parse", f"{LOCAL_STABLE_REF}^{{commit}}").strip()
    candidate = _git(root, "rev-parse", f"{LOCAL_CANDIDATE_REF}^{{commit}}").strip()
    if stable != STABLE_COMMIT:
        raise CandidateAdapterError(f"Stable ref drifted: {stable}")
    if candidate != CANDIDATE_COMMIT:
        raise CandidateAdapterError(f"Candidate ref drifted: {candidate}")
    if _git(root, "rev-parse", f"{LOCAL_STABLE_REF}^{{tree}}").strip() != FROZEN_UPSTREAM["stable"]["tree"]:
        raise CandidateAdapterError("Stable tree drifted")
    if _git(root, "rev-parse", f"{LOCAL_CANDIDATE_REF}^{{tree}}").strip() != FROZEN_UPSTREAM["candidate"]["tree"]:
        raise CandidateAdapterError("Candidate tree drifted")

    model_diff = _git(
        root,
        "diff",
        "--full-index",
        f"{STABLE_COMMIT}..{CANDIDATE_COMMIT}",
        "--",
        *MODEL_PATHS,
    )
    migration_diff = _git(
        root,
        "diff",
        "--full-index",
        f"{STABLE_COMMIT}..{CANDIDATE_COMMIT}",
        "--",
        *MIGRATION_PATHS,
    )
    added_structs = tuple(
        sorted(re.findall(r"^\+type ([A-Za-z0-9_]+) struct \{$", model_diff, re.M))
    )
    if added_structs != tuple(sorted(EXPECTED_STRUCTS)):
        raise CandidateAdapterError(
            f"added model set drifted: {', '.join(added_structs) or 'none'}"
        )
    if not re.search(
        r'^\+\s*Icon\s+string\s+`json:"icon" gorm:"size:80"`$',
        model_diff,
        re.M,
    ):
        raise CandidateAdapterError("ChannelModel.Icon diff no longer matches the adapter")
    added_migration_tables = tuple(
        re.findall(
            r'^\+\s*migrateTable\[[^\]]+\]\("([a-z0-9_]+)"\),$',
            migration_diff,
            re.M,
        )
    )
    if added_migration_tables != EXPECTED_MIGRATION_TABLES:
        raise CandidateAdapterError(
            "migration-list additions no longer match the pinned adapter plan"
        )

    changed_models = sorted(
        {
            *EXPECTED_STRUCTS,
            "ChannelModel.Icon",
        }
    )
    return {
        "stable_ref": STABLE_REF,
        "stable_commit": stable,
        "candidate_ref": CANDIDATE_REF,
        "candidate_commit": candidate,
        "model_diff_sha256": sha256_bytes(model_diff.encode("utf-8")),
        "migration_diff_sha256": sha256_bytes(migration_diff.encode("utf-8")),
        "changed_models": changed_models,
        "migration_list_additions": list(EXPECTED_MIGRATION_TABLES),
        "classification_before": "C_MIGRATION_REQUIRED",
    }


def create_stable_fixture(path: str | Path) -> Path:
    target = Path(path)
    if target.name != "stable.sqlite" or target.exists() or target.is_symlink():
        raise CandidateAdapterError("fixture must be a new stable.sqlite")
    target.parent.mkdir(parents=True, exist_ok=True)
    with managed_sqlite(target) as connection:
        connection.execute(f"PRAGMA application_id = {APPLICATION_ID}")
        connection.executescript(
            """
            CREATE TABLE _filmos_rc_fixture(
                marker TEXT PRIMARY KEY,
                synthetic INTEGER NOT NULL CHECK(synthetic = 1)
            );
            CREATE TABLE channel_models(
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                model_key TEXT NOT NULL,
                provider_model_key TEXT NOT NULL,
                display_name TEXT NOT NULL,
                capability TEXT NOT NULL,
                protocol TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX idx_channel_model_key_active
            ON channel_models(channel_id, model_key);
            """
        )
        connection.execute(
            "INSERT INTO _filmos_rc_fixture(marker, synthetic) VALUES (?, 1)",
            (FIXTURE_MARKER,),
        )
        connection.executemany(
            "INSERT INTO channel_models VALUES(?,?,?,?,?,?,?,?,?)",
            [
                (
                    "channel-model-001",
                    "channel-001",
                    "seedance-2-0",
                    "seedance-2-0",
                    "Seedance 2.0",
                    "video",
                    "openai-compatible",
                    "2026-08-28T00:00:00Z",
                    "2026-08-28T00:00:00Z",
                ),
                (
                    "channel-model-002",
                    "channel-001",
                    "seedream-4-0",
                    "seedream-4-0",
                    "Seedream 4.0",
                    "image",
                    "openai-compatible",
                    "2026-08-28T00:00:00Z",
                    "2026-08-28T00:00:00Z",
                ),
            ],
        )
    sidecar = target.with_suffix(".sqlite.fixture.json")
    sidecar.write_bytes(
        canonical_json(
            {
                "generator": FIXTURE_MARKER,
                "synthetic": True,
                "stable_commit": STABLE_COMMIT,
            }
        )
    )
    return target


class CandidateSchemaAdapter:
    def __init__(
        self,
        sandbox_root: str | Path,
        repo_root: str | Path,
        *,
        enabled: bool = False,
    ) -> None:
        raw_root = Path(sandbox_root)
        if raw_root.is_symlink():
            raise CandidateAdapterError("sandbox root must not be a symlink")
        self.root = raw_root.resolve(strict=True)
        marker = self.root / SANDBOX_MARKER
        if not marker.is_file() or marker.is_symlink():
            raise CandidateAdapterError("RC candidate sandbox marker is missing")
        self.repo_root = Path(repo_root).resolve(strict=True)
        self.enabled = enabled

    def plan(self) -> dict[str, Any]:
        diff = inspect_pinned_diff(self.repo_root)
        return {
            "schema_version": 1,
            "kind": "FILMOS_RC_CANDIDATE_SCHEMA_ADAPTER_PLAN",
            "formal_apply": False,
            "fixture_only": True,
            "diff": diff,
            "steps": [
                "copy immutable synthetic Stable fixture to an isolated work target",
                "add nullable ChannelModel.icon compatible with the Candidate string field",
                "create plugin_platform_states, user_plugin_states, storage_locations",
                "rebuild Candidate indexes from the exact GORM tags",
                "verify old rows and stable IDs, then probe only synthetic Candidate rows",
                "restore the pre-migration backup and verify its exact file hash",
            ],
            "rollback": "replace isolated work target with receipt-bound pre-migration backup",
            "real_database": "NOT_OPENED",
            "real_postgresql": "NOT_EXECUTED",
            "candidate_merge": "NOT_EXECUTED",
        }

    def dry_run(
        self,
        source_path: str | Path,
        *,
        fault_after_step: int | None = None,
    ) -> dict[str, Any]:
        self._require_enabled()
        source = self._fixture(source_path)
        plan = self.plan()
        plan_hash = sha256_bytes(canonical_json(plan))
        source_hash = sha256_file(source)
        before = self._snapshot(source)
        work = self.root / "candidate.sqlite"
        backup = self.root / "stable-backup.sqlite"
        if work.exists() or backup.exists():
            raise CandidateAdapterError("dry-run outputs already exist")
        sqlite_backup(source, work)
        sqlite_backup(work, backup)
        backup_hash = sha256_file(backup)

        step = 0
        try:
            with managed_sqlite(work, isolation_level=None) as connection:
                connection.execute("BEGIN IMMEDIATE")
                try:
                    for statement in self._candidate_statements():
                        connection.execute(statement)
                        step += 1
                        if fault_after_step is not None and step >= fault_after_step:
                            raise CandidateFaultInjected(
                                f"fault injected after candidate DDL step {step}"
                            )
                    connection.execute(
                        "INSERT INTO plugin_platform_states VALUES(?,?,?,?,?)",
                        (
                            "plugin.synthetic.rc",
                            1,
                            "synthetic-admin",
                            "2026-08-28T00:00:00Z",
                            "2026-08-28T00:00:00Z",
                        ),
                    )
                    connection.execute(
                        "INSERT INTO user_plugin_states VALUES(?,?,?,?,?,?)",
                        (
                            "10000000-0000-4000-8000-000000000014",
                            "10000000-0000-4000-8000-000000000001",
                            "plugin.synthetic.rc",
                            1,
                            "2026-08-28T00:00:00Z",
                            "2026-08-28T00:00:00Z",
                        ),
                    )
                    connection.execute(
                        "INSERT INTO storage_locations VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            "10000000-0000-4000-8000-000000000015",
                            "user",
                            "10000000-0000-4000-8000-000000000001",
                            "s3",
                            "a" * 64,
                            '{"bucket":"synthetic-only"}',
                            "b" * 64,
                            "2026-08-28T00:00:00Z",
                            1,
                            "2026-08-28T00:00:00Z",
                            "2026-08-28T00:00:00Z",
                        ),
                    )
                    after = self._snapshot_connection(connection)
                    connection.execute("COMMIT")
                except Exception:
                    connection.execute("ROLLBACK")
                    raise
        except CandidateFaultInjected:
            rolled_back = self._snapshot(work)
            if rolled_back != before:
                raise CandidateAdapterError(
                    "fault rollback left a partial Candidate schema or fact"
                )
            raise

        if sha256_file(source) != source_hash:
            raise CandidateAdapterError("synthetic Stable source changed during dry-run")
        if before["channel_model_ids"] != after["channel_model_ids"]:
            raise CandidateAdapterError("Stable ChannelModel IDs changed")
        if after["channel_model_icons"] != [None, None]:
            raise CandidateAdapterError("existing ChannelModel rows did not retain empty icon state")

        receipt = {
            "schema_version": 1,
            "kind": "FILMOS_RC_CANDIDATE_SCHEMA_DRY_RUN_RECEIPT",
            "status": "PASSED_SYNTHETIC_REVERSIBLE_DRY_RUN",
            "receipt_id": str(uuid5(NAMESPACE_URL, plan_hash + source_hash)),
            "plan_sha256": plan_hash,
            "source_sha256": source_hash,
            "source_unchanged": True,
            "backup_sha256": backup_hash,
            "stable_ids_preserved": True,
            "source_channel_model_row_sha256": before["channel_model_row_sha256"],
            "candidate_channel_model_row_sha256": after[
                "channel_model_row_sha256"
            ],
            "candidate_probe_ids": after["candidate_probe_ids"],
            "candidate_tables": after["candidate_tables"],
            "no_partial_facts": True,
            "classification_after": "C_MIGRATION_REQUIRED",
            "classification_reason": (
                "Synthetic reversible proof does not authorize or execute a real SQLite/PostgreSQL "
                "migration and the Candidate has not been merged."
            ),
            "real_database": "NOT_OPENED",
            "real_postgresql": "NOT_EXECUTED",
            "candidate_merge": "NOT_EXECUTED",
        }
        receipt_hash = sha256_bytes(canonical_json(receipt))
        receipt["receipt_sha256"] = receipt_hash
        return receipt

    def replay(self, source_path: str | Path) -> dict[str, Any]:
        first = self.dry_run(source_path)
        self._remove_outputs()
        second = self.dry_run(source_path)
        if first != second:
            raise CandidateAdapterError("Candidate dry-run receipt is not deterministic")
        return {**second, "replayed_same_receipt": True}

    def rollback(self, receipt: dict[str, Any]) -> dict[str, Any]:
        self._require_enabled()
        work = self.root / "candidate.sqlite"
        backup = self.root / "stable-backup.sqlite"
        if not work.is_file() or not backup.is_file():
            raise CandidateAdapterError("dry-run work target or backup is missing")
        if sha256_file(backup) != receipt.get("backup_sha256"):
            raise CandidateAdapterError("receipt-bound backup hash mismatch")
        temporary = self.root / "candidate.rollback.sqlite"
        if temporary.exists() or temporary.is_symlink():
            raise CandidateAdapterError("rollback temporary path already exists")
        shutil.copyfile(backup, temporary)
        os.replace(temporary, work)
        restored_hash = sha256_file(work)
        if restored_hash != receipt.get("backup_sha256"):
            raise CandidateAdapterError("rollback did not restore the exact bound backup")
        restored = self._snapshot(work)
        return {
            "status": "PASSED_EXACT_STABLE_ROLLBACK",
            "restored_sha256": restored_hash,
            "matches_pre_migration_backup": True,
            "stable_ids_preserved": restored["channel_model_ids"]
            == ["channel-model-001", "channel-model-002"],
            "candidate_tables_absent": restored["candidate_tables"] == [],
        }

    def _remove_outputs(self) -> None:
        for name in ("candidate.sqlite", "stable-backup.sqlite"):
            path = self.root / name
            if path.exists():
                path.unlink()

    def _fixture(self, source_path: str | Path) -> Path:
        source = Path(source_path)
        if source.is_symlink():
            raise CandidateAdapterError("source fixture must not be a symlink")
        source = source.resolve(strict=True)
        if not source.is_relative_to(self.root) or source.name != "stable.sqlite":
            raise CandidateAdapterError("only sandbox-contained stable.sqlite is accepted")
        sidecar = source.with_suffix(".sqlite.fixture.json")
        if not sidecar.is_file() or sidecar.is_symlink():
            raise CandidateAdapterError("synthetic fixture sidecar is missing")
        identity = json.loads(sidecar.read_bytes())
        if identity != {
            "generator": FIXTURE_MARKER,
            "stable_commit": STABLE_COMMIT,
            "synthetic": True,
        }:
            raise CandidateAdapterError("synthetic fixture sidecar is invalid")
        with managed_sqlite(source) as connection:
            app_id = int(connection.execute("PRAGMA application_id").fetchone()[0])
            marker = connection.execute(
                "SELECT marker, synthetic FROM _filmos_rc_fixture"
            ).fetchone()
        if app_id != APPLICATION_ID or tuple(marker or ()) != (FIXTURE_MARKER, 1):
            raise CandidateAdapterError("synthetic fixture database identity is invalid")
        return source

    @staticmethod
    def _candidate_statements() -> tuple[str, ...]:
        return (
            "ALTER TABLE channel_models ADD COLUMN icon TEXT",
            "CREATE TABLE plugin_platform_states(plugin_id TEXT PRIMARY KEY, available INTEGER NOT NULL, updated_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE INDEX idx_plugin_platform_states_available ON plugin_platform_states(available)",
            "CREATE INDEX idx_plugin_platform_states_updated_by ON plugin_platform_states(updated_by)",
            "CREATE TABLE user_plugin_states(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plugin_id TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE INDEX idx_user_plugin_states_user_id ON user_plugin_states(user_id)",
            "CREATE INDEX idx_user_plugin_states_plugin_id ON user_plugin_states(plugin_id)",
            "CREATE INDEX idx_user_plugin_states_enabled ON user_plugin_states(enabled)",
            "CREATE UNIQUE INDEX idx_user_plugin_state_user_plugin ON user_plugin_states(user_id, plugin_id)",
            "CREATE TABLE storage_locations(id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner_id TEXT NOT NULL, provider TEXT NOT NULL, location_digest TEXT NOT NULL, value_json TEXT NOT NULL, tested_digest TEXT NOT NULL, tested_at TEXT, active INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
            "CREATE INDEX idx_storage_locations_provider ON storage_locations(provider)",
            "CREATE INDEX idx_storage_locations_scope_owner_active ON storage_locations(scope, owner_id, active)",
            "CREATE UNIQUE INDEX idx_storage_locations_identity ON storage_locations(scope, owner_id, provider, location_digest)",
        )

    def _snapshot(self, path: Path) -> dict[str, Any]:
        with managed_sqlite(path) as connection:
            return self._snapshot_connection(connection)

    @staticmethod
    def _snapshot_connection(connection: sqlite3.Connection) -> dict[str, Any]:
        tables = [
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall()
        ]
        columns = [
            str(row[1])
            for row in connection.execute("PRAGMA table_info(channel_models)").fetchall()
        ]
        channel_rows = [
            dict(row)
            for row in connection.execute(
                "SELECT * FROM channel_models ORDER BY id"
            ).fetchall()
        ]
        candidate_tables = [
            table
            for table in (
                "plugin_platform_states",
                "storage_locations",
                "user_plugin_states",
            )
            if table in tables
        ]
        candidate_probe_ids: list[str] = []
        if candidate_tables:
            candidate_probe_ids = [
                str(
                    connection.execute(
                        "SELECT plugin_id FROM plugin_platform_states"
                    ).fetchone()[0]
                ),
                str(
                    connection.execute("SELECT id FROM user_plugin_states").fetchone()[0]
                ),
                str(
                    connection.execute("SELECT id FROM storage_locations").fetchone()[0]
                ),
            ]
        return {
            "tables": tables,
            "candidate_tables": candidate_tables,
            "channel_model_columns": columns,
            "channel_model_ids": [row["id"] for row in channel_rows],
            "channel_model_icons": (
                [row.get("icon") for row in channel_rows]
                if "icon" in columns
                else []
            ),
            "channel_model_row_sha256": sha256_bytes(canonical_json(channel_rows)),
            "candidate_probe_ids": candidate_probe_ids,
        }

    def _require_enabled(self) -> None:
        if not self.enabled:
            raise CandidateAdapterError("candidate schema dry-run is disabled by default")


def run_candidate_demo(root: str | Path, repo_root: str | Path) -> dict[str, Any]:
    sandbox = Path(root)
    sandbox.mkdir(parents=True, exist_ok=True)
    (sandbox / SANDBOX_MARKER).write_text("synthetic only\n", encoding="utf-8")
    source = create_stable_fixture(sandbox / "source" / "stable.sqlite")
    engine = CandidateSchemaAdapter(sandbox, repo_root, enabled=True)
    source_hash = sha256_file(source)

    try:
        engine.dry_run(source, fault_after_step=4)
    except CandidateFaultInjected:
        fault_rollback = True
    else:
        fault_rollback = False
    engine._remove_outputs()

    receipt = engine.replay(source)
    rollback = engine.rollback(receipt)
    return {
        "status": "PASSED_SYNTHETIC_REVERSIBLE_DRY_RUN",
        "source_unchanged": sha256_file(source) == source_hash,
        "fault_rollback": fault_rollback,
        "plan": engine.plan(),
        "receipt": receipt,
        "rollback": rollback,
        "classification": "C_MIGRATION_REQUIRED",
    }
