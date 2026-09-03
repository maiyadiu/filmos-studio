#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import selectors
import signal
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from ui_golden import capture_packaged_ui


ROOT = Path(__file__).resolve().parents[2]
LOCAL_RUNTIME_PORT = 17371
FILM_CORE_PORT = 17650
CHATGPT_MCP_PORT = 17840
BUN_HELPERS = (
    "FilmOSChatGPTMCP",
    "FilmOSChatGPTGrant",
    "FilmOSLocalRuntime",
    "FilmOSCanvasAgentMCP",
    "FilmOSReviewBus",
)


def bind_acceptance_build_id(environment: dict[str, str]) -> dict[str, str]:
    acceptance_build_id = environment.get("FILMOS_ACCEPTANCE_BUILD_ID")
    if acceptance_build_id:
        environment["FILMOS_DESKTOP_BUILD_ID"] = acceptance_build_id
    return environment


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


def run(command: tuple[str, ...], environment: dict[str, str] | None = None) -> str:
    result = subprocess.run(command, cwd=ROOT, env=environment, text=True, capture_output=True, check=False)
    output = (result.stdout + result.stderr).strip()
    if result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(command)}\n{output}")
    return output


def verify_bundle_signature(bundle: Path) -> None:
    run(("/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=4", str(bundle)))


def require_invalid_bundle_signature(bundle: Path, label: str) -> None:
    result = subprocess.run(
        ("/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=4", str(bundle)),
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode == 0:
        raise RuntimeError(f"codesign accepted a bundle after {label} tampering")


def verify_signature_tamper_detection(bundle: Path, directory: Path) -> None:
    tamper_bundle = directory / "Signature Tamper.app"
    run(("/usr/bin/ditto", str(bundle), str(tamper_bundle)))
    verify_bundle_signature(tamper_bundle)
    for relative_path, label in (
        (Path("Contents/Info.plist"), "Info.plist"),
        (Path("Contents/Resources/SourceIdentity.json"), "resource"),
    ):
        target = tamper_bundle / relative_path
        original = target.read_bytes()
        try:
            target.write_bytes(original + b"\n")
            require_invalid_bundle_signature(tamper_bundle, label)
        finally:
            target.write_bytes(original)
        verify_bundle_signature(tamper_bundle)


def parse_bun_signature_tail_records(build_output: str) -> list[dict[str, int | str]]:
    pattern = re.compile(
        r"^BUN_MACHO_SIGNATURE_TAIL helper=(\S+) actual_size=(\d+) "
        r"dataoff=(\d+) datasize=(\d+) tail_delta=(\d+)$"
    )
    records: list[dict[str, int | str]] = []
    for line in build_output.splitlines():
        match = pattern.fullmatch(line)
        if not match:
            continue
        helper, actual_size, dataoff, datasize, tail_delta = match.groups()
        records.append({
            "helper": helper,
            "actual_size": int(actual_size),
            "dataoff": int(dataoff),
            "datasize": int(datasize),
            "tail_delta": int(tail_delta),
        })
    if tuple(record["helper"] for record in records) != BUN_HELPERS:
        raise RuntimeError(f"Bun signature-tail evidence is incomplete or reordered: {records}")
    for record in records:
        if record["tail_delta"] not in {0, 14}:
            raise RuntimeError(f"unexpected Bun signature-tail delta: {record}")
        if record["actual_size"] != record["dataoff"] + record["datasize"] + record["tail_delta"]:
            raise RuntimeError(f"inconsistent Bun signature-tail evidence: {record}")
    return records


def stop_process(process: subprocess.Popen[str]) -> str:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    return process.stdout.read() if process.stdout is not None else ""


def probe_http_helper(
    executable: Path,
    environment: dict[str, str],
    working_directory: Path,
    port: int,
    health_path: str,
    expected: dict[str, object],
) -> None:
    process = subprocess.Popen(
        (str(executable),),
        cwd=working_directory,
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    output = ""
    try:
        wait_for(
            lambda: port_open(port) or process.poll() is not None,
            10,
            f"helper did not open its isolated port: {executable.name}",
        )
        if process.poll() is not None:
            output = process.stdout.read() if process.stdout is not None else ""
            raise RuntimeError(f"helper exited before readiness: {executable.name}: {output[-2000:]}")
        health = get_json(f"http://127.0.0.1:{port}{health_path}")
        if any(health.get(key) != value for key, value in expected.items()):
            raise RuntimeError(f"isolated helper health mismatch for {executable.name}: {health}")
    finally:
        if process.poll() is None:
            output = stop_process(process)
        if port_open(port):
            raise RuntimeError(f"isolated helper retained its port after termination: {executable.name}: {output[-2000:]}")


def probe_canvas_agent_mcp(executable: Path, environment: dict[str, str], working_directory: Path) -> None:
    process = subprocess.Popen(
        (str(executable),),
        cwd=working_directory,
        env=environment,
        text=True,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=1,
    )
    try:
        if process.stdin is None or process.stdout is None:
            raise RuntimeError("Canvas Agent MCP pipes are unavailable")
        initialize = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "filmos-signature-acceptance", "version": "1.0.0"},
            },
        }
        process.stdin.write(json.dumps(initialize, separators=(",", ":")) + "\n")
        process.stdin.flush()
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        try:
            if not selector.select(timeout=10):
                raise RuntimeError("Canvas Agent MCP did not answer initialize")
            response = json.loads(process.stdout.readline())
        finally:
            selector.close()
        if response.get("id") != 1 or response.get("result", {}).get("serverInfo", {}).get("name") != "canvas-agent":
            raise RuntimeError(f"Canvas Agent MCP initialize mismatch: {response}")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def verify_bun_helper_lifecycles(bundle: Path, directory: Path, base_environment: dict[str, str]) -> None:
    helpers = bundle / "Contents/Helpers"

    grant_root = directory / "grant"
    grant_root.mkdir()
    grant_environment = base_environment.copy()
    grant_environment["FILMOS_CHATGPT_LOCAL_DIR"] = str(grant_root)
    grant_result = subprocess.run(
        (str(helpers / "FilmOSChatGPTGrant"), "__acceptance_noop__"),
        cwd=grant_root,
        env=grant_environment,
        text=True,
        capture_output=True,
        check=False,
    )
    grant_output = grant_result.stdout + grant_result.stderr
    if (
        grant_result.returncode == 0
        or grant_result.stdout
        or "usage: npm run grant -- <issue|revoke>" not in grant_result.stderr
        or (grant_root / "grants.json").exists()
    ):
        raise RuntimeError(f"FilmOSChatGPTGrant no-op lifecycle mismatch: {grant_output[-2000:]}")

    mcp_root = directory / "chatgpt-mcp"
    mcp_root.mkdir()
    mcp_port = free_port()
    mcp_environment = base_environment.copy()
    mcp_environment.update({
        "FILMOS_CHATGPT_APP_ENABLED": "false",
        "FILMOS_CHATGPT_READ_TOOLS_ENABLED": "false",
        "FILMOS_CHATGPT_WIDGETS_ENABLED": "false",
        "FILMOS_CHATGPT_PROPOSAL_HANDOFF_ENABLED": "false",
        "FILMOS_CHATGPT_HOST": "127.0.0.1",
        "FILMOS_CHATGPT_PORT": str(mcp_port),
        "FILMOS_CHATGPT_LOCAL_DIR": str(mcp_root),
    })
    probe_http_helper(
        helpers / "FilmOSChatGPTMCP",
        mcp_environment,
        mcp_root,
        mcp_port,
        "/health",
        {"ok": True, "enabled": False, "mcp_tool_count": 0, "mcp_write_tool_count": 0},
    )

    local_root = directory / "local-runtime"
    local_root.mkdir()
    local_port = free_port()
    local_environment = base_environment.copy()
    local_environment.update({
        "FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR": str(local_root),
        "FRAMEFIELD_TRUSTED_WEB_ORIGINS": "http://127.0.0.1:3000",
        "PORT": str(local_port),
    })
    probe_http_helper(
        helpers / "FilmOSLocalRuntime",
        local_environment,
        local_root,
        local_port,
        "/health",
        {"ok": True},
    )

    canvas_root = directory / "canvas-agent-mcp"
    canvas_root.mkdir()
    canvas_environment = base_environment.copy()
    canvas_environment["FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR"] = str(canvas_root)
    probe_canvas_agent_mcp(helpers / "FilmOSCanvasAgentMCP", canvas_environment, canvas_root)

    review_root = directory / "review-bus"
    review_root.mkdir()
    review_port = free_port()
    review_environment = base_environment.copy()
    review_environment.update({
        "FILMOS_REVIEW_BUS_HOST": "127.0.0.1",
        "FILMOS_REVIEW_BUS_PORT": str(review_port),
        "FILMOS_REVIEW_BUS_LOCAL_DIR": str(review_root),
        "FILMOS_REVIEW_BUS_TOKEN": "r" * 36,
        "FILMOS_REVIEW_BRIDGE_TOKEN": "b" * 36,
        "FILMOS_REVIEW_CONSTITUTION_PATH": str(bundle / "Contents/Resources/FILMOS_CONSTITUTION.json"),
        "FILMOS_INSTALLED_SOURCE_IDENTITY_PATH": str(bundle / "Contents/Resources/SourceIdentity.json"),
        "FILMOS_INSTALLED_INTERNAL_RUNTIME_PATH": str(bundle / "Contents/Resources/InternalRuntime.json"),
    })
    probe_http_helper(
        helpers / "FilmOSReviewBus",
        review_environment,
        review_root,
        review_port,
        "/healthz",
        {"ok": True, "service": "filmos-review-bus", "external_network_requests": 0, "openai_model_api_calls": 0},
    )


def worktree_status() -> str:
    result = subprocess.run(
        ("git", "status", "--porcelain"),
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("could not inspect worktree status")
    return result.stdout


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


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


def request_app_termination(process: subprocess.Popen[bytes]) -> bool:
    script = (
        'ObjC.import("AppKit"); '
        f'const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier({process.pid}); '
        'if (!app) throw new Error("application is not registered"); '
        'app.terminate;'
    )
    try:
        result = subprocess.run(
            ("osascript", "-l", "JavaScript", "-e", script),
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
    except subprocess.TimeoutExpired:
        return False
    return result.returncode == 0


def wait_for_clean_app_shutdown(
    process: subprocess.Popen[bytes],
    bundle: Path,
    lifecycle_ports: tuple[int, ...],
    label: str,
) -> None:
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"desktop app did not exit after {label}") from error
    wait_for(
        lambda: not any(port_open(port) for port in lifecycle_ports),
        15,
        f"desktop-owned services did not stop after {label}",
    )
    wait_for(
        lambda: not bundle_helper_pids(bundle),
        15,
        f"desktop app left bundled helper processes behind after {label}",
    )


def bundle_helper_pids(bundle: Path) -> list[int]:
    prefix = str(bundle / "Contents/Helpers") + "/"
    result = subprocess.run(
        ("ps", "-axo", "pid=,command="),
        text=True,
        capture_output=True,
        check=True,
    )
    pids: list[int] = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and fields[0].isdigit() and fields[1].startswith(prefix):
            pids.append(int(fields[0]))
    return pids


def stop_exact_processes(pids: list[int]) -> None:
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        live: list[int] = []
        for pid in pids:
            try:
                os.kill(pid, 0)
                live.append(pid)
            except ProcessLookupError:
                pass
        if not live:
            return
        time.sleep(0.05)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def verify_direct_sigterm_shutdown(
    bundle: Path,
    environment: dict[str, str],
    required_ports: tuple[int, ...],
    lifecycle_ports: tuple[int, ...],
    app_log: Path,
    support_directory: Path,
) -> None:
    process: subprocess.Popen[bytes] | None = None
    try:
        with app_log.open("ab") as app_output:
            process = subprocess.Popen(
                (str(bundle / "Contents/MacOS/FilmOSStudioDesktop"),),
                cwd=ROOT,
                env=environment,
                stdout=app_output,
                stderr=subprocess.STDOUT,
            )
            wait_for(lambda: all(port_open(port) for port in required_ports), 20, "SIGTERM probe services did not start")
            process.terminate()
            wait_for_clean_app_shutdown(process, bundle, lifecycle_ports, "direct SIGTERM")
    except Exception:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        stop_exact_processes(bundle_helper_pids(bundle))
        shutil.rmtree(support_directory, ignore_errors=True)
        raise


def main() -> None:
    fixed_ports = (LOCAL_RUNTIME_PORT, FILM_CORE_PORT, CHATGPT_MCP_PORT)
    occupied = [port for port in fixed_ports if port_open(port)]
    if occupied:
        raise RuntimeError(f"desktop gate requires dedicated ports to be free: {occupied}")
    web_port = free_port()
    backend_port = free_port()
    while backend_port == web_port:
        backend_port = free_port()
    review_bus_port = free_port()
    while review_bus_port in {web_port, backend_port}:
        review_bus_port = free_port()
    required_ports = (web_port, backend_port, review_bus_port, LOCAL_RUNTIME_PORT, FILM_CORE_PORT)
    lifecycle_ports = (*required_ports, CHATGPT_MCP_PORT)

    with tempfile.TemporaryDirectory(prefix="filmos-desktop-acceptance-") as directory:
        bundle = Path(directory) / "FilmOS Studio.app"
        support_name = f"FilmOS Acceptance {Path(directory).name[-8:]}"
        ui_golden_root = os.environ.get("FILMOS_ACCEPTANCE_UI_GOLDEN_CAPTURE_ROOT", "").strip()
        environment = bind_acceptance_build_id(os.environ.copy())
        environment.update({
            "FILMOS_DESKTOP_WEB_PORT": str(web_port),
            "FILMOS_DESKTOP_BACKEND_PORT": str(backend_port),
            "FILMOS_DESKTOP_REVIEW_BUS_PORT": str(review_bus_port),
            "FILMOS_DESKTOP_APPLICATION_SUPPORT_DIRECTORY_NAME": support_name,
            "FILMOS_EXPECTED_APPLICATION_SUPPORT_DIRECTORY_NAME": support_name,
        })
        if ui_golden_root:
            environment.update({
                "VITE_FILMOS_UI_GOLDEN_CAPTURE": "true",
                "FILMOS_DESKTOP_RUNTIME_PROFILE": "filmos-candidate",
                "FILMOS_DESKTOP_RELEASE_CHANNEL": "candidate",
                "FILMOS_DESKTOP_EXTERNAL_PAID_SUBMIT_ENABLED": "false",
            })
        tunnel_archive_cache = ROOT / ".local" / "cache" / "tunnel-client" / "tunnel-client-v0.0.13-darwin-arm64.zip"
        if tunnel_archive_cache.is_file():
            environment["FILMOS_TUNNEL_CLIENT_ARCHIVE_CACHE"] = str(tunnel_archive_cache)
        worktree_before = worktree_status()
        build_output = run(("desktop/macos/scripts/build-unsigned-app", str(bundle)), environment)
        bun_signature_tails = parse_bun_signature_tail_records(build_output)
        if worktree_status() != worktree_before:
            raise RuntimeError("desktop bundle build left tracked or untracked source-tree artifacts")
        verify_output = run(("desktop/macos/scripts/verify-unsigned-app", str(bundle)), environment)
        verify_bundle_signature(bundle)
        tamper_directory = Path(directory) / "signature-tamper-copy"
        tamper_directory.mkdir()
        verify_signature_tamper_detection(bundle, tamper_directory)
        helper_lifecycle_directory = Path(directory) / "bun-helper-lifecycles"
        helper_lifecycle_directory.mkdir()
        verify_bun_helper_lifecycles(bundle, helper_lifecycle_directory, environment)
        runtime = json.loads((bundle / "Contents/Resources/InternalRuntime.json").read_text(encoding="utf-8"))
        forbidden_runtime_keys = {"workspace_root", "bun_executable", "backend_data_directory"}
        if forbidden_runtime_keys.intersection(runtime):
            raise RuntimeError(f"desktop runtime still contains source-bound keys: {sorted(runtime)}")
        if any(isinstance(value, str) and ("/Users/" in value or "/Downloads/" in value) for value in runtime.values()):
            raise RuntimeError("desktop runtime contains a protected or private absolute path")
        process: subprocess.Popen[bytes] | None = None
        support_directory = Path.home() / "Library/Application Support" / support_name
        app_log = Path(directory) / "desktop-app.log"
        verify_direct_sigterm_shutdown(
            bundle,
            environment,
            required_ports,
            lifecycle_ports,
            app_log,
            support_directory,
        )
        with app_log.open("wb") as app_output:
            try:
                process = subprocess.Popen(
                    (str(bundle / "Contents/MacOS/FilmOSStudioDesktop"),),
                    cwd=ROOT,
                    env=environment,
                    stdout=app_output,
                    stderr=subprocess.STDOUT,
                )
                try:
                    wait_for(lambda: all(port_open(port) for port in required_ports), 20, "desktop services did not start")
                except RuntimeError as error:
                    app_output.flush()
                    diagnostic = app_log.read_text(encoding="utf-8", errors="replace")[-8000:]
                    raise RuntimeError(
                        f"{error}; app_exit={process.poll()}; app_output={diagnostic or '[empty]'}"
                    ) from error
                settings = get_json(f"http://127.0.0.1:{backend_port}/api/auth/settings")["data"]
                session = get_json(f"http://127.0.0.1:{backend_port}/api/auth/session")["data"]
                with urllib.request.urlopen(f"http://127.0.0.1:{web_port}/create", timeout=2) as response:
                    web_document = response.read().decode("utf-8")
                if settings.get("authMode") != "desktop_local" or settings.get("registrationEnabled") is not False:
                    raise RuntimeError(f"desktop auth settings mismatch: {settings}")
                user = session.get("user") or {}
                if session.get("authMode") != "desktop_local" or user.get("id") != "filmos-desktop-local-user":
                    raise RuntimeError(f"cookie-free desktop session mismatch: {session}")
                if 'name="filmos-workbench" content="v1"' not in web_document or "<title>FilmOS Studio</title>" not in web_document:
                    raise RuntimeError("desktop web marker or FilmOS title is missing")
                listener_pids = {listener_pid(port) for port in required_ports}
                source_root = ROOT.resolve()
                for pid in listener_pids:
                    for open_path in process_open_paths(pid):
                        try:
                            open_path.resolve().relative_to(source_root)
                        except (OSError, ValueError):
                            continue
                        raise RuntimeError(f"desktop service {pid} still has the source tree open")
                data_directory = support_directory / "WorkbenchData"
                if not data_directory.is_dir():
                    raise RuntimeError("desktop backend data directory was not created in Application Support")
                ui_golden = None
                if ui_golden_root:
                    ui_golden = capture_packaged_ui(bundle, web_port, backend_port, Path(ui_golden_root).resolve())
            finally:
                shutdown_error: Exception | None = None
                if process is not None:
                    try:
                        if not request_app_termination(process):
                            raise RuntimeError("desktop app was not registered for graceful termination")
                        wait_for_clean_app_shutdown(process, bundle, lifecycle_ports, "NSRunningApplication terminate")
                    except Exception as error:
                        shutdown_error = error
                    finally:
                        if process.poll() is None:
                            process.terminate()
                            try:
                                process.wait(timeout=5)
                            except subprocess.TimeoutExpired:
                                process.kill()
                                process.wait(timeout=5)
                        stop_exact_processes(bundle_helper_pids(bundle))
                shutil.rmtree(support_directory, ignore_errors=True)
                if shutdown_error is not None:
                    raise shutdown_error

        print(json.dumps({
            "status": "PASSED",
            "build": "UNSIGNED_APP_READY" if "UNSIGNED_APP_READY" in build_output else "UNKNOWN",
            "verify": verify_output.splitlines()[-1],
            "bundle_signature": "DEEP_STRICT_VERIFIED",
            "signature_tamper_detection": ["Info.plist", "SourceIdentity.json"],
            "bun_signature_tails": bun_signature_tails,
            "bun_helper_lifecycles": list(BUN_HELPERS),
            "ports": list(required_ports),
            "auth_mode": "desktop_local",
            "local_user_id": "filmos-desktop-local-user",
            "cookie_required": False,
            "runtime_schema": runtime.get("schema_version"),
            "source_tree_open_files": False,
            "data_location": "$HOME/Library/Application Support/<acceptance-run>/WorkbenchData",
            "services_stopped_after_quit": True,
            "direct_sigterm_shutdown": True,
            "nsrunningapplication_shutdown": True,
            "isolated_review_bus_port": True,
            "ui_golden_captures": len(ui_golden["captures"]) if ui_golden_root and ui_golden else 0,
        }, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
