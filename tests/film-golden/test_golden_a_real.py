#!/usr/bin/env python3
from __future__ import annotations

import os
import unittest
from uuid import UUID

from golden_a_real import REQUIRED_D0005_OPERATIONS, FilmCoreHttpClient, MissingCoreOperation, run_real_golden_a


class GoldenARealSidecarTest(unittest.TestCase):
    def test_real_core_runs_full_candidate_qc_and_human_approval_chain(self) -> None:
        result = run_real_golden_a(python_executable=os.environ.get("FILMOS_CORE_PYTHON"))
        self.assertEqual(result["test_status"], "PASSED")
        self.assertEqual(result["sidecar"]["health"], "ok")
        self.assertEqual(result["sidecar"]["database"], "temporary_sqlite_sidecar")
        self.assertEqual(result["external_provider_calls"], 0)
        self.assertTrue(result["prepared"])
        self.assertTrue(result["persisted"])
        self.assertTrue(result["reviewed"])
        self.assertTrue(result["approved"])
        self.assertFalse(result["fallback_mock_used"])
        self.assertEqual(result["script_lock"]["source_lock_state"], "unlocked")
        self.assertEqual(result["script_lock"]["locked_state"], "locked")
        self.assertTrue(result["script_lock"]["nonhuman_blocked"])
        self.assertEqual(result["canvas"]["nodeCount"], 3)
        self.assertEqual(result["canvas"]["edgeCount"], 1)
        self.assertEqual(result["canvas"]["sourceVersion"], 1)
        self.assertEqual(len(result["canvas"]["sourceHash"]), 64)
        self.assertEqual(result["prompt"]["local_audit"], "PASS")
        self.assertEqual(result["manual_provider"]["local_candidate_state"], "candidate")
        self.assertEqual(result["manual_provider"]["local_approval_state"], "not_approved")
        self.assertTrue(result["qc"]["continuity_passed"])
        self.assertEqual(result["qc"]["reviewer_kind"], "automated_qc")
        self.assertTrue(result["candidate"]["unchanged_after_approval"])
        self.assertTrue(result["approval"]["separate_from_candidate"])
        self.assertTrue(all(result["conflict_recovery"].values()))
        for formal_id in result["formal_ids"].values():
            self.assertEqual(UUID(formal_id).version, 4)
        for aggregate, raw in (
            ("directorRecordHash", "directorRawHash"),
            ("visualLockRecordHash", "visualLockRawHash"),
            ("assetRecordHash", "assetSourceHash"),
        ):
            self.assertNotEqual(result["source_hashes"][aggregate], result["source_hashes"][raw])
        self.assertIn("POST /script-versions/lock", result["operations"])

    def test_operation_adapter_requires_every_d0005_path(self) -> None:
        client = FilmCoreHttpClient("http://127.0.0.1:1")
        client.operations = lambda: {  # type: ignore[method-assign]
            (method, path): object() for method, path in REQUIRED_D0005_OPERATIONS[:-1]
        }
        with self.assertRaises(MissingCoreOperation) as captured:
            client.require_d0005_operations()
        self.assertEqual(captured.exception.operations, ["POST /continuity/check"])


if __name__ == "__main__":
    unittest.main()
