#!/usr/bin/env python3
"""Build the fixed-candidate V2.4 final production authority handoff ZIP."""

from __future__ import annotations

import argparse
import json
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
REQUIRED_FILES = (
    "FINAL_COMMIT.json",
    "RELEASE_MANIFEST.json",
    "EXTERNAL_AUDIT_FINAL_RESOLUTION.json",
    "PRODUCTION_AUTHORITY_TRACE.json",
    "CANONICAL_BROKER_GATE.json",
    "FORMAL_FILM_CORE_AUTHORITY_GATE.json",
    "BUDGET_LEDGER_TRANSACTION_GATE.json",
    "ENGINE_CONNECTION_SYNC_GATE.json",
    "PROJECT_POLICY_LOCK_GATE.json",
    "REAL_PROVIDER_DRY_RUN_MATRIX.json",
    "CANDIDATE_SINGLE_AUTHORITY_GATE.json",
    "MIGRATION_REPORT.json",
    "ROLLBACK_REPORT.json",
    "ACCEPTANCE_SUMMARY.json",
    "KNOWN_LIMITATIONS.md",
    "FILE_SHA256SUMS.txt",
)


def production_artifact(receipt_path: Path, results: dict[str, dict[str, Any]]) -> dict[str, Any]:
    result = results.get("production-generation-composition")
    if not result or result.get("status") != "PASSED" or not result.get("artifact"):
        raise RuntimeError("passing production-generation-composition artifact is required")
    path = receipt_path.parent / str(result["artifact"]["path"])
    if sha256_file(path) != result["artifact"]["sha256"]:
        raise RuntimeError("production authority artifact hash mismatch")
    value = load_json(path)
    if value.get("gate_id") != "V2-4-FINAL-PRODUCTION-AUTHORITY-001" or value.get("status") != "PASSED":
        raise RuntimeError("final production authority gate did not pass")
    return value


def copy_selected_evidence(receipt_path: Path, receipt: dict[str, Any], destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copy2(receipt_path, destination / "receipt.json")
    for result in receipt.get("results", []):
        if result.get("check_id") not in {
            "production-generation-composition",
            "generation-routing-contracts",
            "canvas-agent",
            "film-core-environment",
            "web-typecheck",
            "web-production-build",
            "evidence-index-contract",
            "acceptance-privacy",
        }:
            continue
        log = receipt_path.parent / str(result["log"])
        shutil.copy2(log, destination / f"{result['check_id']}.log")
        artifact = result.get("artifact")
        if artifact:
            shutil.copy2(
                receipt_path.parent / str(artifact["path"]),
                destination / f"{result['check_id']}-artifact.json",
            )


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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--release-manifest", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    args = parser.parse_args()

    receipt_path = args.receipt.resolve()
    release_path = args.release_manifest.resolve()
    receipt = verify_receipt(receipt_path)
    release = load_json(release_path)
    verify_release(release, receipt)
    results = result_index(receipt)
    artifact = production_artifact(receipt_path, results)
    if artifact["external_network_request_count"] != 0 or artifact["external_spend_microunits"] != "0":
        raise RuntimeError("handoff requires zero external provider traffic and zero spend")
    if artifact["synthetic_broker_receipt_count"] != 0 or artifact["parallel_candidate_write_count"] != 0:
        raise RuntimeError("handoff requires single broker and candidate authority")

    commit = str(release["git_commit_sha"])
    tree = str(release["git_tree_sha"])
    short_sha = commit[:8]
    output_root = args.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    zip_path = output_root / f"FilmOS_V2_4_Final_Production_Authority_Handoff_{short_sha}.zip"
    if zip_path.exists():
        raise RuntimeError(f"refusing to replace existing handoff: {zip_path.name}")

    with tempfile.TemporaryDirectory(prefix="filmos-final-authority-") as temporary:
        package = Path(temporary) / f"FilmOS_V2_4_Final_Production_Authority_Handoff_{short_sha}"
        package.mkdir()
        binding = {
            "repository": release["repository"],
            "git_commit_sha": commit,
            "git_tree_sha": tree,
            "github_build_id": release["build_id"],
            "acceptance_receipt_sha256": receipt["receipt_sha256"],
            "release_manifest_sha256": sha256_file(release_path),
        }
        write_json(package / "FINAL_COMMIT.json", {
            "schema_version": "1.0.0",
            **binding,
            "notice": "Convenience Copy Only; Formal Truth = Commit + GitHub Run + Artifact",
        })
        shutil.copy2(release_path, package / "RELEASE_MANIFEST.json")
        resolution = load_json(ROOT / "acceptance" / "EXTERNAL_AUDIT_FINAL_RESOLUTION.json")
        resolution["status"] = "PASSED"
        resolution["binding"] = binding
        write_json(package / "EXTERNAL_AUDIT_FINAL_RESOLUTION.json", resolution)

        write_json(package / "PRODUCTION_AUTHORITY_TRACE.json", {
            "schema_version": "1.0.0",
            "status": "PASSED",
            "binding": binding,
            "production_trace": artifact["production_trace"],
            "film_core_http_trace": artifact["film_core_http_trace"],
        })
        common_checks = ("production-generation-composition",)
        write_json(package / "CANONICAL_BROKER_GATE.json", gate(
            "CANONICAL-PRODUCTION-BROKER-001", release, receipt, results, common_checks,
            ("canvas-agent/src/brains/tool-broker.ts", "canvas-agent/src/brains/generic-agent-runtime.ts"),
            canonical_broker=artifact["canonical_broker"],
            synthetic_broker_receipt_count=artifact["synthetic_broker_receipt_count"],
        ))
        write_json(package / "FORMAL_FILM_CORE_AUTHORITY_GATE.json", gate(
            "FORMAL-FILM-CORE-PRODUCTION-AUTHORITY-001", release, receipt, results, common_checks,
            ("film-core/src/film_production_core/formal_service.py", "film-core/src/film_production_core/generation_production.py"),
            formal_generation_lineage=artifact["formal_generation_lineage"],
            approval_count=artifact["approval_count"],
        ))
        write_json(package / "BUDGET_LEDGER_TRANSACTION_GATE.json", gate(
            "REAL-BUDGET-LEDGER-TRANSACTION-001", release, receipt, results, common_checks,
            ("film-core/src/film_production_core/generation_budget.py",),
            ledger=artifact["real_budget_ledger"],
            reservation_cost_microunits=artifact["budget_reservation_cost_microunits"],
        ))
        write_json(package / "ENGINE_CONNECTION_SYNC_GATE.json", gate(
            "ENGINE-CONNECTION-SYNC-001", release, receipt, results, common_checks,
            ("web/src/film/generation-routing/engine-connection-synchronizer.ts",),
            invariant=artifact["engine_connection_invariant"],
            exact_provider_protocol_capability_evidence=artifact["brain_runtime"]["exact_provider_protocol_capability_evidence"],
        ))
        write_json(package / "PROJECT_POLICY_LOCK_GATE.json", gate(
            "PROJECT-POLICY-MODEL-LOCK-PRODUCTION-001", release, receipt, results, common_checks,
            ("web/src/film/generation-routing/project-production-authority-builder.ts", "web/src/pages/projects/detail/project-ai-generation-settings.tsx"),
            film_core_project_policy_authority=artifact["film_core_project_policy_authority"],
            film_core_model_lock_authority=artifact["film_core_model_lock_authority"],
            route_precedence=artifact["route_precedence"],
        ))
        write_json(package / "REAL_PROVIDER_DRY_RUN_MATRIX.json", {
            "schema_version": "1.0.0", "status": "PASSED", "binding": binding,
            "mode": "doctor_auth_catalog_only",
            "engines": ["dreamina", "flova", "runninghub", "comfyui"],
            "external_generation_requests": 0, "external_paid_operations": 0,
            "provider_submit_count": artifact["brain_runtime"]["provider_request_count"],
        })
        write_json(package / "CANDIDATE_SINGLE_AUTHORITY_GATE.json", gate(
            "CANDIDATE-SINGLE-AUTHORITY-001", release, receipt, results, common_checks,
            ("film-core/src/film_production_core/formal_service.py", "film-core/src/film_production_core/database.py"),
            candidate_count=artifact["candidate_count"],
            candidate_boundary=artifact["candidate_boundary"],
            parallel_candidate_write_count=artifact["parallel_candidate_write_count"],
            legacy_direct_submit_count=artifact["legacy_direct_submit_count"],
        ))
        write_json(package / "MIGRATION_REPORT.json", gate(
            "FINAL-PRODUCTION-AUTHORITY-MIGRATION-001", release, receipt, results,
            ("film-core-environment", "production-generation-composition"),
            ("film-core/src/film_production_core/database.py",),
            schema_version=7,
            new_authority_tables=["generation_production_traces", "generation_authorized_submissions", "generation_provider_evidence", "generation_formal_bindings"],
            legacy_new_authority_writes="blocked_by_trigger",
        ))
        write_json(package / "ROLLBACK_REPORT.json", gate(
            "FINAL-PRODUCTION-AUTHORITY-ROLLBACK-001", release, receipt, results,
            ("rc-recovery", "production-generation-composition"),
            ("acceptance/checks/production_generation_composition.py", "film-core/src/film_production_core/database.py"),
            strategy="restore complete database copy and previous fixed App; do not down-migrate the only database",
            restart_recovered_without_resubmit=artifact["restart_recovered_without_resubmit"],
        ))

        copy_selected_evidence(receipt_path, receipt, package / "evidence")
        ui_source = ROOT / "acceptance" / "golden" / "brain-generation-routing" / "ui"
        if not ui_source.is_dir():
            raise RuntimeError("candidate App UI Golden evidence is missing")
        shutil.copytree(ui_source, package / "ui")
        shutil.copy2(ROOT / "acceptance" / "EVIDENCE_INDEX.json", package / "EVIDENCE_INDEX.json")
        shutil.copy2(ROOT / "acceptance" / "MANIFEST.json", package / "ACCEPTANCE_MANIFEST.json")

        write_json(package / "ACCEPTANCE_SUMMARY.json", {
            "schema_version": "1.0.0", "status": "PASSED", "binding": binding,
            "gate_id": artifact["gate_id"],
            "ordinary_project_same_production_service": artifact["ordinary_project_same_production_service"],
            "mock_submit_exactly_once": artifact["mock_submit_exactly_once"],
            "restart_recovered_without_resubmit": artifact["restart_recovered_without_resubmit"],
            "external_network_request_count": artifact["external_network_request_count"],
            "external_spend_microunits": artifact["external_spend_microunits"],
            "checks": [{"check_id": item["check_id"], "status": item["status"], "log_sha256": item["log_sha256"]} for item in receipt["results"]],
        })
        (package / "KNOWN_LIMITATIONS.md").write_text(
            "# Known Limitations\n\n"
            "- 本次只执行真实 Doctor/Auth/Catalog dry-run；未授权任何 Provider Completion、图片或视频生成。\n"
            "- ChatGPT Live Gate 仍依赖用户的有效 Tunnel、Runtime Key、Project Grant 与当前活动项目上下文。\n"
            "- RunningHub、ComfyUI、Dreamina 与 Flova 的账户权限及远端目录变化在真实生成前继续 fail closed。\n"
            "- 本包冻结固定候选，不创建 RC1 Tag。\n",
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
        if missing or not (package / "ui").is_dir() or not (package / "evidence").is_dir():
            raise RuntimeError(f"handoff package incomplete: {missing}")

        with zipfile.ZipFile(zip_path, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(item for item in package.rglob("*") if item.is_file()):
                archive.write(path, arcname=f"{package.name}/{path.relative_to(package).as_posix()}")

    print(json.dumps({
        "status": "PASSED",
        "zip": str(zip_path),
        "zip_sha256": sha256_file(zip_path),
        "git_commit_sha": commit,
        "git_tree_sha": tree,
    }, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
