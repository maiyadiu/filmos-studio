from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from film_production_core.database import SQLiteDatabase
from film_production_core.errors import DomainRuleViolation, EntityNotFound


MOCK_ENGINE_ID = "filmos_mock_generation"
ACCEPTANCE_PROJECT_NAME = "FilmOS_Acceptance_Project"
HASH_KEYS = {
    "contentHash", "previewReceiptHash", "routeSnapshotContentHash",
    "authorizedSubmissionSemanticHash", "outputHash",
}
FORBIDDEN_KEYS = {"apiKey", "api_key", "cookie", "cookies", "runtimeKey", "runtime_key", "authorization"}


class GenerationProductionStore:
    """Append-only Film Core authority for V2.4 production-composition receipts."""

    def __init__(self, database: SQLiteDatabase) -> None:
        self.database = database

    def persist_acceptance_authority(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._safe_payload(payload)
        if payload.get("projectName") != ACCEPTANCE_PROJECT_NAME:
            raise DomainRuleViolation("mock_provider_scope_forbidden", "Mock authority is restricted to FilmOS_Acceptance_Project")
        project_id = self._string(payload.get("projectId"), "projectId")
        bindings = self._record(payload.get("bindings"), "bindings")
        policy = self._record(bindings.get("projectPolicy"), "bindings.projectPolicy")
        lock = self._record(bindings.get("projectLock"), "bindings.projectLock")
        connection = self._record(bindings.get("connection"), "bindings.connection")
        catalog = self._record(bindings.get("catalog"), "bindings.catalog")
        grant = self._record(bindings.get("grant"), "bindings.grant")
        ledger = self._record(bindings.get("ledger"), "bindings.ledger")
        if policy.get("projectId") != project_id or lock.get("projectId") != project_id or grant.get("projectId") != project_id or ledger.get("projectId") != project_id:
            raise DomainRuleViolation("generation_authority_project_mismatch", "Project Policy, Lock, Grant and Ledger must bind the requested project")
        for field, record in {
            "projectPolicy": policy,
            "projectLock": lock,
            "connection": connection,
            "catalog": catalog,
            "grant": grant,
            "ledger": ledger,
        }.items():
            self._hash(record.get("contentHash"), f"bindings.{field}.contentHash")
        if connection.get("engineId") != MOCK_ENGINE_ID or catalog.get("engineId") != MOCK_ENGINE_ID:
            raise DomainRuleViolation("generation_authority_engine_mismatch", "Acceptance authority must use the dedicated local Mock Engine")
        content_hash = self._canonical_hash(payload)
        return self._insert(
            record_id=project_id,
            record_kind="acceptance_authority",
            generation_attempt_id=f"authority:{project_id}",
            content_hash=content_hash,
            payload=payload,
        )

    def acceptance_authority(self, project_id: str) -> dict[str, Any]:
        return self._get("acceptance_authority", "record_id", project_id)

    def persist_preview(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._safe_payload(payload)
        route = self._record(payload.get("routeSnapshot"), "routeSnapshot")
        proposal = self._record(payload.get("proposal"), "proposal")
        if route.get("engineId") == MOCK_ENGINE_ID and payload.get("projectName") != ACCEPTANCE_PROJECT_NAME:
            raise DomainRuleViolation("mock_provider_scope_forbidden", "Mock Provider is restricted to FilmOS_Acceptance_Project")
        if proposal.get("externalCostMicrounits") != "0" or proposal.get("externalWritePerformed") is not False:
            raise DomainRuleViolation("preview_external_effect_forbidden", "Production preview must have zero external cost and writes")
        return self._insert(
            record_id=self._string(proposal.get("proposalId"), "proposal.proposalId"),
            record_kind="preview",
            generation_attempt_id=self._string(payload.get("generationAttemptId"), "generationAttemptId"),
            proposal_id=self._string(proposal.get("proposalId"), "proposal.proposalId"),
            content_hash=self._hash(proposal.get("previewReceiptHash"), "proposal.previewReceiptHash"),
            payload=payload,
        )

    def preview(self, proposal_id: str) -> dict[str, Any]:
        return self._get("preview", "proposal_id", proposal_id)

    def reject(self, proposal_id: str, decision_id: str, trace_event: dict[str, Any]) -> dict[str, Any]:
        preview = self.preview(proposal_id)
        trace = self._record(trace_event, "traceEvent")
        if trace.get("event") != "confirmation.rejected" or trace.get("brokerDecision") != "rejected" or trace.get("externalCostMicrounits") != "0" or trace.get("externalWrite") is not False:
            raise DomainRuleViolation("generation_rejection_trace_invalid", "Rejected decision requires a zero-effect confirmation.rejected trace event")
        payload = {
            "proposalId": proposal_id,
            "decisionId": self._string(decision_id, "decisionId"),
            "generationAttemptId": preview["generationAttemptId"],
            "decision": "rejected",
            "externalCostMicrounits": "0",
            "externalWritePerformed": False,
            "traceEvent": trace,
        }
        return self._insert(
            record_id=decision_id,
            record_kind="rejection",
            generation_attempt_id=preview["generationAttemptId"],
            proposal_id=proposal_id,
            content_hash=self._canonical_hash(payload),
            payload=payload,
        )

    def persist_authorization(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._safe_payload(payload)
        preview = self._record(payload.get("preview"), "preview")
        authorized = self._record(payload.get("authorizedSubmission"), "authorizedSubmission")
        reservation = self._record(payload.get("budgetReservation"), "budgetReservation")
        proposal_id = self._string(self._record(preview.get("proposal"), "preview.proposal").get("proposalId"), "preview.proposal.proposalId")
        stored_preview = self.preview(proposal_id)
        if stored_preview.get("generationAttemptId") != preview.get("generationAttemptId"):
            raise DomainRuleViolation("authorization_preview_mismatch", "Authorization does not bind the stored preview")
        rejection = self._find_optional("rejection", "proposal_id", proposal_id)
        if rejection is not None:
            raise DomainRuleViolation("generation_proposal_rejected", "Rejected proposal cannot be authorized")
        if reservation.get("reservedCost", {}).get("amountMicrounits") != "0":
            raise DomainRuleViolation("mock_budget_nonzero", "Acceptance Mock reservation must remain zero")
        return self._insert(
            record_id=self._string(authorized.get("authorizedSubmissionId"), "authorizedSubmission.authorizedSubmissionId"),
            record_kind="authorization",
            generation_attempt_id=self._string(preview.get("generationAttemptId"), "preview.generationAttemptId"),
            proposal_id=proposal_id,
            authorized_submission_id=self._string(authorized.get("authorizedSubmissionId"), "authorizedSubmission.authorizedSubmissionId"),
            idempotency_key=self._hash(authorized.get("idempotencyKey"), "authorizedSubmission.idempotencyKey"),
            content_hash=self._hash(authorized.get("contentHash"), "authorizedSubmission.contentHash"),
            payload=payload,
        )

    def authorization(self, authorized_submission_id: str) -> dict[str, Any]:
        return self._get("authorization", "authorized_submission_id", authorized_submission_id)

    def persist_provider_receipt(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._safe_payload(payload)
        if payload.get("externalNetworkRequests") != 0 or payload.get("externalSpendMicrounits") != "0":
            raise DomainRuleViolation("mock_provider_external_effect", "Mock Provider receipt must prove zero external network and spend")
        authorization_id = self._string(payload.get("authorizedSubmissionId"), "authorizedSubmissionId")
        self.authorization(authorization_id)
        idempotency_key = self._hash(payload.get("idempotencyKey"), "idempotencyKey")
        existing = self._find_optional("provider_receipt", "idempotency_key", idempotency_key)
        if existing is not None:
            if existing.get("contentHash") != payload.get("contentHash"):
                raise DomainRuleViolation("provider_receipt_idempotency_conflict", "Idempotency Key already binds another receipt")
            return existing
        return self._insert(
            record_id=self._string(payload.get("providerReceiptId"), "providerReceiptId"),
            record_kind="provider_receipt",
            generation_attempt_id=self._string(self.authorization(authorization_id)["preview"]["generationAttemptId"], "generationAttemptId"),
            authorized_submission_id=authorization_id,
            idempotency_key=idempotency_key,
            content_hash=self._hash(payload.get("contentHash"), "contentHash"),
            payload=payload,
        )

    def provider_receipt(self, idempotency_key: str) -> dict[str, Any]:
        return self._get("provider_receipt", "idempotency_key", idempotency_key)

    def persist_candidate(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._safe_payload(payload)
        if payload.get("qcState") != "pending" or payload.get("approvalState") != "not_approved":
            raise DomainRuleViolation("candidate_approval_boundary", "Provider success may create only QC-pending, not-approved Candidate")
        receipt_id = self._string(payload.get("providerReceiptId"), "providerReceiptId")
        if self._find_optional("provider_receipt", "record_id", receipt_id) is None:
            raise DomainRuleViolation("candidate_provider_receipt_missing", "Candidate requires a persisted Provider Task Receipt")
        return self._insert(
            record_id=self._string(payload.get("candidateId"), "candidateId"),
            record_kind="candidate",
            generation_attempt_id=self._string(payload.get("generationAttemptId"), "generationAttemptId"),
            content_hash=self._hash(payload.get("contentHash"), "contentHash"),
            payload=payload,
        )

    def candidate(self, generation_attempt_id: str) -> dict[str, Any]:
        return self._get("candidate", "generation_attempt_id", generation_attempt_id)

    def _insert(
        self, *, record_id: str, record_kind: str, generation_attempt_id: str,
        content_hash: str, payload: dict[str, Any], proposal_id: str | None = None,
        authorized_submission_id: str | None = None, idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        try:
            with self.database.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "INSERT INTO generation_production_records(record_id, record_kind, generation_attempt_id, proposal_id, authorized_submission_id, idempotency_key, content_hash, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (record_id, record_kind, generation_attempt_id, proposal_id, authorized_submission_id, idempotency_key, content_hash, encoded, created_at),
                )
                connection.execute("COMMIT")
        except Exception as error:
            if "UNIQUE constraint failed" not in str(error):
                raise
            existing = self._find_optional(record_kind, "record_id", record_id)
            if existing is None or self._stored_content_hash(record_kind, record_id) != content_hash:
                raise DomainRuleViolation("generation_production_record_conflict", "Immutable production record already exists") from error
            return existing
        return payload

    def _get(self, kind: str, column: str, value: str) -> dict[str, Any]:
        result = self._find_optional(kind, column, value)
        if result is None:
            raise EntityNotFound(value)
        return result

    def _find_optional(self, kind: str, column: str, value: str) -> dict[str, Any] | None:
        allowed = {"record_id", "proposal_id", "authorized_submission_id", "idempotency_key", "generation_attempt_id"}
        if column not in allowed:
            raise ValueError("invalid generation production lookup")
        with self.database.connect() as connection:
            row = connection.execute(
                f"SELECT payload_json FROM generation_production_records WHERE record_kind = ? AND {column} = ?",
                (kind, value),
            ).fetchone()
        return None if row is None else json.loads(row["payload_json"])

    def _stored_content_hash(self, kind: str, record_id: str) -> str | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT content_hash FROM generation_production_records WHERE record_kind = ? AND record_id = ?",
                (kind, record_id),
            ).fetchone()
        return None if row is None else str(row["content_hash"])

    def _safe_payload(self, value: Any, path: str = "$") -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key in FORBIDDEN_KEYS:
                    raise DomainRuleViolation("generation_production_secret_forbidden", f"Sensitive key forbidden at {path}.{key}")
                self._safe_payload(item, f"{path}.{key}")
            return
        if isinstance(value, list):
            for index, item in enumerate(value):
                self._safe_payload(item, f"{path}[{index}]")
            return
        if isinstance(value, str) and ("/Users/" in value or value.startswith("file:") or value.startswith("http://") or value.startswith("https://")):
            raise DomainRuleViolation("generation_production_private_path_forbidden", f"Private path or external URL forbidden at {path}")

    @staticmethod
    def _record(value: Any, field: str) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise DomainRuleViolation("generation_production_field_invalid", f"{field} must be an object")
        return value

    @staticmethod
    def _string(value: Any, field: str) -> str:
        if not isinstance(value, str) or not value.strip() or len(value) > 256:
            raise DomainRuleViolation("generation_production_field_invalid", f"{field} must be a non-empty opaque string")
        return value

    @staticmethod
    def _hash(value: Any, field: str) -> str:
        if not isinstance(value, str) or len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
            raise DomainRuleViolation("generation_production_hash_invalid", f"{field} must be lowercase sha256")
        return value

    @staticmethod
    def _canonical_hash(value: Any) -> str:
        return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
