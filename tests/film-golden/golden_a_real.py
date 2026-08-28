#!/usr/bin/env python3
"""Real Golden A Sidecar adapter.

The adapter always starts a temporary Film Core HTTP Sidecar. It fails closed
when a D-0005 operation is absent and never substitutes an in-memory formal
store or a fake approval path.
"""

from __future__ import annotations

import json
import hashlib
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
FILM_CORE_SOURCE = REPOSITORY_ROOT / "film-core" / "src"
REQUIRED_D0005_OPERATIONS = (
    ("POST", "/formal-records"),
    ("GET", "/formal-records/{filmEntityId}"),
    ("POST", "/script-versions/lock"),
    ("POST", "/prompts/compile"),
    ("POST", "/manual-results/import"),
    ("POST", "/reviews"),
    ("POST", "/approvals"),
    ("POST", "/continuity/check"),
)
ZERO_HASH = "0" * 64
HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64
FORMAL_STATES = {
    "creative_stage": "authored",
    "execution_state": "not_started",
    "review_state": "not_reviewed",
    "lock_state": "unlocked",
    "delivery_state": "not_ready",
    "stale_state": "fresh",
}


class GoldenARealError(RuntimeError):
    pass


class MissingCoreOperation(GoldenARealError):
    def __init__(self, operations: list[str]) -> None:
        super().__init__(f"Film Core is missing required D-0005 operations: {', '.join(operations)}")
        self.operations = operations


class CoreHttpError(GoldenARealError):
    def __init__(self, status: int, method: str, path: str, payload: Any) -> None:
        super().__init__(f"Film Core HTTP {status}: {method} {path}")
        self.status = status
        self.method = method
        self.path = path
        self.payload = payload


@dataclass(frozen=True)
class CoreOperation:
    method: str
    path: str
    operation_id: str


class FilmCoreHttpClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def get(self, path: str) -> Any:
        return self.request("GET", path)

    def post(self, path: str, payload: dict[str, Any]) -> Any:
        return self.request("POST", path, payload)

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        body = None if payload is None else json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                raw = error.read().decode("utf-8", errors="replace")
            finally:
                error.close()
            try:
                value: Any = json.loads(raw)
            except json.JSONDecodeError:
                value = raw
            raise CoreHttpError(error.code, method, path, value) from None

    def operations(self) -> dict[tuple[str, str], CoreOperation]:
        document = self.get("/openapi.json")
        paths = document.get("paths") if isinstance(document, dict) else None
        if not isinstance(paths, dict):
            raise GoldenARealError("Film Core OpenAPI document has no paths object")
        result: dict[tuple[str, str], CoreOperation] = {}
        for path, path_item in paths.items():
            if not isinstance(path_item, dict):
                continue
            for method, operation in path_item.items():
                upper = method.upper()
                if upper not in {"GET", "POST", "PUT", "PATCH", "DELETE"} or not isinstance(operation, dict):
                    continue
                result[(upper, path)] = CoreOperation(upper, path, str(operation.get("operationId", "")))
        return result

    def require_d0005_operations(self) -> dict[tuple[str, str], CoreOperation]:
        operations = self.operations()
        missing = [f"{method} {path}" for method, path in REQUIRED_D0005_OPERATIONS if (method, path) not in operations]
        if missing:
            raise MissingCoreOperation(missing)
        return operations


class TemporaryFilmCoreSidecar:
    def __init__(self, *, python_executable: str | None = None) -> None:
        self.python_executable = python_executable or os.environ.get("FILMOS_CORE_PYTHON", "").strip() or sys.executable
        self.temporary: tempfile.TemporaryDirectory[str] | None = None
        self.process: subprocess.Popen[str] | None = None
        self.base_url = ""
        self.database_path: Path | None = None

    def __enter__(self) -> FilmCoreHttpClient:
        self.temporary = tempfile.TemporaryDirectory(prefix="filmos-golden-a-")
        temporary_root = Path(self.temporary.name)
        self.database_path = temporary_root / "film-core.sqlite"
        port = available_loopback_port()
        self.base_url = f"http://127.0.0.1:{port}"
        environment = os.environ.copy()
        environment["FILMOS_CORE_DB_PATH"] = str(self.database_path)
        environment["PYTHONPATH"] = str(FILM_CORE_SOURCE)
        self.process = subprocess.Popen(
            [
                self.python_executable,
                "-m",
                "uvicorn",
                "film_production_core.api:create_app",
                "--factory",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--log-level",
                "warning",
            ],
            cwd=REPOSITORY_ROOT / "film-core",
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        client = FilmCoreHttpClient(self.base_url)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                stderr = self.process.stderr.read() if self.process.stderr else ""
                raise GoldenARealError(f"temporary Film Core exited before health check: {stderr.strip()}")
            try:
                health = client.get("/health")
                if health.get("status") == "ok" and health.get("service") == "film-production-core":
                    return client
            except (OSError, urllib.error.URLError, CoreHttpError, json.JSONDecodeError):
                pass
            time.sleep(0.05)
        raise GoldenARealError("temporary Film Core did not become healthy")

    def __exit__(self, _error_type: object, _error: object, _traceback: object) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        if self.process is not None:
            if self.process.stdout is not None:
                self.process.stdout.close()
            if self.process.stderr is not None:
                self.process.stderr.close()
        if self.temporary is not None:
            self.temporary.cleanup()


def available_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


def run_real_golden_a(*, python_executable: str | None = None) -> dict[str, Any]:
    """Run Golden A through a temporary real Core and the real local Web modules."""

    with TemporaryFilmCoreSidecar(python_executable=python_executable) as client:
        health = client.get("/health")
        try:
            operations = client.require_d0005_operations()
        except MissingCoreOperation as error:
            return {
                "golden_id": "GOLDEN-A-REAL",
                "test_status": "BLOCKED_MISSING_CORE_OPERATION",
                "prepared": False,
                "persisted": False,
                "reviewed": False,
                "approved": False,
                "external_provider_calls": 0,
                "sidecar": {
                    "health": health["status"],
                    "service": health["service"],
                    "database": "temporary_sqlite_sidecar",
                },
                "missing_operations": error.operations,
                "fallback_mock_used": False,
            }

        project = create_legacy(
            client,
            "film_project_extension",
            {"host_project_id": "host-project-golden-a"},
        )
        unit = create_legacy(
            client,
            "content_unit_extension",
            {
                "host_project_id": "host-project-golden-a",
                "host_unit_id": "host-unit-golden-a",
            },
            unit_kind="episode",
        )
        shot = create_legacy(
            client,
            "shot_extension",
            {
                "host_project_id": "host-project-golden-a",
                "host_unit_id": "host-unit-golden-a",
                "host_shot_id": "host-shot-golden-a",
            },
            director_unit_ids=[],
        )
        unlocked_script = create_formal(
            client,
            "script_version",
            host={
                "host_project_id": "host-project-golden-a",
                "host_unit_id": "host-unit-golden-a",
            },
            states=FORMAL_STATES,
            script_text="INT. ROOM - DAY\nA reaches for the cup.",
        )

        nonhuman_lock = expect_core_error(
            lambda: client.post(
                "/script-versions/lock",
                {
                    "locked_write": create_guard(),
                    "decision_write": create_guard(),
                    "actor_kind": "codex",
                    "source_script_version": version_guard(unlocked_script),
                    "approved_by": "golden-a-director",
                },
            ),
            status=409,
            code="human_script_lock_required",
        )
        locked = client.post(
            "/script-versions/lock",
            {
                "locked_write": create_guard(),
                "decision_write": create_guard(),
                "actor_kind": "human",
                "source_script_version": version_guard(unlocked_script),
                "approved_by": "golden-a-director",
            },
        )
        locked_script = locked["locked_script_version"]
        script_decision = locked["decision"]

        director_ir_text = (
            "人物在门口停步，右手握住门把，视线保持在室内目标；镜头不得越过既定轴线。"
        )
        director = create_formal(
            client,
            "director_unit",
            script_version=version_guard(locked_script),
            script_decision=version_guard(script_decision),
            states=FORMAL_STATES,
            director_ir_text=director_ir_text,
            director_ir_hash=sha256_text(director_ir_text),
            narrative_purpose="人物决定进入房间",
            performance_beats=["停步", "握住门把", "保持视线"],
        )
        coverage = create_formal(
            client,
            "coverage_link",
            director_unit=version_guard(director),
            shot=version_guard(shot),
            purpose="master coverage",
        )
        visual_lock_text = (
            "人物保持画面左侧，门与动作目标保持右侧；服装、道具与视线连续。"
        )
        visual_lock = create_formal(
            client,
            "visual_lock_set",
            project=version_guard(project),
            shot=version_guard(shot),
            states=FORMAL_STATES,
            visual_lock_text=visual_lock_text,
            visual_lock_hash=sha256_text(visual_lock_text),
            locks={
                "screen_direction": "left_to_right",
                "eyeline": "room_target",
                "action": "right_hand_reaches_door_handle",
                "prop_contact": "right_hand_on_door_handle",
            },
        )
        asset = create_formal(
            client,
            "asset_binding",
            project=version_guard(project),
            host={
                "host_project_id": "host-project-golden-a",
                "host_asset_id": "host-asset-door",
                "host_asset_version_id": "host-asset-door-v1",
            },
            role="hero_prop",
            priority=100,
            asset_content_hash=HASH_A,
        )

        prepared_input = local_segment_input(
            project=project,
            locked_script=locked_script,
            director=director,
            shot=shot,
            coverage=coverage,
            visual_lock=visual_lock,
            asset=asset,
            director_ir_text=director_ir_text,
            visual_lock_text=visual_lock_text,
        )
        prepared = run_local_segment(prepared_input)
        assert_local_bindings(prepared, director, visual_lock, asset)

        prompt_payload = {
            "draft_write": create_guard(),
            "provenance_write": create_guard(),
            "actor_kind": "codex",
            "states": FORMAL_STATES,
            "director_ir_hash": director["director_ir_hash"],
            "visual_lock_hash": visual_lock["visual_lock_hash"],
            "model_capability_profile": "manual.video.v1",
            "prompt_text": prepared["prompt"]["promptText"],
            "project": bound(project),
            "shot": bound(shot),
            "director_unit": bound(director),
            "visual_lock": bound(visual_lock),
            "prompt_template": {
                "host_prompt_template_id": "host-prompt-template-golden-a",
                "operation": "film.prompt.compile",
                "version": 1,
                "content_hash": prepared["prompt"]["templateHash"],
            },
            "assets": [
                {
                    "binding": bound(asset),
                    "asset_content_hash": asset["asset_content_hash"],
                }
            ],
            "capability_profile": {
                "profile_id": "manual-video-v1",
                "profile_version": 1,
                "provider_id": "manual_web",
                "output_kind": "video",
                "dialect": "plain_zh",
                "capabilities": {
                    "reference_assets": True,
                    "negative_prompt": True,
                    "camera_control": True,
                },
            },
            "provider_parameters": {
                "aspect_ratio": "9:16",
                "duration_seconds": 5,
                "seed": None,
                "negative_prompt": "身份漂移，轴线反转，道具错位",
            },
        }
        stale_prompt = json.loads(json.dumps(prompt_payload))
        stale_prompt["visual_lock"]["expected_content_hash"] = HASH_C
        stale_compile = expect_core_error(
            lambda: client.post("/prompts/compile", stale_prompt),
            status=409,
            code="content_hash_conflict",
        )
        compiled = client.post("/prompts/compile", prompt_payload)
        prompt = compiled["prompt_draft"]
        provenance = compiled["provenance"]

        package = create_formal(
            client,
            "generation_package",
            prompt_draft=version_guard(prompt),
            host_project_id="host-project-golden-a",
            provider_id="manual_web",
            capability_id="video",
            parameters={"aspect_ratio": "9:16", "duration_seconds": 5},
        )
        persisted_local_input = local_segment_input(
            project=project,
            locked_script=locked_script,
            director=director,
            shot=shot,
            coverage=coverage,
            visual_lock=visual_lock,
            asset=asset,
            director_ir_text=director_ir_text,
            visual_lock_text=visual_lock_text,
            prompt_draft=prompt,
            generation_package=package,
        )
        local_manual = run_local_segment(persisted_local_input)
        assert_local_bindings(local_manual, director, visual_lock, asset)

        imported = client.post(
            "/manual-results/import",
            {
                "evidence_write": create_guard(),
                "candidate_write": create_guard(),
                "actor_kind": "human",
                "generation_package": version_guard(package),
                "provider_task_id": local_manual["manualImport"]["providerTaskId"],
                "receipt": {
                    "receipt_id": local_manual["manualImport"]["receiptId"],
                    "content_hash": local_manual["manualImport"]["receiptContentHash"],
                    "captured_at": "2026-08-28T03:01:00Z",
                },
                "manual_source": {
                    "source_id": local_manual["manualImport"]["manualSourceId"],
                    "source_kind": "local_runtime_export",
                    "imported_by": local_manual["manualImport"]["importedBy"],
                    "imported_at": "2026-08-28T03:02:00Z",
                    "authorization_evidence_id": local_manual["manualImport"]["authorizationEvidenceId"],
                },
                "outputs": [
                    {
                        "host_resource_id": local_manual["manualImport"]["hostResourceId"],
                        "output_kind": "video",
                        "content_hash": local_manual["manualImport"]["outputContentHash"],
                        "mime_type": "video/mp4",
                        "bytes": 1024,
                    }
                ],
            },
        )
        candidate = imported["candidate"]
        evidence = imported["evidence"]

        continuity = client.post(
            "/continuity/check",
            {
                "write": create_guard(),
                "actor_kind": "codex",
                "previous_shot": None,
                "current_shot": version_guard(shot),
                "checks": [
                    continuity_check("axis", "shot-axis", "left_to_right"),
                    continuity_check("eyeline", "performer-gaze", "room_target"),
                    continuity_check("action", "right-hand", "reaches_door_handle"),
                    continuity_check("prop_contact", "host-asset-door", "right_hand"),
                ],
            },
        )
        review = client.post(
            "/reviews",
            {
                "write": create_guard(),
                "actor_kind": "codex",
                "candidate": version_guard(candidate),
                "review_state": "passed",
                "reviewer_kind": "automated_qc",
                "findings": [],
            },
        )
        nonhuman_approval = expect_core_error(
            lambda: client.post(
                "/approvals",
                {
                    "write": create_guard(),
                    "actor_kind": "codex",
                    "candidate": version_guard(candidate),
                    "passed_review": version_guard(review),
                    "approved_by": "golden-a-director",
                },
            ),
            status=409,
            code="human_approval_required",
        )
        approval = client.post(
            "/approvals",
            {
                "write": create_guard(),
                "actor_kind": "human",
                "candidate": version_guard(candidate),
                "passed_review": version_guard(review),
                "approved_by": "golden-a-director",
            },
        )
        persisted_candidate = client.get(
            f"/formal-records/{candidate['ref']['film_entity_id']}"
        )

        formal_entities = {
            "project": project,
            "content_unit": unit,
            "shot": shot,
            "source_script_version": unlocked_script,
            "locked_script_version": locked_script,
            "script_decision": script_decision,
            "director_unit": director,
            "coverage_link": coverage,
            "visual_lock_set": visual_lock,
            "asset_binding": asset,
            "prompt_draft": prompt,
            "prompt_provenance": provenance,
            "generation_package": package,
            "attempt_evidence": evidence,
            "candidate": candidate,
            "continuity_check": continuity,
            "review": review,
            "approval": approval,
        }
        for name, entity in formal_entities.items():
            require_uuid4(entity["ref"]["film_entity_id"], name)

        candidate_unchanged = persisted_candidate == candidate
        approval_separate = (
            approval["ref"]["film_entity_id"] != candidate["ref"]["film_entity_id"]
            and approval["approved_content_hash"] == candidate["ref"]["content_hash"]
        )
        return {
            "golden_id": "GOLDEN-A-REAL",
            "test_status": "PASSED",
            "prepared": prepared["prepared"] is True,
            "persisted": candidate_unchanged,
            "reviewed": review["review_state"] == "passed",
            "approved": approval_separate,
            "external_provider_calls": 0,
            "fallback_mock_used": False,
            "sidecar": {
                "health": health["status"],
                "service": health["service"],
                "database": "temporary_sqlite_sidecar",
            },
            "operations": {
                f"{method} {path}": operations[(method, path)].operation_id
                for method, path in REQUIRED_D0005_OPERATIONS
            },
            "script_lock": {
                "nonhuman_blocked": nonhuman_lock.status == 409,
                "source_lock_state": unlocked_script["states"]["lock_state"],
                "locked_state": locked_script["states"]["lock_state"],
                "decision": script_decision["decision"],
            },
            "source_hashes": prepared["sourceBindings"],
            "canvas": prepared["canvas"],
            "prompt": {
                "local_audit": prepared["prompt"]["audit"],
                "formal_id": prompt["ref"]["film_entity_id"],
                "aggregate_hash": prompt["ref"]["content_hash"],
                "raw_prompt_hash": prepared["prompt"]["promptHash"],
            },
            "manual_provider": {
                "local_candidate_state": local_manual["candidate"]["status"],
                "local_approval_state": local_manual["candidate"]["approvalState"],
                "package_submission": local_manual["package"]["externalSubmission"],
            },
            "qc": {
                "continuity_passed": continuity["passed"],
                "reviewer_kind": review["reviewer_kind"],
                "review_state": review["review_state"],
            },
            "conflict_recovery": {
                "stale_compile_blocked": stale_compile.status == 409,
                "recovered_with_current_guard": prompt["ref"]["version"] == 1,
                "nonhuman_approval_blocked": nonhuman_approval.status == 409,
            },
            "candidate": {
                "id": candidate["ref"]["film_entity_id"],
                "review_state": candidate["states"]["review_state"],
                "unchanged_after_approval": candidate_unchanged,
            },
            "approval": {
                "id": approval["ref"]["film_entity_id"],
                "separate_from_candidate": approval_separate,
                "actor_kind": approval["actor_kind"],
            },
            "formal_ids": {
                name: entity["ref"]["film_entity_id"]
                for name, entity in formal_entities.items()
            },
        }


def create_guard() -> dict[str, Any]:
    return {
        "target_id": None,
        "expected_version": 0,
        "expected_content_hash": ZERO_HASH,
    }


def version_guard(entity: dict[str, Any]) -> dict[str, Any]:
    return {
        "film_entity_id": entity["ref"]["film_entity_id"],
        "expected_version": entity["ref"]["version"],
        "expected_content_hash": entity["ref"]["content_hash"],
    }


def bound(entity: dict[str, Any]) -> dict[str, Any]:
    return {
        **version_guard(entity),
        "entity_type": entity["ref"]["entity_type"],
        "host": entity.get("host", {}),
    }


def create_legacy(
    client: FilmCoreHttpClient,
    entity_type: str,
    host: dict[str, Any],
    **extra: Any,
) -> dict[str, Any]:
    result = client.post(
        "/commands/apply",
        {
            "command_type": "entity.create",
            "target_id": None,
            "expected_version": 0,
            "actor_kind": "human",
            "payload": {
                "entity_type": entity_type,
                "host": host,
                "states": FORMAL_STATES,
                **extra,
            },
        },
    )
    return result["entity"]


def create_formal(
    client: FilmCoreHttpClient, entity_type: str, **payload: Any
) -> dict[str, Any]:
    result = client.post(
        "/formal-records",
        {
            "write": create_guard(),
            "actor_kind": "codex",
            "payload": {"entity_type": entity_type, **payload},
        },
    )
    entity = result["entity"]
    require_uuid4(entity["ref"]["film_entity_id"], entity_type)
    return entity


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def local_ref(entity_type: str, content_hash: str = HASH_B) -> dict[str, Any]:
    return {
        "filmEntityId": str(uuid4()),
        "entityType": entity_type,
        "version": 1,
        "contentHash": content_hash,
    }


def web_ref(entity: dict[str, Any]) -> dict[str, Any]:
    return {
        "filmEntityId": entity["ref"]["film_entity_id"],
        "entityType": entity["ref"]["entity_type"],
        "version": entity["ref"]["version"],
        "contentHash": entity["ref"]["content_hash"],
    }


def local_segment_input(
    *,
    project: dict[str, Any],
    locked_script: dict[str, Any],
    director: dict[str, Any],
    shot: dict[str, Any],
    coverage: dict[str, Any],
    visual_lock: dict[str, Any],
    asset: dict[str, Any],
    director_ir_text: str,
    visual_lock_text: str,
    prompt_draft: dict[str, Any] | None = None,
    generation_package: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "hostProjectId": "host-project-golden-a",
        "hostUnitId": "host-unit-golden-a",
        "hostShotId": "host-shot-golden-a",
        "directorIr": {
            "text": director_ir_text,
            "contentHash": director["director_ir_hash"],
        },
        "visualLockRaw": {
            "text": visual_lock_text,
            "contentHash": visual_lock["visual_lock_hash"],
        },
        "assetSourceContentHash": asset["asset_content_hash"],
        "project": web_ref(project),
        "scriptVersion": web_ref(locked_script),
        "directorUnit": web_ref(director),
        "shot": web_ref(shot),
        "coverageLink": web_ref(coverage),
        "canvasRelation": web_ref(coverage),
        "promptDraft": web_ref(prompt_draft)
        if prompt_draft is not None
        else local_ref("prompt_draft"),
        "generationPackage": web_ref(generation_package)
        if generation_package is not None
        else local_ref("generation_package"),
        "generationAttempt": local_ref("generation_attempt"),
        "candidate": local_ref("candidate"),
        "visualLock": web_ref(visual_lock),
        "assetVersion": web_ref(asset),
        "outputRepresentation": local_ref("representation", HASH_C),
    }


def run_local_segment(payload: dict[str, Any]) -> dict[str, Any]:
    process = subprocess.run(
        ["bun", "tests/film-golden/golden_a_local.ts"],
        cwd=REPOSITORY_ROOT,
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if process.returncode != 0:
        raise GoldenARealError(
            f"real local Prompt/Manual Provider segment failed: {process.stderr.strip()}"
        )
    return json.loads(process.stdout)


def assert_local_bindings(
    receipt: dict[str, Any],
    director: dict[str, Any],
    visual_lock: dict[str, Any],
    asset: dict[str, Any],
) -> None:
    expected = {
        "directorRecordHash": director["ref"]["content_hash"],
        "directorRawHash": director["director_ir_hash"],
        "visualLockRecordHash": visual_lock["ref"]["content_hash"],
        "visualLockRawHash": visual_lock["visual_lock_hash"],
        "assetRecordHash": asset["ref"]["content_hash"],
        "assetSourceHash": asset["asset_content_hash"],
    }
    if receipt.get("sourceBindings") != expected:
        raise GoldenARealError("local segment did not preserve aggregate and raw hashes")
    if any(
        expected[aggregate] == expected[raw]
        for aggregate, raw in (
            ("directorRecordHash", "directorRawHash"),
            ("visualLockRecordHash", "visualLockRawHash"),
            ("assetRecordHash", "assetSourceHash"),
        )
    ):
        raise GoldenARealError("aggregate record hash was conflated with a raw source hash")


def continuity_check(dimension: str, subject_id: str, value: str) -> dict[str, str]:
    return {
        "dimension": dimension,
        "subject_id": subject_id,
        "expected_value": value,
        "actual_value": value,
    }


def expect_core_error(
    call: Any, *, status: int, code: str
) -> CoreHttpError:
    try:
        call()
    except CoreHttpError as error:
        detail = error.payload.get("detail", {}) if isinstance(error.payload, dict) else {}
        if error.status != status or detail.get("code") != code:
            raise GoldenARealError(
                f"expected Core {status}/{code}, got {error.status}/{detail.get('code')}"
            ) from error
        return error
    raise GoldenARealError(f"expected Core {status}/{code}, request succeeded")


def require_uuid4(value: str, label: str) -> None:
    parsed = UUID(value)
    if parsed.version != 4 or str(parsed) != value:
        raise GoldenARealError(f"{label} identity is not a canonical UUIDv4")
