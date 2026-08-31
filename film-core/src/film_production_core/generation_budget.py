from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterator

UNSIGNED = re.compile(r"^(0|[1-9][0-9]*)$")
SIGNED = re.compile(r"^(0|[1-9][0-9]*|-[1-9][0-9]*)$")


def _canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(kind: str, purpose: str, value: object) -> str:
    return hashlib.sha256((f"filmos:{kind}:{purpose}:v1\0" + _canonical(value)).encode()).hexdigest()


def _amount(value: str) -> int:
    if not UNSIGNED.fullmatch(value):
        raise ValueError("BUDGET_CANONICAL_AMOUNT_INVALID")
    return int(value)


def _delta(value: str) -> int:
    if not SIGNED.fullmatch(value):
        raise ValueError("BUDGET_CANONICAL_DELTA_INVALID")
    return int(value)


@dataclass(frozen=True)
class BudgetScope:
    project_id: str
    engine_id: str
    connection_id: str
    account_binding_ref: str | None
    connection_instance_ref: str
    cost_unit: str


class GenerationBudgetRepository:
    """Single SQLite authority for budget state and append-only recovery evidence."""

    def __init__(self, path: Path):
        # FastAPI executes synchronous handlers in worker threads.  Keep the
        # single budget authority connection usable across those workers while
        # serializing every transaction/read through one re-entrant lock.
        self._lock = threading.RLock()
        self.connection = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript("""
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS generation_budget_grants(
          grant_id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, max_tasks INTEGER NOT NULL,
          max_cost_microunits TEXT, status TEXT NOT NULL, binding_revision INTEGER NOT NULL,
          version INTEGER NOT NULL, content_hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS generation_budget_ledgers(
          ledger_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL UNIQUE, scope_json TEXT NOT NULL,
          reserved_tasks INTEGER NOT NULL, reserved_cost_microunits TEXT NOT NULL,
          consumed_tasks INTEGER NOT NULL, consumed_cost_microunits TEXT NOT NULL,
          open_reservation_ids_json TEXT NOT NULL, last_event_sequence INTEGER NOT NULL,
          status TEXT NOT NULL, version INTEGER NOT NULL, content_hash TEXT NOT NULL,
          FOREIGN KEY(grant_id) REFERENCES generation_budget_grants(grant_id));
        CREATE TABLE IF NOT EXISTS generation_budget_reservations(
          reservation_id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, budget_grant_id TEXT NOT NULL,
          generation_attempt_id TEXT NOT NULL, route_snapshot_id TEXT NOT NULL,
          route_content_hash TEXT NOT NULL, scope_json TEXT NOT NULL,
          budget_grant_expected_version INTEGER NOT NULL, budget_grant_expected_content_hash TEXT NOT NULL,
          ledger_expected_version INTEGER NOT NULL, ledger_expected_content_hash TEXT NOT NULL,
          reserved_tasks INTEGER NOT NULL, reserved_cost_microunits TEXT NOT NULL,
          expires_at TEXT NOT NULL, budget_reservation_semantic_hash TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          FOREIGN KEY(ledger_id) REFERENCES generation_budget_ledgers(ledger_id));
        CREATE TABLE IF NOT EXISTS generation_budget_events(
          event_id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, grant_id TEXT NOT NULL,
          scope_json TEXT NOT NULL, sequence INTEGER NOT NULL, event_type TEXT NOT NULL,
          reservation_id TEXT, generation_attempt_id TEXT, binding_transition_json TEXT,
          cost_unit TEXT, effects_json TEXT NOT NULL, provider_task_id TEXT,
          provider_receipt_id TEXT, reason_code TEXT NOT NULL, occurred_at TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE, budget_ledger_event_semantic_hash TEXT NOT NULL,
          content_hash TEXT NOT NULL, UNIQUE(ledger_id, sequence),
          FOREIGN KEY(ledger_id) REFERENCES generation_budget_ledgers(ledger_id));
        CREATE TABLE IF NOT EXISTS generation_budget_overrun_audits(
          audit_id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
          reserved_cost_microunits TEXT NOT NULL, actual_cost_microunits TEXT NOT NULL,
          overrun_cost_microunits TEXT NOT NULL, provider_receipt_id TEXT NOT NULL,
          content_hash TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS generation_budget_events_no_update BEFORE UPDATE ON generation_budget_events BEGIN SELECT RAISE(ABORT,'budget events are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS generation_budget_events_no_delete BEFORE DELETE ON generation_budget_events BEGIN SELECT RAISE(ABORT,'budget events are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS generation_budget_reservations_no_update BEFORE UPDATE ON generation_budget_reservations BEGIN SELECT RAISE(ABORT,'budget reservations are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS generation_budget_reservations_no_delete BEFORE DELETE ON generation_budget_reservations BEGIN SELECT RAISE(ABORT,'budget reservations are immutable'); END;
        """)

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        with self._lock:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                yield
            except BaseException:
                self.connection.execute("ROLLBACK")
                raise
            else:
                self.connection.execute("COMMIT")

    def close(self) -> None:
        with self._lock:
            self.connection.close()

    @staticmethod
    def _grant_projection(grant_id: str, scope: BudgetScope, max_tasks: int,
                          max_cost_microunits: str | None, status: str,
                          binding_revision: int, version: int) -> dict:
        return {"grant_id": grant_id, "scope": asdict(scope), "max_tasks": max_tasks,
                "max_cost_microunits": max_cost_microunits, "status": status,
                "binding_revision": binding_revision, "version": version}

    @staticmethod
    def _ledger_projection(row: sqlite3.Row | dict) -> dict:
        get = row.__getitem__
        return {
            "ledger_id": get("ledger_id"), "grant_id": get("grant_id"),
            "scope": json.loads(get("scope_json")), "reserved_tasks": get("reserved_tasks"),
            "reserved_cost_microunits": get("reserved_cost_microunits"),
            "consumed_tasks": get("consumed_tasks"),
            "consumed_cost_microunits": get("consumed_cost_microunits"),
            "open_reservation_ids": json.loads(get("open_reservation_ids_json")),
            "last_event_sequence": get("last_event_sequence"), "status": get("status"),
            "version": get("version"),
        }

    def create(self, grant_id: str, ledger_id: str, scope: BudgetScope,
               max_tasks: int, max_cost_microunits: str | None) -> None:
        if max_tasks < 1 or (max_cost_microunits is not None and _amount(max_cost_microunits) < 0):
            raise ValueError("BUDGET_GRANT_INVALID")
        scope_json = _canonical(asdict(scope))
        grant = self._grant_projection(grant_id, scope, max_tasks, max_cost_microunits, "active", 1, 1)
        ledger = {"ledger_id": ledger_id, "grant_id": grant_id, "scope": asdict(scope),
                  "reserved_tasks": 0, "reserved_cost_microunits": "0",
                  "consumed_tasks": 0, "consumed_cost_microunits": "0",
                  "open_reservation_ids": [], "last_event_sequence": 0,
                  "status": "active", "version": 1}
        with self._transaction():
            self.connection.execute("INSERT INTO generation_budget_grants VALUES(?,?,?,?,?,?,?,?)",
                                    (grant_id, scope_json, max_tasks, max_cost_microunits,
                                     "active", 1, 1, _hash("generation-budget-grant", "envelope", grant)))
            self.connection.execute("INSERT INTO generation_budget_ledgers VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                                    (ledger_id, grant_id, scope_json, 0, "0", 0, "0", "[]", 0,
                                     "active", 1, _hash("budget-ledger", "envelope", ledger)))

    def ensure(self, grant_id: str, ledger_id: str, scope: BudgetScope,
               max_tasks: int, max_cost_microunits: str | None) -> dict:
        with self._lock:
            existing = self.connection.execute(
                "SELECT ledger_id FROM generation_budget_ledgers WHERE ledger_id=? AND grant_id=?",
                (ledger_id, grant_id),
            ).fetchone()
            if existing is None:
                self.create(grant_id, ledger_id, scope, max_tasks, max_cost_microunits)
            snapshot = self.snapshot(ledger_id)
            self._assert_scope(snapshot["scope_json"], scope)
            return snapshot

    def _require_fresh_ledger(self, ledger_id: str, expected_version: int,
                              expected_content_hash: str,
                              allow_settlement_only: bool = False) -> tuple[sqlite3.Row, sqlite3.Row]:
        ledger = self.connection.execute("SELECT * FROM generation_budget_ledgers WHERE ledger_id=?",
                                         (ledger_id,)).fetchone()
        permitted = {"active"} if not allow_settlement_only else {
            "active", "exhausted", "revoked", "binding_rotated", "reconciliation_required"
        }
        if (not ledger or ledger["status"] not in permitted or ledger["version"] != expected_version
                or ledger["content_hash"] != expected_content_hash):
            raise ValueError("BUDGET_LEDGER_STALE")
        grant = self.connection.execute("SELECT * FROM generation_budget_grants WHERE grant_id=?",
                                        (ledger["grant_id"],)).fetchone()
        if not grant:
            raise ValueError("BUDGET_GRANT_MISSING")
        return ledger, grant

    @staticmethod
    def _assert_scope(scope_json: str, scope: BudgetScope) -> None:
        if json.loads(scope_json) != asdict(scope):
            raise ValueError("BUDGET_BINDING_SCOPE_MISMATCH")

    def _event_exists(self, idempotency_key: str, event_type: str,
                      reservation_id: str | None) -> bool:
        existing = self.connection.execute(
            "SELECT event_type,reservation_id FROM generation_budget_events WHERE idempotency_key=?",
            (idempotency_key,)).fetchone()
        if not existing:
            return False
        if existing["event_type"] != event_type or existing["reservation_id"] != reservation_id:
            raise ValueError("BUDGET_EVENT_IDEMPOTENCY_CONFLICT")
        return True

    def _append_event(self, *, ledger: sqlite3.Row, event_type: str,
                      reservation_id: str | None, generation_attempt_id: str | None,
                      effects: dict, reason_code: str, occurred_at: str,
                      idempotency_key: str, provider_task_id: str | None = None,
                      provider_receipt_id: str | None = None,
                      binding_transition: dict | None = None) -> int:
        for key in ("reservedCostMicrounitsDelta", "consumedCostMicrounitsDelta"):
            _delta(effects[key])
        if not all(isinstance(effects[key], int) for key in ("reservedTasksDelta", "consumedTasksDelta")):
            raise ValueError("BUDGET_TASK_DELTA_INVALID")
        if event_type in {"reserved", "submitted", "released", "expired", "settled", "adjusted"} and (
                not reservation_id or not generation_attempt_id):
            raise ValueError("BUDGET_EVENT_RESERVATION_SCOPE_REQUIRED")
        if event_type in {"revoked", "binding_rotated"} and any((
                effects["reservedTasksDelta"], effects["consumedTasksDelta"],
                _delta(effects["reservedCostMicrounitsDelta"]),
                _delta(effects["consumedCostMicrounitsDelta"]))):
            raise ValueError("BUDGET_BINDING_EVENT_EFFECTS_MUST_BE_ZERO")
        sequence = ledger["last_event_sequence"] + 1
        scope = json.loads(ledger["scope_json"])
        semantic = {"ledger_id": ledger["ledger_id"], "grant_id": ledger["grant_id"],
                    "scope": scope, "sequence": sequence, "event_type": event_type,
                    "reservation_id": reservation_id, "generation_attempt_id": generation_attempt_id,
                    "binding_transition": binding_transition, "cost_unit": scope["cost_unit"],
                    "effects": effects, "provider_task_id": provider_task_id,
                    "provider_receipt_id": provider_receipt_id, "reason_code": reason_code,
                    "idempotency_key": idempotency_key}
        semantic_hash = _hash("budget-ledger-event", "semantic", semantic)
        envelope = {**semantic, "event_id": f"{ledger['ledger_id']}:{sequence}",
                    "occurred_at": occurred_at,
                    "budget_ledger_event_semantic_hash": semantic_hash}
        self.connection.execute(
            "INSERT INTO generation_budget_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (envelope["event_id"], ledger["ledger_id"], ledger["grant_id"], ledger["scope_json"],
             sequence, event_type, reservation_id, generation_attempt_id,
             _canonical(binding_transition) if binding_transition else None, scope["cost_unit"],
             _canonical(effects), provider_task_id, provider_receipt_id, reason_code, occurred_at,
             idempotency_key, semantic_hash, _hash("budget-ledger-event", "envelope", envelope)))
        return sequence

    def _update_ledger(self, ledger: sqlite3.Row, *, effects: dict, sequence: int,
                       status: str | None = None,
                       open_reservation_ids: list[str] | None = None) -> dict:
        reserved_tasks = ledger["reserved_tasks"] + effects["reservedTasksDelta"]
        consumed_tasks = ledger["consumed_tasks"] + effects["consumedTasksDelta"]
        reserved_cost = _amount(ledger["reserved_cost_microunits"]) + _delta(effects["reservedCostMicrounitsDelta"])
        consumed_cost = _amount(ledger["consumed_cost_microunits"]) + _delta(effects["consumedCostMicrounitsDelta"])
        if min(reserved_tasks, consumed_tasks, reserved_cost, consumed_cost) < 0:
            raise ValueError("BUDGET_LEDGER_NEGATIVE")
        projection = self._ledger_projection(ledger)
        projection.update({"reserved_tasks": reserved_tasks, "reserved_cost_microunits": str(reserved_cost),
                           "consumed_tasks": consumed_tasks, "consumed_cost_microunits": str(consumed_cost),
                           "open_reservation_ids": open_reservation_ids if open_reservation_ids is not None else projection["open_reservation_ids"],
                           "last_event_sequence": sequence, "status": status or ledger["status"],
                           "version": ledger["version"] + 1})
        content_hash = _hash("budget-ledger", "envelope", projection)
        self.connection.execute(
            "UPDATE generation_budget_ledgers SET reserved_tasks=?,reserved_cost_microunits=?,"
            "consumed_tasks=?,consumed_cost_microunits=?,open_reservation_ids_json=?,"
            "last_event_sequence=?,status=?,version=?,content_hash=? WHERE ledger_id=?",
            (reserved_tasks, str(reserved_cost), consumed_tasks, str(consumed_cost),
             _canonical(projection["open_reservation_ids"]), sequence, projection["status"],
             projection["version"], content_hash, ledger["ledger_id"]))
        return self.snapshot(ledger["ledger_id"])

    def reserve(self, *, reservation_id: str, ledger_id: str, generation_attempt_id: str,
                route_content_hash: str, tasks: int, cost_microunits: str,
                idempotency_key: str, expected_version: int, expected_content_hash: str,
                scope: BudgetScope | None = None, route_snapshot_id: str = "route-snapshot",
                expires_at: str = "9999-12-31T23:59:59Z",
                occurred_at: str = "1970-01-01T00:00:00Z") -> dict:
        with self._transaction():
            return self._reserve_current_transaction(
                reservation_id=reservation_id, ledger_id=ledger_id,
                generation_attempt_id=generation_attempt_id,
                route_content_hash=route_content_hash, tasks=tasks,
                cost_microunits=cost_microunits, idempotency_key=idempotency_key,
                expected_version=expected_version, expected_content_hash=expected_content_hash,
                scope=scope, route_snapshot_id=route_snapshot_id,
                expires_at=expires_at, occurred_at=occurred_at,
            )

    def authorize_submission(self, *, payload: dict, ledger_id: str,
                             reservation_id: str, reservation_event_key: str,
                             expected_version: int, expected_content_hash: str,
                             scope: BudgetScope, occurred_at: str,
                             cost_microunits: str) -> dict:
        authorized = payload.get("authorizedSubmission") or {}
        preview = payload.get("preview") or {}
        route = preview.get("routeSnapshot") or {}
        authorization_id = str(authorized.get("authorizedSubmissionId") or "")
        attempt_id = str(preview.get("generationAttemptId") or "")
        proposal_id = str((preview.get("proposal") or {}).get("proposalId") or "")
        idempotency_key = str(authorized.get("idempotencyKey") or "")
        content_hash = str(authorized.get("contentHash") or "")
        if not all((authorization_id, attempt_id, proposal_id, idempotency_key)):
            raise ValueError("GENERATION_AUTHORIZATION_FIELDS_REQUIRED")
        if not re.fullmatch(r"[0-9a-f]{64}", content_hash):
            raise ValueError("GENERATION_AUTHORIZATION_HASH_INVALID")
        existing = self.connection.execute(
            "SELECT payload_json FROM generation_authorized_submissions WHERE authorized_submission_id=?",
            (authorization_id,),
        ).fetchone()
        if existing is not None:
            return {"authorization": json.loads(existing["payload_json"]), "ledger": self.snapshot(ledger_id)}
        with self._transaction():
            ledger = self._reserve_current_transaction(
                reservation_id=reservation_id, ledger_id=ledger_id,
                generation_attempt_id=attempt_id,
                route_content_hash=str(route.get("routeContentHash") or ""),
                tasks=1, cost_microunits=cost_microunits,
                idempotency_key=reservation_event_key,
                expected_version=expected_version,
                expected_content_hash=expected_content_hash,
                scope=scope,
                route_snapshot_id=str(route.get("routeSnapshotId") or "route-snapshot"),
                expires_at=str((payload.get("budgetReservation") or {}).get("expiresAt") or "9999-12-31T23:59:59Z"),
                occurred_at=occurred_at,
            )
            self.connection.execute(
                "INSERT INTO generation_authorized_submissions(authorized_submission_id,generation_attempt_id,proposal_id,idempotency_key,ledger_id,reservation_id,content_hash,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (authorization_id, attempt_id, proposal_id, idempotency_key, ledger_id,
                 reservation_id, content_hash, _canonical(payload), occurred_at),
            )
            return {"authorization": payload, "ledger": ledger}

    def _reserve_current_transaction(self, *, reservation_id: str, ledger_id: str,
                                     generation_attempt_id: str, route_content_hash: str,
                                     tasks: int, cost_microunits: str,
                                     idempotency_key: str, expected_version: int,
                                     expected_content_hash: str, scope: BudgetScope | None,
                                     route_snapshot_id: str, expires_at: str,
                                     occurred_at: str) -> dict:
        cost = _amount(cost_microunits)
        if tasks < 1:
            raise ValueError("BUDGET_RESERVATION_INVALID")
        if self._event_exists(idempotency_key, "reserved", reservation_id):
            return self.snapshot(ledger_id)
        ledger, grant = self._require_fresh_ledger(ledger_id, expected_version, expected_content_hash)
        resolved_scope = scope or BudgetScope(**json.loads(ledger["scope_json"]))
        self._assert_scope(ledger["scope_json"], resolved_scope)
        next_tasks = ledger["reserved_tasks"] + ledger["consumed_tasks"] + tasks
        next_cost = (_amount(ledger["reserved_cost_microunits"])
                     + _amount(ledger["consumed_cost_microunits"]) + cost)
        if next_tasks > grant["max_tasks"] or (grant["max_cost_microunits"] is not None
                                                and next_cost > _amount(grant["max_cost_microunits"])):
            raise ValueError("BUDGET_LIMIT_EXCEEDED")
        reservation_semantic = {
            "ledger_id": ledger_id, "budget_grant_id": ledger["grant_id"],
            "generation_attempt_id": generation_attempt_id, "route_snapshot_id": route_snapshot_id,
            "route_content_hash": route_content_hash, "scope": asdict(resolved_scope),
            "budget_grant_expected_version": grant["version"],
            "budget_grant_expected_content_hash": grant["content_hash"],
            "ledger_expected_version": expected_version,
            "ledger_expected_content_hash": expected_content_hash,
            "reserved_tasks": tasks, "reserved_cost_microunits": cost_microunits,
            "expires_at": expires_at}
        semantic_hash = _hash("budget-reservation", "semantic", reservation_semantic)
        envelope = {**reservation_semantic, "reservation_id": reservation_id,
                    "budget_reservation_semantic_hash": semantic_hash, "created_at": occurred_at}
        self.connection.execute(
            "INSERT INTO generation_budget_reservations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (reservation_id, ledger_id, ledger["grant_id"], generation_attempt_id,
             route_snapshot_id, route_content_hash, ledger["scope_json"], grant["version"],
             grant["content_hash"], expected_version, expected_content_hash, tasks,
             cost_microunits, expires_at, semantic_hash,
             _hash("budget-reservation", "envelope", envelope)))
        effects = {"reservedTasksDelta": tasks, "reservedCostMicrounitsDelta": cost_microunits,
                   "consumedTasksDelta": 0, "consumedCostMicrounitsDelta": "0"}
        sequence = self._append_event(
            ledger=ledger, event_type="reserved", reservation_id=reservation_id,
            generation_attempt_id=generation_attempt_id, effects=effects,
            reason_code="authorized", occurred_at=occurred_at, idempotency_key=idempotency_key)
        open_ids = json.loads(ledger["open_reservation_ids_json"])
        open_ids.append(reservation_id)
        return self._update_ledger(ledger, effects=effects, sequence=sequence,
                                   open_reservation_ids=open_ids)

    def transition_reservation(self, *, ledger_id: str, reservation_id: str,
                               event_type: str, actual_cost_microunits: str | None,
                               idempotency_key: str, expected_version: int,
                               expected_content_hash: str, occurred_at: str,
                               reason_code: str, provider_task_id: str | None = None,
                               provider_receipt_id: str | None = None) -> dict:
        if event_type not in {"submitted", "released", "expired", "settled"}:
            raise ValueError("BUDGET_RESERVATION_TRANSITION_INVALID")
        with self._transaction():
            if self._event_exists(idempotency_key, event_type, reservation_id):
                return self.snapshot(ledger_id)
            ledger, grant = self._require_fresh_ledger(
                ledger_id, expected_version, expected_content_hash,
                allow_settlement_only=event_type == "settled")
            reservation = self.connection.execute(
                "SELECT * FROM generation_budget_reservations WHERE reservation_id=? AND ledger_id=?",
                (reservation_id, ledger_id)).fetchone()
            if not reservation:
                raise ValueError("BUDGET_RESERVATION_MISSING")
            open_ids = json.loads(ledger["open_reservation_ids_json"])
            if reservation_id not in open_ids and event_type != "submitted":
                raise ValueError("BUDGET_RESERVATION_CLOSED")
            reserved_tasks = reservation["reserved_tasks"]
            reserved_cost = _amount(reservation["reserved_cost_microunits"])
            if event_type == "submitted":
                effects = {"reservedTasksDelta": 0, "reservedCostMicrounitsDelta": "0",
                           "consumedTasksDelta": 0, "consumedCostMicrounitsDelta": "0"}
            elif event_type in {"released", "expired"}:
                effects = {"reservedTasksDelta": -reserved_tasks,
                           "reservedCostMicrounitsDelta": str(-reserved_cost) if reserved_cost else "0",
                           "consumedTasksDelta": 0, "consumedCostMicrounitsDelta": "0"}
                open_ids.remove(reservation_id)
            else:
                if actual_cost_microunits is None:
                    raise ValueError("BUDGET_ACTUAL_COST_REQUIRED")
                actual = _amount(actual_cost_microunits)
                effects = {"reservedTasksDelta": -reserved_tasks,
                           "reservedCostMicrounitsDelta": str(-reserved_cost) if reserved_cost else "0",
                           "consumedTasksDelta": reserved_tasks,
                           "consumedCostMicrounitsDelta": str(actual)}
                open_ids.remove(reservation_id)
            sequence = self._append_event(
                ledger=ledger, event_type=event_type, reservation_id=reservation_id,
                generation_attempt_id=reservation["generation_attempt_id"], effects=effects,
                reason_code=reason_code, occurred_at=occurred_at, idempotency_key=idempotency_key,
                provider_task_id=provider_task_id, provider_receipt_id=provider_receipt_id)
            status = ledger["status"]
            if event_type == "settled":
                actual = _amount(actual_cost_microunits or "0")
                maximum = grant["max_cost_microunits"]
                overrun = max(0, actual - reserved_cost)
                total = _amount(ledger["consumed_cost_microunits"]) + actual
                if overrun or (maximum is not None and total > _amount(maximum)):
                    status = "reconciliation_required"
                    audit = {"audit_id": f"overrun:{reservation_id}", "ledger_id": ledger_id,
                             "reservation_id": reservation_id,
                             "reserved_cost_microunits": str(reserved_cost),
                             "actual_cost_microunits": str(actual),
                             "overrun_cost_microunits": str(overrun),
                             "provider_receipt_id": provider_receipt_id or "missing"}
                    self.connection.execute(
                        "INSERT INTO generation_budget_overrun_audits VALUES(?,?,?,?,?,?,?,?)",
                        (*audit.values(), _hash("budget-overrun-audit", "envelope", audit)))
            return self._update_ledger(ledger, effects=effects, sequence=sequence,
                                       status=status, open_reservation_ids=open_ids)

    def mark_reconciliation_required(self, *, ledger_id: str, reservation_id: str,
                                     idempotency_key: str, expected_version: int,
                                     expected_content_hash: str, occurred_at: str,
                                     reason_code: str) -> dict:
        with self._transaction():
            if self._event_exists(idempotency_key, "reconciliation_required", reservation_id):
                return self.snapshot(ledger_id)
            ledger, _ = self._require_fresh_ledger(ledger_id, expected_version, expected_content_hash)
            reservation = self.connection.execute(
                "SELECT * FROM generation_budget_reservations WHERE reservation_id=?", (reservation_id,)).fetchone()
            if not reservation:
                raise ValueError("BUDGET_RESERVATION_MISSING")
            effects = {"reservedTasksDelta": 0, "reservedCostMicrounitsDelta": "0",
                       "consumedTasksDelta": 0, "consumedCostMicrounitsDelta": "0"}
            sequence = self._append_event(
                ledger=ledger, event_type="reconciliation_required", reservation_id=reservation_id,
                generation_attempt_id=reservation["generation_attempt_id"], effects=effects,
                reason_code=reason_code, occurred_at=occurred_at, idempotency_key=idempotency_key)
            return self._update_ledger(ledger, effects=effects, sequence=sequence,
                                       status="reconciliation_required")

    def revoke(self, *, ledger_id: str, idempotency_key: str, expected_version: int,
               expected_content_hash: str, occurred_at: str) -> dict:
        with self._transaction():
            if self._event_exists(idempotency_key, "revoked", None):
                return self.snapshot(ledger_id)
            ledger, grant = self._require_fresh_ledger(ledger_id, expected_version, expected_content_hash)
            scope = json.loads(ledger["scope_json"])
            transition = {"previousAccountBindingRef": scope.get("account_binding_ref"),
                          "previousConnectionInstanceRef": scope["connection_instance_ref"]}
            effects = {"reservedTasksDelta": 0, "reservedCostMicrounitsDelta": "0",
                       "consumedTasksDelta": 0, "consumedCostMicrounitsDelta": "0"}
            sequence = self._append_event(
                ledger=ledger, event_type="revoked", reservation_id=None,
                generation_attempt_id=None, effects=effects, reason_code="manual_revocation",
                occurred_at=occurred_at, idempotency_key=idempotency_key,
                binding_transition=transition)
            grant_projection = self._grant_projection(
                grant["grant_id"], BudgetScope(**scope), grant["max_tasks"],
                grant["max_cost_microunits"], "revoked", grant["binding_revision"],
                grant["version"] + 1)
            self.connection.execute(
                "UPDATE generation_budget_grants SET status='revoked',version=?,content_hash=? WHERE grant_id=?",
                (grant_projection["version"], _hash("generation-budget-grant", "envelope", grant_projection),
                 grant["grant_id"]))
            return self._update_ledger(ledger, effects=effects, sequence=sequence, status="revoked")

    def rotate_binding(self, *, ledger_id: str, replacement_grant_id: str,
                       replacement_ledger_id: str, next_scope: BudgetScope,
                       idempotency_key: str, expected_version: int,
                       expected_content_hash: str, occurred_at: str) -> dict:
        with self._transaction():
            if self._event_exists(idempotency_key, "binding_rotated", None):
                return self.snapshot(ledger_id)
            ledger, grant = self._require_fresh_ledger(ledger_id, expected_version, expected_content_hash)
            previous_scope = BudgetScope(**json.loads(ledger["scope_json"]))
            if (previous_scope.account_binding_ref == next_scope.account_binding_ref and
                    previous_scope.connection_instance_ref == next_scope.connection_instance_ref):
                raise ValueError("BUDGET_BINDING_ROTATION_NO_CHANGE")
            effects = {"reservedTasksDelta": 0, "reservedCostMicrounitsDelta": "0",
                       "consumedTasksDelta": 0, "consumedCostMicrounitsDelta": "0"}
            transition = {"previousAccountBindingRef": previous_scope.account_binding_ref,
                          "previousConnectionInstanceRef": previous_scope.connection_instance_ref,
                          "nextAccountBindingRef": next_scope.account_binding_ref,
                          "nextConnectionInstanceRef": next_scope.connection_instance_ref,
                          "replacementGrantId": replacement_grant_id,
                          "replacementLedgerId": replacement_ledger_id}
            sequence = self._append_event(
                ledger=ledger, event_type="binding_rotated", reservation_id=None,
                generation_attempt_id=None, effects=effects, reason_code="account_binding_changed",
                occurred_at=occurred_at, idempotency_key=idempotency_key,
                binding_transition=transition)
            old_grant = self._grant_projection(
                grant["grant_id"], previous_scope, grant["max_tasks"], grant["max_cost_microunits"],
                "binding_rotated", grant["binding_revision"] + 1, grant["version"] + 1)
            self.connection.execute(
                "UPDATE generation_budget_grants SET status='binding_rotated',binding_revision=?,"
                "version=?,content_hash=? WHERE grant_id=?",
                (old_grant["binding_revision"], old_grant["version"],
                 _hash("generation-budget-grant", "envelope", old_grant), grant["grant_id"]))
            updated = self._update_ledger(ledger, effects=effects, sequence=sequence,
                                          status="binding_rotated")
            replacement_grant = self._grant_projection(
                replacement_grant_id, next_scope, grant["max_tasks"], grant["max_cost_microunits"],
                "active", 1, 1)
            replacement_ledger = {"ledger_id": replacement_ledger_id, "grant_id": replacement_grant_id,
                                  "scope": asdict(next_scope), "reserved_tasks": 0,
                                  "reserved_cost_microunits": "0", "consumed_tasks": 0,
                                  "consumed_cost_microunits": "0", "open_reservation_ids": [],
                                  "last_event_sequence": 0, "status": "active", "version": 1}
            scope_json = _canonical(asdict(next_scope))
            self.connection.execute("INSERT INTO generation_budget_grants VALUES(?,?,?,?,?,?,?,?)",
                                    (replacement_grant_id, scope_json, grant["max_tasks"],
                                     grant["max_cost_microunits"], "active", 1, 1,
                                     _hash("generation-budget-grant", "envelope", replacement_grant)))
            self.connection.execute("INSERT INTO generation_budget_ledgers VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                                    (replacement_ledger_id, replacement_grant_id, scope_json, 0, "0", 0,
                                     "0", "[]", 0, "active", 1,
                                     _hash("budget-ledger", "envelope", replacement_ledger)))
            return updated

    def snapshot(self, ledger_id: str) -> dict:
        with self._lock:
            row = self.connection.execute("SELECT * FROM generation_budget_ledgers WHERE ledger_id=?",
                                          (ledger_id,)).fetchone()
            if not row:
                raise KeyError(ledger_id)
            return dict(row)

    def event_count(self, ledger_id: str) -> int:
        with self._lock:
            return int(self.connection.execute(
                "SELECT count(*) FROM generation_budget_events WHERE ledger_id=?", (ledger_id,)).fetchone()[0])

    def event_types(self, ledger_id: str) -> list[str]:
        with self._lock:
            return [row[0] for row in self.connection.execute(
                "SELECT event_type FROM generation_budget_events WHERE ledger_id=? ORDER BY sequence",
                (ledger_id,))]

    def verify_ledger_against_events(self, ledger_id: str) -> None:
        with self._lock:
            ledger = self.snapshot(ledger_id)
            totals = {"reserved_tasks": 0, "reserved_cost": 0, "consumed_tasks": 0, "consumed_cost": 0}
            sequence = 0
            for row in self.connection.execute(
                    "SELECT * FROM generation_budget_events WHERE ledger_id=? ORDER BY sequence", (ledger_id,)):
                if row["sequence"] != sequence + 1:
                    raise ValueError("BUDGET_LEDGER_INCONSISTENT")
                effects = json.loads(row["effects_json"])
                totals["reserved_tasks"] += effects["reservedTasksDelta"]
                totals["reserved_cost"] += _delta(effects["reservedCostMicrounitsDelta"])
                totals["consumed_tasks"] += effects["consumedTasksDelta"]
                totals["consumed_cost"] += _delta(effects["consumedCostMicrounitsDelta"])
                sequence = row["sequence"]
        actual = (ledger["reserved_tasks"], _amount(ledger["reserved_cost_microunits"]),
                  ledger["consumed_tasks"], _amount(ledger["consumed_cost_microunits"]),
                  ledger["last_event_sequence"])
        expected = (totals["reserved_tasks"], totals["reserved_cost"],
                    totals["consumed_tasks"], totals["consumed_cost"], sequence)
        if actual != expected:
            raise ValueError("BUDGET_LEDGER_INCONSISTENT")
