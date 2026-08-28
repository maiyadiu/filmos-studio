from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "upstream"))

from rc_schema_adapter import (  # noqa: E402
    CANDIDATE_COMMIT,
    EXPECTED_MIGRATION_TABLES,
    SANDBOX_MARKER,
    CandidateAdapterError,
    CandidateFaultInjected,
    CandidateSchemaAdapter,
    create_stable_fixture,
    inspect_pinned_diff,
    run_candidate_demo,
    sha256_file,
)
from frozen_upstream import prepare_frozen_upstream  # noqa: E402


class CandidateSchemaAdapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.upstream_temporary = tempfile.TemporaryDirectory(
            prefix="filmos-rc-adapter-upstream-"
        )
        cls.upstream_repo = Path(cls.upstream_temporary.name) / "upstream.git"
        prepare_frozen_upstream(cls.upstream_repo)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.upstream_temporary.cleanup()

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="filmos-rc-adapter-test-")
        self.root = Path(self.temporary.name)
        (self.root / SANDBOX_MARKER).write_text("synthetic only\n", encoding="utf-8")
        self.source = create_stable_fixture(self.root / "source" / "stable.sqlite")
        self.engine = CandidateSchemaAdapter(
            self.root, self.upstream_repo, enabled=True
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_pinned_real_diff_matches_adapter_contract(self) -> None:
        result = inspect_pinned_diff(self.upstream_repo)
        self.assertEqual(result["candidate_commit"], CANDIDATE_COMMIT)
        self.assertEqual(
            result["changed_models"],
            [
                "ChannelModel.Icon",
                "PluginPlatformState",
                "StorageLocation",
                "UserPluginState",
            ],
        )
        self.assertEqual(
            result["migration_list_additions"], list(EXPECTED_MIGRATION_TABLES)
        )
        self.assertEqual(result["classification_before"], "C_MIGRATION_REQUIRED")

    def test_default_off_and_fixture_identity_reject_non_synthetic_source(self) -> None:
        disabled = CandidateSchemaAdapter(self.root, self.upstream_repo)
        with self.assertRaisesRegex(CandidateAdapterError, "disabled by default"):
            disabled.dry_run(self.source)
        with tempfile.TemporaryDirectory(prefix="filmos-rc-outside-") as outside:
            fake = Path(outside) / "stable.sqlite"
            fake.write_bytes(b"not a synthetic fixture")
            with self.assertRaisesRegex(CandidateAdapterError, "sandbox-contained"):
                self.engine.dry_run(fake)
        sidecar = self.source.with_suffix(".sqlite.fixture.json")
        sidecar.write_text(json.dumps({"synthetic": True}), encoding="utf-8")
        with self.assertRaisesRegex(CandidateAdapterError, "sidecar is invalid"):
            self.engine.dry_run(self.source)

    def test_fault_rolls_back_ddl_without_partial_schema_or_facts(self) -> None:
        source_hash = sha256_file(self.source)
        with self.assertRaises(CandidateFaultInjected):
            self.engine.dry_run(self.source, fault_after_step=8)
        self.assertEqual(sha256_file(self.source), source_hash)
        with closing(sqlite3.connect(self.root / "candidate.sqlite")) as connection:
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            columns = [
                row[1]
                for row in connection.execute("PRAGMA table_info(channel_models)")
            ]
        self.assertNotIn("icon", columns)
        self.assertTrue(
            {
                "plugin_platform_states",
                "storage_locations",
                "user_plugin_states",
            }.isdisjoint(tables)
        )

    def test_replay_preserves_source_stable_ids_and_receipt(self) -> None:
        source_hash = sha256_file(self.source)
        receipt = self.engine.replay(self.source)
        self.assertEqual(receipt["status"], "PASSED_SYNTHETIC_REVERSIBLE_DRY_RUN")
        self.assertTrue(receipt["replayed_same_receipt"])
        self.assertTrue(receipt["source_unchanged"])
        self.assertTrue(receipt["stable_ids_preserved"])
        self.assertTrue(receipt["no_partial_facts"])
        self.assertEqual(sha256_file(self.source), source_hash)
        self.assertEqual(receipt["classification_after"], "C_MIGRATION_REQUIRED")
        self.assertEqual(receipt["real_database"], "NOT_OPENED")
        self.assertEqual(receipt["real_postgresql"], "NOT_EXECUTED")
        self.assertEqual(receipt["candidate_merge"], "NOT_EXECUTED")
        self.assertEqual(
            receipt["candidate_probe_ids"],
            [
                "plugin.synthetic.rc",
                "10000000-0000-4000-8000-000000000014",
                "10000000-0000-4000-8000-000000000015",
            ],
        )

    def test_rollback_restores_exact_stable_fixture_and_removes_candidate_schema(self) -> None:
        receipt = self.engine.dry_run(self.source)
        result = self.engine.rollback(receipt)
        self.assertEqual(result["status"], "PASSED_EXACT_STABLE_ROLLBACK")
        self.assertTrue(result["matches_pre_migration_backup"])
        self.assertTrue(result["stable_ids_preserved"])
        self.assertTrue(result["candidate_tables_absent"])

    def test_tampered_backup_is_rejected(self) -> None:
        receipt = self.engine.dry_run(self.source)
        backup = self.root / "stable-backup.sqlite"
        backup.write_bytes(backup.read_bytes() + b"tamper")
        with self.assertRaisesRegex(CandidateAdapterError, "backup hash mismatch"):
            self.engine.rollback(receipt)

    def test_full_demo_retains_c_classification(self) -> None:
        with tempfile.TemporaryDirectory(prefix="filmos-rc-adapter-demo-") as directory:
            result = run_candidate_demo(directory, self.upstream_repo)
        self.assertEqual(result["status"], "PASSED_SYNTHETIC_REVERSIBLE_DRY_RUN")
        self.assertTrue(result["fault_rollback"])
        self.assertTrue(result["source_unchanged"])
        self.assertEqual(result["classification"], "C_MIGRATION_REQUIRED")
        self.assertEqual(result["rollback"]["status"], "PASSED_EXACT_STABLE_ROLLBACK")


if __name__ == "__main__":
    unittest.main()
