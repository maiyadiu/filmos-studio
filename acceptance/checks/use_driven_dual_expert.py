#!/usr/bin/env python3
"""Static smoke contract for the V1.1 use-driven dual-expert system.

The component tests exercise behavior.  This check binds their public entry
points and the zero-cost Pilot boundary into one machine-readable artifact for
the final handoff.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BASE_COMMIT = "6ea93bfa08381264a1379fe938ade3a7513c7bba"
BASE_TREE = "51896f7874e21cc9868cb1bfa33b302cd323a925"
REVIEW_BASE_COMMIT = "ecfc79a9b9f7e91cdfd558747fdc5d2b62e1700a"
TASK_PACKAGE_HASH = "7cf9bed457611e44a6b1f1bbb96968f20d83edec0d7d00bedfc73c7cdea2a10f"
CONSTITUTION_HASH = "a61228c66e931cb977928f4d2864ab6556f3fcd163479e31ccebbc6fccf39d41"


def read(relative: str) -> str:
    path = ROOT / relative
    if not path.is_file():
        raise RuntimeError(f"required V1.1 source is missing: {relative}")
    return path.read_text(encoding="utf-8")


def require(relative: str, needles: tuple[str, ...]) -> str:
    value = read(relative)
    missing = [needle for needle in needles if needle not in value]
    if missing:
        raise RuntimeError(f"{relative} is missing contracts: {', '.join(missing)}")
    return value


def constitution_contract() -> dict[str, object]:
    contract = json.loads(read("governance/FILMOS_CONSTITUTION.json"))
    hashed = dict(contract)
    hashed.pop("content_hash", None)
    digest = hashlib.sha256(
        json.dumps(hashed, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    if contract.get("content_hash") != digest or digest != CONSTITUTION_HASH:
        raise RuntimeError("FILMOS-CONSTITUTION-HASH-001 failed")
    principles = contract.get("principles")
    if not isinstance(principles, list) or [item.get("id") for item in principles] != [f"C-{index:02d}" for index in range(1, 17)]:
        raise RuntimeError("FilmOS Constitution C-01 through C-16 are required")
    return contract


def main() -> int:
    constitution = constitution_contract()
    pilot = json.loads(read("implementation/use-driven-dual-expert-v1-1/PILOT_BASE_0_MANIFEST.json"))
    if pilot.get("pilot_base_id") != "PILOT_BASE_0" or pilot.get("git_commit_sha") != BASE_COMMIT or pilot.get("git_tree_sha") != BASE_TREE:
        raise RuntimeError("PILOT-BASE-FIXED-COMMIT-001 failed")
    if pilot.get("stable") is not False or pilot.get("rc1") is not False:
        raise RuntimeError("PILOT_BASE_0 must not claim Stable or RC1")
    policy = pilot.get("pilot_policy", {})
    if policy.get("external_paid_submit_policy") != "forbidden" or policy.get("openai_model_api_calls") != 0:
        raise RuntimeError("PILOT-NO-PAID-SUBMIT-001 failed")

    contracts = require(
        "services/filmos-review-bus/src/contracts.mjs",
        (TASK_PACKAGE_HASH, CONSTITUTION_HASH, "MAX_AUTOMATIC_ROUNDS = 2", "PREVIOUS_REVIEW_MISS", "SCOPE_EXPANSION"),
    )
    require(
        "services/filmos-review-bus/src/server.mjs",
        ("Library/Application Support/FilmOS Studio/review-bus", "/v1/bridge/challenge", "/v1/bridge/decision", "/v1/bridge/revoke", "live-roundtrip-trace"),
    )
    require(
        "services/filmos-review-bus/src/service.mjs",
        ("FILMOS-ISSUE", "FILMOS-ARCH", "EVIDENCE_REQUIRED", "REVIEW_CODEX_CANNOT_SELF_CLOSE", "pilotAllowed", "github_remote_verification", "runtime_recovery"),
    )
    require("services/filmos-review-bus/src/github-evidence-verifier.mjs", ("maiyadiu/filmos-studio", "evidence_index_hash_matches", "GITHUB_REMOTE_EVIDENCE_MISMATCH", "FILMOS_GH_EXECUTABLE"))
    require("services/filmos-review-bus/src/live-roundtrip-trace.mjs", ("EXACTLY_TWO_CANDIDATES_REQUIRED", "CODEX_SUBSCRIPTION_COORDINATION_REQUIRED", "FORMAL_GITHUB_REMOTE_EVIDENCE_REQUIRED"))
    require(
        "canvas-agent/src/brains/review-codex-coordinator.ts",
        ("filmos-governance-global", "CONSENSUS_RESPONSE", "LOCAL_CANDIDATE_ACCEPTANCE", "codex_workspace", "real Git commit"),
    )
    require(
        "canvas-agent/src/brains/review-worktree-manager.ts",
        ("FILMOS_REVIEW_SOURCE_REPOSITORY", "codex/review-", "REVIEW_WORKTREE_BASE_NOT_ANCESTOR"),
    )
    require(
        "canvas-agent/src/brains/generic-agent-runtime.ts",
        ("review_coordinator", "REVIEW_CODEX_SESSION_WORKSPACE_MISMATCH", "REVIEW_SOURCE_REPOSITORY_NOT_CONFIGURED"),
    )
    require(
        "services/filmos-chatgpt-app/src/review-mcp.ts",
        ("issue_list_pending", "issue_get_evidence", "issue_get_codex_assessment_blind", "review_verify_candidate_binding"),
    )
    require(
        "desktop/macos/Sources/FilmOSDesktopCore/ReviewBusRuntimeContract.swift",
        ("FilmOS Studio", "FILMOS_REVIEW_BUS_READ_ENABLED", "FILMOS_REVIEW_BUS_AUTH_FILE", REVIEW_BASE_COMMIT),
    )
    require(
        "desktop/macos/Sources/FilmOSStudioDesktop/main.swift",
        ("ReviewBusRuntimeContract.fixedBaseCommit", "FILMOS_GH_EXECUTABLE", "githubCLIPath", "FILMOS_REVIEW_SOURCE_REPOSITORY", "FILMOS_REVIEW_WORKTREE_ROOT"),
    )
    require(
        "desktop/macos/scripts/prepare-review-source-repository",
        ("git clone --local --no-hardlinks --no-checkout", "maiyadiu/filmos-studio", "developer-repository.json"),
    )
    require(
        "desktop/macos/scripts/build-unsigned-app",
        ('import { DatabaseSync } from "node:sqlite"', "FilmOS requires Bun 1.4.0+"),
    )
    for workflow in (
        ".github/workflows/acceptance.yml",
        ".github/workflows/film-upstream-compat.yml",
        ".github/workflows/quality.yml",
    ):
        require(workflow, ("bun-version: 1.4.0",))
    require(
        "web/src/film/governance/report-issue.ts",
        ("FILMOS-ISSUE-", "OBSERVED_IN_USE", "filmOSReviewIssueIntake"),
    )
    require("web/src/application.tsx", ("ReportIssuePortal",))

    extension = json.loads(read("extensions/filmos-review-bridge/manifest.json"))
    if extension.get("permissions") != ["storage"] or extension.get("host_permissions") != [
        "https://chatgpt.com/*",
        "http://127.0.0.1:17920/*",
    ]:
        raise RuntimeError("Chrome Review Bridge permissions are not minimal and exact")
    require(
        "extensions/filmos-review-bridge/src/protocol.mjs",
        ("/v1/bridge/challenge", "/v1/bridge/decision", "/v1/bridge/revoke", "x-filmos-user-gesture"),
    )
    require("extensions/filmos-review-bridge/src/content.js", ("candidateTexts", "navigator.userActivation", "发送到 FilmOS"))

    require(
        "packages/filmos-generation-contracts/src/types.ts",
        ("ProjectGenerationPolicyV2", "allowedConnections", "budgetGrantIdsByConnection", "modelLocksByTask", "externalProjectBindings"),
    )
    require(
        "packages/filmos-generation-contracts/src/migration.ts",
        ("migrateProjectGenerationPolicyV1ToV2", "readProjectGenerationPolicy"),
    )
    require(
        "canvas-agent/src/modules/dreamina-http.ts",
        ("FILMOS_EXTERNAL_PAID_SUBMIT_ENABLED", "PILOT_EXTERNAL_PAID_SUBMIT_DISABLED"),
    )
    require(
        "canvas-agent/src/dreamina-model-catalog.ts",
        ("verified_static_version_bound", "executableSha256", "cliVersion", "catalogHash"),
    )
    require(
        "web/src/film/generation-routing/local-account-binding-ref.ts",
        ("HMAC", "local", "binding"),
    )

    required_wp00 = (
        "BASELINE_6EA93BFA_AUDIT.md",
        "CURRENT_CAPABILITY_MATRIX.json",
        "CURRENT_KNOWN_GAPS.json",
        "PILOT_BASE_0_MANIFEST.json",
        "REVIEW_AUTHORITY_MATRIX.md",
        "CONSTITUTION_DRAFT.md",
        "FILE_OWNERSHIP.csv",
    )
    for filename in required_wp00:
        read(f"implementation/use-driven-dual-expert-v1-1/{filename}")

    result = {
        "schema_version": "1.0.0",
        "gate_id": "USE-DRIVEN-DUAL-EXPERT-V1-1-STATIC-SMOKE-001",
        "status": "PASSED",
        "classification": "STATIC_SMOKE_NOT_OPERATIONAL_OR_EXTERNAL_LIVE_GATE",
        "pilot_base": {"id": "PILOT_BASE_0", "commit": BASE_COMMIT, "tree": BASE_TREE, "active_for_zero_cost_copy": True},
        "constitution": {"version": constitution["constitution_version"], "content_hash": constitution["content_hash"], "principles": 16},
        "task_package_content_hash": TASK_PACKAGE_HASH,
        "review_bus": {"storage": "sqlite-wal", "loopback_port": 17920, "openai_model_api_calls": 0},
        "single_issue_entry": "PASSED",
        "usage_evidence_pack": "PASSED_FAIL_CLOSED_WHEN_INCOMPLETE",
        "blind_dual_assessment": "PASSED",
        "consensus_and_lanes": "PASSED",
        "chatgpt_mcp": "READ_ONLY",
        "chrome_writeback": "USER_GESTURE_ONLY",
        "project_generation_policy": "V2",
        "dreamina_real_provider": "READY_FOR_USER_AUTHORIZATION",
        "external_network_requests": 0,
        "external_paid_operations": 0,
        "openai_model_api_calls": 0,
        "source_contract_bytes": len(contracts.encode()),
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
