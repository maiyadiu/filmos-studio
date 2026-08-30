#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "desktop/macos"


def swift_test_command() -> tuple[str, ...]:
    base = ("swift", "test", "--package-path", str(PACKAGE))
    if os.environ.get("FILMOS_DESKTOP_SWIFT_VERSION"):
        return base
    frameworks = Path("/Library/Developer/CommandLineTools/Library/Developer/Frameworks")
    testing_runtime = Path("/Library/Developer/CommandLineTools/Library/Developer/usr/lib")
    if not frameworks.is_dir() or not testing_runtime.is_dir():
        return base
    machine = "arm64" if platform.machine() == "arm64" else "x86_64"
    return base + (
        "-Xswiftc", "-target", "-Xswiftc", f"{machine}-apple-macos14.0",
        "-Xswiftc", "-F", "-Xswiftc", str(frameworks),
        "-Xlinker", "-F", "-Xlinker", str(frameworks),
        "-Xlinker", "-rpath", "-Xlinker", str(frameworks),
        "-Xlinker", "-rpath", "-Xlinker", str(testing_runtime),
    )


def main() -> None:
    build_script = (PACKAGE / "scripts/build-unsigned-app").read_text(encoding="utf-8")
    runtime_source = (PACKAGE / "Sources/FilmOSStudioDesktop/DesktopChatGPTRuntime.swift").read_text(encoding="utf-8")
    manager_source = (PACKAGE / "Sources/FilmOSDesktopCore/ChatGPTConnectionManager.swift").read_text(encoding="utf-8")
    workbench_source = (PACKAGE / "Sources/FilmOSStudioDesktop/main.swift").read_text(encoding="utf-8")
    connection_window_source = (PACKAGE / "Sources/FilmOSStudioDesktop/ChatGPTConnectionWindow.swift").read_text(encoding="utf-8")
    lifecycle_source = (PACKAGE / "Sources/FilmOSDesktopCore/DesktopWindowLifecycle.swift").read_text(encoding="utf-8")
    install_script = (PACKAGE / "scripts/install-local-app").read_text(encoding="utf-8")
    fingerprint_path = PACKAGE / "scripts/source-fingerprint"
    sync_verifier = (PACKAGE / "scripts/verify-installed-app-sync").read_text(encoding="utf-8")
    bundle_verifier = (PACKAGE / "scripts/verify-unsigned-app").read_text(encoding="utf-8")
    for helper in ("FilmOSFilmCore", "FilmOSChatGPTMCP", "FilmOSChatGPTGrant", "tunnel-client", "cloudflared"):
        if helper not in build_script:
            raise RuntimeError(f"desktop bundle is missing ChatGPT helper contract: {helper}")
    contract_build = build_script.find("npm run build:contracts")
    mcp_compile = build_script.find("bun_executable\" build --compile src/server.ts")
    if contract_build < 0 or mcp_compile < 0 or contract_build > mcp_compile:
        raise RuntimeError(
            "desktop bundle must generate @filmos/tool-contracts before compiling the MCP helper"
        )
    for state in (
        "NOT_CONFIGURED", "LOCAL_SERVICES_STARTING", "LOCAL_SERVICES_READY",
        "TUNNEL_STARTING", "TUNNEL_CONNECTED", "TUNNEL_RECONNECTING",
        "TUNNEL_FAILED", "WAITING_FOR_CHATGPT", "CHATGPT_REACHED_FILMOS", "GRANT_EXPIRED",
    ):
        if state not in manager_source:
            raise RuntimeError(f"desktop ChatGPT state is missing: {state}")
    required_runtime_markers = (
        '"CONTROL_PLANE_API_KEY"',
        '"FILMOS_SECURE_TUNNEL_PROOF"',
        '"X-FilmOS-Live-Gate-Challenge: env:FILMOS_LIVE_GATE_CHALLENGE"',
        '"http://127.0.0.1:17650/film"',
        'mcpWriteToolCount: healthPayload?["mcp_write_tool_count"] as? Int ?? 0',
    )
    if not all(marker in runtime_source for marker in required_runtime_markers):
        raise RuntimeError("desktop ChatGPT runtime contract is incomplete")
    if "window.isReleasedWhenClosed = false" not in lifecycle_source:
        raise RuntimeError("reusable desktop windows must survive close and Dock reopen")
    if "DesktopWindowLifecycle.configureReusable(window)" not in workbench_source:
        raise RuntimeError("the main workbench window is missing its reopen lifecycle contract")
    if "DesktopWindowLifecycle.configureReusable(window)" not in connection_window_source:
        raise RuntimeError("the ChatGPT connection window is missing its reopen lifecycle contract")
    for marker in (
        "AppBackups",
        "--relaunch",
        "LOCAL_APP_INSTALLED",
        "FilmOSStudioDesktop$/",
        "FILMOS_TUNNEL_CLIENT_RUNTIME_CACHE",
        "verify-installed-app-sync",
    ):
        if marker not in install_script:
            raise RuntimeError(f"stable local app installer is missing: {marker}")
    for marker in ("source-fingerprint", "SourceIdentity.json", "source_identity_before", "source_identity_after"):
        if marker not in build_script:
            raise RuntimeError(f"desktop bundle source identity is missing: {marker}")
    for marker in ("SourceIdentity.json", "LOCAL_APP_SYNC_VERIFIED", "source-fingerprint"):
        if marker not in sync_verifier:
            raise RuntimeError(f"installed app synchronization verifier is missing: {marker}")
    for marker in ("source_fingerprint_sha256", "git_commit_sha", "git_tree_sha", "HEAD^{tree}"):
        if marker not in bundle_verifier:
            raise RuntimeError(f"desktop bundle identity verification is missing: {marker}")

    fingerprint = json.loads(subprocess.check_output((str(fingerprint_path), "--json"), cwd=ROOT, text=True))
    digest = fingerprint.get("source_fingerprint_sha256", "")
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        raise RuntimeError("desktop source fingerprint is not canonical SHA-256")
    if fingerprint.get("schema_version") != "1.0.0" or fingerprint.get("source_file_count", 0) < 1:
        raise RuntimeError("desktop source fingerprint contract is incomplete")

    environment = os.environ.copy()
    runtime_library = "/Library/Developer/CommandLineTools/Library/Developer/usr/lib"
    if not environment.get("FILMOS_DESKTOP_SWIFT_VERSION") and Path(runtime_library).is_dir():
        environment["DYLD_LIBRARY_PATH"] = runtime_library
    command = swift_test_command()
    result = subprocess.run(command, cwd=ROOT, env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    sys.stdout.write(result.stdout)
    if result.returncode:
        raise SystemExit(result.returncode)
    print(json.dumps({
        "status": "PASSED",
        "swift_connection_manager_tests": True,
        "keychain_only_runtime_key": True,
        "bounded_reconnect": [1, 2, 5, 10, 30],
        "owned_process_shutdown": True,
        "clean_clone_contract_build": True,
        "dock_reopen_lifecycle": True,
        "stable_local_install": True,
        "desktop_source_sync_contract": True,
        "source_fingerprint_sha256": digest,
        "tool_count_source": "MCP_HEALTH_MANIFEST_RUNTIME",
        "write_tools_gate": "DYNAMIC_ZERO_REQUIRED",
        "bundled_helpers": ["FilmOSFilmCore", "FilmOSChatGPTMCP", "FilmOSChatGPTGrant", "tunnel-client", "cloudflared"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
