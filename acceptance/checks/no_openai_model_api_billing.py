#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RUNTIME_SOURCES = (
    ROOT / "desktop/macos/Sources/FilmOSDesktopCore/ChatGPTConnectionManager.swift",
    ROOT / "desktop/macos/Sources/FilmOSStudioDesktop/DesktopChatGPTRuntime.swift",
    ROOT / "desktop/macos/scripts/build-unsigned-app",
    ROOT / "services/filmos-chatgpt-app/src",
)
FORBIDDEN_MODEL_PATHS = (
    "/v1/responses",
    "/v1/chat/completions",
    "/v1/embeddings",
    "/v1/images",
    "/v1/audio",
)


def source_files() -> list[Path]:
    values: list[Path] = []
    for path in RUNTIME_SOURCES:
        if path.is_dir():
            values.extend(sorted(item for item in path.rglob("*") if item.is_file()))
        else:
            values.append(path)
    return values


def main() -> None:
    started = datetime.now(timezone.utc)
    violations: list[dict[str, str]] = []
    observed_model_api_calls = 0
    files = source_files()
    for path in files:
        text = path.read_text(encoding="utf-8")
        for endpoint in FORBIDDEN_MODEL_PATHS:
            if endpoint in text:
                violations.append({"path": str(path.relative_to(ROOT)), "endpoint": endpoint})
                observed_model_api_calls += 1

    desktop = (ROOT / "desktop/macos/Sources/FilmOSStudioDesktop/DesktopChatGPTRuntime.swift").read_text(encoding="utf-8")
    supervisor = (ROOT / "desktop/macos/Sources/FilmOSDesktopCore/ServiceSupervisor.swift").read_text(encoding="utf-8")
    manager = (ROOT / "desktop/macos/Sources/FilmOSDesktopCore/ChatGPTConnectionManager.swift").read_text(encoding="utf-8")
    required_markers = {
        "control_plane_key_reference": '"--control-plane.api-key", "env:CONTROL_PLANE_API_KEY"' in desktop,
        "runtime_key_is_secret_environment": '"CONTROL_PLANE_API_KEY"' in supervisor,
        "no_openai_api_key_runtime": "OPENAI_API_KEY" not in desktop,
        "dynamic_mcp_risk_counts": 'mcpWriteToolCount: healthPayload?["mcp_write_tool_count"] as? Int ?? 0' in desktop,
        "read_only_host_blocks_write_tools": "health.mcpWriteToolCount == 0" in manager,
    }
    if not all(required_markers.values()):
        violations.append({"path": "desktop/macos", "endpoint": "RUNTIME_CONTRACT_MISSING"})

    ended = datetime.now(timezone.utc)
    receipt = {
        "schema_version": "1.1.0",
        "gate_id": "NO-OPENAI-MODEL-API-001",
        "gate": "NO_OPENAI_MODEL_API_BILLING",
        "billing_mode": "SUBSCRIPTION_ONLY",
        "protected_profiles": ["codex.subscription", "chatgpt.subscription.host"],
        "allow_api_fallback": False,
        "start_time": started.isoformat(),
        "end_time": ended.isoformat(),
        "observation_mode": "STATIC_RUNTIME_NETWORK_CONTRACT",
        "observed_model_api_calls": observed_model_api_calls,
        "allowed_tunnel_calls": ["https://api.openai.com/v1/tunnel/*"],
        "forbidden_model_paths": list(FORBIDDEN_MODEL_PATHS),
        "runtime_source_files_checked": len(files),
        "runtime_contract_checks": required_markers,
        "violations": violations,
        "result": "PASSED" if not violations else "BLOCK_RC",
    }
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
    if violations:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
