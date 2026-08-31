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
        "projectId": "filmos-acceptance-project-v1",
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


def authorization(preview_payload: dict, authorization_id: str, authority: dict) -> dict:
    bindings = authority["bindings"]
    return {
        "preview": preview_payload,
        "catalogValidation": {"catalogValidationReceiptId": "catalog-validation-1", "contentHash": H1},
        "inputAuthorization": {
            "authorizationSnapshotId": "input-authorization-1",
            "contentHash": H2,
            "authorizationEvidence": {
                "brokerGrantContentHash": H1,
                "brokerDecisionReceiptContentHash": H2,
                "brokerDecisionReceiptId": f"broker-decision-{authorization_id}",
            },
        },
        "budgetReservation": {
            "reservationId": f"reservation-{authorization_id}",
            "contentHash": H3,
            "ledgerId": bindings["ledger"]["ledgerId"],
            "ledgerExpectedVersion": bindings["ledger"]["entityVersion"],
            "ledgerExpectedContentHash": bindings["ledger"]["contentHash"],
            "budgetGrantExpectedVersion": bindings["grant"]["entityVersion"],
            "budgetGrantExpectedContentHash": bindings["grant"]["contentHash"],
            "reservedCost": {"unit": "mock", "amountMicrounits": "0"},
            "expiresAt": "2099-01-01T00:00:00Z",
        },
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
        "projectId": "filmos-acceptance-project-v1",
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
    instance = "filmos_instance_44444444-4444-4444-8444-444444444444"
    at = "2026-08-31T00:00:00Z"
    return {
        "projectId": project_id,
        "projectName": "FilmOS_Acceptance_Project",
        "bindings": {
            "projectPolicy": {"projectId": project_id, "contentHash": H1},
            "projectLock": {"projectId": project_id, "contentHash": H2},
            "connection": {"engineId": "filmos_mock_generation", "connectionId": "mock-local", "connectionInstanceRef": instance, "contentHash": H3},
            "catalog": {"engineId": "filmos_mock_generation", "connectionId": "mock-local", "contentHash": H4},
            "grant": {
                "schemaVersion": 1, "entityVersion": 1, "grantId": "grant-mock", "projectId": project_id,
                "engineId": "filmos_mock_generation", "connectionId": "mock-local", "connectionInstanceRef": instance,
                "maxTasks": 10, "maxTotalCost": {"unit": "mock", "amountMicrounits": "0"}, "contentHash": H1,
            },
            "ledger": {
                "schemaVersion": 1, "entityVersion": 1, "ledgerId": "ledger-mock", "grantId": "grant-mock",
                "projectId": project_id, "engineId": "filmos_mock_generation", "connectionId": "mock-local",
                "connectionInstanceRef": instance, "costUnit": "mock", "createdAt": at, "updatedAt": at,
                "contentHash": H2,
            },
        },
    }


def test_acceptance_policy_lock_catalog_and_budget_authority_are_film_core_owned(tmp_path) -> None:
    database = tmp_path / "film-core.sqlite"
    payload = acceptance_authority()
    client = TestClient(create_app(database))
    stored = client.post("/generation-production/acceptance-authority", json=payload).json()
    repeated = client.post("/generation-production/acceptance-authority", json=payload).json()
    assert stored["projectId"] == payload["projectId"]
    assert stored["bindings"]["ledger"] == repeated["bindings"]["ledger"]

    restarted = TestClient(create_app(database))
    assert restarted.get("/generation-production/acceptance-authority/filmos-acceptance-project-v1").json() == stored

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
        assert connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 7

    client = TestClient(create_app(database_path))
    assert client.post("/generation-production/acceptance-authority", json=acceptance_authority()).status_code == 200


def test_generation_production_records_are_append_only_idempotent_and_restart_safe(tmp_path) -> None:
    database = tmp_path / "film-core.sqlite"
    client = TestClient(create_app(database))
    authority = client.post("/generation-production/acceptance-authority", json=acceptance_authority()).json()
    preview_payload = preview("attempt-approved", "proposal-approved")
    assert client.post("/generation-production/previews", json=preview_payload).status_code == 200
    assert client.post("/generation-production/previews", json=preview_payload).json() == preview_payload
    authorization_payload = authorization(preview_payload, "authorized-approved", authority)
    assert client.post("/generation-production/authorizations", json=authorization_payload).status_code == 200

    restarted = TestClient(create_app(database))
    assert restarted.get("/generation-production/previews/proposal-approved").json() == preview_payload
    assert restarted.get("/generation-production/authorizations/authorized-approved").json() == authorization_payload
    release = restarted.post("/generation-production/authorization-release", json={"authorization": authorization_payload, "reasonCode": "test_release"})
    assert release.status_code == 200
    assert release.json()["reserved_tasks"] == 0
    assert release.json()["open_reservation_ids_json"] == "[]"


def test_rejected_preview_cannot_be_authorized_and_mock_scope_is_enforced(tmp_path) -> None:
    client = TestClient(create_app(tmp_path / "film-core.sqlite"))
    authority = client.post("/generation-production/acceptance-authority", json=acceptance_authority()).json()
    rejected = preview("attempt-rejected", "proposal-rejected")
    assert client.post("/generation-production/previews", json=rejected).status_code == 200
    assert client.post("/generation-production/previews/proposal-rejected/reject", json={"decisionId": "decision-reject", "traceEvent": rejected_trace()}).status_code == 200
    response = client.post("/generation-production/authorizations", json=authorization(rejected, "authorized-rejected", authority))
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "generation_proposal_rejected"

    wrong_scope = preview("attempt-wrong", "proposal-wrong")
    wrong_scope["projectName"] = "Ordinary_User_Project"
    response = client.post("/generation-production/previews", json=wrong_scope)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "mock_provider_scope_forbidden"
