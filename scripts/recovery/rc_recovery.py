from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "migration"))
sys.path.insert(0, str(ROOT / "scripts" / "upstream"))
sys.path.insert(0, str(ROOT / "film-core" / "src"))

from frozen_upstream import prepare_frozen_upstream  # noqa: E402
from rc_schema_adapter import run_candidate_demo  # noqa: E402
from synthetic_migration import run_demo as run_synthetic_migration  # noqa: E402
from film_production_core.database import SQLiteDatabase  # noqa: E402


RC_SANDBOX_MARKER = ".filmos-rc-recovery-sandbox"
FILM_CORE_ENTITY_ID = "10000000-0000-4000-8000-000000000061"
FILM_CORE_AUDIT_ID = "10000000-0000-4000-8000-000000000062"


class RCRecoveryError(RuntimeError):
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
def managed_sqlite(path: Path, *, isolation_level: str | None = None):
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
        raise RCRecoveryError("backup target must be a new regular path")
    with managed_sqlite(source) as source_db, managed_sqlite(target) as target_db:
        source_db.backup(target_db)


def run_film_core_recovery(root: str | Path) -> dict[str, Any]:
    sandbox = Path(root)
    sandbox.mkdir(parents=True, exist_ok=True)
    source = sandbox / "film-core.sqlite"
    database = SQLiteDatabase(source)
    with closing(database.connect()) as connection:
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute(
                """
                INSERT INTO film_entities(
                    film_entity_id, entity_type, version, content_hash,
                    host_project_id, host_unit_id, host_shot_id, host_asset_id,
                    host_asset_version_id, host_canvas_id, host_resource_id,
                    creative_stage, execution_state, review_state, lock_state,
                    delivery_state, stale_state, unit_kind, director_unit_ids_json,
                    created_at, updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    FILM_CORE_ENTITY_ID,
                    "film_project_extension",
                    1,
                    "6" * 64,
                    "rc-host-project",
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    "authored",
                    "ready",
                    "passed",
                    "unlocked",
                    "ready",
                    "fresh",
                    None,
                    "[]",
                    "2026-08-28T00:00:00Z",
                    "2026-08-28T00:00:00Z",
                ),
            )
            connection.execute(
                """
                INSERT INTO audit_events(
                    event_id, actor_kind, action, target_id, previous_version,
                    resulting_version, command_type, command_payload_json, recorded_at
                ) VALUES(?,?,?,?,?,?,?,?,?)
                """,
                (
                    FILM_CORE_AUDIT_ID,
                    "human",
                    "rc.synthetic.created",
                    FILM_CORE_ENTITY_ID,
                    None,
                    1,
                    "entity.create",
                    '{"fixture":"rc-recovery"}',
                    "2026-08-28T00:00:00Z",
                ),
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS _filmos_rc_recovery_receipts(
                    receipt_id TEXT PRIMARY KEY,
                    source_entity_id TEXT NOT NULL,
                    source_content_hash TEXT NOT NULL,
                    status TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "INSERT INTO _filmos_rc_recovery_receipts VALUES(?,?,?,?)",
                (
                    "rc-film-core-receipt-001",
                    FILM_CORE_ENTITY_ID,
                    "6" * 64,
                    "PREPARED_LOCAL_RECOVERY",
                ),
            )
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    before = _film_core_snapshot(source)
    source_hash_before = sha256_file(source)
    backup = sandbox / "film-core.backup.sqlite"
    sqlite_backup(source, backup)
    source_hash_after_backup = sha256_file(source)

    fault_target = sandbox / "film-core.fault.sqlite"
    sqlite_backup(backup, fault_target)
    fault_rolled_back = False
    try:
        with managed_sqlite(fault_target, isolation_level=None) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    "UPDATE film_entities SET version = 2 WHERE film_entity_id = ?",
                    (FILM_CORE_ENTITY_ID,),
                )
                raise RCRecoveryError("injected Film Core recovery fault")
            except Exception:
                connection.execute("ROLLBACK")
                raise
    except RCRecoveryError:
        fault_rolled_back = _film_core_snapshot(fault_target) == before

    restored = sandbox / "film-core.restored.sqlite"
    sqlite_backup(backup, restored)
    restored_snapshot = _film_core_snapshot(restored)
    source_hash_after = sha256_file(source)
    if source_hash_before != source_hash_after_backup or source_hash_before != source_hash_after:
        raise RCRecoveryError("Film Core source database changed during recovery drill")
    if restored_snapshot != before:
        raise RCRecoveryError("Film Core restored logical state differs from source")
    if not fault_rolled_back:
        raise RCRecoveryError("Film Core fault probe left a partial fact")

    logical_hash = sha256_bytes(canonical_json(before))
    return {
        "status": "PASSED_LOCAL_FILM_CORE_RECOVERY",
        "schema_version": before["schema_version"],
        "journal_mode": before["journal_mode"],
        "source_sha256": source_hash_before,
        "source_unchanged": True,
        "backup_sha256": sha256_file(backup),
        "logical_state_sha256": logical_hash,
        "restored_logical_state_sha256": sha256_bytes(
            canonical_json(restored_snapshot)
        ),
        "stable_ids": before["stable_ids"],
        "receipt_id": before["receipt_ids"][0],
        "receipt_preserved": before["receipt_ids"]
        == restored_snapshot["receipt_ids"],
        "foreign_keys_valid": before["foreign_key_violations"] == [],
        "fault_rollback": fault_rolled_back,
        "no_partial_facts": fault_rolled_back,
    }


def _film_core_snapshot(path: Path) -> dict[str, Any]:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only = ON")
        entities = [
            dict(row)
            for row in connection.execute(
                "SELECT * FROM film_entities ORDER BY film_entity_id"
            ).fetchall()
        ]
        audits = [
            dict(row)
            for row in connection.execute(
                "SELECT * FROM audit_events ORDER BY event_id"
            ).fetchall()
        ]
        receipts = [
            dict(row)
            for row in connection.execute(
                "SELECT * FROM _filmos_rc_recovery_receipts ORDER BY receipt_id"
            ).fetchall()
        ]
        schema_versions = [
            int(row[0])
            for row in connection.execute(
                "SELECT version FROM schema_migrations ORDER BY version"
            ).fetchall()
        ]
        journal_mode = str(connection.execute("PRAGMA journal_mode").fetchone()[0])
        foreign_keys = [
            list(row) for row in connection.execute("PRAGMA foreign_key_check").fetchall()
        ]
    finally:
        connection.close()
    return {
        "schema_version": max(schema_versions),
        "schema_versions": schema_versions,
        "journal_mode": journal_mode,
        "entity_row_sha256": sha256_bytes(canonical_json(entities)),
        "audit_row_sha256": sha256_bytes(canonical_json(audits)),
        "receipt_row_sha256": sha256_bytes(canonical_json(receipts)),
        "stable_ids": [row["film_entity_id"] for row in entities]
        + [row["event_id"] for row in audits],
        "receipt_ids": [row["receipt_id"] for row in receipts],
        "foreign_key_violations": foreign_keys,
    }


def run_surface(repo_root: Path) -> dict[str, Any]:
    bun = shutil.which("bun")
    if not bun:
        raise RCRecoveryError("bun is required to replay Remote and Agent surfaces")
    result = subprocess.run(
        [bun, "../tests/film-rc/rc_surface.ts"],
        cwd=repo_root / "web",
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode:
        raise RCRecoveryError(
            result.stderr.strip() or result.stdout.strip() or "RC surface failed"
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RCRecoveryError("RC surface did not return one JSON receipt") from error


def run_rc_recovery(root: str | Path, repo_root: str | Path = ROOT) -> dict[str, Any]:
    raw_sandbox = Path(root)
    if raw_sandbox.is_symlink():
        raise RCRecoveryError("RC recovery sandbox must not be a symlink")
    raw_sandbox.mkdir(parents=True, exist_ok=True)
    sandbox = raw_sandbox.resolve(strict=True)
    if any(sandbox.iterdir()):
        raise RCRecoveryError("RC recovery sandbox must be a new empty directory")
    marker = sandbox / RC_SANDBOX_MARKER
    marker.write_text("synthetic and local only\n", encoding="utf-8")
    repo = Path(repo_root).resolve(strict=True)

    surface = run_surface(repo)
    beta_migration = run_synthetic_migration(sandbox / "beta-migration")
    film_core = run_film_core_recovery(sandbox / "film-core")
    upstream_repo = sandbox / "yingce-upstream.git"
    upstream_bootstrap = prepare_frozen_upstream(upstream_repo)
    candidate = run_candidate_demo(sandbox / "candidate-adapter", upstream_repo)

    checks = {
        "remote_receipt_recovered": (
            surface["remote"]["receipt_id"]
            == surface["remote"]["recovered_receipt_id"]
        ),
        "remote_not_executed": surface["remote"]["execution_state"]
        == "NOT_EXECUTED",
        "feature_flags_rolled_back": surface["feature_flag_rollback"][
            "all_default_false"
        ],
        "agent_and_session_fail_closed": (
            surface["agent"]["apply_calls"] == 0
            and surface["agent"]["deepseek_apply_error"]
            == "human_apply_required"
            and surface["agent"]["session_loss_error"] == "read_required"
        ),
        "beta_migration_restored": beta_migration["restore"]["receipt_preserved"]
        and beta_migration["fault_rollback"],
        "film_core_restored": film_core["receipt_preserved"]
        and film_core["fault_rollback"],
        "candidate_reversible": candidate["fault_rollback"]
        and candidate["rollback"]["candidate_tables_absent"],
        "all_sources_unchanged": surface["remote"]["source_unchanged"]
        and film_core["source_unchanged"]
        and candidate["source_unchanged"],
        "stable_ids_preserved": film_core["stable_ids"]
        == [FILM_CORE_ENTITY_ID, FILM_CORE_AUDIT_ID]
        and candidate["receipt"]["stable_ids_preserved"],
        "no_partial_facts": film_core["no_partial_facts"]
        and candidate["receipt"]["no_partial_facts"],
        "no_provider_network_or_external_apply": surface["network_calls"] == 0
        and surface["external_provider_calls"] == 0
        and surface["formal_apply_calls"] == 0,
    }
    failures = [name for name, passed in checks.items() if not passed]
    body = {
        "schema_version": 1,
        "kind": "FILMOS_RC_UNIFIED_LOCAL_RECOVERY_RECEIPT",
        "status": (
            "PASSED_LOCAL_RC_RECOVERY" if not failures else "FAILED_LOCAL_RC_RECOVERY"
        ),
        "scope": "synthetic_execution_with_read_only_frozen_upstream_fetch",
        "source_of_truth": "unchanged",
        "surface": surface,
        "beta_migration": beta_migration,
        "film_core": film_core,
        "candidate_adapter": candidate,
        "upstream_bootstrap": upstream_bootstrap,
        "checks": checks,
        "failures": failures,
        "authority_boundaries": {
            "real_user_database": "NOT_OPENED",
            "real_postgresql": "NOT_EXECUTED",
            "network_publish": "NOT_EXECUTED",
            "external_provider": "NOT_EXECUTED",
            "formal_apply": "NOT_EXECUTED",
            "upstream_fetch": "READ_ONLY_EXACT_FROZEN_OBJECTS",
            "upstream_merge": "NOT_EXECUTED",
        },
        "upstream_classification": "C_MIGRATION_REQUIRED",
    }
    replay_key = {
        "schema_version": body["schema_version"],
        "kind": body["kind"],
        "status": body["status"],
        "remote_manifest_sha256": surface["remote"]["manifest_sha256"],
        "remote_receipt_id": surface["remote"]["receipt_id"],
        "beta_migration_receipt_id": beta_migration["apply"]["receipt_id"],
        "film_core_logical_state_sha256": film_core["logical_state_sha256"],
        "film_core_receipt_id": film_core["receipt_id"],
        "candidate_plan_sha256": candidate["receipt"]["plan_sha256"],
        "candidate_receipt_id": candidate["receipt"]["receipt_id"],
        "upstream_stable_commit": upstream_bootstrap["stable"]["commit"],
        "upstream_candidate_commit": upstream_bootstrap["candidate"]["commit"],
        "checks": checks,
        "authority_boundaries": body["authority_boundaries"],
        "upstream_classification": body["upstream_classification"],
    }
    replay_hash = sha256_bytes(canonical_json(replay_key))
    receipt_hash = sha256_bytes(canonical_json(body))
    return {
        **body,
        "receipt_id": str(uuid5(NAMESPACE_URL, replay_hash)),
        "replay_key_sha256": replay_hash,
        "receipt_sha256": receipt_hash,
    }


def write_receipt(path: str | Path, receipt: dict[str, Any]) -> None:
    target = Path(path)
    if target.exists() or target.is_symlink():
        raise RCRecoveryError("refusing to overwrite an existing RC receipt")
    target.parent.mkdir(parents=True, exist_ok=True)
    data = canonical_json(receipt)
    with target.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
