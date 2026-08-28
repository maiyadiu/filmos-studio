from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5


SANDBOX_MARKER = ".filmos-migration-sandbox"
FIXTURE_SIDECAR_SUFFIX = ".fixture.json"
FIXTURE_GENERATOR = "filmos-beta-migration-test"
SYNTHETIC_APPLICATION_ID = 0x46494C4D
MANIFEST_NAME = "manifest.json"
MANIFEST_HASH_NAME = "manifest.sha256"
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class MigrationError(RuntimeError):
    pass


class FaultInjected(MigrationError):
    pass


@contextmanager
def managed_sqlite(database: str | Path, **kwargs: Any):
    """Preserve sqlite3 transaction semantics while always closing the handle."""
    connection = sqlite3.connect(database, **kwargs)
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


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


def normalized(value: Any) -> Any:
    if isinstance(value, bytes):
        return {
            "encoding": "hex",
            "bytes": len(value),
            "sha256": sha256_bytes(value),
            "value": value.hex(),
        }
    if isinstance(value, float):
        return {"encoding": "float", "value": repr(value)}
    return value


def row_hash(columns: list[str], rows: list[tuple[Any, ...]]) -> str:
    return sha256_bytes(
        canonical_json(
            [
                {column: normalized(value) for column, value in zip(columns, row, strict=True)}
                for row in rows
            ]
        )
    )


def quote_identifier(value: str) -> str:
    if not IDENTIFIER.fullmatch(value):
        raise MigrationError(f"unsafe SQL identifier: {value}")
    return f'"{value}"'


class SyntheticMigration:
    """A marker-bound migration harness that only accepts generated fixtures."""

    def __init__(self, sandbox_root: str | Path, *, enabled: bool = False) -> None:
        candidate = Path(sandbox_root)
        if candidate.is_symlink():
            raise MigrationError("sandbox root must not be a symlink")
        self.root = candidate.resolve(strict=True)
        marker = self.root / SANDBOX_MARKER
        if not marker.is_file() or marker.is_symlink():
            raise MigrationError("migration sandbox marker is missing")
        self.enabled = enabled

    def build_package(
        self,
        source_path: str | Path,
        package_dir: str | Path,
        *,
        migration_key: str,
    ) -> dict[str, Any]:
        self._require_enabled()
        if not IDENTIFIER.fullmatch(migration_key):
            raise MigrationError("migration_key must be a safe stable identifier")
        source = self._fixture_source(source_path)
        package = self._output(package_dir, "package")
        if package.exists():
            raise MigrationError("refusing to overwrite an existing migration package")
        source_before = sha256_file(source)
        inventory = self._inventory(source)
        package.mkdir(parents=True)
        payload_dir = package / "payload"
        payload_dir.mkdir()

        artifacts: list[dict[str, Any]] = []
        psql_lines = [
            "\\set ON_ERROR_STOP on",
            "BEGIN;",
            "-- Target schema must already be created by backend database.MigrateSchema.",
        ]
        schema_lines: list[str] = ["PRAGMA foreign_keys = ON;", "BEGIN;"]
        for table in inventory["tables"]:
            csv_path = payload_dir / f"{table['name']}.csv"
            self._write_csv(csv_path, table["columns"], table["rows"])
            artifacts.append(self._artifact(package, csv_path))
            columns_sql = ", ".join(quote_identifier(item) for item in table["columns"])
            relative = csv_path.relative_to(package).as_posix().replace("'", "''")
            psql_lines.append(
                f"\\copy {quote_identifier(table['name'])} ({columns_sql}) "
                f"FROM '{relative}' WITH (FORMAT csv, HEADER true, NULL '\\N')"
            )
            schema_lines.append(table["sqlite_schema"] + ";")
        psql_lines.extend(["COMMIT;", ""])
        schema_lines.extend(["COMMIT;", ""])
        load_path = package / "load.psql"
        schema_path = package / "sqlite-verifier-schema.sql"
        self._write_once(load_path, "\n".join(psql_lines).encode("utf-8"))
        self._write_once(schema_path, "\n".join(schema_lines).encode("utf-8"))
        artifacts.extend(
            [self._artifact(package, load_path), self._artifact(package, schema_path)]
        )

        source_after = sha256_file(source)
        if source_before != source_after:
            raise MigrationError("synthetic source changed during export")
        manifest = {
            "schema_version": 1,
            "migration_key": migration_key,
            "mode": "synthetic_beta_migration_package",
            "formal_apply": False,
            "source": {
                "kind": "synthetic_sqlite_fixture",
                "path": source.relative_to(self.root).as_posix(),
                "sha256": source_before,
                "quick_check": "ok",
                "unchanged_after_export": True,
            },
            "target": {
                "package_format": "postgresql_psql_copy_csv",
                "requires_precreated_schema": "backend.database.MigrateSchema",
                "real_postgresql_status": postgres_status(),
                "local_equivalent": "sqlite_verifier_import",
            },
            "table_order": [item["name"] for item in inventory["tables"]],
            "tables": [
                {
                    key: value
                    for key, value in table.items()
                    if key not in {"rows", "sqlite_schema"}
                }
                for table in inventory["tables"]
            ],
            "totals": {
                "tables": len(inventory["tables"]),
                "rows": sum(item["row_count"] for item in inventory["tables"]),
            },
            "artifacts": sorted(artifacts, key=lambda item: item["path"]),
            "invariants": {
                "row_counts": True,
                "row_hashes": True,
                "foreign_keys": True,
                "stable_primary_keys": True,
                "source_immutable": True,
            },
        }
        encoded = canonical_json(manifest)
        manifest_hash = sha256_bytes(encoded)
        self._write_once(package / MANIFEST_NAME, encoded)
        self._write_once(
            package / MANIFEST_HASH_NAME,
            f"{manifest_hash}  {MANIFEST_NAME}\n".encode("utf-8"),
        )
        verification = self.verify_package(package)
        return {**verification, "manifest": manifest}

    def verify_package(self, package_dir: str | Path) -> dict[str, Any]:
        self._require_enabled()
        package = self._directory(package_dir, "package")
        manifest_path = package / MANIFEST_NAME
        sidecar_path = package / MANIFEST_HASH_NAME
        if any(path.is_symlink() or not path.is_file() for path in (manifest_path, sidecar_path)):
            raise MigrationError("manifest or manifest hash is missing")
        encoded = manifest_path.read_bytes()
        digest = sha256_bytes(encoded)
        if sidecar_path.read_text(encoding="utf-8") != f"{digest}  {MANIFEST_NAME}\n":
            raise MigrationError("manifest hash sidecar mismatch")
        manifest = json.loads(encoded)
        self._validate_manifest(manifest)
        expected = {
            MANIFEST_NAME,
            MANIFEST_HASH_NAME,
            *[item["path"] for item in manifest["artifacts"]],
        }
        actual = {
            path.relative_to(package).as_posix()
            for path in package.rglob("*")
            if path.is_file()
        }
        if actual != expected:
            raise MigrationError("migration package file set mismatch")
        for artifact in manifest["artifacts"]:
            path = self._child(package, artifact["path"])
            if sha256_file(path) != artifact["sha256"] or path.stat().st_size != artifact["bytes"]:
                raise MigrationError(f"migration artifact failed verification: {artifact['path']}")
        for table in manifest["tables"]:
            path = self._child(package, f"payload/{table['name']}.csv")
            with path.open(newline="", encoding="utf-8") as stream:
                reader = csv.reader(stream)
                header = next(reader)
                count = sum(1 for _ in reader)
            if header != table["columns"] or count != table["row_count"]:
                raise MigrationError(f"CSV row contract mismatch: {table['name']}")
        return {
            "verified": True,
            "manifest_sha256": digest,
            "table_count": manifest["totals"]["tables"],
            "row_count": manifest["totals"]["rows"],
            "real_postgresql_status": manifest["target"]["real_postgresql_status"],
        }

    def apply_local_equivalent(
        self,
        package_dir: str | Path,
        target_path: str | Path,
        *,
        fault_after_rows: int | None = None,
    ) -> dict[str, Any]:
        verification = self.verify_package(package_dir)
        package = self._directory(package_dir, "package")
        manifest = json.loads((package / MANIFEST_NAME).read_bytes())
        target = self._output(target_path, "target")
        if target.suffix != ".sqlite" or target.is_symlink():
            raise MigrationError("local target must be a real .sqlite path")
        backup_dir = self.root / "backups"
        backup_dir.mkdir(exist_ok=True)
        backup_path = backup_dir / f"{manifest['migration_key']}-before.sqlite"
        if not target.exists():
            self._create_empty_target(package, target)
        with managed_sqlite(target) as connection:
            connection.execute("PRAGMA foreign_keys = ON")
            self._ensure_receipt_table(connection)
            existing = connection.execute(
                "SELECT manifest_sha256, receipt_json FROM _filmos_migration_receipts WHERE migration_key = ?",
                (manifest["migration_key"],),
            ).fetchone()
            if existing is not None:
                if existing[0] != verification["manifest_sha256"]:
                    raise MigrationError("migration key already binds a different manifest")
                receipt = json.loads(existing[1])
                self._verify_target(connection, manifest)
                return {**receipt, "replayed": True}
        if not backup_path.exists():
            sqlite_backup(target, backup_path)
        backup_hash = sha256_file(backup_path)

        inserted = 0
        try:
            with managed_sqlite(target, isolation_level=None) as connection:
                connection.execute("PRAGMA foreign_keys = ON")
                connection.execute("BEGIN IMMEDIATE")
                try:
                    for table_name in manifest["table_order"]:
                        table = next(item for item in manifest["tables"] if item["name"] == table_name)
                        csv_path = package / "payload" / f"{table_name}.csv"
                        with csv_path.open(newline="", encoding="utf-8") as stream:
                            reader = csv.DictReader(stream)
                            columns = table["columns"]
                            placeholders = ",".join("?" for _ in columns)
                            insert_sql = (
                                f"INSERT INTO {quote_identifier(table_name)} "
                                f"({','.join(quote_identifier(item) for item in columns)}) VALUES ({placeholders})"
                            )
                            for row in reader:
                                values = [decode_csv_value(row[item], affinity) for item, affinity in zip(columns, table["affinities"], strict=True)]
                                connection.execute(insert_sql, values)
                                inserted += 1
                                if fault_after_rows is not None and inserted >= fault_after_rows:
                                    raise FaultInjected(f"fault injected after {inserted} rows")
                    target_data = self._verify_target(connection, manifest)
                    receipt_id = str(uuid5(NAMESPACE_URL, verification["manifest_sha256"]))
                    receipt = {
                        "status": "PASSED_LOCAL_EQUIVALENT",
                        "receipt_id": receipt_id,
                        "migration_key": manifest["migration_key"],
                        "manifest_sha256": verification["manifest_sha256"],
                        "target_data_sha256": target_data,
                        "source_sha256": manifest["source"]["sha256"],
                        "table_count": manifest["totals"]["tables"],
                        "row_count": manifest["totals"]["rows"],
                        "foreign_keys_valid": True,
                        "stable_primary_keys_preserved": True,
                        "backup_path": backup_path.relative_to(self.root).as_posix(),
                        "backup_sha256": backup_hash,
                        "real_postgresql_status": manifest["target"]["real_postgresql_status"],
                        "replayed": False,
                    }
                    connection.execute(
                        "INSERT INTO _filmos_migration_receipts(migration_key, manifest_sha256, receipt_json) VALUES(?,?,?)",
                        (
                            manifest["migration_key"],
                            verification["manifest_sha256"],
                            canonical_json(receipt).decode("utf-8"),
                        ),
                    )
                    connection.execute("COMMIT")
                except Exception:
                    connection.execute("ROLLBACK")
                    raise
        except FaultInjected:
            with managed_sqlite(target) as connection:
                if any(
                    connection.execute(
                        f"SELECT COUNT(*) FROM {quote_identifier(item['name'])}"
                    ).fetchone()[0]
                    for item in manifest["tables"]
                ):
                    raise MigrationError("fault rollback left partial rows")
            raise

        receipt_dir = self.root / "receipts"
        receipt_dir.mkdir(exist_ok=True)
        self._write_once(
            receipt_dir / f"{manifest['migration_key']}.json", canonical_json(receipt)
        )
        return receipt

    def backup_and_restore(
        self,
        package_dir: str | Path,
        source_target: str | Path,
        restored_target: str | Path,
    ) -> dict[str, Any]:
        package = self._directory(package_dir, "package")
        manifest = json.loads((package / MANIFEST_NAME).read_bytes())
        source = self._directory_file(source_target, "source target")
        restored = self._output(restored_target, "restored target")
        if restored.exists():
            raise MigrationError("restored target must not already exist")
        recovery_dir = self.root / "recovery"
        recovery_dir.mkdir(exist_ok=True)
        backup = recovery_dir / f"{manifest['migration_key']}-success.sqlite"
        if backup.exists():
            raise MigrationError("recovery backup already exists")
        sqlite_backup(source, backup)
        sqlite_backup(backup, restored)
        with managed_sqlite(source) as original, managed_sqlite(restored) as recovered:
            original_hash = self._verify_target(original, manifest)
            restored_hash = self._verify_target(recovered, manifest)
            receipt_count = recovered.execute(
                "SELECT COUNT(*) FROM _filmos_migration_receipts WHERE migration_key = ?",
                (manifest["migration_key"],),
            ).fetchone()[0]
        if original_hash != restored_hash or receipt_count != 1:
            raise MigrationError("backup restore verification failed")
        return {
            "status": "PASSED_LOCAL_RESTORE",
            "backup_sha256": sha256_file(backup),
            "target_data_sha256": restored_hash,
            "receipt_preserved": True,
        }

    def rollback_local(
        self,
        package_dir: str | Path,
        target_path: str | Path,
    ) -> dict[str, Any]:
        package = self._directory(package_dir, "package")
        manifest = json.loads((package / MANIFEST_NAME).read_bytes())
        target = self._directory_file(target_path, "target")
        with managed_sqlite(target) as connection:
            row = connection.execute(
                "SELECT receipt_json FROM _filmos_migration_receipts WHERE migration_key = ?",
                (manifest["migration_key"],),
            ).fetchone()
            if row is None:
                raise MigrationError("successful migration receipt is missing")
            receipt = json.loads(row[0])
            current_hash = self._verify_target(connection, manifest)
        if current_hash != receipt["target_data_sha256"]:
            raise MigrationError("target changed after migration; rollback refused")
        backup = self._child(self.root, receipt["backup_path"])
        if sha256_file(backup) != receipt["backup_sha256"]:
            raise MigrationError("rollback backup hash mismatch")
        temporary = target.with_suffix(".rollback.tmp")
        if temporary.exists():
            raise MigrationError("rollback temporary path already exists")
        sqlite_backup(backup, temporary)
        os.replace(temporary, target)
        rollback_receipt = {
            "status": "PASSED_LOCAL_ROLLBACK",
            "migration_receipt_id": receipt["receipt_id"],
            "backup_sha256": receipt["backup_sha256"],
            "restored_file_sha256": sha256_file(target),
            "source_deleted": False,
        }
        receipt_dir = self.root / "receipts"
        self._write_once(
            receipt_dir / f"{manifest['migration_key']}-rollback.json",
            canonical_json(rollback_receipt),
        )
        return rollback_receipt

    def _inventory(self, source: Path) -> dict[str, Any]:
        with sqlite_read_only(source) as connection:
            quick = connection.execute("PRAGMA quick_check").fetchone()[0]
            if quick != "ok":
                raise MigrationError(f"synthetic SQLite quick_check failed: {quick}")
            if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise MigrationError("synthetic source contains invalid foreign keys")
            table_rows = connection.execute(
                "SELECT name, sql FROM sqlite_master WHERE type='table' "
                "AND name NOT LIKE 'sqlite_%' AND name <> '_synthetic_fixture_marker' "
                "ORDER BY name"
            ).fetchall()
            raw: dict[str, dict[str, Any]] = {}
            for name, schema_sql in table_rows:
                quote_identifier(name)
                info = connection.execute(
                    f"PRAGMA table_info({quote_identifier(name)})"
                ).fetchall()
                columns = [item[1] for item in info]
                for column in columns:
                    quote_identifier(column)
                primary_key = [
                    item[1] for item in sorted(info, key=lambda value: value[5]) if item[5]
                ]
                if not primary_key:
                    raise MigrationError(f"table has no stable primary key: {name}")
                affinities = [sqlite_affinity(item[2]) for item in info]
                order_sql = ",".join(quote_identifier(item) for item in primary_key)
                rows = connection.execute(
                    f"SELECT {','.join(quote_identifier(item) for item in columns)} "
                    f"FROM {quote_identifier(name)} ORDER BY {order_sql}"
                ).fetchall()
                foreign_keys = [
                    {
                        "from": item[3],
                        "target_table": item[2],
                        "target_column": item[4],
                    }
                    for item in connection.execute(
                        f"PRAGMA foreign_key_list({quote_identifier(name)})"
                    ).fetchall()
                ]
                raw[name] = {
                    "name": name,
                    "columns": columns,
                    "affinities": affinities,
                    "primary_key": primary_key,
                    "primary_keys": [
                        [normalized(row[columns.index(key)]) for key in primary_key]
                        for row in rows
                    ],
                    "foreign_keys": foreign_keys,
                    "row_count": len(rows),
                    "row_sha256": row_hash(columns, rows),
                    "rows": rows,
                    "sqlite_schema": schema_sql,
                }
        return {"tables": topological_tables(raw)}

    def _fixture_source(self, path: str | Path) -> Path:
        source = self._directory_file(path, "source")
        if source.name != "synthetic.sqlite":
            raise MigrationError("only the exact synthetic.sqlite fixture filename is allowed")
        sidecar = source.with_name(source.name + FIXTURE_SIDECAR_SUFFIX)
        if not sidecar.is_file() or sidecar.is_symlink():
            raise MigrationError("synthetic fixture sidecar is missing")
        marker = json.loads(sidecar.read_text(encoding="utf-8"))
        if marker != {"generator": FIXTURE_GENERATOR, "synthetic": True}:
            raise MigrationError("synthetic fixture sidecar is invalid")
        with sqlite_read_only(source) as connection:
            if connection.execute("PRAGMA application_id").fetchone()[0] != SYNTHETIC_APPLICATION_ID:
                raise MigrationError("SQLite application_id is not the synthetic fixture marker")
            row = connection.execute(
                "SELECT generator, synthetic FROM _synthetic_fixture_marker"
            ).fetchone()
            if row != (FIXTURE_GENERATOR, 1):
                raise MigrationError("SQLite synthetic fixture marker table is invalid")
        return source

    def _create_empty_target(self, package: Path, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        with managed_sqlite(target) as connection:
            connection.executescript(
                (package / "sqlite-verifier-schema.sql").read_text(encoding="utf-8")
            )
            self._ensure_receipt_table(connection)

    @staticmethod
    def _ensure_receipt_table(connection: sqlite3.Connection) -> None:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS _filmos_migration_receipts("
            "migration_key TEXT PRIMARY KEY, manifest_sha256 TEXT NOT NULL, receipt_json TEXT NOT NULL)"
        )
        connection.commit()

    def _verify_target(self, connection: sqlite3.Connection, manifest: dict[str, Any]) -> str:
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise MigrationError("target foreign key verification failed")
        results: list[dict[str, Any]] = []
        for table in manifest["tables"]:
            order_sql = ",".join(quote_identifier(item) for item in table["primary_key"])
            rows = connection.execute(
                f"SELECT {','.join(quote_identifier(item) for item in table['columns'])} "
                f"FROM {quote_identifier(table['name'])} ORDER BY {order_sql}"
            ).fetchall()
            if len(rows) != table["row_count"] or row_hash(table["columns"], rows) != table["row_sha256"]:
                raise MigrationError(f"target row verification failed: {table['name']}")
            primary_keys = [
                [normalized(row[table["columns"].index(key)]) for key in table["primary_key"]]
                for row in rows
            ]
            if primary_keys != table["primary_keys"]:
                raise MigrationError(f"stable primary key verification failed: {table['name']}")
            results.append(
                {
                    "table": table["name"],
                    "rows": len(rows),
                    "sha256": table["row_sha256"],
                }
            )
        return sha256_bytes(canonical_json(results))

    def _validate_manifest(self, manifest: dict[str, Any]) -> None:
        if (
            manifest.get("schema_version") != 1
            or manifest.get("mode") != "synthetic_beta_migration_package"
            or manifest.get("formal_apply") is not False
        ):
            raise MigrationError("migration manifest contract is invalid")
        if manifest.get("target", {}).get("package_format") != "postgresql_psql_copy_csv":
            raise MigrationError("PostgreSQL package format is invalid")
        tables = manifest.get("tables")
        if not isinstance(tables, list) or not tables:
            raise MigrationError("migration manifest table inventory is empty")
        names = [item.get("name") for item in tables]
        if names != manifest.get("table_order") or len(names) != len(set(names)):
            raise MigrationError("migration table order is invalid")
        for table in tables:
            quote_identifier(table["name"])
            if (
                not table.get("columns")
                or not table.get("primary_key")
                or len(table.get("primary_keys", [])) != table.get("row_count")
                or len(table.get("row_sha256", "")) != 64
            ):
                raise MigrationError(f"migration table contract is invalid: {table['name']}")

    def _artifact(self, root: Path, path: Path) -> dict[str, Any]:
        return {
            "path": path.relative_to(root).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        }

    @staticmethod
    def _write_csv(path: Path, columns: list[str], rows: list[tuple[Any, ...]]) -> None:
        with path.open("x", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream, lineterminator="\n")
            writer.writerow(columns)
            for row in rows:
                writer.writerow([encode_csv_value(value) for value in row])

    @staticmethod
    def _write_once(path: Path, value: bytes) -> None:
        if path.exists():
            if path.is_symlink() or path.read_bytes() != value:
                raise MigrationError(f"refusing to overwrite artifact: {path.name}")
            return
        with path.open("xb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())

    def _require_enabled(self) -> None:
        if not self.enabled:
            raise MigrationError("synthetic migration is disabled by default")

    def _directory(self, path: str | Path, label: str) -> Path:
        value = self._contained(path, label, must_exist=True)
        if not value.is_dir() or value.is_symlink():
            raise MigrationError(f"{label} must be a real directory")
        return value

    def _directory_file(self, path: str | Path, label: str) -> Path:
        value = self._contained(path, label, must_exist=True)
        if not value.is_file() or value.is_symlink():
            raise MigrationError(f"{label} must be a real file")
        return value

    def _output(self, path: str | Path, label: str) -> Path:
        return self._contained(path, label, must_exist=False)

    def _child(self, root: Path, relative: str) -> Path:
        if Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise MigrationError("unsafe package relative path")
        value = (root / relative).resolve(strict=True)
        if value.is_symlink() or not value.is_file() or not value.is_relative_to(root):
            raise MigrationError("package path escapes sandbox")
        return value

    def _contained(self, path: str | Path, label: str, *, must_exist: bool) -> Path:
        candidate = Path(path)
        if candidate.is_symlink():
            raise MigrationError(f"{label} must not be a symlink")
        try:
            value = candidate.resolve(strict=must_exist)
        except FileNotFoundError as error:
            raise MigrationError(f"{label} does not exist") from error
        if value == self.root or not value.is_relative_to(self.root):
            raise MigrationError(f"{label} must stay inside the marked sandbox")
        return value


def topological_tables(raw: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    ordered: list[dict[str, Any]] = []
    pending = dict(raw)
    emitted: set[str] = set()
    while pending:
        ready = sorted(
            name
            for name, table in pending.items()
            if {
                item["target_table"]
                for item in table["foreign_keys"]
                if item["target_table"] != name
            }
            <= emitted
        )
        if not ready:
            raise MigrationError("foreign key graph contains a cycle or missing table")
        for name in ready:
            ordered.append(pending.pop(name))
            emitted.add(name)
    return ordered


def sqlite_affinity(declared: str) -> str:
    value = declared.upper()
    if "INT" in value:
        return "INTEGER"
    if any(item in value for item in ("CHAR", "CLOB", "TEXT")):
        return "TEXT"
    if "BLOB" in value or not value:
        return "BLOB"
    if any(item in value for item in ("REAL", "FLOA", "DOUB")):
        return "REAL"
    return "NUMERIC"


def encode_csv_value(value: Any) -> str:
    if value is None:
        return r"\N"
    if isinstance(value, bytes):
        return r"\x" + value.hex()
    if isinstance(value, float):
        return repr(value)
    return str(value)


def decode_csv_value(value: str, affinity: str) -> Any:
    if value == r"\N":
        return None
    if affinity == "BLOB" and value.startswith(r"\x"):
        return bytes.fromhex(value[2:])
    if affinity == "INTEGER":
        return int(value)
    if affinity in {"REAL", "NUMERIC"}:
        return float(value)
    return value


@contextmanager
def sqlite_read_only(path: Path):
    connection = sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)
    try:
        connection.execute("PRAGMA query_only = ON")
        connection.execute("PRAGMA foreign_keys = ON")
        yield connection
    finally:
        connection.close()


def sqlite_backup(source: Path, target: Path) -> None:
    if target.exists() or target.is_symlink():
        raise MigrationError("backup target must not already exist")
    with managed_sqlite(source) as source_db, managed_sqlite(target) as target_db:
        source_db.backup(target_db)


def postgres_status() -> str:
    psql = shutil.which("psql")
    dsn = os.environ.get("FILMOS_TEST_POSTGRES_DSN", "").strip()
    if not psql or not dsn:
        return "BLOCKED_REAL_PG"
    result = subprocess.run(
        [psql, dsn, "-X", "-A", "-t", "-c", "SELECT 1"],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    return "READY_REAL_PG" if result.returncode == 0 and result.stdout.strip() == "1" else "BLOCKED_REAL_PG"


def create_synthetic_fixture(path: str | Path) -> Path:
    """Create the only source shape accepted by the Beta migration harness."""
    target = Path(path)
    if target.name != "synthetic.sqlite" or target.exists():
        raise MigrationError("fixture target must be a new synthetic.sqlite path")
    target.parent.mkdir(parents=True, exist_ok=True)
    with managed_sqlite(target) as connection:
        connection.execute(f"PRAGMA application_id = {SYNTHETIC_APPLICATION_ID}")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(
            """
            CREATE TABLE _synthetic_fixture_marker(generator TEXT PRIMARY KEY, synthetic INTEGER NOT NULL CHECK(synthetic=1));
            CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE projects(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL);
            CREATE TABLE project_units(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), ordinal INTEGER NOT NULL, source_text TEXT NOT NULL);
            CREATE TABLE assets(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), content_hash TEXT NOT NULL);
            CREATE TABLE project_asset_links(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), asset_id TEXT NOT NULL REFERENCES assets(id));
            CREATE TABLE shots(id TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES project_units(id), stable_film_id TEXT NOT NULL UNIQUE);
            """
        )
        connection.execute(
            "INSERT INTO _synthetic_fixture_marker VALUES(?,1)",
            (FIXTURE_GENERATOR,),
        )
        connection.executemany(
            "INSERT INTO users VALUES(?,?)",
            [("user-001", "Synthetic A"), ("user-002", "Synthetic B")],
        )
        connection.executemany(
            "INSERT INTO projects VALUES(?,?,?)",
            [
                ("project-001", "user-001", "Synthetic Project A"),
                ("project-002", "user-002", "Synthetic Project B"),
            ],
        )
        connection.executemany(
            "INSERT INTO project_units VALUES(?,?,?,?)",
            [
                ("unit-001", "project-001", 1, "INT. ROOM - DAY"),
                ("unit-002", "project-001", 2, "INT. HALL - NIGHT"),
                ("unit-003", "project-002", 1, "EXT. STREET - DAY"),
            ],
        )
        connection.executemany(
            "INSERT INTO assets VALUES(?,?,?)",
            [
                ("asset-001", "user-001", "a" * 64),
                ("asset-002", "user-002", "b" * 64),
            ],
        )
        connection.executemany(
            "INSERT INTO project_asset_links VALUES(?,?,?)",
            [
                ("link-001", "project-001", "asset-001"),
                ("link-002", "project-002", "asset-002"),
            ],
        )
        connection.executemany(
            "INSERT INTO shots VALUES(?,?,?)",
            [
                ("shot-001", "unit-001", "10000000-0000-4000-8000-000000000001"),
                ("shot-002", "unit-002", "20000000-0000-4000-8000-000000000002"),
                ("shot-003", "unit-003", "30000000-0000-4000-8000-000000000003"),
            ],
        )
    sidecar = target.with_name(target.name + FIXTURE_SIDECAR_SUFFIX)
    sidecar.write_bytes(canonical_json({"generator": FIXTURE_GENERATOR, "synthetic": True}))
    return target


def run_demo(root: str | Path) -> dict[str, Any]:
    sandbox = Path(root)
    sandbox.mkdir(parents=True, exist_ok=True)
    (sandbox / SANDBOX_MARKER).write_text("synthetic only\n", encoding="utf-8")
    source = create_synthetic_fixture(sandbox / "source" / "synthetic.sqlite")
    engine = SyntheticMigration(sandbox, enabled=True)
    package = sandbox / "package"
    built = engine.build_package(source, package, migration_key="synthetic_beta_001")
    target = sandbox / "target.sqlite"
    try:
        engine.apply_local_equivalent(package, target, fault_after_rows=3)
    except FaultInjected:
        fault_rollback = True
    else:
        fault_rollback = False
    applied = engine.apply_local_equivalent(package, target)
    replay = engine.apply_local_equivalent(package, target)
    restored = engine.backup_and_restore(package, target, sandbox / "restored.sqlite")
    rollback = engine.rollback_local(package, target)
    return {
        "status": "PASSED_LOCAL_EQUIVALENT",
        "real_postgresql_status": built["real_postgresql_status"],
        "package_verified": built["verified"],
        "fault_rollback": fault_rollback,
        "apply": applied,
        "replay_same_receipt": replay["receipt_id"] == applied["receipt_id"],
        "restore": restored,
        "rollback": rollback,
    }
