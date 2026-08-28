#!/usr/bin/env python3
from __future__ import annotations

import json
import unittest
from pathlib import Path


SPEC_PATH = Path(__file__).with_name("golden-c.json")


class GoldenCCheckedInSpecTest(unittest.TestCase):
    def setUp(self) -> None:
        self.spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))

    def test_pipeline_and_three_independent_camera_chains_are_locked(self) -> None:
        self.assertEqual(
            self.spec["pipeline"],
            [
                "SceneTwin",
                "3 Cameras",
                "Blocking",
                "Composition",
                "Previs",
                "Prompt/Provider",
                "Video",
                "Spatial Continuity QC",
            ],
        )
        minimums = self.spec["minimums"]
        for key in (
            "shots",
            "camera_versions",
            "blocking_versions",
            "composition_versions",
            "previs_projections",
            "video_candidates",
        ):
            self.assertGreaterEqual(minimums[key], 3)
        self.assertEqual(len(self.spec["camera_plan"]), 3)

    def test_scene_twin_is_cross_shot_spatial_truth_with_pass_lineage(self) -> None:
        contract = self.spec["scene_twin_contract"]
        self.assertTrue(contract["cross_shot_shared"])
        self.assertEqual(
            set(contract["required_pass_lineage"]),
            {"rgb", "depth", "normal", "object_id"},
        )
        self.assertEqual(
            set(contract["required_collections"]),
            {
                "fixed_architecture",
                "fixed_props",
                "portals",
                "walkable_zones",
                "anchors",
                "camera_zones",
                "approved_view_families",
            },
        )

    def test_formal_version_and_candidate_boundaries_are_explicit(self) -> None:
        invariants = set(self.spec["version_invariants"])
        self.assertIn(
            "camera_blocking_and_composition_have_independent_film_entity_ids",
            invariants,
        )
        self.assertIn(
            "previs_is_a_hash_bound_local_projection_not_an_approved_formal_version",
            invariants,
        )
        self.assertIn("canvas_or_3d_projection_never_auto_approves", invariants)
        self.assertIn(
            "video_result_remains_candidate_until_separate_human_review_and_approval",
            invariants,
        )
        self.assertEqual(
            self.spec["blocking_interaction_chain"],
            ["feet", "torso", "face", "gaze", "hands", "target_prop"],
        )
        self.assertEqual(
            set(self.spec["camera_requirements"]),
            {"axis_id", "anchor_id", "camera_zone_id", "approved_view_family_id"},
        )
        self.assertIn("safe_area", self.spec["composition_requirements"])
        self.assertIn("occlusion_checks", self.spec["composition_requirements"])

    def test_production_canvas_and_recovery_are_fail_closed(self) -> None:
        canvas = self.spec["production_canvas_boundary"]
        self.assertTrue(canvas["single_default_per_project_unit"])
        self.assertTrue(canvas["concurrent_get_or_create_is_idempotent"])
        self.assertTrue(canvas["duplicate_history_is_report_only"])
        cases = set(self.spec["recovery_cases"])
        self.assertIn("transaction_failure_has_zero_partial_formal_writes", cases)
        self.assertIn(
            "stale_version_or_hash_guard_has_zero_partial_formal_writes", cases
        )
        self.assertIn("external_provider_call_count_remains_zero", cases)

    def test_spec_is_not_an_execution_receipt_or_mock_permission(self) -> None:
        execution = self.spec["execution"]
        self.assertEqual(execution["test_status"], "NOT_RUN")
        self.assertEqual(execution["external_provider_calls"], 0)
        self.assertFalse(execution["fallback_mock_allowed"])
        self.assertTrue(execution["formal_write_requires_real_sidecar"])


if __name__ == "__main__":
    unittest.main()
