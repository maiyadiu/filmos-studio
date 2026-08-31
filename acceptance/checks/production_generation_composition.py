#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def run(command: tuple[str, ...], cwd: Path, environment: dict[str, str]) -> str:
    result = subprocess.run(command, cwd=cwd, env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    if result.returncode:
        raise RuntimeError(f"production composition command failed: {' '.join(command)}\n{result.stdout[-4000:]}")
    return result.stdout


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def unused_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def wait_for_health(url: str, process: subprocess.Popen[str]) -> None:
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process.poll() is not None:
            output = process.stdout.read() if process.stdout else ""
            raise RuntimeError(f"Film Core production sidecar exited early\n{output[-4000:]}")
        try:
            with urllib.request.urlopen(url, timeout=0.25) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(0.05)
    raise RuntimeError("Film Core production sidecar did not become ready")


def main() -> int:
    environment = os.environ.copy()
    environment["FILMOS_EXTERNAL_NETWORK_FORBIDDEN"] = "1"
    film_core_python = environment.get("FILMOS_TEST_PYTHON", "").strip()
    if not film_core_python:
        raise RuntimeError("FILMOS_TEST_PYTHON is required for persistent Film Core production composition")
    with tempfile.TemporaryDirectory(prefix="filmos-production-composition-") as temporary:
        trace_path = Path(temporary) / "production-generation-trace.json"
        http_trace_path = Path(temporary) / "production-generation-film-core-http-trace.json"
        database_path = Path(temporary) / "film-core-production.sqlite"
        port = unused_loopback_port()
        film_core_base_url = f"http://127.0.0.1:{port}/film"
        environment["FILMOS_PRODUCTION_TRACE_OUTPUT"] = str(trace_path)
        environment["FILMOS_PRODUCTION_HTTP_TRACE_OUTPUT"] = str(http_trace_path)
        environment["FILMOS_PRODUCTION_FILM_CORE_URL"] = film_core_base_url
        environment["PYTHONPATH"] = str(ROOT / "film-core" / "src")
        sidecar = subprocess.Popen(
            (
                film_core_python,
                str(ROOT / "canvas-agent" / "test" / "fixtures" / "film-core-http-sidecar.py"),
                "--database", str(database_path),
                "--port", str(port),
            ),
            cwd=ROOT,
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        try:
            wait_for_health(f"http://127.0.0.1:{port}/film/health", sidecar)
            web_log = run(("bun", "test", "test/production-generation-composition.test.ts", "test/production-generation-film-core-http.test.ts", "test/project-production-runtime.test.ts", "test/engine-connection-synchronizer.test.ts", "test/agent-browser-runtime-lifecycle.test.ts", "test/brain-generation-routing-config.test.ts", "test/canonical-generation-tool-runtime.test.ts"), ROOT / "web", environment)
        finally:
            sidecar.terminate()
            try:
                sidecar.wait(timeout=5)
            except subprocess.TimeoutExpired:
                sidecar.kill()
                sidecar.wait(timeout=2)
        core_log = run((film_core_python, "-m", "pytest", "-q", "tests/test_generation_production.py"), ROOT / "film-core", environment)
        trace = json.loads(trace_path.read_text(encoding="utf-8"))
        http_trace = json.loads(http_trace_path.read_text(encoding="utf-8"))

    approved = trace["rounds"]["approve"]
    rejected = trace["rounds"]["reject"]
    stale = trace["rounds"]["stale"]
    restarted = trace["rounds"]["restart"]
    events = [item["event"] for item in approved["trace"]]
    expected = [
        "draft.created", "descriptor.resolved", "prompt.compiled", "route.snapshotted", "proposal.previewed",
        "confirmation.approved", "catalog.validated", "input.authorized", "budget.reserved", "submission.authorized",
        "provider.submitted", "provider.succeeded", "output.downloaded", "candidate.imported", "qc.pending",
    ]
    if events != expected:
        raise RuntimeError("production generation trace sequence changed")
    if rejected["decision_event"]["event"] != "confirmation.rejected" or rejected["provider_submit_count"] != 0:
        raise RuntimeError("reject round crossed provider boundary")
    if approved["provider_submit_count"] != 1 or approved["provider_receipt"]["externalNetworkRequests"] != 0:
        raise RuntimeError("approved local Mock Provider is not exactly-once and zero-network")
    if stale["blocked_code"] != "GENERATION_SUBMISSION_STALE" or stale["provider_submit_delta"] != 0:
        raise RuntimeError("stale round did not fail before provider submit")
    if restarted["provider_submit_count"] != 0:
        raise RuntimeError("restart recovery resubmitted the provider task")
    if approved["candidate"]["qcState"] != "pending" or approved["candidate"]["approvalState"] != "not_approved":
        raise RuntimeError("provider success crossed the Candidate approval boundary")
    if trace["external_network_request_count"] != 0 or trace["external_spend_microunits"] != "0":
        raise RuntimeError("production composition external effect closure changed")
    if trace.get("synthetic_broker_receipt_count") != 0 or http_trace.get("synthetic_broker_receipt_count") != 0:
        raise RuntimeError("synthetic Broker receipt detected")
    for broker in (trace.get("canonical_broker", {}), http_trace.get("canonical_broker", {})):
        if not broker.get("confirmation_id") or not broker.get("broker_grant_id") or not broker.get("broker_decision_receipt_id"):
            raise RuntimeError("Canonical Broker identity is missing")
        if any(len(str(broker.get(field, ""))) != 64 for field in ("broker_grant_content_hash", "broker_decision_receipt_content_hash")):
            raise RuntimeError("Canonical Broker hash evidence is incomplete")
    if not trace.get("hard_lock_unsupported_blocked") or not trace.get("tampered_authorization_blocked"):
        raise RuntimeError("reference hard-lock or authorization tamper gate was not proven")
    if trace.get("route_precedence_verified") != ["explicit_task", "node_override", "project_default", "global_default"]:
        raise RuntimeError("production route precedence was not proven by the runtime test")
    if not trace.get("route_missing_fails_closed"):
        raise RuntimeError("missing production route did not fail closed")
    if http_trace.get("status") != "PASSED" or http_trace.get("film_core_transport") != "loopback_http":
        raise RuntimeError("candidate runtime did not complete through real Film Core HTTP")
    if http_trace.get("gate_id") != "V2-4-FINAL-PRODUCTION-AUTHORITY-001":
        raise RuntimeError("final production authority gate id changed")
    if http_trace.get("approve_provider_submit_count") != 1 or http_trace.get("restart_provider_resubmit_count") != 0:
        raise RuntimeError("Film Core HTTP composition is not exactly-once across restart")
    if http_trace.get("legacy_direct_submit_count") != 0 or http_trace.get("candidate_count") != 1 or http_trace.get("approval_count") != 0:
        raise RuntimeError("Film Core HTTP composition object-count closure changed")
    if not http_trace.get("film_core_project_policy_authority") or not http_trace.get("film_core_model_lock_authority"):
        raise RuntimeError("Project Policy or Model Lock is not owned by Film Core")
    if http_trace.get("candidate_qc_state") != "pending" or http_trace.get("candidate_approval_state") != "not_approved":
        raise RuntimeError("Film Core HTTP composition crossed the Candidate boundary")
    if http_trace.get("formal_counts") != {"generation_package": 1, "generation_attempt_evidence": 1, "candidate": 1}:
        raise RuntimeError("Film Core formal generation lineage is not the unique Candidate authority")
    if http_trace.get("active_formal_binding_count") != 1 or http_trace.get("parallel_candidate_write_count") != 0:
        raise RuntimeError("parallel Candidate authority was detected")
    ledger = http_trace.get("real_budget_ledger", {})
    if any((ledger.get("reservedTasks") != 0, ledger.get("reservedCostMicrounits") != "0", ledger.get("consumedTasks") != 1,
            ledger.get("consumedCostMicrounits") != "0", ledger.get("openReservationIds") != [], ledger.get("lastEventSequence") != 3)):
        raise RuntimeError("real Film Core Budget Ledger did not close reserve -> submitted -> settled")

    receipt = {
        "schema_version": "1.0.0",
        "gate_id": "V2-4-FINAL-PRODUCTION-AUTHORITY-001",
        "status": "PASSED",
        "project_name": "FilmOS_Acceptance_Project",
        "production_trace": trace,
        "film_core_http_trace": http_trace,
        "brain_runtime": {
            "profile_ids": ["openai.api", "anthropic.api", "deepseek.api", "local.model"],
            "exact_provider_protocol_capability_evidence": True,
            "local_brain_uses_dreamina": False,
            "provider_request_count": 0,
        },
        "reference_contract": {
            "prepared_representation_binding": True,
            "integer_weight_microunits": True,
            "hard_lock_required": True,
            "ordinal_zero_based_contiguous": True,
            "binding_id_excluded_from_semantic_hash": True,
            "hard_lock_unsupported_blocked_before_provider": trace["hard_lock_unsupported_blocked"],
            "tampered_authorization_blocked_before_provider": trace["tampered_authorization_blocked"],
        },
        "engine_connection_invariant": {
            "account_ready_requires_account_binding_ref": True,
            "flova_before_project_selection": "NOT_ROUTABLE",
        },
        "route_precedence": trace["route_precedence_verified"],
        "route_missing_fails_closed": trace["route_missing_fails_closed"],
        "mock_submit_exactly_once": True,
        "legacy_direct_submit_count": 0,
        "candidate_count": 1,
        "approval_count": 0,
        "formal_generation_lineage": http_trace["formal_counts"],
        "parallel_candidate_write_count": 0,
        "canonical_broker": http_trace["canonical_broker"],
        "synthetic_broker_receipt_count": 0,
        "film_core_project_policy_authority": True,
        "film_core_model_lock_authority": True,
        "ordinary_project_same_production_service": True,
        "real_budget_ledger": ledger,
        "budget_reservation_cost_microunits": "0",
        "candidate_boundary": "QC_PENDING_NOT_APPROVED",
        "restart_recovered_without_resubmit": True,
        "external_network_request_count": 0,
        "external_spend_microunits": "0",
        "web_test_log_sha256": sha256_text(web_log),
        "film_core_test_log_sha256": sha256_text(core_log),
    }
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
