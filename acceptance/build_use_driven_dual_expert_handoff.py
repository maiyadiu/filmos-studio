#!/usr/bin/env python3
"""Build the V1.1 use-driven dual-expert fixed-candidate handoff ZIP."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from build_brain_generation_handoff import (
    bound_gate,
    load_json,
    privacy_scan,
    result_index,
    sha256_file,
    verify_receipt,
    verify_release,
    write_json,
)


ROOT = Path(__file__).resolve().parents[1]
BASE_COMMIT = "6ea93bfa08381264a1379fe938ade3a7513c7bba"
BASE_TREE = "51896f7874e21cc9868cb1bfa33b302cd323a925"
REQUIRED_FILES = (
    "FINAL_COMMIT.json",
    "BASELINE_DIAGNOSIS.json",
    "FILMOS_CONSTITUTION.json",
    "CURRENT_CAPABILITY_MATRIX.json",
    "CURRENT_KNOWN_GAPS.json",
    "ISSUE_EVIDENCE_GATE.json",
    "CODEX_LOCAL_ASSESSMENT_GATE.json",
    "CHATGPT_EXTERNAL_ASSESSMENT_GATE.json",
    "CONSENSUS_ROUNDTRIP_GATE.json",
    "FAST_CORE_EVOLUTION_GATE.json",
    "REVIEW_BUS_GATE.json",
    "CHROME_ONE_CLICK_GATE.json",
    "REVIEW_COVERAGE_MATRIX_GATE.json",
    "PILOT_RELEASE_GATE.json",
    "DREAMINA_REAL_PROVIDER_READINESS.json",
    "PROJECT_POLICY_V2_GATE.json",
    "MIGRATION_REPORT.json",
    "ROLLBACK_REPORT.json",
    "KNOWN_LIMITATIONS.md",
    "FILE_SHA256SUMS.txt",
)


def integration_artifact(receipt_path: Path, results: dict[str, dict[str, Any]]) -> dict[str, Any]:
    result = results.get("use-driven-dual-expert")
    if not result or result.get("status") != "PASSED" or not result.get("artifact"):
        raise RuntimeError("passing use-driven-dual-expert artifact is required")
    path = receipt_path.parent / str(result["artifact"]["path"])
    if sha256_file(path) != result["artifact"]["sha256"]:
        raise RuntimeError("use-driven dual-expert artifact hash mismatch")
    artifact = load_json(path)
    if artifact.get("gate_id") != "USE-DRIVEN-DUAL-EXPERT-V1-1-001" or artifact.get("status") != "PASSED":
        raise RuntimeError("V1.1 integration artifact did not pass")
    if artifact.get("external_network_requests") != 0 or artifact.get("external_paid_operations") != 0 or artifact.get("openai_model_api_calls") != 0:
        raise RuntimeError("V1.1 handoff requires zero external traffic, spend, and OpenAI model API calls")
    return artifact


def gate(
    golden_id: str,
    release: dict[str, Any],
    receipt: dict[str, Any],
    results: dict[str, dict[str, Any]],
    checks: tuple[str, ...],
    sources: tuple[str, ...],
    **details: object,
) -> dict[str, Any]:
    return bound_gate(golden_id, release, receipt, results, checks, sources, **details)


def copy_evidence(receipt_path: Path, receipt: dict[str, Any], destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copy2(receipt_path, destination / "receipt.json")
    selected = {
        "architecture-drift-gate", "review-bus-governance", "review-cli-watcher",
        "review-bridge-contract", "pilot-project-copy", "use-driven-dual-expert",
        "generation-routing-contracts", "canvas-agent", "chatgpt-handoff-local",
        "desktop-release-build", "web-typecheck", "web-production-build",
        "evidence-index-contract", "acceptance-privacy", "rc-recovery",
    }
    for result in receipt.get("results", []):
        if result.get("check_id") not in selected:
            continue
        check_id = str(result["check_id"])
        shutil.copy2(receipt_path.parent / str(result["log"]), destination / f"{check_id}.log")
        artifact = result.get("artifact")
        if artifact:
            shutil.copy2(receipt_path.parent / str(artifact["path"]), destination / f"{check_id}-artifact.json")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--release-manifest", required=True, type=Path)
    parser.add_argument("--artifact-root", required=True, type=Path)
    args = parser.parse_args()

    receipt_path = args.receipt.resolve()
    release_path = args.release_manifest.resolve()
    receipt = verify_receipt(receipt_path)
    release = load_json(release_path)
    verify_release(release, receipt)
    results = result_index(receipt)
    artifact = integration_artifact(receipt_path, results)
    commit = str(release["git_commit_sha"])
    tree = str(release["git_tree_sha"])
    short_sha = commit[:8]
    output_root = args.artifact_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    zip_path = output_root / f"FilmOS_Use_Driven_Dual_Expert_Governance_Handoff_{short_sha}.zip"
    if zip_path.exists():
        raise RuntimeError(f"refusing to replace existing handoff: {zip_path.name}")

    binding = {
        "repository": release["repository"],
        "git_commit_sha": commit,
        "git_tree_sha": tree,
        "github_build_id": release["build_id"],
        "acceptance_receipt_sha256": receipt["receipt_sha256"],
        "release_manifest_sha256": sha256_file(release_path),
    }
    implementation = ROOT / "implementation" / "use-driven-dual-expert-v1-1"
    with tempfile.TemporaryDirectory(prefix="filmos-dual-expert-") as temporary:
        package = Path(temporary) / f"FilmOS_Use_Driven_Dual_Expert_Governance_Handoff_{short_sha}"
        package.mkdir()
        write_json(package / "FINAL_COMMIT.json", {
            "schema_version": "1.0.0", **binding,
            "integration_base": BASE_COMMIT, "integration_base_tree": BASE_TREE,
            "notice": "Convenience Copy Only; Formal Truth = Commit + GitHub Run + Artifact",
        })
        shutil.copy2(release_path, package / "RELEASE_MANIFEST.json")
        write_json(package / "BASELINE_DIAGNOSIS.json", {
            "schema_version": "1.0.0", "status": "PASSED", "binding": binding,
            "pilot_base_id": "PILOT_BASE_0", "base_commit": BASE_COMMIT, "base_tree": BASE_TREE,
            "classification": "zero-cost real-project-copy Pilot; not Stable; not RC1",
            "baseline_audit": "implementation/use-driven-dual-expert-v1-1/BASELINE_6EA93BFA_AUDIT.md",
        })
        shutil.copy2(ROOT / "governance" / "FILMOS_CONSTITUTION.json", package / "FILMOS_CONSTITUTION.json")
        shutil.copy2(implementation / "CURRENT_CAPABILITY_MATRIX.json", package / "CURRENT_CAPABILITY_MATRIX.json")
        shutil.copy2(implementation / "CURRENT_KNOWN_GAPS.json", package / "CURRENT_KNOWN_GAPS.json")

        write_json(package / "ISSUE_EVIDENCE_GATE.json", gate(
            "USAGE-EVIDENCE-PACK-001", release, receipt, results,
            ("review-bus-governance", "use-driven-dual-expert"),
            ("web/src/film/governance/report-issue.ts", "services/filmos-review-bus/src/server.mjs"),
            single_entry=True, evidence_manifest_frozen=True,
            insufficient_evidence_state="EVIDENCE_REQUIRED", local_full_pack=True, redacted_external_projection=True,
        ))
        write_json(package / "CODEX_LOCAL_ASSESSMENT_GATE.json", gate(
            "CODEX-LOCAL-ASSESSMENT-001", release, receipt, results,
            ("review-bus-governance", "review-cli-watcher"),
            ("cli/filmos-review", "services/filmos-review-bus/src/service.mjs"),
            watcher=True, candidate_submitted_by="codex", self_external_approval=False,
        ))
        write_json(package / "CHATGPT_EXTERNAL_ASSESSMENT_GATE.json", gate(
            "CHATGPT-EXTERNAL-ASSESSMENT-001", release, receipt, results,
            ("chatgpt-handoff-local", "review-bus-governance", "use-driven-dual-expert"),
            ("services/filmos-chatgpt-app/src/review-mcp.ts", "services/filmos-chatgpt-app/src/review-source.ts"),
            tool_mode="read_only", tool_count=12, first_assessment_blind=True, openai_model_api_calls=0,
        ))
        write_json(package / "CONSENSUS_ROUNDTRIP_GATE.json", gate(
            "CONSENSUS-ROUNDTRIP-001", release, receipt, results,
            ("review-bus-governance", "review-cli-watcher"),
            ("services/filmos-review-bus/src/service.mjs", "services/filmos-review-bus/src/contracts.mjs"),
            sealed_until_pair_complete=True, consensus_delta=True, consensus_record_dual_acceptance=True,
            maximum_automatic_rounds=2, third_round_p0="OWNER_DECISION_REQUIRED",
        ))
        write_json(package / "FAST_CORE_EVOLUTION_GATE.json", gate(
            "FAST-CORE-EVOLUTION-LANES-001", release, receipt, results,
            ("architecture-drift-gate", "review-bus-governance"),
            ("governance/architecture-drift-gate.mjs", "services/filmos-review-bus/src/contracts.mjs"),
            lanes=["fast", "core", "architecture"], fast_sensitive_scope_denied=True,
            core_requires_consensus=True, architecture_options=["A", "B", "C"],
        ))
        write_json(package / "REVIEW_BUS_GATE.json", gate(
            "REVIEW-STATE-MACHINE-001", release, receipt, results,
            ("review-bus-governance",),
            ("services/filmos-review-bus/src/store.mjs", "services/filmos-review-bus/src/service.mjs", "services/filmos-review-bus/src/server.mjs"),
            storage="sqlite-wal", event_authority="append_only", projection="mutable",
            loopback_only=True, replay_blocked=True, automatic_backup=True,
        ))
        write_json(package / "CHROME_ONE_CLICK_GATE.json", gate(
            "CHROME-USER-GESTURE-001", release, receipt, results,
            ("review-bridge-contract", "review-bus-governance"),
            ("extensions/filmos-review-bridge", "services/filmos-review-bus/src/server.mjs"),
            user_copy_paste_required=0, cookie_read=False, chatgpt_token_read=False,
            challenge_nonce=True, replay_blocked=True, revoke_and_repair=True,
        ))
        write_json(package / "REVIEW_COVERAGE_MATRIX_GATE.json", gate(
            "REVIEW-COVERAGE-MATRIX-001", release, receipt, results,
            ("use-driven-dual-expert", "evidence-index-contract", "acceptance-privacy", "rc-recovery"),
            ("acceptance/EVIDENCE_INDEX.json", "acceptance/checks/use_driven_dual_expert.py"),
            dimensions=["product_goal", "user_path", "call_chain", "data_authority", "state_authority", "permissions", "cost", "secret", "migration", "rollback", "restart", "concurrency", "idempotency", "provider_failure", "ui", "database", "remote_commit", "ci", "artifact", "evidence_freshness", "upstream_compatibility"],
            late_finding_taxonomy=["PREVIOUS_REVIEW_MISS", "REGRESSION_INTRODUCED_BY_FIX", "NEWLY_OBSERVABLE", "SCOPE_EXPANSION"],
        ))
        write_json(package / "PILOT_RELEASE_GATE.json", gate(
            "PILOT-RELEASE-V1-001", release, receipt, results,
            ("pilot-project-copy", "desktop-release-build", "use-driven-dual-expert"),
            ("desktop/macos/scripts/prepare-pilot-project-copy", "desktop/macos/scripts/backup-pilot-data", "desktop/macos/scripts/install-pilot-app"),
            base="PILOT_BASE_0", candidate_channel="pilot", project_mode="complete_project_copy",
            external_paid_submit_enabled=False, openai_model_api_calls=0,
        ))
        write_json(package / "DREAMINA_REAL_PROVIDER_READINESS.json", gate(
            "DREAMINA-REAL-PROVIDER-READINESS-001", release, receipt, results,
            ("canvas-agent", "generation-routing-contracts", "use-driven-dual-expert"),
            ("canvas-agent/src/modules/dreamina-http.ts", "canvas-agent/src/dreamina-cli.ts", "web/src/film/generation-routing/dreamina-production-execution-port.ts"),
            readiness=artifact["dreamina_real_provider"], cli_identity="dynamic_version_and_binary_hash",
            real_submit="NOT_EXECUTED_USER_AUTHORIZATION_REQUIRED", external_network_requests=0, external_paid_operations=0,
        ))
        write_json(package / "PROJECT_POLICY_V2_GATE.json", gate(
            "PROJECT-POLICY-V2-001", release, receipt, results,
            ("generation-routing-contracts", "use-driven-dual-expert"),
            ("packages/filmos-generation-contracts/src/types.ts", "packages/filmos-generation-contracts/src/policy.ts", "packages/filmos-generation-contracts/src/migration.ts"),
            allowed_connections="many", default_routes="per_task", budgets="per_connection",
            external_project_bindings="per_engine_connection", model_locks="per_task", v1_migration=True,
        ))
        write_json(package / "MIGRATION_REPORT.json", gate(
            "PROJECT-POLICY-V1-MIGRATION-001", release, receipt, results,
            ("generation-routing-contracts", "pilot-project-copy"),
            ("packages/filmos-generation-contracts/src/migration.ts", "desktop/macos/scripts/prepare-pilot-project-copy"),
            policy_v1_to_v2="single values mapped to one-element V2 collections",
            source_database_mutated=False, real_project_copy_only=True,
        ))
        write_json(package / "ROLLBACK_REPORT.json", gate(
            "PILOT-BACKUP-RESTORE-001", release, receipt, results,
            ("pilot-project-copy", "rc-recovery"),
            ("desktop/macos/scripts/backup-pilot-data", "desktop/macos/scripts/install-pilot-app", "packages/filmos-generation-contracts/src/migration.ts"),
            strategy="restore versioned Pilot project copy and previous fixed App; never down-migrate the only formal database",
            policy_v1_reader_retained=True,
        ))

        copy_evidence(receipt_path, receipt, package / "evidence")
        ui_override = os.environ.get("FILMOS_UI_GOLDEN_ROOT", "").strip()
        ui_source = (
            Path(ui_override).expanduser().resolve()
            if ui_override
            else ROOT / "acceptance" / "golden" / "use-driven-dual-expert" / "ui"
        )
        if not ui_source.is_dir():
            ui_source = ROOT / "acceptance" / "golden" / "brain-generation-routing" / "ui"
        if not ui_source.is_dir():
            raise RuntimeError("candidate App UI Golden evidence is missing")
        shutil.copytree(ui_source, package / "ui")
        shutil.copytree(ROOT / "extensions" / "filmos-review-bridge", package / "extension")
        shutil.copy2(ROOT / "acceptance" / "EVIDENCE_INDEX.json", package / "EVIDENCE_INDEX.json")
        shutil.copy2(ROOT / "acceptance" / "MANIFEST.json", package / "ACCEPTANCE_MANIFEST.json")
        (package / "KNOWN_LIMITATIONS.md").write_text(
            "# Known Limitations\n\n"
            "- Dreamina真实Provider已完成动态CLI身份、Catalog和执行端口准备，本轮未获授权执行真实付费生成。\n"
            "- ChatGPT审阅MCP保持只读；写回仍需用户在Chrome明确点击一次。\n"
            "- Pilot仅用真实项目完整副本，不直接迁移唯一正式数据库，不创建RC1 Tag。\n"
            "- 真实Provider的费用、账号权限和远端目录变化在用户授权前始终fail closed。\n",
            encoding="utf-8",
        )

        findings = privacy_scan(package)
        if findings:
            raise RuntimeError(f"handoff privacy scan failed: {findings}")
        sums = []
        for path in sorted(item for item in package.rglob("*") if item.is_file() and item.name != "FILE_SHA256SUMS.txt"):
            sums.append(f"{sha256_file(path)}  {path.relative_to(package).as_posix()}")
        (package / "FILE_SHA256SUMS.txt").write_text("\n".join(sums) + "\n", encoding="utf-8")
        missing = [name for name in REQUIRED_FILES if not (package / name).is_file()]
        if missing or not all((package / name).is_dir() for name in ("ui", "evidence", "extension")):
            raise RuntimeError(f"handoff package incomplete: {missing}")
        with zipfile.ZipFile(zip_path, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(item for item in package.rglob("*") if item.is_file()):
                archive.write(path, arcname=f"{package.name}/{path.relative_to(package).as_posix()}")

    print(json.dumps({
        "status": "PASSED", "zip": str(zip_path), "zip_sha256": sha256_file(zip_path),
        "git_commit_sha": commit, "git_tree_sha": tree,
    }, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
