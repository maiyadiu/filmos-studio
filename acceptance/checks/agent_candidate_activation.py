#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FLAG_IDS = (
    "film.agent_native_brain_selector",
    "film.agent_generic_runtime",
    "film.agent_context_broker",
    "film.agent_canonical_tool_manifest",
    "film.agent_canonical_tool_broker",
    "film.agent_codex_subscription",
    "film.agent_chatgpt_host",
    "film.agent_model_api_profiles",
    "film.agent_no_silent_api_fallback",
    "film.agent_request_scoped_identity",
)
LOCAL_RUNTIME_PORT = 17371


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


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


def run(command: tuple[str, ...], environment: dict[str, str]) -> str:
    result = subprocess.run(command, cwd=ROOT, env=environment, text=True, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError((result.stdout + result.stderr)[-8000:] or f"command failed: {' '.join(command)}")
    return result.stdout + result.stderr


def worktree_status() -> str:
    result = subprocess.run(("git", "status", "--porcelain"), cwd=ROOT, text=True, capture_output=True, check=True)
    return result.stdout


def terminate_app(process: subprocess.Popen[bytes]) -> None:
    script = (
        'ObjC.import("AppKit"); '
        f'const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier({process.pid}); '
        'if (app) app.terminate;'
    )
    subprocess.run(("osascript", "-l", "JavaScript", "-e", script), text=True, capture_output=True, check=False)


def main() -> None:
    if port_open(LOCAL_RUNTIME_PORT):
        raise RuntimeError("candidate gate requires the dedicated Local Runtime port to be free")
    web_port = free_port()
    backend_port = free_port()
    while backend_port in {web_port, LOCAL_RUNTIME_PORT}:
        backend_port = free_port()

    with tempfile.TemporaryDirectory(prefix="filmos-agent-candidate-") as directory:
        root = Path(directory)
        bundle = root / "FilmOS Studio.app"
        support_name = f"FilmOS Candidate {root.name[-8:]}"
        environment = os.environ.copy()
        environment.update({
            "FILMOS_DESKTOP_RUNTIME_PROFILE": "filmos-candidate",
            "FILMOS_DESKTOP_WEB_PORT": str(web_port),
            "FILMOS_DESKTOP_BACKEND_PORT": str(backend_port),
            "FILMOS_DESKTOP_APPLICATION_SUPPORT_DIRECTORY_NAME": support_name,
            "FILMOS_EXPECTED_APPLICATION_SUPPORT_DIRECTORY_NAME": support_name,
        })
        cache = ROOT / ".local" / "cache" / "tunnel-client" / "tunnel-client-v0.0.13-darwin-arm64.zip"
        if cache.is_file():
            environment["FILMOS_TUNNEL_CLIENT_ARCHIVE_CACHE"] = str(cache)
        before = worktree_status()
        run(("desktop/macos/scripts/build-unsigned-app", str(bundle)), environment)
        if worktree_status() != before:
            raise RuntimeError("candidate bundle build modified the source worktree")
        run(("desktop/macos/scripts/verify-unsigned-app", str(bundle)), environment)

        runtime = json.loads((bundle / "Contents/Resources/InternalRuntime.json").read_text(encoding="utf-8"))
        mcp_helper = bundle / "Contents/Helpers/FilmOSCanvasAgentMCP"
        if not mcp_helper.is_file() or not os.access(mcp_helper, os.X_OK):
            raise RuntimeError("candidate bundle is missing its executable Canvas Agent MCP helper")
        flags = runtime.get("agent_feature_flags")
        if runtime.get("agent_runtime_profile") != "filmos-candidate" or not isinstance(flags, dict):
            raise RuntimeError("candidate runtime profile was not embedded")
        if set(flags) != set(FLAG_IDS) or not all(flags.get(flag) is True for flag in FLAG_IDS):
            raise RuntimeError("candidate runtime flags are not atomically enabled")
        feature_hash = runtime.get("agent_feature_flags_hash")
        if not isinstance(feature_hash, str) or len(feature_hash) != 64:
            raise RuntimeError("candidate runtime flag hash is invalid")
        web_root = bundle / "Contents/Resources/Web"
        if not any(
            feature_hash in path.read_text(encoding="utf-8", errors="ignore")
            and "filmos-candidate" in path.read_text(encoding="utf-8", errors="ignore")
            for path in web_root.rglob("*.js")
        ):
            raise RuntimeError("candidate Vite build is not bound to the runtime profile hash")

        process: subprocess.Popen[bytes] | None = None
        support = Path.home() / "Library/Application Support" / support_name
        try:
            process = subprocess.Popen(
                (str(bundle / "Contents/MacOS/FilmOSStudioDesktop"),),
                cwd=root,
                env=environment,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            wait_for(lambda: all(port_open(port) for port in (web_port, backend_port, LOCAL_RUNTIME_PORT)), 30, "candidate App services did not start")
            health = get_json(f"http://127.0.0.1:{LOCAL_RUNTIME_PORT}/health")
            expected = {
                "ok": True,
                "agent_runtime_profile": "filmos-candidate",
                "agent_feature_flag_count": 10,
                "agent_feature_flags_hash": feature_hash,
                "agent_activation_consistent": True,
                "agent_generic_runtime_enabled": True,
            }
            if any(health.get(key) != value for key, value in expected.items()):
                raise RuntimeError(f"candidate Local Runtime health mismatch: {health}")
        finally:
            if process is not None:
                terminate_app(process)
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=5)
                wait_for(lambda: not any(port_open(port) for port in (web_port, backend_port, LOCAL_RUNTIME_PORT)), 15, "candidate App services did not stop")
            shutil.rmtree(support, ignore_errors=True)

        print(json.dumps({
            "gate_id": "AGENT-CANDIDATE-ACTIVATION-001",
            "status": "PASSED",
            "profile_id": "filmos-candidate",
            "feature_flag_count": 10,
            "feature_flags_hash": feature_hash,
            "vite_runtime_hash_match": True,
            "adapter_runtime_managed_by_app": True,
            "codex_mcp_helper_bundled": True,
            "black_box_app_launch": True,
            "legacy_rollback_profile": "integration",
            "private_paths_emitted": False,
        }, sort_keys=True))


if __name__ == "__main__":
    main()
