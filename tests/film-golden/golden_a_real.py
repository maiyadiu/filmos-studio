#!/usr/bin/env python3
"""Real Golden A Sidecar adapter.

The adapter always starts a temporary Film Core HTTP Sidecar. It fails closed
when a D-0005 operation is absent and never substitutes an in-memory formal
store or a fake approval path.
"""

from __future__ import annotations

import json
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


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
FILM_CORE_SOURCE = REPOSITORY_ROOT / "film-core" / "src"
REQUIRED_D0005_OPERATIONS = (
    ("POST", "/formal-records"),
    ("GET", "/formal-records/{filmEntityId}"),
    ("POST", "/prompts/compile"),
    ("POST", "/manual-results/import"),
    ("POST", "/reviews"),
    ("POST", "/approvals"),
    ("POST", "/continuity/check"),
)


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
            raw = error.read().decode("utf-8", errors="replace")
            try:
                value: Any = json.loads(raw)
            except json.JSONDecodeError:
                value = raw
            raise CoreHttpError(error.code, method, path, value) from error

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
    """Run the real HTTP preflight and return a non-forged receipt."""

    external_provider_calls = 0
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
                "external_provider_calls": external_provider_calls,
                "sidecar": {
                    "health": health["status"],
                    "service": health["service"],
                    "database": "temporary_sqlite_sidecar",
                },
                "missing_operations": error.operations,
                "fallback_mock_used": False,
            }
        raise GoldenARealError(
            "D-0005 operations are present but the payload adapter has not been aligned with the current Core commit: "
            + ", ".join(sorted(operation.operation_id for operation in operations.values() if operation.operation_id))
        )
