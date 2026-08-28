#!/usr/bin/env python3
from __future__ import annotations

import json
import unittest
from pathlib import Path


SPEC_PATH = Path(__file__).with_name("golden-b.json")


class GoldenBCheckedInSpecTest(unittest.TestCase):
    def setUp(self) -> None:
        self.spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))

    def test_spec_is_not_a_fake_execution_receipt(self) -> None:
        execution = self.spec["execution"]
        self.assertEqual(execution["test_status"], "NOT_RUN")
        self.assertFalse(execution["external_provider_calls"])
        self.assertFalse(execution["fallback_mock_allowed"])

    def test_multi_dialogue_and_many_to_many_minimums_are_locked(self) -> None:
        minimums = self.spec["minimums"]
        self.assertGreaterEqual(len(self.spec["cast"]), 3)
        self.assertGreaterEqual(minimums["dialogue_cues"], 6)
        self.assertGreater(minimums["coverage_links"], minimums["director_units"])
        self.assertGreater(minimums["coverage_links"], minimums["shots"])

    def test_j_cut_never_exempts_visual_continuity(self) -> None:
        policy = self.spec["j_cut_policy"]
        self.assertEqual(policy["allowed_exception"], "audio_lead_only")
        self.assertEqual(
            set(policy["must_not_exempt"]), set(self.spec["continuity_dimensions"])
        )

    def test_precise_stale_and_state_axis_invariants_are_explicit(self) -> None:
        cases = set(self.spec["impact_cases"])
        self.assertIn("unrelated_shot_prompt_and_candidate_remain_fresh", cases)
        self.assertIn("stale_guard_failure_has_zero_partial_writes", cases)
        self.assertTrue(
            any("independently" in item for item in self.spec["invariants"])
        )


if __name__ == "__main__":
    unittest.main()
