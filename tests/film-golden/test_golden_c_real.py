#!/usr/bin/env python3
from __future__ import annotations

import os
import unittest

from golden_c_real import (
    REQUIRED_GOLDEN_C_OPERATIONS,
    blocked_receipt,
    missing_golden_c_operations,
    run_real_golden_c,
)


class GoldenCRealIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.receipt = run_real_golden_c(
            python_executable=os.environ.get("FILMOS_CORE_PYTHON")
        )

    def test_real_core_and_zero_external_provider_boundary(self) -> None:
        self.assertEqual(self.receipt["test_status"], "PASSED")
        self.assertTrue(self.receipt["persisted"])
        self.assertFalse(self.receipt["fallback_mock_used"])
        self.assertEqual(self.receipt["external_provider_calls"], 0)

    def test_scene_twin_and_three_independent_spatial_chains(self) -> None:
        self.assertEqual(self.receipt["scene_twin"]["version"], 2)
        self.assertTrue(self.receipt["scene_twin"]["create_replayed"])
        self.assertTrue(self.receipt["scene_twin"]["update_replayed"])
        self.assertEqual(
            self.receipt["scene_twin"]["render_passes"],
            ["depth", "normal", "object_id", "rgb"],
        )
        versions = self.receipt["spatial_versions"]
        self.assertEqual(versions["cameras"], 3)
        self.assertEqual(versions["blockings"], 3)
        self.assertEqual(versions["compositions"], 3)
        self.assertTrue(versions["independent_ids"])

    def test_previs_video_and_spatial_continuity_are_local_candidates(self) -> None:
        self.assertEqual(self.receipt["previs"]["projections"], 3)
        self.assertFalse(self.receipt["previs"]["formal_apply"])
        self.assertTrue(all(self.receipt["previs"]["checks"].values()))
        self.assertEqual(self.receipt["video"]["candidates"], 3)
        self.assertTrue(self.receipt["video"]["all_candidate_only"])
        self.assertTrue(self.receipt["continuity"]["core_passed"])
        self.assertTrue(self.receipt["continuity"]["local_spatial_passed"])

    def test_spatial_component_change_marks_only_declared_target_stale(self) -> None:
        stale = self.receipt["stale"]
        self.assertTrue(stale["edge_before_update"])
        self.assertEqual(stale["edge_owner_version"], 1)
        self.assertEqual(stale["updated_owner_version"], 2)
        self.assertTrue(stale["precise"])
        self.assertEqual(stale["changed_component"], "lighting_base")
        self.assertEqual(len(stale["stale_target_ids"]), 1)
        self.assertTrue(stale["unrelated_prompt_fresh"])
        self.assertTrue(stale["candidates_fresh"])
        self.assertTrue(stale["state_axes_preserved"])
        self.assertTrue(stale["replayed"])

    def test_restart_backup_transaction_idempotency_and_stale_guard(self) -> None:
        self.assertTrue(all(self.receipt["recovery"].values()))

    def test_missing_operation_path_is_explicitly_blocked_without_fallback(self) -> None:
        operations = {
            pair: object() for pair in REQUIRED_GOLDEN_C_OPERATIONS[:-1]
        }
        missing = missing_golden_c_operations(operations)
        self.assertEqual(missing, ["POST /impacts/propagate-stale"])
        receipt = blocked_receipt(
            "00000000-0000-4000-8000-000000000000",
            {"status": "ok", "service": "film-production-core"},
            missing,
        )
        self.assertEqual(receipt["test_status"], "BLOCKED_MISSING_CORE_OPERATION")
        self.assertFalse(receipt["fallback_mock_used"])
        self.assertEqual(receipt["external_provider_calls"], 0)


if __name__ == "__main__":
    unittest.main()
