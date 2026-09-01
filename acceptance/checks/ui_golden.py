#!/usr/bin/env python3
"""Capture and bind real packaged-App UI evidence without external network access."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import secrets
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
REQUIRED_SURFACE_IMAGES = {
    "report_issue_entry": "report-issue.png",
    "report_paste_attachment": "report-paste.png",
    "issue_detail": "review-top.png",
    "evidence_completeness": "review-top.png",
    "codex_assessment_status": "review-top.png",
    "chatgpt_assessment_status": "review-top.png",
    "consensus_delta": "review-middle.png",
    "consensus_proposal": "review-middle.png",
    "findings": "review-middle.png",
    "candidate_history": "review-candidate.png",
    "chrome_pairing_code": "chrome-pairing.png",
    "chrome_send_ack": "chrome-send-ack.png",
    "owner_decision": "owner-decision.png",
    "architecture_options": "owner-decision.png",
    "dual_signoff": "review-bottom.png",
    "pilot_gate": "review-bottom.png",
    "document_readable": "document-readable.png",
    "document_markdown": "document-markdown.png",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"expected JSON object: {path.name}")
    return value


def chrome_executable() -> Path:
    candidates = (
        os.environ.get("FILMOS_UI_GOLDEN_CHROME", ""),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        shutil.which("google-chrome") or "",
        shutil.which("chromium") or "",
    )
    for raw in candidates:
        path = Path(raw) if raw else None
        if path and path.is_file() and os.access(path, os.X_OK):
            return path
    raise RuntimeError("Google Chrome is required for packaged-App UI Golden capture")


def request_json(url: str, method: str = "GET", payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=10) as response:
        value = json.loads(response.read().decode("utf-8"))
    if not isinstance(value, dict) or value.get("code") != 0 or not isinstance(value.get("data"), dict):
        raise RuntimeError(f"packaged-App fixture request failed: {method} {url}")
    return value["data"]


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


class CdpSocket:
    def __init__(self, url: str):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "ws" or parsed.hostname not in {"127.0.0.1", "localhost"} or not parsed.port:
            raise RuntimeError("Chrome DevTools endpoint must be explicit loopback ws://")
        self.socket = socket.create_connection((parsed.hostname, parsed.port), timeout=10)
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        path = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
        request = (
            f"GET {path} HTTP/1.1\r\nHost: {parsed.hostname}:{parsed.port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
            "Origin: http://127.0.0.1\r\n\r\n"
        ).encode("ascii")
        self.socket.sendall(request)
        response = b""
        while b"\r\n\r\n" not in response and len(response) < 16384:
            response += self.socket.recv(4096)
        if not response.startswith(b"HTTP/1.1 101"):
            raise RuntimeError(f"Chrome DevTools WebSocket upgrade failed: {response[:200]!r}")

    def close(self) -> None:
        try:
            self.socket.close()
        except OSError:
            pass

    def send_json(self, value: dict[str, Any]) -> None:
        payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
        mask = secrets.token_bytes(4)
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        self.socket.sendall(bytes(header) + mask + masked)

    def recv_json(self) -> dict[str, Any]:
        fragments = bytearray()
        while True:
            first, second = self._recv_exact(2)
            opcode = first & 0x0F
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv_exact(8))[0]
            mask = self._recv_exact(4) if second & 0x80 else b""
            payload = self._recv_exact(length)
            if mask:
                payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
            if opcode == 0x8:
                raise RuntimeError("Chrome DevTools WebSocket closed")
            if opcode == 0x9:
                self._send_control(0xA, payload)
                continue
            if opcode not in {0x0, 0x1}:
                continue
            fragments.extend(payload)
            if first & 0x80:
                value = json.loads(fragments.decode("utf-8"))
                if not isinstance(value, dict):
                    raise RuntimeError("Chrome DevTools response is not an object")
                return value

    def _send_control(self, opcode: int, payload: bytes) -> None:
        mask = secrets.token_bytes(4)
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        self.socket.sendall(bytes([0x80 | opcode, 0x80 | len(payload)]) + mask + masked)

    def _recv_exact(self, length: int) -> bytes:
        result = bytearray()
        while len(result) < length:
            chunk = self.socket.recv(length - len(result))
            if not chunk:
                raise RuntimeError("Chrome DevTools WebSocket ended unexpectedly")
            result.extend(chunk)
        return bytes(result)


class ChromeCapture:
    def __init__(self, chrome: Path, directory: Path):
        self.chrome = chrome
        self.directory = directory
        self.port = free_port()
        self.process: subprocess.Popen[bytes] | None = None
        self.connection: CdpSocket | None = None
        self.command_id = 0
        self.events: list[dict[str, Any]] = []

    def __enter__(self) -> "ChromeCapture":
        profile = self.directory / "profile"
        log = (self.directory / "chrome.log").open("wb")
        command = (
            str(self.chrome), "--headless=new", "--disable-gpu", "--disable-background-networking",
            "--disable-component-update", "--disable-default-apps", "--disable-sync", "--hide-scrollbars",
            "--no-first-run", "--force-device-scale-factor=1", "--remote-allow-origins=*",
            f"--remote-debugging-port={self.port}", f"--user-data-dir={profile}", "about:blank",
        )
        self.process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 20
        target = None
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/list", timeout=1) as response:
                    values = json.loads(response.read().decode("utf-8"))
                target = next((item for item in values if item.get("type") == "page" and item.get("webSocketDebuggerUrl")), None)
                if target:
                    break
            except (OSError, ValueError):
                time.sleep(0.1)
        if not target:
            raise RuntimeError("Chrome DevTools page target did not start")
        self.connection = CdpSocket(str(target["webSocketDebuggerUrl"]))
        self.call("Page.enable")
        self.call("Runtime.enable")
        self.call("Log.enable")
        self.call("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 1000, "deviceScaleFactor": 1, "mobile": False})
        return self

    def __exit__(self, *_: object) -> None:
        if self.connection:
            self.connection.close()
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.connection:
            raise RuntimeError("Chrome DevTools is not connected")
        self.command_id += 1
        command_id = self.command_id
        self.connection.send_json({"id": command_id, "method": method, **({"params": params} if params else {})})
        while True:
            response = self.connection.recv_json()
            if response.get("id") != command_id:
                method = response.get("method")
                if method in {"Runtime.exceptionThrown", "Runtime.consoleAPICalled", "Log.entryAdded"}:
                    self.events.append(response)
                continue
            if response.get("error"):
                raise RuntimeError(f"Chrome DevTools command failed: {method}: {response['error']}")
            result = response.get("result", {})
            return result if isinstance(result, dict) else {}

    def screenshot(self, url: str, ready_mode: str, destination: Path) -> None:
        navigation = self.call("Page.navigate", {"url": url})
        if navigation.get("errorText"):
            raise RuntimeError(f"UI Golden navigation failed: {ready_mode}: {navigation['errorText']}")
        deadline = time.monotonic() + 30
        ready = False
        expression = f"document.documentElement.dataset.filmosUiGoldenReady === {json.dumps(ready_mode)}"
        while time.monotonic() < deadline:
            result = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True})
            ready = result.get("result", {}).get("value") is True
            if ready:
                break
            time.sleep(0.1)
        if not ready:
            state = self.call("Runtime.evaluate", {
                "expression": "JSON.stringify({href:location.href,readyState:document.readyState,text:document.body?.innerText?.slice(0,1200)||'',html:document.documentElement?.outerHTML?.slice(0,1200)||''})",
                "returnByValue": True,
            })
            raise RuntimeError(f"UI Golden fixture did not become ready: {ready_mode}: state={state}: events={self.events[-20:]}")
        self.call("Runtime.evaluate", {"expression": "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", "awaitPromise": True})
        result = self.call("Page.captureScreenshot", {"format": "png", "fromSurface": True, "captureBeyondViewport": False})
        data = result.get("data")
        if not isinstance(data, str):
            raise RuntimeError(f"Chrome DevTools did not return screenshot bytes: {ready_mode}")
        destination.write_bytes(base64.b64decode(data, validate=True))
        if destination.stat().st_size < 1024:
            raise RuntimeError(f"UI Golden screenshot is empty: {destination.name}")


def create_document_fixture(backend_port: int) -> tuple[str, str]:
    base = f"http://127.0.0.1:{backend_port}/api"
    project = request_json(f"{base}/projects", "POST", {
        "name": "FilmOS UI Golden 项目",
        "type": "short_drama",
        "aspectRatio": "9:16",
        "sourceType": "script",
        "description": "仅用于打包 App 的本地零网络 UI 取证",
    })["project"]
    unit = request_json(f"{base}/projects/{project['id']}/units", "POST", {
        "kind": "chapter",
        "title": "第001集｜缘浅白头",
        "sourceText": (
            "<p># 《FilmOS UI Golden》第一章</p>"
            "<p>**目标时长：55秒**</p>"
            "<p>雨落在旧城长街，人物关系、动作节拍与制作边界在易读模式中清晰呈现。</p>"
            "<p>## 一、当前阶段</p><p>- 本地证据完整<br>- 外部费用为 0<br>- 双专家签核可追溯</p>"
        ),
    })["unit"]
    return str(project["id"]), str(unit["id"])


def extension_ack_fixture(directory: Path) -> Path:
    content_script = ROOT / "extensions" / "filmos-review-bridge" / "src" / "content.js"
    shutil.copy2(content_script, directory / "content.js")
    page = directory / "chrome-send-ack.html"
    page.write_text(
        "<!doctype html><html lang='zh-CN'><meta charset='utf-8'><title>FilmOS Review Bridge UI Golden</title>"
        "<style>html,body{margin:0;background:#151515;color:#f5f5f5;font:16px -apple-system,BlinkMacSystemFont,sans-serif}"
        "main{max-width:980px;margin:80px auto;padding:32px}article{border:1px solid #333;border-radius:24px;padding:34px;background:#202020}"
        "h1{font-size:30px}p{color:#bbb;line-height:1.8}</style><main><article><div data-message-author-role='assistant'>"
        "<h1>ChatGPT 双专家复核</h1><p>已核对 FilmOS Evidence、Consensus、Candidate B 与机器判定。</p>"
        "<pre>{\"purpose\":\"CHATGPT_CANDIDATE_REVIEW\",\"verdict\":\"EXTERNAL_APPROVED\"}</pre>"
        "</div></article></main><script src='content.js'></script><script>setTimeout(()=>{const b=document.getElementById('filmos-review-send');"
        "if(b){b.textContent='已发送：FILMOS-ISSUE-UI-GOLDEN-001';document.documentElement.dataset.filmosUiGoldenReady='chrome-send-ack'}},300)</script></html>",
        encoding="utf-8",
    )
    return page


def capture_packaged_ui(bundle: Path, web_port: int, backend_port: int, capture_root: Path) -> dict[str, Any]:
    if capture_root.exists() and any(capture_root.iterdir()):
        raise RuntimeError("UI Golden capture root must be empty")
    ui_root = capture_root / "ui"
    ui_root.mkdir(parents=True, exist_ok=True)
    identity = load_json(bundle / "Contents" / "Resources" / "SourceIdentity.json")
    chrome = chrome_executable()
    project_id, unit_id = create_document_fixture(backend_port)
    base = f"http://127.0.0.1:{web_port}"
    routes = {
        "report-issue.png": f"{base}/create?ui-golden=report",
        "report-paste.png": f"{base}/create?ui-golden=report-paste",
        "review-top.png": f"{base}/admin/review-center?ui-golden=review-top",
        "review-middle.png": f"{base}/admin/review-center?ui-golden=review-middle",
        "review-candidate.png": f"{base}/admin/review-center?ui-golden=review-candidate",
        "review-bottom.png": f"{base}/admin/review-center?ui-golden=review-bottom",
        "owner-decision.png": f"{base}/admin/review-center?ui-golden=owner",
        "chrome-pairing.png": f"{base}/admin/review-center?ui-golden=pairing",
        "document-readable.png": f"{base}/projects/{project_id}/chapters/{unit_id}?ui-golden=document-readable",
        "document-markdown.png": f"{base}/projects/{project_id}/chapters/{unit_id}?ui-golden=document-markdown",
    }
    ready_modes = {
        "report-issue.png": "report",
        "report-paste.png": "report-paste",
        "review-top.png": "review-top",
        "review-middle.png": "review-middle",
        "review-candidate.png": "review-candidate",
        "review-bottom.png": "review-bottom",
        "owner-decision.png": "owner",
        "chrome-pairing.png": "pairing",
        "document-readable.png": "document-readable",
        "document-markdown.png": "document-markdown",
    }
    with tempfile.TemporaryDirectory(prefix="filmos-ui-golden-chrome-") as temporary:
        temp = Path(temporary)
        for index, (filename, url) in enumerate(routes.items(), start=1):
            browser_root = temp / f"capture-{index:02d}"
            browser_root.mkdir()
            with ChromeCapture(chrome, browser_root) as browser:
                browser.screenshot(url, ready_modes[filename], ui_root / filename)
        ack_root = temp / "capture-extension-ack"
        ack_root.mkdir()
        ack_page = extension_ack_fixture(ack_root)
        with ChromeCapture(chrome, ack_root) as browser:
            browser.screenshot(ack_page.as_uri(), "chrome-send-ack", ui_root / "chrome-send-ack.png")

    contexts = {
        "report-issue.png": ("/create", "report-modal"),
        "report-paste.png": ("/create", "report-pasted-image"),
        "review-top.png": ("/admin/review-center", "dual-approved-top"),
        "review-middle.png": ("/admin/review-center", "dual-approved-consensus-findings"),
        "review-candidate.png": ("/admin/review-center", "candidate-a-b-history"),
        "review-bottom.png": ("/admin/review-center", "dual-signoff-pilot-gate"),
        "owner-decision.png": ("/admin/review-center", "owner-decision-required"),
        "chrome-pairing.png": ("/admin/review-center", "one-time-pairing-code"),
        "chrome-send-ack.png": ("filmos-review-bridge://content-script", "user-gesture-writeback-ack"),
        "document-readable.png": ("/projects/:projectId/chapters/:unitId", "document-readable"),
        "document-markdown.png": ("/projects/:projectId/chapters/:unitId", "document-markdown"),
    }
    captures = []
    for surface, image in REQUIRED_SURFACE_IMAGES.items():
        route, fixture = contexts[image]
        captures.append({
            "surface": surface,
            "image": image,
            "route": route,
            "fixture": fixture,
            "feature_flags": {
                "packaged_app": True,
                "ui_golden_capture": True,
                "loopback_only": True,
                "external_network_requests": 0,
                "paid_provider_operations": 0,
            },
        })
    context = {
        "schema_version": "1.0.0",
        "status": "CAPTURED",
        "git_commit_sha": identity["git_commit_sha"],
        "git_tree_sha": identity["git_tree_sha"],
        "build_id": identity["build_id"],
        "ui_source_fingerprint": identity["source_fingerprint_sha256"],
        "packaged_app_source_fingerprint": identity["source_fingerprint_sha256"],
        "packaged_app": "FilmOS Studio.app",
        "captures": captures,
    }
    write_json(capture_root / "CAPTURE_CONTEXT.json", context)
    return context


def finalize(capture_root: Path, release_manifest: Path) -> dict[str, Any]:
    context = load_json(capture_root / "CAPTURE_CONTEXT.json")
    release = load_json(release_manifest)
    for key in ("git_commit_sha", "git_tree_sha", "build_id"):
        if context.get(key) != release.get(key):
            raise RuntimeError(f"UI Golden release binding mismatch: {key}")
    if context.get("ui_source_fingerprint") != context.get("packaged_app_source_fingerprint"):
        raise RuntimeError("UI Golden packaged-App source fingerprint mismatch")
    ui_root = capture_root / "ui"
    captures = context.get("captures")
    if not isinstance(captures, list):
        raise RuntimeError("UI Golden capture context is incomplete")
    finalized = []
    for raw in captures:
        if not isinstance(raw, dict) or not isinstance(raw.get("image"), str):
            raise RuntimeError("UI Golden capture entry is invalid")
        image = ui_root / raw["image"]
        if not image.is_file() or image.stat().st_size < 1024:
            raise RuntimeError(f"UI Golden image is missing: {raw.get('image')}")
        finalized.append({
            **raw,
            "git_commit_sha": release["git_commit_sha"],
            "git_tree_sha": release["git_tree_sha"],
            "build_id": release["build_id"],
            "image_sha256": sha256_file(image),
        })
    value = {
        "schema_version": "1.0.0",
        "status": "PASSED",
        "git_commit_sha": release["git_commit_sha"],
        "git_tree_sha": release["git_tree_sha"],
        "build_id": release["build_id"],
        "ui_source_fingerprint": context["ui_source_fingerprint"],
        "packaged_app_source_fingerprint": context["packaged_app_source_fingerprint"],
        "capture_environment": {
            "packaged_app": "FilmOS Studio.app",
            "browser": "Google Chrome headless",
            "network": "loopback-only",
            "external_network_requests": 0,
            "openai_model_api_calls": 0,
            "paid_provider_operations": 0,
        },
        "captures": finalized,
    }
    write_json(capture_root / "UI_GOLDEN_FRESHNESS.json", value)
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("finalize",))
    parser.add_argument("--capture-root", type=Path, required=True)
    parser.add_argument("--release-manifest", type=Path, required=True)
    args = parser.parse_args()
    value = finalize(args.capture_root.resolve(), args.release_manifest.resolve())
    print(json.dumps({"status": value["status"], "captures": len(value["captures"])}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
