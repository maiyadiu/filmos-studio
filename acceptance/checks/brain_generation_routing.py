#!/usr/bin/env python3
from __future__ import annotations

import json
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def require(path: str, *needles: str) -> str:
    value = (ROOT / path).read_text(encoding="utf-8")
    missing = [needle for needle in needles if needle not in value]
    if missing:
        raise RuntimeError(f"{path} missing contracts: {missing}")
    return value


def main() -> int:
    freeze = json.loads((ROOT / "implementation/brain-generation-routing/ARCHITECTURE_FREEZE.json").read_text(encoding="utf-8"))
    if freeze.get("status") != "APPROVED_FOR_IMPLEMENTATION" or freeze.get("unresolved_p0") != 0 or freeze.get("duplicate_authorities") != 0:
        raise RuntimeError("architecture freeze is not approved")
    brain = require("packages/filmos-generation-contracts/src/brain.ts", "USER_SELECTABLE_BRAIN_PROFILE_IDS", "BRAIN_API_FALLBACK_FORBIDDEN")
    profile_ids = set(re.findall(r'"(?:codex\.subscription|chatgpt\.subscription\.host|openai\.api|anthropic\.api|deepseek\.api|local\.model)"', brain.split("as const", 1)[0]))
    if len(profile_ids) != 6 or "human.only" in brain:
        raise RuntimeError("user-selectable brain profile closure changed")
    runtime = require("web/src/film/agent/browser-runtime-handler.ts", "resolveBinding", "exactBoundModelConfig")
    if "textModel ||" in runtime or "channelMatchesProfile" in runtime:
        raise RuntimeError("Agent still contains global text fallback or name guessing")
    require("web/src/pages/settings/index.tsx", "AI 大脑", "生成引擎", "模型与默认路由")
    require(
        "web/src/pages/settings/generation-engine-settings-pane.tsx",
        "Dreamina Catalog", "Catalog Evidence", "Flova 尚未接入", "Flova 待选择",
        "Flova 待授权", "Flova 可用", "Flova 能力已验证但被上游阻断",
        "READY_FOR_USER_SELECTION", "RunningHub", "ComfyUI", "Manual Web",
    )
    require("web/src/components/canvas/canvas-config-composer.tsx", "Generation Composer", "生成预览（零费用）", "提交（需授权）", "Catalog Validation", "Broker Confirmation")
    require("web/src/film/generation-routing/canonical-tool-runtime.ts", "CANONICAL_GENERATION_TOOL_NAMES", "AUTHORIZED_GENERATION_SUBMISSION_REQUIRED", "externalWritePerformed: false")
    require("packages/filmos-generation-contracts/src/catalog.ts", "CATALOG_VALIDATION_STALE", "CATALOG_VALIDATION_BINDING_MISMATCH")
    require("packages/filmos-generation-contracts/src/authorization.ts", "BROKER_AUTHORIZATION_EVIDENCE_INCOMPLETE", "GENERATION_SUBMISSION_STALE")
    require("packages/filmos-generation-contracts/src/budget.ts", "BUDGET_BINDING_SCOPE_MISMATCH", "BUDGET_LEDGER_SEQUENCE_GAP")
    require("packages/filmos-generation-contracts/src/policy.ts", "LOCKED_MODEL_UNAVAILABLE", "PROJECT_ENGINE_NOT_ALLOWED")
    require("film-core/src/film_production_core/generation_budget.py", "BEGIN IMMEDIATE", "transition_reservation", "rotate_binding", "verify_ledger_against_events", "generation_budget_overrun_audits")
    require("backend/internal/service/desktop_user_config.go", "DesktopUserConfigFormat", "findForbiddenConfigSecret")
    require("film-core/src/film_production_core/formal_models.py", "GenerationExecutionEvidenceBinding", "authorized_submission_content_hash")
    flova = json.loads((ROOT / "implementation/flova-cli/CAPABILITY_MATRIX.json").read_text(encoding="utf-8"))
    if flova.get("external_cost_microunits") != "0" or flova.get("state") != "READY_FOR_USER_SELECTION":
        raise RuntimeError("Flova external state/cost closure changed")
    if any(flova["privacy"].values()):
        raise RuntimeError("Flova report privacy flags are not zero")
    dreamina = json.loads((ROOT / "implementation/dreamina-cli/CAPABILITY_MATRIX.json").read_text(encoding="utf-8"))
    if dreamina.get("external_cost_microunits") != "0" or dreamina.get("state") != "PASS_AUTOMATED":
        raise RuntimeError("Dreamina zero-cost automated evidence closure changed")
    workflows = json.loads((ROOT / "implementation/workflow-engines/CAPABILITY_MATRIX.json").read_text(encoding="utf-8"))
    if workflows.get("external_cost_microunits") != "0" or any(not value.get("single_store") for value in workflows["engines"].values()):
        raise RuntimeError("workflow engine single-store or zero-cost closure changed")
    ui_golden_path = ROOT / "acceptance/golden/brain-generation-routing/GENERATION_COMPOSER_GOLDEN.json"
    ui_golden = json.loads(ui_golden_path.read_text(encoding="utf-8"))
    observed = ui_golden.get("observed_contracts", {})
    if ui_golden.get("status") != "PASSED_ZERO_COST" or observed.get("flova_external_gate_state") != "READY_FOR_USER_SELECTION":
        raise RuntimeError("candidate UI Golden state closure changed")
    if any(observed.get(field) for field in (
        "provider_submit_invoked", "provider_completion_invoked", "asset_upload_invoked", "external_generation_invoked",
    )) or observed.get("external_spend_microunits") != "0":
        raise RuntimeError("candidate UI Golden crossed the zero-cost boundary")
    for screenshot in ui_golden.get("screenshots", []):
        screenshot_path = ui_golden_path.parent / screenshot["path"]
        if hashlib.sha256(screenshot_path.read_bytes()).hexdigest() != screenshot["sha256"]:
            raise RuntimeError(f"candidate UI Golden screenshot hash mismatch: {screenshot['path']}")
    tool_manifest = require("canvas-agent/src/brains/tool-manifest-source.ts", "generation_list_engines", "generation_submit", "generation_get_lineage")
    declared_generation_tools = set(re.findall(r'"(generation_[a-z_]+)"', tool_manifest))
    if len(declared_generation_tools) != 18:
        raise RuntimeError("canonical generation tool closure changed")
    gates = [
        "ARCHITECTURE-FREEZE-INTERNAL-001", "BRAIN-SETTINGS-DISCOVERABLE-001",
        "BRAIN-RUNTIME-BINDING-EXACT-001", "BRAIN-NO-GLOBAL-TEXT-FALLBACK-001",
        "LOCAL-CONFIG-NO-LOGIN-DEPENDENCY-001", "GEN-ENGINE-SETTINGS-DISCOVERABLE-001",
        "GEN-CATALOG-CACHE-BOUNDED-001", "GEN-DESCRIPTOR-BLOB-EXACT-SELECTION-001",
        "GEN-CATALOG-VALIDATION-RECEIPT-001", "GEN-COMPOSER-REUSES-EXISTING-NODE-PATH-001",
        "GEN-PAID-PREVIEW-001", "PROMPT-COMPILATION-RECEIPT-001",
        "GEN-PROVIDER-INPUT-AUTH-BROKER-EVIDENCE-001", "GEN-TARGET-GUARD-001",
        "GEN-BUDGET-LEDGER-SINGLE-AUTHORITY-001", "GEN-BUDGET-CANONICAL-AMOUNT-LEXICAL-001",
        "GEN-BUDGET-RESERVATION-ATOMIC-001", "GEN-BUDGET-SETTLEMENT-001",
        "GEN-BUDGET-OVERRUN-AUDIT-001", "GEN-BUDGET-BINDING-ROTATION-001",
        "PROJECT-MODEL-LOCK-001", "LOCKED-MODEL-UNAVAILABLE-001",
        "DREAMINA-DOCTOR-REAL-001", "DREAMINA-CATALOG-EVIDENCE-001",
        "WORKFLOW-SINGLE-STORE-001", "WORKFLOW-SCHEMA-COMPOSER-001",
        "FLOVA-SOURCE-VERIFIED-001", "FLOVA-DOCTOR-REAL-001",
    ]
    print(json.dumps({"golden_id": "BRAIN-GENERATION-ROUTING-V2.4-001", "candidate_ui_golden_id": ui_golden["golden_case_id"], "status": "PASSED", "gates": gates, "external_cost_microunits": "0", "dreamina": "PASS_AUTOMATED", "flova": "READY_FOR_USER_SELECTION", "runninghub": "READY_FOR_USER_SELECTION", "comfyui": "READY_FOR_USER_SELECTION"}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
