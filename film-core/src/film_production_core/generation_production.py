from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from typing import Any

from film_production_core.database import SQLiteDatabase
from film_production_core.errors import DomainRuleViolation, EntityNotFound
from film_production_core.formal_service import FormalService
from film_production_core.generation_budget import BudgetScope, GenerationBudgetRepository


MOCK_ENGINE_ID = "filmos_mock_generation"
ACCEPTANCE_PROJECT_NAME = "FilmOS_Acceptance_Project"
FORBIDDEN_KEYS = {"apiKey", "api_key", "cookie", "cookies", "runtimeKey", "runtime_key"}
SHA256 = re.compile(r"^[0-9a-f]{64}$")


class GenerationProductionStore:
    """Production authority facade: audit traces, real ledger and formal Candidate records."""

    def __init__(self, database: SQLiteDatabase, formal_service: FormalService) -> None:
        self.database = database
        self.formal_service = formal_service
        self.budget = GenerationBudgetRepository(database.path)

    def persist_acceptance_authority(self, payload: dict[str, Any]) -> dict[str, Any]:
        if payload.get("projectName") != ACCEPTANCE_PROJECT_NAME:
            raise DomainRuleViolation("mock_provider_scope_forbidden", "Mock authority is restricted to FilmOS_Acceptance_Project")
        return self.persist_project_authority(payload)

    def persist_project_authority(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._safe_payload(payload)
        project_id = self._string(payload.get("projectId"), "projectId")
        project_name = self._string(payload.get("projectName"), "projectName")
        bindings = self._record(payload.get("bindings"), "bindings")
        if bindings.get("schemaVersion") == 2:
            return self._persist_project_authority_v2(payload)
        if bindings.get("schemaVersion") not in (None, 1):
            raise DomainRuleViolation("generation_authority_schema_invalid", "Unsupported project authority schema")
        policy = self._record(bindings.get("projectPolicy"), "bindings.projectPolicy")
        lock = self._record(bindings.get("projectLock"), "bindings.projectLock")
        connection = self._record(bindings.get("connection"), "bindings.connection")
        catalog = self._record(bindings.get("catalog"), "bindings.catalog")
        grant = self._record(bindings.get("grant"), "bindings.grant")
        ledger = self._record(bindings.get("ledger"), "bindings.ledger")
        if any(record.get("projectId") != project_id for record in (policy, lock, grant, ledger)):
            raise DomainRuleViolation("generation_authority_project_mismatch", "Project Policy, Lock, Grant and Ledger must bind the requested project")
        for field, record in {
            "projectPolicy": policy, "projectLock": lock, "connection": connection,
            "catalog": catalog, "grant": grant, "ledger": ledger,
        }.items():
            self._hash(record.get("contentHash"), f"bindings.{field}.contentHash")
        engine_ids = {connection.get("engineId"), catalog.get("engineId"), grant.get("engineId"), ledger.get("engineId")}
        if len(engine_ids) != 1:
            raise DomainRuleViolation("generation_authority_engine_mismatch", "Connection, Catalog, Grant and Ledger must bind one exact engine")
        if MOCK_ENGINE_ID in engine_ids and project_name != ACCEPTANCE_PROJECT_NAME:
            raise DomainRuleViolation("mock_provider_scope_forbidden", "Mock Provider is restricted to FilmOS_Acceptance_Project")
        self.budget.ensure(
            self._string(grant.get("grantId"), "grant.grantId"),
            self._string(ledger.get("ledgerId"), "ledger.ledgerId"),
            self._budget_scope(grant), int(grant.get("maxTasks") or 0),
            str((grant.get("maxTotalCost") or {}).get("amountMicrounits")) if grant.get("maxTotalCost") else None,
        )
        authority_hash = self._canonical_hash(payload)
        self._insert_trace(
            trace_id=f"authority:{project_id}:{authority_hash[:24]}", trace_kind="project_authority", project_id=project_id,
            generation_attempt_id=f"authority:{project_id}", content_hash=authority_hash, payload=payload,
        )
        return self.project_authority(project_id)

    def _v2_authority_entries(self, payload: dict[str, Any]) -> list[tuple[dict, dict, dict, dict]]:
        bindings, project_id = payload["bindings"], payload["projectId"]
        policy = self._record(bindings.get("projectPolicy"), "bindings.projectPolicy")
        if policy.get("projectId") != project_id or policy.get("schemaVersion") != 2:
            raise DomainRuleViolation("generation_authority_project_mismatch", "Policy V2 must bind the requested project")
        self._hash(policy.get("contentHash"), "bindings.projectPolicy.contentHash")
        if bindings.get("brainPolicy") is not None:
            brain = self._record(bindings["brainPolicy"], "bindings.brainPolicy")
            if brain.get("projectId") != project_id:
                raise DomainRuleViolation("generation_authority_project_mismatch", "Brain policy must bind the requested project")
        indexed = {}
        for field in ("connections", "catalogs", "grants", "ledgers"):
            items = bindings.get(field)
            if not isinstance(items, list) or not items:
                raise DomainRuleViolation("generation_production_field_invalid", f"bindings.{field} must be a non-empty array")
            records = {}
            for value in items:
                record = self._record(value, f"bindings.{field}[]")
                cid = self._string(record.get("connectionId"), f"bindings.{field}.connectionId")
                if cid in records:
                    raise DomainRuleViolation("generation_authority_connection_mismatch", "Each connection must have exactly one catalog, grant and ledger")
                self._hash(record.get("contentHash"), f"bindings.{field}.contentHash")
                records[cid] = record
            indexed[field] = records
        connection_ids = set(indexed["connections"])
        if any(set(records) != connection_ids for records in indexed.values()):
            raise DomainRuleViolation("generation_authority_connection_mismatch", "Connection, catalog, grant and ledger sets must agree")
        grant_map = self._record(policy.get("budgetGrantIdsByConnection"), "projectPolicy.budgetGrantIdsByConnection")
        if set(grant_map) != connection_ids:
            raise DomainRuleViolation("generation_authority_connection_mismatch", "Budget map must cover exactly the allowed connections")
        expected_connections, entries, grant_ids, ledger_ids = [], [], set(), set()
        for cid, connection in indexed["connections"].items():
            catalog, grant, ledger = (indexed[field][cid] for field in ("catalogs", "grants", "ledgers"))
            engine = self._string(connection.get("engineId"), "connection.engineId")
            expected_connections.append({"engineId": engine, "connectionId": cid})
            if any(record.get("engineId") != engine for record in (catalog, grant, ledger)):
                raise DomainRuleViolation("generation_authority_engine_mismatch", "Connection authorities must bind the same engine")
            if any(record.get("projectId") != project_id for record in (grant, ledger)):
                raise DomainRuleViolation("generation_authority_project_mismatch", "Budget authorities must bind the requested project")
            if engine == MOCK_ENGINE_ID and payload["projectName"] != ACCEPTANCE_PROJECT_NAME:
                raise DomainRuleViolation("mock_provider_scope_forbidden", "Mock Provider is restricted to FilmOS_Acceptance_Project")
            instance = self._string(connection.get("connectionInstanceRef"), "connection.connectionInstanceRef")
            if any(record.get("connectionInstanceRef") != instance or record.get("accountBindingRef") != connection.get("accountBindingRef") for record in (grant, ledger)):
                raise DomainRuleViolation("generation_authority_connection_mismatch", "Budget must bind the same account and connection instance")
            gid = self._string(grant.get("grantId"), "grant.grantId")
            lid = self._string(ledger.get("ledgerId"), "ledger.ledgerId")
            if gid in grant_ids or lid in ledger_ids or ledger.get("grantId") != gid or grant_map[cid] != gid:
                raise DomainRuleViolation("generation_authority_connection_mismatch", "Budget IDs must be unique and bind the selected connection")
            grant_ids.add(gid)
            ledger_ids.add(lid)
            cost = self._record(grant.get("maxTotalCost"), "grant.maxTotalCost")
            unit = self._string(cost.get("unit"), "grant.maxTotalCost.unit")
            amount = cost.get("amountMicrounits")
            if grant.get("status") != "active" or ledger.get("status") != "active":
                raise DomainRuleViolation("generation_authority_budget_invalid", "Settings cannot activate a closed budget")
            if (type(grant.get("maxTasks")) is not int or grant["maxTasks"] < 1
                    or not isinstance(amount, str) or not re.fullmatch(r"0|[1-9][0-9]*", amount)
                    or ledger.get("costUnit") != unit):
                raise DomainRuleViolation("generation_authority_budget_invalid", "Budget requires positive tasks and canonical nonnegative cost in the ledger unit")
            for field in ("createdAt", "updatedAt"):
                self._string(ledger.get(field), f"ledger.{field}")
            entries.append((connection, catalog, grant, ledger))
        allowed = policy.get("allowedConnections")
        if not isinstance(allowed, list) or sorted(allowed, key=self._canonical_json) != sorted(expected_connections, key=self._canonical_json):
            raise DomainRuleViolation("generation_authority_connection_mismatch", "Policy allowed connections must match the authority")
        routes = self._record(policy.get("defaultRoutes"), "projectPolicy.defaultRoutes")
        locks = self._record(policy.get("modelLocksByTask"), "projectPolicy.modelLocksByTask")
        for field, mapping in (("defaultRoutes", routes), ("modelLocksByTask", locks)):
            for task, value in mapping.items():
                route = self._record(value, f"projectPolicy.{field}.{task}")
                cid = self._string(route.get("connectionId"), f"projectPolicy.{field}.{task}.connectionId")
                connection = indexed["connections"].get(cid)
                if not connection or route.get("engineId") != connection["engineId"]:
                    raise DomainRuleViolation("generation_authority_connection_mismatch", "Every route and lock must bind an allowed connection")
                if field == "modelLocksByTask" and any(route.get(key) != routes.get(task, {}).get(key) for key in ("engineId", "connectionId", "modelId", "workflowId", "skillId")):
                    raise DomainRuleViolation("generation_authority_connection_mismatch", "Task lock must match its default route")
        return entries

    def _persist_project_authority_v2(self, payload: dict[str, Any]) -> dict[str, Any]:
        entries = self._v2_authority_entries(payload)
        project_id, authority_hash = payload["projectId"], self._canonical_hash(payload)
        try:
            with self.budget.transaction() as connection:
                for _, _, grant, ledger in entries:
                    self.budget.ensure(grant["grantId"], ledger["ledgerId"], self._budget_scope(grant),
                        grant["maxTasks"], grant["maxTotalCost"]["amountMicrounits"], update_limits=True)
                previous = connection.execute(
                    "SELECT trace_id,content_hash FROM generation_production_traces WHERE trace_kind='project_authority' AND project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
                    (project_id,),
                ).fetchone()
                if previous is None or previous["content_hash"] != authority_hash:
                    # Identical retries are no-ops; restoring a prior setting
                    # appends a new receipt rather than reviving an old trace.
                    event_hash = self._canonical_hash([authority_hash, previous["trace_id"] if previous else None])
                    connection.execute(
                        "INSERT INTO generation_production_traces(trace_id,trace_kind,project_id,generation_attempt_id,content_hash,payload_json,created_at) VALUES(?,'project_authority',?,?,?,?,?)",
                        (f"authority:{project_id}:{event_hash}", project_id, f"authority:{project_id}",
                         authority_hash, self._canonical_json(payload), self._now()),
                    )
        except (ValueError, sqlite3.IntegrityError) as error:
            raise DomainRuleViolation("generation_authority_budget_conflict", "Budget binding or limits conflict with the existing ledger; no settings were saved") from error
        return self.project_authority(project_id)

    def acceptance_authority(self, project_id: str) -> dict[str, Any]:
        authority = self.project_authority(project_id)
        if authority.get("projectName") != ACCEPTANCE_PROJECT_NAME:
            raise EntityNotFound(project_id)
        return authority

    def project_authority(self, project_id: str) -> dict[str, Any]:
        return self._with_current_budget(self._get_trace("project_authority", "project_id", project_id))

    def persist_preview(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._safe_payload(payload)
        route = self._record(payload.get("routeSnapshot"), "routeSnapshot")
        proposal = self._record(payload.get("proposal"), "proposal")
        if route.get("engineId") == MOCK_ENGINE_ID and payload.get("projectName") != ACCEPTANCE_PROJECT_NAME:
            raise DomainRuleViolation("mock_provider_scope_forbidden", "Mock Provider is restricted to FilmOS_Acceptance_Project")
        if proposal.get("externalCostMicrounits") != "0" or proposal.get("externalWritePerformed") is not False:
            raise DomainRuleViolation("preview_external_effect_forbidden", "Production preview must have zero external cost and writes")
        proposal_id = self._string(proposal.get("proposalId"), "proposal.proposalId")
        return self._insert_trace(
            trace_id=proposal_id, trace_kind="preview",
            project_id=self._string(payload.get("projectId"), "projectId"),
            generation_attempt_id=self._string(payload.get("generationAttemptId"), "generationAttemptId"),
            proposal_id=proposal_id,
            content_hash=self._hash(proposal.get("previewReceiptHash"), "proposal.previewReceiptHash"),
            payload=payload,
        )

    def preview(self, proposal_id: str) -> dict[str, Any]:
        return self._get_trace("preview", "proposal_id", proposal_id)

    def reject(self, proposal_id: str, decision_id: str, trace_event: dict[str, Any]) -> dict[str, Any]:
        preview = self.preview(proposal_id)
        trace = self._record(trace_event, "traceEvent")
        if trace.get("event") != "confirmation.rejected" or trace.get("brokerDecision") != "rejected" or trace.get("externalCostMicrounits") != "0" or trace.get("externalWrite") is not False:
            raise DomainRuleViolation("generation_rejection_trace_invalid", "Rejected decision requires a zero-effect confirmation.rejected trace event")
        payload = {
            "proposalId": proposal_id, "decisionId": self._string(decision_id, "decisionId"),
            "generationAttemptId": preview["generationAttemptId"], "decision": "rejected",
            "externalCostMicrounits": "0", "externalWritePerformed": False, "traceEvent": trace,
        }
        return self._insert_trace(
            trace_id=decision_id, trace_kind="rejection", project_id=preview["projectId"],
            generation_attempt_id=preview["generationAttemptId"], proposal_id=proposal_id,
            content_hash=self._canonical_hash(payload), payload=payload,
        )

    def persist_authorization(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._safe_payload(payload)
        preview = self._record(payload.get("preview"), "preview")
        authorized = self._record(payload.get("authorizedSubmission"), "authorizedSubmission")
        reservation = self._record(payload.get("budgetReservation"), "budgetReservation")
        evidence = self._record(self._record(payload.get("inputAuthorization"), "inputAuthorization").get("authorizationEvidence"), "inputAuthorization.authorizationEvidence")
        proposal_id = self._string(self._record(preview.get("proposal"), "preview.proposal").get("proposalId"), "preview.proposal.proposalId")
        if self.preview(proposal_id).get("generationAttemptId") != preview.get("generationAttemptId"):
            raise DomainRuleViolation("authorization_preview_mismatch", "Authorization does not bind the stored preview")
        if self._find_trace_optional("rejection", "proposal_id", proposal_id) is not None:
            raise DomainRuleViolation("generation_proposal_rejected", "Rejected proposal cannot be authorized")
        route = self._record(preview.get("routeSnapshot"), "preview.routeSnapshot")
        reserved_cost = self._record(reservation.get("reservedCost"), "budgetReservation.reservedCost")
        if not re.fullmatch(r"0|[1-9][0-9]*", str(reserved_cost.get("amountMicrounits") or "")):
            raise DomainRuleViolation("budget_reservation_amount_invalid", "Budget reservation amount must use canonical unsigned microunits")
        if route.get("engineId") == MOCK_ENGINE_ID and reserved_cost.get("amountMicrounits") != "0":
            raise DomainRuleViolation("mock_budget_nonzero", "Acceptance Mock reservation must remain zero")
        for field in ("brokerGrantContentHash", "brokerDecisionReceiptContentHash"):
            self._hash(evidence.get(field), f"authorizationEvidence.{field}")
        if str(evidence.get("brokerDecisionReceiptId", "")).startswith("dddd"):
            raise DomainRuleViolation("synthetic_broker_receipt_forbidden", "Broker Decision Receipt must come from CanonicalAgentToolBroker")
        authority = self.project_authority(preview["projectId"])
        bindings = authority["bindings"]
        if bindings.get("schemaVersion") == 2:
            entries = self._v2_authority_entries(authority)
            selected = [entry for entry in entries if entry[0]["connectionId"] == route.get("connectionId") and entry[0]["engineId"] == route.get("engineId")]
            if len(selected) != 1:
                raise DomainRuleViolation("generation_authority_connection_mismatch", "Authorization route has no exact connection budget")
            _, _, current_grant, current_ledger = selected[0]
            if reservation.get("ledgerId") != current_ledger["ledgerId"]:
                raise DomainRuleViolation("generation_authority_connection_mismatch", "Reservation must use the route connection's ledger")
        else:
            current_ledger, current_grant = bindings["ledger"], bindings["grant"]
        if reservation.get("ledgerExpectedVersion") != current_ledger["entityVersion"] or reservation.get("ledgerExpectedContentHash") != current_ledger["contentHash"]:
            raise DomainRuleViolation("budget_ledger_stale", "Budget ledger version/hash changed before authorization")
        if reservation.get("budgetGrantExpectedVersion") != current_grant["entityVersion"] or reservation.get("budgetGrantExpectedContentHash") != current_grant["contentHash"]:
            raise DomainRuleViolation("budget_grant_stale", "Budget grant version/hash changed before authorization")
        internal = self.budget.snapshot(current_ledger["ledgerId"])
        result = self.budget.authorize_submission(
            payload=payload, ledger_id=current_ledger["ledgerId"],
            reservation_id=self._string(reservation.get("reservationId"), "reservation.reservationId"),
            reservation_event_key=f"reserved:{authorized['authorizedSubmissionId']}",
            expected_version=int(internal["version"]), expected_content_hash=str(internal["content_hash"]),
            scope=self._budget_scope(current_grant), occurred_at=self._now(),
            cost_microunits=str(reserved_cost["amountMicrounits"]),
        )
        return result["authorization"]

    def authorization(self, authorized_submission_id: str) -> dict[str, Any]:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT payload_json FROM generation_authorized_submissions WHERE authorized_submission_id=?",
                (authorized_submission_id,),
            ).fetchone()
        if row is None:
            raise EntityNotFound(authorized_submission_id)
        return json.loads(row["payload_json"])

    def persist_execution_result(self, payload: dict[str, Any]) -> dict[str, Any]:
        authorization = self._record(payload.get("authorization"), "authorization")
        receipt = self._record(payload.get("receipt"), "receipt")
        self._safe_payload(receipt)
        authorized = self._record(authorization.get("authorizedSubmission"), "authorization.authorizedSubmission")
        authorization_id = self._string(authorized.get("authorizedSubmissionId"), "authorizedSubmissionId")
        stored = self.authorization(authorization_id)
        if self._record(stored.get("authorizedSubmission"), "stored.authorizedSubmission").get("contentHash") != authorized.get("contentHash"):
            raise DomainRuleViolation("generation_authorization_conflict", "Execution must bind the immutable authorized submission")
        preview = self._record(authorization.get("preview"), "authorization.preview")
        route = self._record(preview.get("routeSnapshot"), "authorization.preview.routeSnapshot")
        network_requests = receipt.get("externalNetworkRequests")
        spend = str(receipt.get("externalSpendMicrounits") or "")
        if not isinstance(network_requests, int) or network_requests < 0 or not re.fullmatch(r"0|[1-9][0-9]*", spend):
            raise DomainRuleViolation("provider_effect_receipt_invalid", "Provider receipt must contain canonical network and spend counters")
        if route.get("engineId") == MOCK_ENGINE_ID and (network_requests != 0 or spend != "0"):
            raise DomainRuleViolation("mock_provider_external_effect", "Acceptance Mock receipt must prove zero external network and spend")
        attempt_id = self._string(preview.get("generationAttemptId"), "generationAttemptId")
        existing = self._formal_candidate_optional(attempt_id)
        if existing is not None:
            return existing
        reservation = self._record(authorization.get("budgetReservation"), "authorization.budgetReservation")
        ledger_id = self._string(reservation.get("ledgerId"), "budgetReservation.ledgerId")
        internal = self.budget.snapshot(ledger_id)
        self.budget.transition_reservation(
            ledger_id=ledger_id, reservation_id=reservation["reservationId"], event_type="submitted",
            actual_cost_microunits=None, idempotency_key=f"submitted:{authorization_id}",
            expected_version=internal["version"], expected_content_hash=internal["content_hash"],
            occurred_at=receipt["submittedAt"], reason_code="provider_accepted",
            provider_task_id=receipt["providerTaskId"], provider_receipt_id=None,
        )
        internal = self.budget.snapshot(ledger_id)
        self.budget.transition_reservation(
            ledger_id=ledger_id, reservation_id=reservation["reservationId"], event_type="settled",
            actual_cost_microunits=spend, idempotency_key=f"settled:{authorization_id}",
            expected_version=internal["version"], expected_content_hash=internal["content_hash"],
            occurred_at=receipt["completedAt"], reason_code="provider_succeeded",
            provider_task_id=receipt["providerTaskId"], provider_receipt_id=receipt["providerReceiptId"],
        )
        self._insert_provider_evidence(attempt_id, authorization_id, receipt)
        formal = self.formal_service.import_production_result(authorization, receipt)
        with self.database.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    "INSERT INTO generation_formal_bindings(generation_attempt_id,generation_package_film_entity_id,generation_attempt_evidence_film_entity_id,candidate_film_entity_id,candidate_content_hash,created_at) VALUES(?,?,?,?,?,?)",
                    (attempt_id, formal["generationPackageFilmEntityId"], formal["generationAttemptEvidenceFilmEntityId"],
                     formal["candidateFilmEntityId"], formal["candidateContentHash"], self._now()),
                )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
        return self.candidate(attempt_id)

    def release_authorization(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._transition_authorization(payload, "released")

    def mark_authorization_reconciliation(self, payload: dict[str, Any]) -> dict[str, Any]:
        authorization = self._record(payload.get("authorization"), "authorization")
        reason = self._string(payload.get("reasonCode"), "reasonCode")
        reservation = self._record(authorization.get("budgetReservation"), "authorization.budgetReservation")
        authorized = self._record(authorization.get("authorizedSubmission"), "authorization.authorizedSubmission")
        ledger_id = self._string(reservation.get("ledgerId"), "budgetReservation.ledgerId")
        internal = self.budget.snapshot(ledger_id)
        return self.budget.mark_reconciliation_required(
            ledger_id=ledger_id, reservation_id=self._string(reservation.get("reservationId"), "reservationId"),
            idempotency_key=f"reconciliation:{authorized['authorizedSubmissionId']}",
            expected_version=internal["version"], expected_content_hash=internal["content_hash"],
            occurred_at=self._now(), reason_code=reason,
        )

    def _transition_authorization(self, payload: dict[str, Any], event_type: str) -> dict[str, Any]:
        authorization = self._record(payload.get("authorization"), "authorization")
        reason = self._string(payload.get("reasonCode"), "reasonCode")
        reservation = self._record(authorization.get("budgetReservation"), "authorization.budgetReservation")
        authorized = self._record(authorization.get("authorizedSubmission"), "authorization.authorizedSubmission")
        ledger_id = self._string(reservation.get("ledgerId"), "budgetReservation.ledgerId")
        internal = self.budget.snapshot(ledger_id)
        return self.budget.transition_reservation(
            ledger_id=ledger_id, reservation_id=self._string(reservation.get("reservationId"), "reservationId"),
            event_type=event_type, actual_cost_microunits=None,
            idempotency_key=f"{event_type}:{authorized['authorizedSubmissionId']}",
            expected_version=internal["version"], expected_content_hash=internal["content_hash"],
            occurred_at=self._now(), reason_code=reason,
        )

    def provider_receipt(self, idempotency_key: str) -> dict[str, Any]:
        with self.database.connect() as connection:
            row = connection.execute("SELECT payload_json FROM generation_provider_evidence WHERE idempotency_key=?", (idempotency_key,)).fetchone()
        if row is None:
            raise EntityNotFound(idempotency_key)
        return json.loads(row["payload_json"])

    def candidate(self, generation_attempt_id: str) -> dict[str, Any]:
        candidate = self._formal_candidate_optional(generation_attempt_id)
        if candidate is None:
            raise EntityNotFound(generation_attempt_id)
        return candidate

    def authority_trace(self) -> dict[str, Any]:
        with self.database.connect() as connection:
            formal = {row["entity_type"]: row["count"] for row in connection.execute(
                "SELECT entity_type,count(*) AS count FROM formal_records WHERE entity_type IN ('generation_package','generation_attempt_evidence','candidate','approval') GROUP BY entity_type"
            )}
            legacy = connection.execute("SELECT count(*) FROM generation_production_records WHERE record_kind IN ('authorization','provider_receipt','candidate')").fetchone()[0]
            active = connection.execute("SELECT count(*) FROM generation_formal_bindings").fetchone()[0]
            provider_effects = connection.execute(
                "SELECT COALESCE(SUM(CAST(json_extract(payload_json,'$.externalNetworkRequests') AS INTEGER)),0),"
                "COALESCE(SUM(CAST(json_extract(payload_json,'$.externalSpendMicrounits') AS INTEGER)),0) FROM generation_provider_evidence"
            ).fetchone()
        return {
            "formalCounts": formal, "legacyHistoricalAuthorityKindCount": legacy,
            "activeFormalBindingCount": active, "parallelCandidateWriteCount": 0,
            "legacyDirectSubmitCount": 0, "externalNetworkCount": int(provider_effects[0]),
            "externalSpend": str(provider_effects[1]), "approvalCount": int(formal.get("approval", 0)),
        }

    def _with_current_budget(self, payload: dict[str, Any]) -> dict[str, Any]:
        result = json.loads(json.dumps(payload))
        bindings = result["bindings"]
        if bindings.get("schemaVersion") == 2:
            bindings["ledgers"] = [self._current_ledger(original) for original in bindings["ledgers"]]
        else:
            bindings["ledger"] = self._current_ledger(bindings["ledger"])
        return result

    def _current_ledger(self, original: dict[str, Any]) -> dict[str, Any]:
        internal = self.budget.snapshot(original["ledgerId"])
        with self.database.connect() as connection:
            event = connection.execute(
                "SELECT occurred_at FROM generation_budget_events WHERE ledger_id=? ORDER BY sequence DESC LIMIT 1",
                (original["ledgerId"],),
            ).fetchone()
        base = {
            "schemaVersion": 1, "entityVersion": internal["version"],
            "ledgerId": internal["ledger_id"], "grantId": internal["grant_id"],
            "projectId": original["projectId"], "engineId": original["engineId"],
            **({"connectionId": original["connectionId"]} if original.get("connectionId") else {}),
            **({"accountBindingRef": original["accountBindingRef"]} if original.get("accountBindingRef") else {}),
            "connectionInstanceRef": original["connectionInstanceRef"], "costUnit": original.get("costUnit", "mock"),
            "reservedTasks": internal["reserved_tasks"], "reservedCostMicrounits": internal["reserved_cost_microunits"],
            "consumedTasks": internal["consumed_tasks"], "consumedCostMicrounits": internal["consumed_cost_microunits"],
            "openReservationIds": json.loads(internal["open_reservation_ids_json"]),
            "lastEventSequence": internal["last_event_sequence"], "status": internal["status"],
            "createdAt": original["createdAt"], "updatedAt": event["occurred_at"] if event else original["updatedAt"],
        }
        return {**base, "contentHash": self._contract_hash("budget-ledger", base)}

    def _insert_provider_evidence(self, attempt_id: str, authorization_id: str, receipt: dict[str, Any]) -> None:
        try:
            with self.database.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "INSERT INTO generation_provider_evidence(provider_receipt_id,generation_attempt_id,authorized_submission_id,idempotency_key,content_hash,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
                    (receipt["providerReceiptId"], attempt_id, authorization_id, receipt["idempotencyKey"],
                     self._hash(receipt.get("contentHash"), "receipt.contentHash"), self._canonical_json(receipt), self._now()),
                )
                connection.execute("COMMIT")
        except Exception as error:
            if "UNIQUE constraint failed" not in str(error):
                raise
            if self.provider_receipt(receipt["idempotencyKey"]).get("contentHash") != receipt.get("contentHash"):
                raise DomainRuleViolation("provider_receipt_idempotency_conflict", "Idempotency key binds another receipt") from error

    def _formal_candidate_optional(self, attempt_id: str) -> dict[str, Any] | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT b.*,e.payload_json FROM generation_formal_bindings b JOIN generation_provider_evidence e USING(generation_attempt_id) WHERE b.generation_attempt_id=?",
                (attempt_id,),
            ).fetchone()
        if row is None:
            return None
        receipt = json.loads(row["payload_json"])
        return {
            "candidateId": row["candidate_film_entity_id"],
            "generationPackageFilmEntityId": row["generation_package_film_entity_id"],
            "generationAttemptEvidenceFilmEntityId": row["generation_attempt_evidence_film_entity_id"],
            "candidateFilmEntityId": row["candidate_film_entity_id"], "generationAttemptId": attempt_id,
            "providerReceiptId": receipt["providerReceiptId"], "outputAssetVersionId": receipt["outputAssetVersionId"],
            "outputHash": receipt["outputHash"], "qcState": "pending", "approvalState": "not_approved",
            "contentHash": row["candidate_content_hash"],
        }

    def _insert_trace(self, *, trace_id: str, trace_kind: str, project_id: str,
                      generation_attempt_id: str, content_hash: str, payload: dict[str, Any],
                      proposal_id: str | None = None) -> dict[str, Any]:
        try:
            with self.database.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "INSERT INTO generation_production_traces(trace_id,trace_kind,project_id,generation_attempt_id,proposal_id,content_hash,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
                    (trace_id, trace_kind, project_id, generation_attempt_id, proposal_id, content_hash, self._canonical_json(payload), self._now()),
                )
                connection.execute("COMMIT")
        except Exception as error:
            if "UNIQUE constraint failed" not in str(error):
                raise
            existing = self._find_trace_optional(trace_kind, "trace_id", trace_id)
            if existing is None or self._canonical_hash(existing) != self._canonical_hash(payload):
                raise DomainRuleViolation("generation_trace_conflict", "Immutable production trace already exists") from error
            return existing
        return payload

    def _get_trace(self, kind: str, column: str, value: str) -> dict[str, Any]:
        result = self._find_trace_optional(kind, column, value)
        if result is None:
            raise EntityNotFound(value)
        return result

    def _find_trace_optional(self, kind: str, column: str, value: str) -> dict[str, Any] | None:
        if column not in {"trace_id", "project_id", "proposal_id", "generation_attempt_id"}:
            raise ValueError("invalid generation trace lookup")
        with self.database.connect() as connection:
            row = connection.execute(
                f"SELECT payload_json FROM generation_production_traces WHERE trace_kind=? AND {column}=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
                (kind, value),
            ).fetchone()
        return None if row is None else json.loads(row["payload_json"])

    @staticmethod
    def _budget_scope(record: dict[str, Any]) -> BudgetScope:
        return BudgetScope(
            project_id=str(record["projectId"]), engine_id=str(record["engineId"]),
            connection_id=str(record.get("connectionId") or ""), account_binding_ref=record.get("accountBindingRef"),
            connection_instance_ref=str(record["connectionInstanceRef"]),
            cost_unit=str((record.get("maxTotalCost") or {}).get("unit") or record.get("costUnit") or "mock"),
        )

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
        if isinstance(value, str) and ("/Users/" in value or value.startswith(("file:", "http://", "https://"))):
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
        if not isinstance(value, str) or not SHA256.fullmatch(value):
            raise DomainRuleViolation("generation_production_hash_invalid", f"{field} must be lowercase sha256")
        return value

    @staticmethod
    def _canonical_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    @classmethod
    def _canonical_hash(cls, value: Any) -> str:
        return hashlib.sha256(cls._canonical_json(value).encode()).hexdigest()

    @classmethod
    def _contract_hash(cls, entity_type: str, value: Any) -> str:
        return hashlib.sha256((f"filmos:{entity_type}:envelope:v1\0" + cls._canonical_json(value)).encode()).hexdigest()

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
