#!/usr/bin/env python3
from __future__ import annotations

import json
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PORTS = (43100, 43101)
BUNDLE_ID = "com.filmos.studio.localbeta"


def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.settimeout(0.2)
        return client.connect_ex(("127.0.0.1", port)) == 0


def wait_for(predicate, timeout: float, message: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.25)
    raise RuntimeError(message)


def get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=2) as response:
        return json.loads(response.read().decode("utf-8"))


def run(command: tuple[str, ...]) -> str:
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)
    output = (result.stdout + result.stderr).strip()
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}\n{output}")
    return output


def listener_pid(port: int) -> int:
    result = subprocess.run(
        ("lsof", "-nP", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"),
        text=True,
        capture_output=True,
        check=False,
    )
    values = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if result.returncode != 0 or len(values) != 1:
        raise RuntimeError(f"expected one listener for port {port}, found {values}")
    return int(values[0])


def process_open_paths(pid: int) -> list[Path]:
    result = subprocess.run(
        ("lsof", "-Fn", "-p", str(pid)),
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"could not inspect open files for process {pid}")
    paths = []
    for line in result.stdout.splitlines():
        if line.startswith("n/"):
            paths.append(Path(line[1:]))
    return paths


def quit_app() -> None:
    subprocess.run(
        ("osascript", "-e", f'tell application id "{BUNDLE_ID}" to quit'),
        text=True,
        capture_output=True,
        check=False,
    )


def main() -> None:
    occupied = [port for port in PORTS if port_open(port)]
    if occupied:
        raise RuntimeError(f"dedicated FilmOS acceptance ports are already in use: {occupied}")

    with tempfile.TemporaryDirectory(prefix="filmos-desktop-acceptance-") as directory:
        bundle = Path(directory) / "FilmOS Studio.app"
        build_output = run(("desktop/macos/scripts/build-unsigned-app", str(bundle)))
        verify_output = run(("desktop/macos/scripts/verify-unsigned-app", str(bundle)))
        runtime = json.loads((bundle / "Contents/Resources/InternalRuntime.json").read_text(encoding="utf-8"))
        forbidden_runtime_keys = {"workspace_root", "bun_executable", "backend_data_directory"}
        if forbidden_runtime_keys.intersection(runtime):
            raise RuntimeError(f"desktop runtime still contains source-bound keys: {sorted(runtime)}")
        if any(isinstance(value, str) and ("/Users/" in value or "/Downloads/" in value) for value in runtime.values()):
            raise RuntimeError("desktop runtime contains a protected or private absolute path")
        launched = False
        try:
            run(("open", "-n", str(bundle)))
            launched = True
            wait_for(lambda: all(port_open(port) for port in PORTS), 20, "desktop services did not start")
            settings = get_json("http://127.0.0.1:43101/api/auth/settings")["data"]
            session = get_json("http://127.0.0.1:43101/api/auth/session")["data"]
            with urllib.request.urlopen("http://127.0.0.1:43100/create", timeout=2) as response:
                web_document = response.read().decode("utf-8")
            if settings.get("authMode") != "desktop_local" or settings.get("registrationEnabled") is not False:
                raise RuntimeError(f"desktop auth settings mismatch: {settings}")
            user = session.get("user") or {}
            if session.get("authMode") != "desktop_local" or user.get("id") != "filmos-desktop-local-user":
                raise RuntimeError(f"cookie-free desktop session mismatch: {session}")
            if 'name="filmos-workbench" content="v1"' not in web_document or "<title>FilmOS Studio</title>" not in web_document:
                raise RuntimeError("desktop web marker or FilmOS title is missing")
            listener_pids = {listener_pid(port) for port in PORTS}
            source_root = ROOT.resolve()
            for pid in listener_pids:
                for open_path in process_open_paths(pid):
                    try:
                        open_path.resolve().relative_to(source_root)
                    except (OSError, ValueError):
                        continue
                    raise RuntimeError(f"desktop service {pid} still has the source tree open")
            data_directory = Path.home() / "Library/Application Support/FilmOS Studio/WorkbenchData"
            if not data_directory.is_dir():
                raise RuntimeError("desktop backend data directory was not created in Application Support")
        finally:
            if launched:
                quit_app()
                wait_for(lambda: not any(port_open(port) for port in PORTS), 15, "desktop-owned services did not stop")

        print(json.dumps({
            "status": "PASSED",
            "build": "UNSIGNED_APP_READY" if "UNSIGNED_APP_READY" in build_output else "UNKNOWN",
            "verify": verify_output.splitlines()[-1],
            "ports": list(PORTS),
            "auth_mode": "desktop_local",
            "local_user_id": "filmos-desktop-local-user",
            "cookie_required": False,
            "runtime_schema": runtime.get("schema_version"),
            "source_tree_open_files": False,
            "data_location": "$HOME/Library/Application Support/FilmOS Studio/WorkbenchData",
            "services_stopped_after_quit": True,
        }, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
