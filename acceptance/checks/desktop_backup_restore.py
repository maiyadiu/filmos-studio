#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[2]
BACKUP_FORMAT = "filmos.local-backup/v1"
GOLDEN_PROJECT_ID = "acceptance-backup-golden"
GOLDEN_TITLE = "FilmOS 备份恢复黄金用例"
FORBIDDEN_MARKER = b"FILMOS-ACCEPTANCE-KEY-MUST-NOT-BE-EXPORTED"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


def wait_for_health(origin: str, process: subprocess.Popen[bytes], timeout: float = 20) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("FilmOS backend exited before health check")
        try:
            payload = request_json("GET", origin + "/api/health")
            if payload.get("code") == 0 and payload.get("data", {}).get("status") == "ok":
                return
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(0.2)
    raise RuntimeError("FilmOS backend did not become healthy")


def request_json(method: str, url: str, body: object | None = None) -> dict:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, method=method, data=data)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=10) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("code") != 0:
        raise RuntimeError(f"FilmOS API returned a business failure: {payload.get('code')}")
    return payload


def start_backend(binary: Path, data_directory: Path, port: int, log_path: Path) -> tuple[subprocess.Popen[bytes], object]:
    environment = os.environ.copy()
    environment.update({
        "CANVAS_BACKEND_ADDR": f"127.0.0.1:{port}",
        "CANVAS_BACKEND_DATA_DIR": str(data_directory),
        "CANVAS_DESKTOP_LOCAL_AUTH_ENABLED": "true",
        "CANVAS_DESKTOP_LOCAL_CHANNELS_ENABLED": "false",
        "CANVAS_CORS_ORIGINS": f"http://127.0.0.1:{port}",
    })
    log_stream = log_path.open("wb")
    process = subprocess.Popen(
        (str(binary),),
        cwd=data_directory,
        env=environment,
        stdout=log_stream,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return process, log_stream


def stop_backend(process: subprocess.Popen[bytes] | None, log_stream: object | None) -> None:
    if process is not None and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
    if log_stream is not None:
        log_stream.close()


def safe_backup_path(value: str) -> bool:
    path = PurePosixPath(value)
    return bool(value) and not path.is_absolute() and ".." not in path.parts and "\\" not in value


def verify_backup(package_path: Path, expected_hash: str) -> dict:
    package_bytes = package_path.read_bytes()
    if hashlib.sha256(package_bytes).hexdigest() != expected_hash:
        raise RuntimeError("backup response SHA-256 mismatch")
    if FORBIDDEN_MARKER in package_bytes:
        raise RuntimeError("credential encryption key leaked into backup package")

    with zipfile.ZipFile(package_path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or "manifest.json" not in names:
            raise RuntimeError("backup ZIP contains duplicate entries or lacks manifest")
        if any(not safe_backup_path(name) for name in names):
            raise RuntimeError("backup ZIP contains an unsafe path")
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("format") != BACKUP_FORMAT or manifest.get("database") != "database/open_ai_canvas.db":
            raise RuntimeError("backup manifest contract mismatch")
        entries = manifest.get("entries") or []
        if sorted(names) != sorted(["manifest.json", *[entry["path"] for entry in entries]]):
            raise RuntimeError("backup manifest inventory mismatch")
        for entry in entries:
            value = archive.read(entry["path"])
            if len(value) != entry["size"] or hashlib.sha256(value).hexdigest() != entry["sha256"]:
                raise RuntimeError("backup manifest entry hash mismatch")
        lowered_names = "\n".join(names).lower()
        if any(token in lowered_names for token in (".settings-key", "cookie", "credential", "api-key", "api_key")):
            raise RuntimeError("backup inventory contains a forbidden credential path")
        return manifest


def restore_backup(package_path: Path, restore_directory: Path, manifest: dict) -> None:
    with zipfile.ZipFile(package_path) as archive:
        for entry in manifest["entries"]:
            archive_path = entry["path"]
            if archive_path == manifest["database"]:
                destination = restore_directory / "open_ai_canvas.db"
            elif archive_path.startswith("resources/"):
                destination = restore_directory / archive_path
            else:
                raise RuntimeError("backup manifest contains an unsupported restore target")
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(archive_path) as source, destination.open("xb") as target:
                shutil.copyfileobj(source, target)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="filmos-backup-acceptance-") as temporary:
        root = Path(temporary)
        binary = root / "FilmOSBackend"
        build = subprocess.run(
            ("go", "build", "-o", str(binary), "./cmd/server"),
            cwd=ROOT / "backend",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        if build.returncode != 0:
            raise RuntimeError("FilmOS backend build failed for backup acceptance")

        source_directory = root / "source"
        restore_directory = root / "restore"
        source_directory.mkdir()
        restore_directory.mkdir()
        first_port = free_port()
        second_port = free_port()
        while second_port == first_port:
            second_port = free_port()
        first_origin = f"http://127.0.0.1:{first_port}"
        second_origin = f"http://127.0.0.1:{second_port}"
        process: subprocess.Popen[bytes] | None = None
        log_stream: object | None = None
        try:
            process, log_stream = start_backend(binary, source_directory, first_port, root / "source-backend.log")
            wait_for_health(first_origin, process)
            timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            project = {
                "id": GOLDEN_PROJECT_ID,
                "title": GOLDEN_TITLE,
                "createdAt": timestamp,
                "updatedAt": timestamp,
                "nodes": [],
                "connections": [],
            }
            request_json("PUT", first_origin + f"/api/canvas-projects/{GOLDEN_PROJECT_ID}", {"project": project})
            (source_directory / ".settings-key").write_bytes(FORBIDDEN_MARKER)

            backup_request = urllib.request.Request(
                first_origin + "/api/desktop/backup?app_version=acceptance",
                method="GET",
            )
            with urllib.request.urlopen(backup_request, timeout=30) as response:
                if response.status != 200 or response.headers.get("X-FilmOS-Backup-Format") != BACKUP_FORMAT:
                    raise RuntimeError("backup HTTP response contract mismatch")
                expected_hash = (response.headers.get("X-FilmOS-Backup-SHA256") or "").lower()
                package_path = root / "FilmOSAcceptance.filmosbackup"
                package_path.write_bytes(response.read())
            if len(expected_hash) != 64:
                raise RuntimeError("backup HTTP response lacks SHA-256")
            manifest = verify_backup(package_path, expected_hash)
        finally:
            stop_backend(process, log_stream)

        restore_backup(package_path, restore_directory, manifest)
        process = None
        log_stream = None
        try:
            process, log_stream = start_backend(binary, restore_directory, second_port, root / "restore-backend.log")
            wait_for_health(second_origin, process)
            restored = request_json("GET", second_origin + f"/api/canvas-projects/{GOLDEN_PROJECT_ID}")
            restored_project = restored.get("data", {}).get("project") or {}
            if restored_project.get("id") != GOLDEN_PROJECT_ID or restored_project.get("title") != GOLDEN_TITLE:
                raise RuntimeError("restored FilmOS project does not match Golden source")
        finally:
            stop_backend(process, log_stream)

        print(json.dumps({
            "status": "PASSED",
            "backup_format": BACKUP_FORMAT,
            "database_snapshot": "VERIFIED",
            "entry_hashes": "VERIFIED",
            "credentials_exported": False,
            "restore_restart": "PASSED",
            "golden_case_id": "DESKTOP-BACKUP-RESTORE-001",
            "golden_project_id": GOLDEN_PROJECT_ID,
        }, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
