#!/usr/bin/env python3
from __future__ import annotations

import atexit
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from desktop_runtime import bind_acceptance_build_id, free_port, port_open, request_app_termination, wait_for


ROOT = Path(__file__).resolve().parents[2]
PROJECT_ID = "33333333-3333-4333-8333-333333333333"
SUBMISSION_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
SUBMISSION_ID = f"FILMOS-SUBMISSION-{SUBMISSION_UUID}"
ISSUE_ID = f"FILMOS-ARCH-{SUBMISSION_UUID}"
CAPTURED_AT = "2026-09-02T01:00:00Z"
EVENT_PREFIX = "FILMOS_REVIEW_VERTICAL_CANARY "


def run(command: tuple[str, ...], environment: dict[str, str] | None = None) -> str:
    result = subprocess.run(command, cwd=ROOT, env=environment, text=True, capture_output=True, check=False)
    output = (result.stdout + result.stderr).strip()
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}\n{output}")
    return output


def git(*arguments: str) -> str:
    return run(("git", *arguments)).strip()


def request_json(
    url: str,
    *,
    method: str = "GET",
    token: str | None = None,
    body: dict[str, Any] | None = None,
    timeout: float = 3,
) -> tuple[int, dict[str, Any]]:
    headers = {"accept": "application/json"}
    data = None
    if token:
        headers["authorization"] = f"Bearer {token}"
    if body is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        payload = json.loads(error.read().decode("utf-8"))
        return error.code, payload


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def metadata_snapshot(paths: tuple[Path, ...]) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    for root in paths:
        if not root.exists():
            entries.append({"root": root.name, "exists": False})
            continue
        for path in sorted((root, *root.rglob("*")), key=lambda item: str(item)):
            try:
                stat = path.lstat()
            except FileNotFoundError:
                continue
            entries.append({
                "root": root.name,
                "relative": "." if path == root else str(path.relative_to(root)),
                "kind": "directory" if path.is_dir() else "file",
                "size": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
            })
    encoded = json.dumps(entries, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return {"entry_count": len(entries), "metadata_hash": hashlib.sha256(encoded).hexdigest()}


def canary_events(log_path: Path) -> list[dict[str, Any]]:
    if not log_path.is_file():
        return []
    events = []
    for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if EVENT_PREFIX not in line:
            continue
        raw = line.split(EVENT_PREFIX, 1)[1].strip()
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def wait_event(log_path: Path, event_name: str, timeout: float = 45) -> dict[str, Any]:
    selected: dict[str, Any] | None = None

    def present() -> bool:
        nonlocal selected
        selected = next((item for item in reversed(canary_events(log_path)) if item.get("event") == event_name), None)
        return selected is not None

    try:
        wait_for(present, timeout, f"packaged app did not emit {event_name}")
    except RuntimeError as error:
        events = canary_events(log_path)
        log_tail = log_path.read_text(encoding="utf-8", errors="replace")[-12000:] if log_path.is_file() else ""
        raise RuntimeError(f"{error}; observed_events={events}; log_tail=\n{log_tail}") from error
    assert selected is not None
    return selected


def start_process(command: tuple[str, ...], environment: dict[str, str], log_path: Path) -> tuple[subprocess.Popen[bytes], Any]:
    output = log_path.open("ab")
    process = subprocess.Popen(command, cwd=ROOT, env=environment, stdout=output, stderr=subprocess.STDOUT)
    return process, output


def stop_process(process: subprocess.Popen[bytes] | None, output: Any | None, *, app: bool = False) -> None:
    if process is not None and process.poll() is None:
        if app:
            request_app_termination(process)
        else:
            process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if output is not None:
        output.close()


def wait_http(url: str, timeout: float = 25) -> None:
    def ready() -> bool:
        try:
            status, _ = request_json(url, timeout=1)
            return status == 200
        except (OSError, ValueError, urllib.error.URLError):
            return False

    wait_for(ready, timeout, f"service did not become ready: {url}")


def wait_packaged_services(
    process: subprocess.Popen[bytes],
    log_path: Path,
    ports: tuple[int, ...],
    phase: str,
    timeout: float = 30,
) -> None:
    try:
        wait_for(lambda: all(port_open(port) for port in ports), timeout, f"{phase} packaged app services did not start")
    except RuntimeError as error:
        port_status = {str(port): port_open(port) for port in ports}
        log_tail = ""
        if log_path.is_file():
            log_tail = log_path.read_text(encoding="utf-8", errors="replace")[-12000:]
        raise RuntimeError(
            f"{error}; process_exit={process.poll()}; port_status={port_status}; log_tail=\n{log_tail}"
        ) from error


def assert_exact_database(database: Path, receipt_hash: str) -> dict[str, Any]:
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    try:
        counts = {
            "submission": connection.execute("SELECT COUNT(*) FROM review_submissions WHERE submission_id = ?", (SUBMISSION_ID,)).fetchone()[0],
            "receipt": connection.execute("SELECT COUNT(*) FROM review_submission_receipts WHERE submission_id = ? AND receipt_hash = ?", (SUBMISSION_ID, receipt_hash)).fetchone()[0],
            "projection": connection.execute("SELECT COUNT(*) FROM review_projections WHERE issue_id = ? AND project_id = ?", (ISSUE_ID, PROJECT_ID)).fetchone()[0],
            "issue_observed": connection.execute("SELECT COUNT(*) FROM review_events WHERE issue_id = ? AND event_type = 'issue.observed'", (ISSUE_ID,)).fetchone()[0],
            "attachment": connection.execute("SELECT COUNT(*) FROM review_attachments WHERE issue_id = ?", (ISSUE_ID,)).fetchone()[0],
            "pending_read": connection.execute("SELECT COUNT(*) FROM review_read_receipts WHERE issue_id = ? AND consumer = 'chatgpt-mcp' AND tool_name = 'issue_list_pending'", (ISSUE_ID,)).fetchone()[0],
            "evidence_read": connection.execute("SELECT COUNT(*) FROM review_read_receipts WHERE issue_id = ? AND consumer = 'chatgpt-mcp' AND tool_name = 'issue_get_evidence'", (ISSUE_ID,)).fetchone()[0],
        }
        if counts != {
            "submission": 1,
            "receipt": 1,
            "projection": 1,
            "issue_observed": 1,
            "attachment": 1,
            "pending_read": 1,
            "evidence_read": 1,
        }:
            raise RuntimeError(f"vertical canary database uniqueness mismatch: {counts}")
        previous_hash: str | None = None
        event_count = 0
        for row in connection.execute(
            "SELECT event_id,issue_id,event_type,actor,payload_json,previous_hash,event_hash,created_at FROM review_events WHERE issue_id = ? ORDER BY sequence",
            (ISSUE_ID,),
        ):
            if row["previous_hash"] != previous_hash:
                raise RuntimeError("vertical canary event chain previous hash mismatch")
            event_base = {
                "event_id": row["event_id"],
                "issue_id": row["issue_id"],
                "event_type": row["event_type"],
                "actor": row["actor"],
                "payload": json.loads(row["payload_json"]),
                "previous_hash": row["previous_hash"],
                "created_at": row["created_at"],
            }
            encoded = json.dumps(event_base, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
            if hashlib.sha256(encoded).hexdigest() != row["event_hash"]:
                raise RuntimeError("vertical canary event chain content hash mismatch")
            previous_hash = row["event_hash"]
            event_count += 1
        if event_count < 5:
            raise RuntimeError("vertical canary architecture transition evidence is incomplete")
        return {"counts": counts, "event_count": event_count, "event_chain_verified": True}
    finally:
        connection.close()


def main() -> None:
    if git("status", "--porcelain"):
        raise RuntimeError("vertical canary requires a clean source worktree so Installed SourceIdentity is exact")

    web_port = free_port()
    backend_port = free_port()
    review_bus_port = free_port()
    local_runtime_port = free_port()
    film_core_port = free_port()
    chatgpt_mcp_port = free_port()
    while len({web_port, backend_port, review_bus_port, local_runtime_port, film_core_port, chatgpt_mcp_port}) != 6:
        backend_port = free_port()
        review_bus_port = free_port()
        local_runtime_port = free_port()
        film_core_port = free_port()
        chatgpt_mcp_port = free_port()
    lifecycle_ports = (web_port, backend_port, review_bus_port, local_runtime_port, film_core_port, chatgpt_mcp_port)
    real_support = Path.home() / "Library/Application Support/FilmOS Studio"
    protected = (real_support / "review-bus", real_support / "WorkbenchData")
    user_before = metadata_snapshot(protected)

    with tempfile.TemporaryDirectory(prefix="filmos-review-vertical-canary-") as directory_text:
        directory = Path(directory_text)
        suffix = directory.name[-8:].lower().replace("_", "-")
        bundle = directory / "FilmOS Studio.app"
        review_bus_directory = directory / "governance" / "review-bus"
        developer_root = directory / "governance" / "DeveloperRepository"
        support_name = f"FilmOS Review Canary {suffix}"
        bundle_id = f"com.filmos.studio.acceptance.{suffix}"
        support_directory = Path.home() / "Library/Application Support" / support_name
        webkit_directory = Path.home() / "Library/WebKit" / bundle_id
        atexit.register(shutil.rmtree, support_directory, ignore_errors=True)
        atexit.register(shutil.rmtree, webkit_directory, ignore_errors=True)
        environment = bind_acceptance_build_id(os.environ.copy())
        environment.update({
            "FILMOS_DESKTOP_WEB_PORT": str(web_port),
            "FILMOS_DESKTOP_BACKEND_PORT": str(backend_port),
            "FILMOS_DESKTOP_REVIEW_BUS_PORT": str(review_bus_port),
            "FILMOS_DESKTOP_APPLICATION_SUPPORT_DIRECTORY_NAME": support_name,
            "FILMOS_EXPECTED_APPLICATION_SUPPORT_DIRECTORY_NAME": support_name,
            "FILMOS_DESKTOP_BUNDLE_IDENTIFIER": bundle_id,
            "FILMOS_EXPECTED_BUNDLE_IDENTIFIER": bundle_id,
            "FILMOS_DESKTOP_RUNTIME_PROFILE": "filmos-candidate",
            "FILMOS_DESKTOP_RELEASE_CHANNEL": "candidate",
            "FILMOS_DESKTOP_EXTERNAL_PAID_SUBMIT_ENABLED": "false",
            "FILMOS_DESKTOP_ACCEPTANCE_REVIEW_BUS_DIRECTORY": str(review_bus_directory),
            "FILMOS_DESKTOP_VERTICAL_CANARY_PROJECT_ID": PROJECT_ID,
            "FILMOS_DESKTOP_VERTICAL_CANARY_SUBMISSION_UUID": SUBMISSION_UUID,
            "FILMOS_DESKTOP_VERTICAL_CANARY_CAPTURED_AT": CAPTURED_AT,
            "FILMOS_DESKTOP_CANARY_LOCAL_RUNTIME_PORT": str(local_runtime_port),
            "FILMOS_DESKTOP_CANARY_FILM_CORE_PORT": str(film_core_port),
            "FILMOS_DESKTOP_CANARY_MCP_PORT": str(chatgpt_mcp_port),
            "VITE_FRAMEFIELD_LOCAL_RUNTIME_ENDPOINT": f"http://127.0.0.1:{local_runtime_port}",
        })
        tunnel_cache = ROOT / ".local/cache/tunnel-client/tunnel-client-v0.0.13-darwin-arm64.zip"
        if tunnel_cache.is_file():
            environment["FILMOS_TUNNEL_CLIENT_ARCHIVE_CACHE"] = str(tunnel_cache)

        build_output = run(("desktop/macos/scripts/build-unsigned-app", str(bundle)), environment)
        verify_output = run(("desktop/macos/scripts/verify-unsigned-app", str(bundle)), environment)
        source_identity = json.loads((bundle / "Contents/Resources/SourceIdentity.json").read_text(encoding="utf-8"))
        internal_runtime = json.loads((bundle / "Contents/Resources/InternalRuntime.json").read_text(encoding="utf-8"))
        run(("desktop/macos/scripts/prepare-review-source-repository",), {
            **environment,
            "FILMOS_REVIEW_SOURCE_ROOT": str(ROOT),
            "FILMOS_REVIEW_DEVELOPER_ROOT": str(developer_root),
            "FILMOS_REVIEW_BUS_LOCAL_DIR": str(review_bus_directory),
        })

        app_process: subprocess.Popen[bytes] | None = None
        app_output: Any | None = None
        mcp_process: subprocess.Popen[bytes] | None = None
        mcp_output: Any | None = None
        seed_event: dict[str, Any]
        pending_event: dict[str, Any]
        confirmed_event: dict[str, Any]
        mcp_result: dict[str, Any]
        final_context: dict[str, Any]
        confirmation: dict[str, Any]
        submission_status: dict[str, Any]
        try:
            seed_log = directory / "seed-app.log"
            seed_environment = {**environment, "FILMOS_DESKTOP_VERTICAL_CANARY_PHASE": "seed"}
            app_process, app_output = start_process((str(bundle / "Contents/MacOS/FilmOSStudioDesktop"),), seed_environment, seed_log)
            wait_packaged_services(app_process, seed_log, lifecycle_ports[:-1], "seed")
            seed_event = wait_event(seed_log, "FINALIZE_COMMITTED_RECEIPT_DROPPED", 60)
            receipt = ((seed_event.get("result") or {}).get("receipt") or {})
            if receipt.get("formal_issue_id") != ISSUE_ID or receipt.get("project_id") != PROJECT_ID:
                raise RuntimeError(f"seed receipt scope mismatch: {receipt}")
            stop_process(app_process, app_output, app=True)
            app_process = None
            app_output = None
            wait_for(lambda: not any(port_open(port) for port in lifecycle_ports[:-1]), 20, "seed packaged services did not stop")

            recover_log = directory / "recover-app.log"
            recover_environment = {**environment, "FILMOS_DESKTOP_VERTICAL_CANARY_PHASE": "recover"}
            app_process, app_output = start_process((str(bundle / "Contents/MacOS/FilmOSStudioDesktop"),), recover_environment, recover_log)
            wait_packaged_services(app_process, recover_log, lifecycle_ports[:-1], "recovery")
            pending_event = wait_event(recover_log, "RECOVERY_PENDING", 45)
            if (pending_event.get("status") or {}).get("pending_count") != 1:
                raise RuntimeError(f"recovery did not restore exactly one local pending draft: {pending_event}")

            token_file = review_bus_directory / "review-bus.token"
            wait_for(token_file.is_file, 10, "isolated Review Bus token missing")
            review_token = token_file.read_text(encoding="utf-8").strip()
            review_base = f"http://127.0.0.1:{review_bus_port}"
            status, requirement = request_json(
                f"{review_base}/v1/issues/{urllib.parse.quote(ISSUE_ID)}/architecture/requirement-delta",
                method="POST",
                token=review_token,
                body={
                    "current_flow": "The packaged app has one locally durable Architecture submission whose first finalize receipt was deliberately lost.",
                    "current_blocker": "The same draft must recover through Review Bus without duplicate issue, event, projection, or receipt.",
                    "target_experience": "After app restart, the exact project-scoped issue reaches independent Assessment readiness and MCP evidence readback.",
                    "must_preserve": ["Review Bus authority", "submission idempotency", "project isolation", "captured attachment hash"],
                    "may_change": ["local delivery state after verified readback"],
                    "success_criteria": ["one canonical issue", "one issue.observed event", "MCP Evidence readable", "pending count becomes zero"],
                },
            )
            if status != 200 or requirement.get("state") != "REQUIREMENT_DELTA_FROZEN":
                raise RuntimeError(f"owner requirement delta failed: {status} {requirement}")

            def assessment_ready() -> bool:
                nonlocal final_context
                code, value = request_json(
                    f"{review_base}/v1/review/internal/issues/{urllib.parse.quote(ISSUE_ID)}/full-context?project_id={urllib.parse.quote(PROJECT_ID)}",
                    token=review_token,
                )
                if code == 200:
                    final_context = value
                    return value.get("state") == "ARCHITECTURE_ASSESSMENTS_PENDING" and (value.get("codex_coordination") or {}).get("last_action") == "MODEL_TURN_DISABLED:LOCAL_ASSESSMENT"
                return False

            final_context = {}
            wait_for(assessment_ready, 45, "Coordinator did not reach model-disabled Assessment readiness")

            mcp_directory = support_directory / "ChatGPTConnection/MCP"
            grant_environment = {**recover_environment, "FILMOS_CHATGPT_LOCAL_DIR": str(mcp_directory)}
            grant = json.loads(run((str(bundle / "Contents/Helpers/FilmOSChatGPTGrant"), "issue", PROJECT_ID, "vertical-canary", "20"), grant_environment))
            mcp_environment = {
                **recover_environment,
                "FILMOS_CHATGPT_APP_ENABLED": "true",
                "FILMOS_CHATGPT_READ_TOOLS_ENABLED": "true",
                "FILMOS_CHATGPT_WIDGETS_ENABLED": "false",
                "FILMOS_CHATGPT_PROPOSAL_HANDOFF_ENABLED": "false",
                "FILMOS_CHATGPT_HOST_PROFILE": "chatgpt.subscription.host.pro_readonly",
                "FILMOS_CHATGPT_CONNECTION_ID": "vertical-canary",
                "FILMOS_CHATGPT_HOST": "127.0.0.1",
                "FILMOS_CHATGPT_PORT": str(chatgpt_mcp_port),
                "FILMOS_CHATGPT_LOCAL_DIR": str(mcp_directory),
                "FILMOS_CHATGPT_PID_FILE": str(mcp_directory / "canary-mcp.pid"),
                "FILMOS_CORE_BASE_URL": f"http://127.0.0.1:{film_core_port}/film",
                "FILMOS_REVIEW_BUS_READ_ENABLED": "true",
                "FILMOS_REVIEW_BUS_BASE_URL": review_base,
                "FILMOS_REVIEW_BUS_AUTH_FILE": str(token_file),
                "FILMOS_SECURE_TUNNEL_PROOF": "vertical-canary-loopback-proof",
            }
            mcp_log = directory / "packaged-mcp.log"
            mcp_process, mcp_output = start_process((str(bundle / "Contents/Helpers/FilmOSChatGPTMCP"),), mcp_environment, mcp_log)
            wait_http(f"http://127.0.0.1:{chatgpt_mcp_port}/health", 20)
            client_environment = {**mcp_environment, "FILMOS_CANARY_PROJECT_GRANT": grant["token"]}
            mcp_result = json.loads(run((
                "node",
                "services/filmos-chatgpt-app/scripts/packaged-review-canary-client.mjs",
                f"http://127.0.0.1:{chatgpt_mcp_port}/mcp",
                PROJECT_ID,
                ISSUE_ID,
            ), client_environment))
            if mcp_result.get("status") != "PASS":
                raise RuntimeError(f"packaged MCP read canary failed: {mcp_result}")
            confirmed_event = wait_event(recover_log, "RECOVERY_CONFIRMED", 35)
            confirmed_status = confirmed_event.get("status") or {}
            if confirmed_status.get("pending_count") != 0 or confirmed_status.get("canonical_issue_id") != ISSUE_ID:
                raise RuntimeError(f"recovery confirmation mismatch: {confirmed_event}")

            code, submission_status = request_json(
                f"{review_base}/v1/submissions/{urllib.parse.quote(SUBMISSION_ID)}?project_id={urllib.parse.quote(PROJECT_ID)}",
                token=review_token,
            )
            if code != 200:
                raise RuntimeError(f"submission status unavailable: {code} {submission_status}")
            code, confirmation = request_json(
                f"{review_base}/v1/review/internal/issues/{urllib.parse.quote(ISSUE_ID)}/intake-confirmation?project_id={urllib.parse.quote(PROJECT_ID)}",
                token=review_token,
            )
            if code != 200 or not confirmation.get("pending_read") or not confirmation.get("evidence_read"):
                raise RuntimeError(f"MCP intake confirmation missing: {code} {confirmation}")
        finally:
            stop_process(mcp_process, mcp_output)
            stop_process(app_process, app_output, app=True)
            wait_for(lambda: not any(port_open(port) for port in lifecycle_ports), 25, "vertical canary services did not stop")

        receipt_hash = confirmation["receipt_hash"]
        database = review_bus_directory / "review-bus.sqlite"
        database_proof = assert_exact_database(database, receipt_hash)
        if submission_status.get("receipt", {}).get("receipt_hash") != receipt_hash:
            raise RuntimeError("idempotent recovery receipt changed")
        if final_context.get("project_id") != PROJECT_ID or final_context.get("state") != "ARCHITECTURE_ASSESSMENTS_PENDING":
            raise RuntimeError("final Architecture context is not project-scoped Assessment-ready")
        if source_identity.get("git_commit_sha") != git("rev-parse", "HEAD") or source_identity.get("git_tree_sha") != git("rev-parse", "HEAD^{tree}"):
            raise RuntimeError("packaged SourceIdentity does not match the clean canary source")
        if internal_runtime.get("external_paid_submit_enabled") is not False:
            raise RuntimeError("packaged canary did not fail closed for paid submit")

        shutil.rmtree(support_directory, ignore_errors=True)
        shutil.rmtree(webkit_directory, ignore_errors=True)

        user_after = metadata_snapshot(protected)
        if user_after != user_before:
            raise RuntimeError(f"real FilmOS user data metadata changed during isolated canary: before={user_before} after={user_after}")
        result = {
            "schema_version": "filmos.desktop-review-vertical-canary.v1",
            "status": "PASS",
            "installed_app": {
                "build_id": source_identity["build_id"],
                "commit": source_identity["git_commit_sha"],
                "tree": source_identity["git_tree_sha"],
                "bundle_identifier": "<isolated-acceptance-bundle>",
                "build": "UNSIGNED_APP_READY" if "UNSIGNED_APP_READY" in build_output else "UNKNOWN",
                "verify": verify_output.splitlines()[-1],
            },
            "chain": ["ReportIssuePortal", "IndexedDB", "WKWebView", "Swift", "ReviewBus", "SQLite", "Coordinator", "MCPProjection"],
            "project_id": PROJECT_ID,
            "submission_id": SUBMISSION_ID,
            "canonical_issue_id": ISSUE_ID,
            "receipt_hash": receipt_hash,
            "first_finalize_receipt_deliberately_lost": seed_event["event"] == "FINALIZE_COMMITTED_RECEIPT_DROPPED",
            "restart_pending_count": (pending_event.get("status") or {}).get("pending_count"),
            "final_pending_count": (confirmed_event.get("status") or {}).get("pending_count"),
            "assessment_state": final_context["state"],
            "coordinator_action": (final_context.get("codex_coordination") or {}).get("last_action"),
            "mcp": mcp_result,
            "database": database_proof,
            "user_data": {"before": user_before, "after": user_after, "preserved": True},
            "isolated_review_bus": True,
            "isolated_webkit_origin": True,
            "external_network_requests": 0,
            "openai_model_api_calls": 0,
            "paid_provider_operations": 0,
        }
        result["result_hash"] = hashlib.sha256(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
