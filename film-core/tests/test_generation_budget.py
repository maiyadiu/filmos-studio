from pathlib import Path

import pytest

from film_production_core.generation_budget import BudgetScope, GenerationBudgetRepository

AT = "2026-08-30T00:00:00Z"


def reserve(repo: GenerationBudgetRepository, ledger_id: str = "ledger-1", suffix: str = "1", cost: str = "1000000") -> dict:
    current = repo.snapshot(ledger_id)
    return repo.reserve(
        reservation_id=f"reservation-{suffix}", ledger_id=ledger_id,
        generation_attempt_id=f"attempt-{suffix}", route_content_hash=(suffix * 64)[:64],
        tasks=1, cost_microunits=cost, idempotency_key=f"reserve-{suffix}",
        expected_version=current["version"], expected_content_hash=current["content_hash"],
        route_snapshot_id=f"route-{suffix}", expires_at="2026-08-31T00:00:00Z",
        occurred_at=AT,
    )


def test_budget_lifecycle_is_atomic_idempotent_and_recoverable(tmp_path: Path) -> None:
    repo = GenerationBudgetRepository(tmp_path / "budget.sqlite")
    scope = BudgetScope("project-1", "dreamina_cli", "dreamina-local", "filmos_acct_1", "filmos_instance_1", "credits")
    repo.create("grant-1", "ledger-1", scope, 3, "3000000")
    initial = repo.snapshot("ledger-1")
    after_reserve = reserve(repo)
    assert after_reserve["reserved_cost_microunits"] == "1000000"
    assert repo.event_count("ledger-1") == 1
    assert repo.reserve(
        reservation_id="reservation-1", ledger_id="ledger-1", generation_attempt_id="attempt-1",
        route_content_hash="1" * 64, tasks=1, cost_microunits="1000000",
        idempotency_key="reserve-1", expected_version=initial["version"],
        expected_content_hash=initial["content_hash"],
    )["version"] == after_reserve["version"]
    submitted = repo.transition_reservation(
        ledger_id="ledger-1", reservation_id="reservation-1", event_type="submitted",
        actual_cost_microunits=None, idempotency_key="submit-1",
        expected_version=after_reserve["version"], expected_content_hash=after_reserve["content_hash"],
        occurred_at=AT, reason_code="provider_accepted", provider_task_id="provider-task-1",
    )
    settled = repo.transition_reservation(
        ledger_id="ledger-1", reservation_id="reservation-1", event_type="settled",
        actual_cost_microunits="750000", idempotency_key="settle-1",
        expected_version=submitted["version"], expected_content_hash=submitted["content_hash"],
        occurred_at=AT, reason_code="provider_receipt", provider_receipt_id="receipt-1",
    )
    assert settled["reserved_cost_microunits"] == "0"
    assert settled["consumed_cost_microunits"] == "750000"
    assert repo.event_types("ledger-1") == ["reserved", "submitted", "settled"]
    repo.verify_ledger_against_events("ledger-1")
    repo.close()


def test_release_expire_unknown_and_overrun_close_without_duplicate_submit(tmp_path: Path) -> None:
    repo = GenerationBudgetRepository(tmp_path / "budget.sqlite")
    scope = BudgetScope("project-1", "dreamina_cli", "dreamina-local", "filmos_acct_1", "filmos_instance_1", "credits")
    repo.create("grant-1", "ledger-1", scope, 4, "4000000")
    value = reserve(repo, suffix="1")
    released = repo.transition_reservation(
        ledger_id="ledger-1", reservation_id="reservation-1", event_type="released",
        actual_cost_microunits=None, idempotency_key="release-1",
        expected_version=value["version"], expected_content_hash=value["content_hash"],
        occurred_at=AT, reason_code="cancelled_before_provider_acceptance",
    )
    value = reserve(repo, suffix="2")
    expired = repo.transition_reservation(
        ledger_id="ledger-1", reservation_id="reservation-2", event_type="expired",
        actual_cost_microunits=None, idempotency_key="expire-2",
        expected_version=value["version"], expected_content_hash=value["content_hash"],
        occurred_at=AT, reason_code="expired_before_submit",
    )
    value = reserve(repo, suffix="3", cost="500000")
    unknown = repo.mark_reconciliation_required(
        ledger_id="ledger-1", reservation_id="reservation-3", idempotency_key="unknown-3",
        expected_version=value["version"], expected_content_hash=value["content_hash"],
        occurred_at=AT, reason_code="provider_submission_unknown",
    )
    assert released["reserved_tasks"] == 0 and expired["reserved_tasks"] == 0
    assert unknown["status"] == "reconciliation_required"
    settled = repo.transition_reservation(
        ledger_id="ledger-1", reservation_id="reservation-3", event_type="settled",
        actual_cost_microunits="900000", idempotency_key="settle-3",
        expected_version=unknown["version"], expected_content_hash=unknown["content_hash"],
        occurred_at=AT, reason_code="provider_receipt_after_reconcile",
        provider_receipt_id="receipt-overrun",
    )
    assert settled["consumed_cost_microunits"] == "900000"
    assert settled["status"] == "reconciliation_required"
    assert repo.connection.execute("SELECT count(*) FROM generation_budget_overrun_audits").fetchone()[0] == 1
    repo.verify_ledger_against_events("ledger-1")
    repo.close()


def test_binding_rotation_and_revocation_are_atomic_and_fail_closed(tmp_path: Path) -> None:
    repo = GenerationBudgetRepository(tmp_path / "budget.sqlite")
    old_scope = BudgetScope("project-1", "dreamina_cli", "dreamina-local", "filmos_acct_1", "filmos_instance_1", "credits")
    new_scope = BudgetScope("project-1", "dreamina_cli", "dreamina-local", "filmos_acct_2", "filmos_instance_2", "credits")
    repo.create("grant-1", "ledger-1", old_scope, 2, "2000000")
    initial = repo.snapshot("ledger-1")
    rotated = repo.rotate_binding(
        ledger_id="ledger-1", replacement_grant_id="grant-2", replacement_ledger_id="ledger-2",
        next_scope=new_scope, idempotency_key="rotate-1", expected_version=initial["version"],
        expected_content_hash=initial["content_hash"], occurred_at=AT,
    )
    assert rotated["status"] == "binding_rotated"
    assert repo.snapshot("ledger-2")["status"] == "active"
    with pytest.raises(ValueError, match="STALE"):
        reserve(repo, ledger_id="ledger-1", suffix="old")
    replacement = repo.snapshot("ledger-2")
    revoked = repo.revoke(
        ledger_id="ledger-2", idempotency_key="revoke-2",
        expected_version=replacement["version"], expected_content_hash=replacement["content_hash"],
        occurred_at=AT,
    )
    assert revoked["status"] == "revoked"
    with pytest.raises(ValueError, match="STALE"):
        reserve(repo, ledger_id="ledger-2", suffix="new")
    repo.verify_ledger_against_events("ledger-1")
    repo.verify_ledger_against_events("ledger-2")
    repo.close()


def test_budget_rejects_noncanonical_amount_and_stale_write(tmp_path: Path) -> None:
    repo = GenerationBudgetRepository(tmp_path / "budget.sqlite")
    scope = BudgetScope("project-1", "dreamina_cli", "dreamina-local", "filmos_acct_1", "filmos_instance_1", "credits")
    repo.create("grant-1", "ledger-1", scope, 2, "3000000")
    initial = repo.snapshot("ledger-1")
    current = reserve(repo)
    with pytest.raises(ValueError, match="STALE"):
        repo.reserve(
            reservation_id="reservation-2", ledger_id="ledger-1", generation_attempt_id="attempt-2",
            route_content_hash="2" * 64, tasks=1, cost_microunits="1000000",
            idempotency_key="reserve-2", expected_version=initial["version"],
            expected_content_hash=initial["content_hash"],
        )
    with pytest.raises(ValueError, match="CANONICAL"):
        repo.reserve(
            reservation_id="reservation-3", ledger_id="ledger-1", generation_attempt_id="attempt-3",
            route_content_hash="3" * 64, tasks=1, cost_microunits="01",
            idempotency_key="reserve-3", expected_version=current["version"],
            expected_content_hash=current["content_hash"],
        )
    repo.close()
