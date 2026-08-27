#!/usr/bin/env python3
"""Golden A offline executable specification.

This module models only the acceptance contract. It never starts a service,
touches project data, or calls an external provider.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SPEC_PATH = Path(__file__).with_name("golden-a.json")
TEST_STATUSES = {"NOT_RUN", "PASSED", "FAILED"}
ARTIFACT_STATES = {"Candidate", "Approved"}


class GoldenAContractError(RuntimeError):
    """Raised when the mock chain violates a Golden A invariant."""


def _entity_id(index: int) -> str:
    return f"00000000-0000-4000-8000-{index:012x}"


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass
class EntityVersion:
    entity_id: str
    entity_type: str
    version: int
    content_hash: str


class MockFormalStore:
    """Minimal versioned store that fails closed on stale writes."""

    def __init__(self) -> None:
        self.entities: dict[str, EntityVersion] = {}
        self.events: list[dict[str, Any]] = []

    def write(
        self,
        *,
        entity_id: str,
        entity_type: str,
        expected_version: int,
        payload: dict[str, Any],
    ) -> EntityVersion:
        current = self.entities.get(entity_id)
        current_version = current.version if current else 0
        if expected_version != current_version:
            raise GoldenAContractError(
                f"expected_version mismatch for {entity_type}: "
                f"expected {expected_version}, current {current_version}"
            )
        version = current_version + 1
        content_hash = _hash(json.dumps(payload, sort_keys=True, separators=(",", ":")))
        entity = EntityVersion(entity_id, entity_type, version, content_hash)
        self.entities[entity_id] = entity
        self.events.append(
            {
                "entity_id": entity_id,
                "entity_type": entity_type,
                "expected_version": expected_version,
                "version": version,
                "content_hash": content_hash,
            }
        )
        return entity


class GoldenARunner:
    def __init__(self, spec: dict[str, Any]) -> None:
        self.spec = spec
        self.store = MockFormalStore()
        self.external_provider_calls = 0
        self.candidate_id = _entity_id(12)
        self.candidate_state: str | None = None
        self.review_passed = False
        self.approval_recorded = False
        self.seen_artifact_states: list[str] = []
        self.ids: dict[str, str] = {}

    def _validate_spec(self) -> None:
        execution = self.spec["execution"]
        allowed = set(execution["allowed_test_statuses"])
        if execution["test_status"] != "NOT_RUN":
            raise GoldenAContractError("checked-in Golden A spec must remain NOT_RUN")
        if allowed != TEST_STATUSES:
            raise GoldenAContractError("Golden A test status vocabulary drifted")
        if execution["external_provider_calls"] is not False:
            raise GoldenAContractError("Golden A baseline must forbid external providers")
        declared_artifact_states = set(self.spec["artifact_states"].values())
        if declared_artifact_states != ARTIFACT_STATES:
            raise GoldenAContractError("Golden A artifact state vocabulary drifted")

    def _create_chain_entities(self) -> None:
        for index, step in enumerate(self.spec["steps"][:10], start=1):
            entity_id = _entity_id(index)
            self.ids[step] = entity_id
            self.store.write(
                entity_id=entity_id,
                entity_type=step,
                expected_version=0,
                payload={"golden_id": self.spec["golden_id"], "step": step},
            )
        if self.ids["DirectorUnit"] == self.ids["Shot"]:
            raise GoldenAContractError("DirectorUnit and Shot must be separate entities")

    def import_manual_result(self) -> None:
        if self.external_provider_calls != 0:
            raise GoldenAContractError("external provider was called")
        candidate = self.store.write(
            entity_id=self.candidate_id,
            entity_type="Candidate",
            expected_version=0,
            payload={
                "generation_package_id": self.ids["ManualProviderResult"],
                "output_hash": _hash("offline-manual-result"),
                "artifact_state": "Candidate",
            },
        )
        self.ids["Candidate"] = candidate.entity_id
        self.candidate_state = "Candidate"
        self.seen_artifact_states.append("Candidate")

    def approve_candidate(self) -> None:
        if self.candidate_state != "Candidate":
            raise GoldenAContractError("only a Candidate can enter approval")
        if not self.review_passed or not self.approval_recorded:
            raise GoldenAContractError(
                "Candidate cannot become Approved without passed Review and Approval"
            )
        current = self.store.entities[self.candidate_id]
        self.store.write(
            entity_id=self.candidate_id,
            entity_type="Candidate",
            expected_version=current.version,
            payload={"artifact_state": "Approved", "approved_hash": current.content_hash},
        )
        self.candidate_state = "Approved"
        self.seen_artifact_states.append("Approved")

    def record_qc_and_approval(self) -> None:
        review = self.store.write(
            entity_id=_entity_id(13),
            entity_type="Review",
            expected_version=0,
            payload={
                "target_id": self.candidate_id,
                "review_state": "passed",
                "reviewer_kind": "automated_qc",
            },
        )
        self.ids["QC"] = review.entity_id
        self.review_passed = True
        approval = self.store.write(
            entity_id=_entity_id(14),
            entity_type="Approval",
            expected_version=0,
            payload={
                "target_id": self.candidate_id,
                "approved_by": "golden-a-independent-mock",
                "approved_content_hash": self.store.entities[self.candidate_id].content_hash,
            },
        )
        self.ids["Approved"] = approval.entity_id
        self.approval_recorded = True

    def _observability(self) -> dict[str, str]:
        fields = {
            "trace_id": "golden-a-offline-trace",
            "project_id": self.ids["Project"],
            "unit_id": self.ids["ContentUnit"],
            "shot_id": self.ids["Shot"],
            "task_id": self.ids["ManualProviderResult"],
            "provider_task_id": "manual-mock-task-1",
            "visual_lock_hash": _hash("golden-a-visual-lock"),
            "prompt_hash": _hash("golden-a-prompt"),
            "input_hash": _hash("golden-a-input"),
            "output_hash": _hash("offline-manual-result"),
        }
        required = set(self.spec["required_observability"])
        if set(fields) != required or not all(fields.values()):
            raise GoldenAContractError("Golden A observability fields are incomplete")
        return fields

    def run(self) -> dict[str, Any]:
        self._validate_spec()
        self._create_chain_entities()
        self.import_manual_result()

        gate_was_enforced = False
        try:
            self.approve_candidate()
        except GoldenAContractError:
            gate_was_enforced = True
        if not gate_was_enforced:
            raise GoldenAContractError("approval gate did not fail closed")

        self.record_qc_and_approval()
        self.approve_candidate()
        if self.candidate_state != "Approved":
            raise GoldenAContractError("Golden A did not reach Approved")
        if self.external_provider_calls != 0:
            raise GoldenAContractError("Golden A crossed an external provider boundary")
        return {
            "golden_id": self.spec["golden_id"],
            "test_status": "PASSED",
            "checked_in_status": self.spec["execution"]["test_status"],
            "artifact_state": self.candidate_state,
            "seen_artifact_states": self.seen_artifact_states,
            "external_provider_calls": self.external_provider_calls,
            "formal_write_count": len(self.store.events),
            "observability": self._observability(),
        }


def load_spec(path: Path = SPEC_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def run_golden_a() -> dict[str, Any]:
    return GoldenARunner(load_spec()).run()
