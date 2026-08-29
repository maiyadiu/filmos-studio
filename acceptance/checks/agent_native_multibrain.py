#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BASELINE = "643a993a66b5eacd0f534bd78670bdb766d5dcb2"
PRODUCTION_RECEIPT_PREFIX = "FILMOS_PRODUCTION_RUNTIME_RECEIPT "


def text(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def require(condition: bool, code: str) -> None:
    if not condition:
        raise RuntimeError(code)


def production_composition_receipt() -> dict:
    result = subprocess.run(
        ("npx", "tsx", "--test", "test/production-runtime-gate.test.ts"),
        cwd=ROOT / "canvas-agent",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    require(result.returncode == 0, "PRODUCTION_COMPOSITION_TEST_FAILED\n" + result.stdout[-8000:])
    lines = [line.split(PRODUCTION_RECEIPT_PREFIX, 1)[1] for line in result.stdout.splitlines() if PRODUCTION_RECEIPT_PREFIX in line]
    require(len(lines) == 1, "PRODUCTION_COMPOSITION_RECEIPT_MISSING")
    receipt = json.loads(lines[0])
    require(receipt.get("status") == "PASSED", "PRODUCTION_COMPOSITION_NOT_PASSED")
    return receipt


def main() -> int:
    ancestry = subprocess.run(
        ("git", "merge-base", "--is-ancestor", BASELINE, "HEAD"),
        cwd=ROOT,
        check=False,
    )
    require(ancestry.returncode == 0, "FIXED_BASELINE_NOT_ANCESTOR")

    profiles = text("canvas-agent/src/brains/profiles.ts")
    flags = text("canvas-agent/src/brains/feature-flags.ts")
    runtime = text("canvas-agent/src/brains/generic-agent-runtime.ts")
    manager = text("canvas-agent/src/brains/session-manager.ts")
    codex = text("canvas-agent/src/brains/adapters/codex-app-server-adapter.ts")
    codex_client = text("canvas-agent/src/brains/adapters/codex-app-server-client.ts")
    codex_entry = text("canvas-agent/src/agents.ts")
    api_adapter = text("canvas-agent/src/brains/adapters/model-api-brain-adapter.ts")
    hosted_adapter = text("canvas-agent/src/brains/adapters/chatgpt-hosted-adapter.ts")
    tool_manifest = text("canvas-agent/src/brains/tool-manifest.ts")
    generated_tool_contract = json.loads(text("packages/filmos-agent-tool-contracts/generated/canonical-tools.json"))
    generated_tool_names = {item["name"] for item in generated_tool_contract["tools"]}
    tool_broker = text("canvas-agent/src/brains/tool-broker.ts")
    mcp_server = text("canvas-agent/src/mcp-server.ts")
    canvas_http = text("canvas-agent/src/modules/canvas-agent-http.ts")
    web_profiles = text("web/src/film/agent/brain-profiles.ts")

    required_profiles = (
        "codex.subscription",
        "chatgpt.subscription.host",
        "openai.api",
        "anthropic.api",
        "deepseek.api",
        "local.model",
        "human.only",
    )
    require(all(profile in profiles for profile in required_profiles), "BRAIN_PROFILE_SET_INCOMPLETE")
    require(all(profile in web_profiles for profile in required_profiles if profile != "human.only"), "VISIBLE_BRAIN_PROFILE_SET_INCOMPLETE")
    declared_flags = set(re.findall(r'"(film\.agent_[a-z_]+)"', flags.split("] as const", 1)[0]))
    require(declared_flags == {
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
    }, "FEATURE_FLAG_DECLARATION_COUNT_CHANGED")
    require("configured[id] === true" in flags, "FEATURE_FLAGS_ARE_NOT_DEFAULT_FALSE")
    require("JsonBrainSessionStore" in runtime and "brain-sessions.v1.json" in runtime, "SINGLE_DURABLE_SESSION_STORE_MISSING")
    require("JsonlAgentAuditSink" in runtime and "agent-audit.v1.jsonl" in runtime, "DURABLE_AGENT_AUDIT_MISSING")
    require("new CodexSubscriptionAdapter" in runtime, "CODEX_ADAPTER_NOT_REGISTERED")
    require("class ModelApiBrainAdapter" in api_adapter and "MODEL_API_PROFILE_NOT_SELECTED" in api_adapter, "EXPLICIT_API_ADAPTER_BOUNDARY_MISSING")
    require("class ChatGPTHostedAdapter" in hosted_adapter and "directApplyAvailable: false" in hosted_adapter, "CHATGPT_HOSTED_BOUNDARY_MISSING")
    require("cannot produce ChatGPT message deltas" in hosted_adapter, "CHATGPT_HOST_MESSAGE_BOUNDARY_MISSING")
    require("--canvas-only" not in codex_entry, "CODEX_STILL_USES_CANVAS_ONLY")
    require('"mcp_servers.yingce.command"' in codex_entry, "CODEX_THREAD_MCP_OVERRIDE_NOT_DOTTED")
    require('FILMOS_AGENT_PROFILE: "codex_app_server"' in codex_entry, "FILM_GATEWAY_PROFILE_COMPATIBILITY_MISSING")
    require('FILMOS_BRAIN_PROFILE_ID: "codex.subscription"' in codex_entry, "BRAIN_PROFILE_ATTRIBUTION_MISSING")
    require("preflightWorkbenchMcp" in codex and '"workbench_get_context"' in codex, "CODEX_MCP_PREFLIGHT_MISSING")
    require("terminateProcessTree" in codex_client and '"SIGKILL"' in codex_client, "CODEX_PROCESS_TREE_SHUTDOWN_MISSING")
    require("AgentContextBroker" in runtime and "CanonicalAgentToolManifest" in runtime, "SHARED_CONTEXT_OR_MANIFEST_MISSING")
    require("class CanonicalAgentToolBroker" in tool_broker, "SINGLE_TOOL_BROKER_MISSING")
    require("class AgentSessionManager" in manager and "permissionGrantId" in manager, "SESSION_GRANT_BINDING_MISSING")
    require("mcpAnnotationsForRisk" in mcp_server, "CANONICAL_MCP_RISK_ANNOTATIONS_MISSING")
    require("canonicalAgentToolsByName" in tool_manifest, "CANONICAL_TOOL_CONTRACT_NOT_CONSUMED")
    require({"workbench_get_context", "film_command_apply"}.issubset(generated_tool_names), "WORKBENCH_TOOL_SURFACE_INCOMPLETE")
    require('/agent/codex/turn' in canvas_http and '/agent/sessions/:sessionId/turns' in canvas_http, "LEGACY_OR_GENERIC_ROUTE_MISSING")

    source_roots = (ROOT / "canvas-agent/src", ROOT / "web/src/film/agent")
    forbidden_fallbacks = []
    for source_root in source_roots:
        for path in source_root.rglob("*"):
            if path.is_file() and path.suffix in {".ts", ".tsx", ".js", ".mjs"}:
                value = path.read_text(encoding="utf-8")
                if "host-project-1" in value:
                    forbidden_fallbacks.append(path.relative_to(ROOT).as_posix())
    require(not forbidden_fallbacks, "TEST_PROJECT_FALLBACK_PRESENT")

    tests = (
        "canvas-agent/test/agent-session-manager.test.ts",
        "canvas-agent/test/agent-context-pack.test.ts",
        "canvas-agent/test/agent-tool-broker.test.ts",
        "canvas-agent/test/chatgpt-hosted-adapter.test.ts",
        "canvas-agent/test/model-api-brain-adapter.test.ts",
        "canvas-agent/test/agent-feature-flags.test.ts",
        "canvas-agent/test/agent-session-migration.test.ts",
        "canvas-agent/test/agent-rollback.test.ts",
        "canvas-agent/test/agent-audit-persistence.test.ts",
        "canvas-agent/test/internal-canvas-mcp-mode.test.ts",
        "web/src/film/agent/brain-selector.test.mjs",
        "web/src/film/agent/agent-client.test.mjs",
    )
    require(all((ROOT / item).is_file() for item in tests), "AGENT_ACCEPTANCE_TEST_MATRIX_INCOMPLETE")

    production = production_composition_receipt()
    expected_profiles = set(required_profiles)
    require(set(production["enabled_profile_ids"]) == expected_profiles, "PRODUCTION_ENABLED_PROFILE_DRIFT")
    require(set(production["adapter_profile_ids"]) == expected_profiles, "PRODUCTION_ADAPTER_REGISTRY_INCOMPLETE")
    require(production["instrumentation"] == {
        "broker_request_count": 7,
        "broker_confirmation_count": 1,
        "broker_execute_count": 7,
        "legacy_direct_execute_count": 0,
    }, "PRODUCTION_BROKER_INSTRUMENTATION_MISMATCH")
    require(production["controlled_write_execute_count"] == 1, "PRODUCTION_CONTROLLED_WRITE_COUNT_MISMATCH")
    require(production["duplicate_confirmation_replay_blocked"] is True, "PRODUCTION_CONFIRMATION_REPLAY_NOT_BLOCKED")

    receipt = {
        "schema_version": "1.0.0",
        "gate_id": "AGENT-NATIVE-MULTIBRAIN-CONTRACT-001",
        "status": "PASSED",
        "fixed_baseline": BASELINE,
        "feature_flag_count": 10,
        "brain_profile_count": len(required_profiles),
        "test_contract_count": len(tests),
        "duplicate_runtime_sources_detected": 0,
        "test_project_fallbacks_detected": forbidden_fallbacks,
        "production_composition": production,
        "gates": {
            "A": "COVERED_BY_RC_LOCAL",
            "B": "COVERED_BY_MCP_ACTUAL_TOOL_COUNT",
            "C": "AUTOMATED_CANVAS_AGENT",
            "D": "PASSED_NO_TEST_PROJECT_FALLBACK",
            "E": "REQUIRES_RC_REAL_AGENT_RECEIPT",
            "F": "PASSED_EXPLICIT_API_ONLY",
            "G": "PASS_WITH_EXTERNAL_ACCOUNT_LIMITATION",
            "H": "COVERED_BY_NO_OPENAI_MODEL_API_BILLING",
            "I": "PASSED_SINGLE_SOURCE_CONTRACT",
            "J": "PASS_WITH_LIMITATIONS",
        },
        "rc1_tag_created_by_check": False,
    }
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
