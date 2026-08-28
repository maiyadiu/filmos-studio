from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "migration"))

from synthetic_migration import (  # noqa: E402
    FIXTURE_GENERATOR,
    FaultInjected,
    MigrationError,
    SANDBOX_MARKER,
    SyntheticMigration,
    create_synthetic_fixture,
    postgres_status,
    sha256_file,
)


class SyntheticMigrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="filmos-migration-test-")
        self.root = Path(self.temporary.name)
        (self.root / SANDBOX_MARKER).write_text("synthetic only\n", encoding="utf-8")
        self.source = create_synthetic_fixture(self.root / "source" / "synthetic.sqlite")
        self.engine = SyntheticMigration(self.root, enabled=True)
        self.package = self.root / "package"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def build(self, key: str = "synthetic_beta_001") -> dict:
        return self.engine.build_package(self.source, self.package, migration_key=key)

    def test_default_off_marker_containment_and_fixture_identity(self) -> None:
        disabled = SyntheticMigration(self.root)
        with self.assertRaisesRegex(MigrationError, "disabled by default"):
            disabled.build_package(self.source, self.package, migration_key="synthetic_beta_001")
        with tempfile.TemporaryDirectory(prefix="filmos-outside-") as outside_dir:
            outside = Path(outside_dir) / "synthetic.sqlite"
            outside.write_bytes(b"not a database")
            with self.assertRaisesRegex(MigrationError, "inside the marked sandbox"):
                self.engine.build_package(outside, self.package, migration_key="synthetic_beta_001")
        sidecar = self.source.with_name(self.source.name + ".fixture.json")
        sidecar.write_text(json.dumps({"generator": "forged", "synthetic": True}))
        with self.assertRaisesRegex(MigrationError, "sidecar is invalid"):
            self.engine.build_package(self.source, self.package, migration_key="synthetic_beta_001")

    def test_postgresql_compatible_package_is_deterministic_and_source_immutable(self) -> None:
        source_hash = sha256_file(self.source)
        result = self.build()
        self.assertTrue(result["verified"])
        self.assertEqual(result["real_postgresql_status"], "BLOCKED_REAL_PG")
        self.assertEqual(result["table_count"], 6)
        self.assertEqual(result["row_count"], 14)
        self.assertEqual(sha256_file(self.source), source_hash)
        load = (self.package / "load.psql").read_text(encoding="utf-8")
        self.assertIn("\\set ON_ERROR_STOP on", load)
        self.assertEqual(load.count("\\copy "), 6)
        self.assertIn("BEGIN;", load)
        self.assertIn("COMMIT;", load)

    def test_package_tamper_is_detected(self) -> None:
        self.build()
        csv_path = self.package / "payload" / "users.csv"
        csv_path.write_text(csv_path.read_text() + "forged,user\n")
        with self.assertRaisesRegex(MigrationError, "artifact failed verification"):
            self.engine.verify_package(self.package)

    def test_fault_injection_rolls_back_all_rows_then_retry_succeeds(self) -> None:
        self.build()
        target = self.root / "target.sqlite"
        with self.assertRaises(FaultInjected):
            self.engine.apply_local_equivalent(
                self.package, target, fault_after_rows=4
            )
        with closing(sqlite3.connect(target)) as connection:
            counts = [
                connection.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
                for name in ("users", "projects", "project_units", "assets", "project_asset_links", "shots")
            ]
        self.assertEqual(counts, [0, 0, 0, 0, 0, 0])
        receipt = self.engine.apply_local_equivalent(self.package, target)
        self.assertEqual(receipt["status"], "PASSED_LOCAL_EQUIVALENT")
        self.assertTrue(receipt["foreign_keys_valid"])
        self.assertTrue(receipt["stable_primary_keys_preserved"])
        self.assertEqual(receipt["row_count"], 14)

    def test_idempotent_replay_returns_same_receipt_and_no_duplicate_rows(self) -> None:
        self.build()
        target = self.root / "target.sqlite"
        first = self.engine.apply_local_equivalent(self.package, target)
        second = self.engine.apply_local_equivalent(self.package, target)
        self.assertEqual(first["receipt_id"], second["receipt_id"])
        self.assertTrue(second["replayed"])
        with closing(sqlite3.connect(target)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM shots").fetchone()[0], 3)
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_backup_restore_preserves_hash_rows_foreign_keys_ids_and_receipt(self) -> None:
        self.build()
        target = self.root / "target.sqlite"
        applied = self.engine.apply_local_equivalent(self.package, target)
        result = self.engine.backup_and_restore(
            self.package, target, self.root / "restored.sqlite"
        )
        self.assertEqual(result["status"], "PASSED_LOCAL_RESTORE")
        self.assertEqual(result["target_data_sha256"], applied["target_data_sha256"])
        self.assertTrue(result["receipt_preserved"])

    def test_rollback_uses_bound_backup_and_refuses_changed_target(self) -> None:
        self.build()
        target = self.root / "target.sqlite"
        self.engine.apply_local_equivalent(self.package, target)
        with closing(sqlite3.connect(target)) as connection:
            connection.execute("UPDATE users SET name='changed' WHERE id='user-001'")
            connection.commit()
        with self.assertRaisesRegex(MigrationError, "target row verification failed"):
            self.engine.rollback_local(self.package, target)

    def test_rollback_restores_preimport_target_without_deleting_source(self) -> None:
        self.build()
        source_hash = sha256_file(self.source)
        target = self.root / "target.sqlite"
        self.engine.apply_local_equivalent(self.package, target)
        result = self.engine.rollback_local(self.package, target)
        self.assertEqual(result["status"], "PASSED_LOCAL_ROLLBACK")
        self.assertFalse(result["source_deleted"])
        self.assertEqual(sha256_file(self.source), source_hash)
        with closing(sqlite3.connect(target)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM users").fetchone()[0], 0)

    def test_same_key_different_manifest_is_rejected(self) -> None:
        self.build()
        target = self.root / "target.sqlite"
        self.engine.apply_local_equivalent(self.package, target)
        second_root = self.root / "second"
        second_root.mkdir()
        second_source = create_synthetic_fixture(second_root / "synthetic.sqlite")
        with closing(sqlite3.connect(second_source)) as connection:
            connection.execute("UPDATE users SET name='Different' WHERE id='user-001'")
            connection.commit()
        second_package = self.root / "package-two"
        self.engine.build_package(
            second_source, second_package, migration_key="synthetic_beta_001"
        )
        with self.assertRaisesRegex(MigrationError, "different manifest"):
            self.engine.apply_local_equivalent(second_package, target)

    def test_real_postgresql_is_explicitly_blocked_on_this_host(self) -> None:
        self.assertEqual(postgres_status(), "BLOCKED_REAL_PG")


if __name__ == "__main__":
    unittest.main()
