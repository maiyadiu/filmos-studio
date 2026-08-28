from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "recovery"))

from rc_recovery import (  # noqa: E402
    FILM_CORE_AUDIT_ID,
    FILM_CORE_ENTITY_ID,
    RCRecoveryError,
    run_film_core_recovery,
    run_rc_recovery,
    write_receipt,
)


class RCRecoveryTest(unittest.TestCase):
    def test_film_core_backup_fault_rollback_restore_and_receipt(self) -> None:
        with tempfile.TemporaryDirectory(prefix="filmos-rc-core-test-") as directory:
            result = run_film_core_recovery(directory)
        self.assertEqual(result["status"], "PASSED_LOCAL_FILM_CORE_RECOVERY")
        self.assertEqual(result["schema_version"], 4)
        self.assertEqual(
            result["stable_ids"], [FILM_CORE_ENTITY_ID, FILM_CORE_AUDIT_ID]
        )
        self.assertTrue(result["source_unchanged"])
        self.assertTrue(result["receipt_preserved"])
        self.assertTrue(result["foreign_keys_valid"])
        self.assertTrue(result["fault_rollback"])
        self.assertTrue(result["no_partial_facts"])
        self.assertEqual(
            result["logical_state_sha256"],
            result["restored_logical_state_sha256"],
        )

    def test_unified_runner_replays_all_local_surfaces_and_keeps_c_gate(self) -> None:
        with tempfile.TemporaryDirectory(prefix="filmos-rc-runner-test-") as directory:
            result = run_rc_recovery(directory)
        with tempfile.TemporaryDirectory(prefix="filmos-rc-replay-test-") as directory:
            replayed = run_rc_recovery(directory)
        self.assertEqual(result["status"], "PASSED_LOCAL_RC_RECOVERY")
        self.assertEqual(result["failures"], [])
        self.assertTrue(all(result["checks"].values()))
        self.assertEqual(result["upstream_classification"], "C_MIGRATION_REQUIRED")
        self.assertEqual(
            result["authority_boundaries"],
            {
                "real_user_database": "NOT_OPENED",
                "real_postgresql": "NOT_EXECUTED",
                "network_publish": "NOT_EXECUTED",
                "external_provider": "NOT_EXECUTED",
                "formal_apply": "NOT_EXECUTED",
                "upstream_merge": "NOT_EXECUTED",
            },
        )
        self.assertRegex(result["receipt_id"], r"^[0-9a-f-]{36}$")
        self.assertEqual(result["receipt_id"], replayed["receipt_id"])
        self.assertEqual(
            result["replay_key_sha256"], replayed["replay_key_sha256"]
        )
        self.assertRegex(result["receipt_sha256"], r"^[0-9a-f]{64}$")

    def test_receipt_write_is_create_only(self) -> None:
        with tempfile.TemporaryDirectory(prefix="filmos-rc-receipt-test-") as directory:
            path = Path(directory) / "receipt.json"
            write_receipt(path, {"status": "synthetic"})
            self.assertEqual(json.loads(path.read_text()), {"status": "synthetic"})
            with self.assertRaisesRegex(RCRecoveryError, "refusing to overwrite"):
                write_receipt(path, {"status": "changed"})

    def test_cli_requires_explicit_synthetic_acknowledgement(self) -> None:
        result = subprocess.run(
            [str(ROOT / "scripts" / "recovery" / "RC恢复演练")],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--synthetic is required", result.stderr)


if __name__ == "__main__":
    unittest.main()
