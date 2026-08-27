#!/usr/bin/env python3
from __future__ import annotations

import unittest

from golden_a_mock import GoldenAContractError, GoldenARunner, MockFormalStore, load_spec


class GoldenAOfflineSpecTest(unittest.TestCase):
    def test_checked_in_spec_is_not_a_fake_execution_receipt(self) -> None:
        spec = load_spec()
        self.assertEqual(spec["execution"]["test_status"], "NOT_RUN")
        self.assertFalse(spec["execution"]["external_provider_calls"])
        self.assertEqual(
            set(spec["artifact_states"].values()), {"Candidate", "Approved"}
        )

    def test_candidate_cannot_skip_review_and_approval(self) -> None:
        runner = GoldenARunner(load_spec())
        runner._validate_spec()
        runner._create_chain_entities()
        runner.import_manual_result()
        with self.assertRaisesRegex(GoldenAContractError, "without passed Review"):
            runner.approve_candidate()
        self.assertEqual(runner.candidate_state, "Candidate")

    def test_stale_expected_version_fails_closed(self) -> None:
        store = MockFormalStore()
        entity_id = "00000000-0000-4000-8000-000000000001"
        store.write(
            entity_id=entity_id,
            entity_type="Project",
            expected_version=0,
            payload={"name": "Golden A"},
        )
        with self.assertRaisesRegex(GoldenAContractError, "expected_version mismatch"):
            store.write(
                entity_id=entity_id,
                entity_type="Project",
                expected_version=0,
                payload={"name": "stale write"},
            )

    def test_offline_happy_path_reports_test_and_artifact_states_separately(self) -> None:
        runner = GoldenARunner(load_spec())
        result = runner.run()
        self.assertEqual(result["checked_in_status"], "NOT_RUN")
        self.assertEqual(result["test_status"], "PASSED")
        self.assertEqual(result["seen_artifact_states"], ["Candidate", "Approved"])
        self.assertEqual(result["artifact_state"], "Approved")
        self.assertEqual(result["external_provider_calls"], 0)
        self.assertNotEqual(runner.ids["DirectorUnit"], runner.ids["Shot"])
        self.assertEqual(
            set(result["observability"]), set(load_spec()["required_observability"])
        )


if __name__ == "__main__":
    unittest.main()
