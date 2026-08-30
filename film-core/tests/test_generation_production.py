from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

from film_production_core.api import create_app
from film_production_core.database import MIGRATIONS, SQLiteDatabase


H1 = "1" * 64
H2 = "2" * 64
H3 = "3" * 64
H4 = "4" * 64


def preview(attempt: str, proposal: str) -> dict:
    return {
        "projectId": "project-acceptance",
        "projectName": "FilmOS_Acceptance_Project",
        "nodeId": "node-image-1",
        "generationAttemptId": attempt,
        "routeSnapshot": {
            "routeSnapshotId": f"route-{attempt}",
            "engineId": "filmos_mock_generation",
            "connectionId": "mock-local",
            "contentHash": H1,
            "routeContentHash": H2,
        },
        "proposal": {
            "proposalId": proposal,
            "proposalHash": H3,
            "previewReceiptId": f"preview-{attempt}",
            "previewReceiptHash": H4,
            "externalCostMicrounits": "0",
            "externalWritePerformed": False,
        },
        "guards": {},
        "trace": [],
    }


def authorization(preview_payload: dict, authorization_id: str) -> dict:
    return {
        "preview": preview_payload,
        "catalogValidation": {"catalogValidationReceiptId": "catalog-validation-1", "contentHash": H1},
        "inputAuthorization": {"authorizationSnapshotId": "input-authorization-1", "contentHash": H2},
        "budgetReservation": {"reservationId": "reservation-1", "contentHash": H3, "reservedCost": {"unit": "mock", "amountMicrounits": "0"}},
        "authorizedSubmission": {
            "authorizedSubmissionId": authorization_id,
            "contentHash": H4,
            "authorizedSubmissionSemanticHash": H3,
            "idempotencyKey": H2,
        },
        "trace": [],
    }


def rejected_trace() -> dict:
    return {
        "sequence": 6,
        "event": "confirmation.rejected",
        "objectId": "decision-reject",
        "contentHash": H4,
        "semanticHash": H3,
        "projectId": "project-acceptance",
        "nodeId": "node-image-1",
        "generationAttemptId": "attempt-rejected",
        "timestamp": "2026-08-31T00:00:00Z",
        "actor": "filmos-production-composition",
        "brokerDecision": "rejected",
        "externalCostMicrounits": "0",
        "externalWrite": False,
    }


def acceptance_authority() -> dict:
    project_id = "filmos-acceptance-project-v1"
    return {
        "projectId": project_id,
        "projectName": "FilmOS_Acceptance_Project",
        "bindings": {
            "projectPolicy": {"projectId": project_id, "contentHash": H1},
            "projectLock": {"projectId": project_id, "contentHash": H2},
            "connection": {"engineId": "filmos_mock_generation", "contentHash": H3},
            "catalog": {"engineId": "filmos_mock_generation", "contentHash": H4},
            "grant": {"projectId": project_id, "contentHash": H1},
            "ledger": {"projectId": project_id, "contentHash": H2},
        },
    }


def test_acceptance_policy_lock_catalog_and_budget_authority_are_film_core_owned(tmp_path) -> None:
    database = tmp_path / "film-core.sqlite"
    payload = acceptance_authority()
    client = TestClient(create_app(database))
    assert client.post("/generation-production/acceptance-authority", json=payload).json() == payload
    assert client.post("/generation-production/acceptance-authority", json=payload).json() == payload

    restarted = TestClient(create_app(database))
    assert restarted.get("/generation-production/acceptance-authority/filmos-acceptance-project-v1").json() == payload

    ordinary = acceptance_authority()
    ordinary["projectName"] = "Ordinary_User_Project"
    response = client.post("/generation-production/acceptance-authority", json=ordinary)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "mock_provider_scope_forbidden"


def test_v5_generation_records_migrate_to_acceptance_authority_schema_without_rewrite(tmp_path) -> None:
    database_path = tmp_path / "film-core-v5.sqlite"
    with sqlite3.connect(database_path, isolation_level=None) as connection:
        for version, migration in MIGRATIONS[:5]:
            connection.executescript(migration)
            connection.execute(
                "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, 'now')",
                (version,),
            )
        connection.execute(
            "INSERT INTO generation_production_records(record_id, record_kind, generation_attempt_id, proposal_id, content_hash, payload_json, created_at) VALUES (?, 'preview', ?, ?, ?, ?, 'now')",
            ("legacy-proposal", "legacy-attempt", "legacy-proposal", H1, '{"legacy":true}'),
        )

    database = SQLiteDatabase(database_path)
    with database.connect() as connection:
        row = connection.execute(
            "SELECT record_kind, payload_json FROM generation_production_records WHERE record_id = 'legacy-proposal'"
        ).fetchone()
        assert tuple(row) == ("preview", '{"legacy":true}')
        assert connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 6

    client = TestClient(create_app(database_path))
    assert client.post("/generation-production/acceptance-authority", json=acceptance_authority()).status_code == 200


def test_generation_production_records_are_append_only_idempotent_and_restart_safe(tmp_path) -> None:
    database = tmp_path / "film-core.sqlite"
    client = TestClient(create_app(database))
    preview_payload = preview("attempt-approved", "proposal-approved")
    assert client.post("/generation-production/previews", json=preview_payload).status_code == 200
    assert client.post("/generation-production/previews", json=preview_payload).json() == preview_payload
    authorization_payload = authorization(preview_payload, "authorized-approved")
    assert client.post("/generation-production/authorizations", json=authorization_payload).status_code == 200
    receipt = {
        "providerReceiptId": "mock-receipt-1",
        "providerTaskId": "mock-task-1",
        "authorizedSubmissionId": "authorized-approved",
        "idempotencyKey": H2,
        "outputHash": H3,
        "outputAssetVersionId": "asset-version-1",
        "contentHash": H1,
        "status": "succeeded",
        "externalNetworkRequests": 0,
        "externalSpendMicrounits": "0",
        "submittedAt": "2026-08-31T00:00:00Z",
        "completedAt": "2026-08-31T00:00:00Z",
    }
    assert client.post("/generation-production/provider-receipts", json=receipt).json() == receipt
    assert client.post("/generation-production/provider-receipts", json=receipt).json() == receipt
    candidate = {
        "candidateId": "candidate-1",
        "generationAttemptId": "attempt-approved",
        "providerReceiptId": "mock-receipt-1",
        "outputAssetVersionId": "asset-version-1",
        "outputHash": H3,
        "qcState": "pending",
        "approvalState": "not_approved",
        "contentHash": H4,
    }
    assert client.post("/generation-production/candidates", json=candidate).json() == candidate

    restarted = TestClient(create_app(database))
    assert restarted.get("/generation-production/previews/proposal-approved").json() == preview_payload
    assert restarted.get("/generation-production/authorizations/authorized-approved").json() == authorization_payload
    assert restarted.get(f"/generation-production/provider-receipts/{H2}").json() == receipt
    assert restarted.get("/generation-production/candidates/by-attempt/attempt-approved").json() == candidate


def test_rejected_preview_cannot_be_authorized_and_mock_scope_is_enforced(tmp_path) -> None:
    client = TestClient(create_app(tmp_path / "film-core.sqlite"))
    rejected = preview("attempt-rejected", "proposal-rejected")
    assert client.post("/generation-production/previews", json=rejected).status_code == 200
    assert client.post("/generation-production/previews/proposal-rejected/reject", json={"decisionId": "decision-reject", "traceEvent": rejected_trace()}).status_code == 200
    response = client.post("/generation-production/authorizations", json=authorization(rejected, "authorized-rejected"))
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "generation_proposal_rejected"

    wrong_scope = preview("attempt-wrong", "proposal-wrong")
    wrong_scope["projectName"] = "Ordinary_User_Project"
    response = client.post("/generation-production/previews", json=wrong_scope)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "mock_provider_scope_forbidden"
