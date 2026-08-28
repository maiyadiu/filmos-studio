#!/usr/bin/env python3
from __future__ import annotations

import unittest

from golden_b_real import run_real_golden_b


class GoldenBRealIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.receipt = run_real_golden_b()

    def test_uses_real_core_without_fallback_or_external_generation(self) -> None:
        self.assertEqual(self.receipt["test_status"], "PASSED")
        self.assertTrue(self.receipt["persisted"])
        self.assertFalse(self.receipt["fallback_mock_used"])
        self.assertEqual(self.receipt["external_provider_calls"], 0)

    def test_multi_person_dialogue_and_many_to_many_coverage_are_real(self) -> None:
        self.assertEqual(self.receipt["dialogue"]["cast"], ["A", "B", "C"])
        self.assertGreaterEqual(self.receipt["dialogue"]["cue_count"], 6)
        self.assertTrue(self.receipt["coverage"]["many_to_many"])
        self.assertGreaterEqual(self.receipt["coverage"]["links"], 4)

    def test_approved_character_costume_locks_and_continuity_pass(self) -> None:
        self.assertGreaterEqual(
            self.receipt["approved_asset_bindings"]["character"], 3
        )
        self.assertGreaterEqual(
            self.receipt["approved_asset_bindings"]["costume"], 2
        )
        self.assertTrue(self.receipt["continuity"]["core_passed"])
        self.assertTrue(self.receipt["continuity"]["j_cut_applied"])
        self.assertFalse(self.receipt["continuity"]["j_cut_formal_apply"])
        self.assertEqual(
            set(self.receipt["continuity"]["dimensions"]),
            {"axis", "eyeline", "blocking", "action", "prop_contact"},
        )

    def test_precise_stale_unresolved_and_fresh_targets(self) -> None:
        self.assertTrue(self.receipt["stale"]["script_precise"])
        self.assertTrue(self.receipt["stale"]["visual_precise"])
        self.assertTrue(self.receipt["stale"]["lighting_unresolved"])
        self.assertTrue(self.receipt["stale"]["state_axes_preserved"])
        self.assertTrue(self.receipt["stale"]["fresh_preserved"])
        self.assertEqual(len(self.receipt["stale_target_ids"]), 2)
        self.assertEqual(len(self.receipt["fresh_target_ids"]), 2)

    def test_conflict_is_atomic_and_replay_is_idempotent(self) -> None:
        self.assertTrue(self.receipt["conflict_recovery"]["stale_guard_blocked"])
        self.assertTrue(self.receipt["conflict_recovery"]["zero_partial_writes"])
        self.assertTrue(self.receipt["conflict_recovery"]["recovered_with_current_guard"])
        self.assertTrue(self.receipt["idempotency"]["script_replayed"])
        self.assertTrue(self.receipt["idempotency"]["visual_replayed"])
        self.assertTrue(self.receipt["idempotency"]["same_audit_ids"])


if __name__ == "__main__":
    unittest.main()
