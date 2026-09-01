#!/usr/bin/env python3
"""Build the final V1.1 operational closure handoff from a real external Live Trace."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from build_brain_generation_handoff import (
    load_json,
    privacy_scan,
    result_index,
    sha256_file,
    verify_receipt,
    verify_release,
    write_json,
)


ROOT = Path(__file__).resolve().parents[1]
BASE_COMMIT = "ecfc79a9b9f7e91cdfd558747fdc5d2b62e1700a"
REPOSITORY = "maiyadiu/filmos-studio"
REQUIRED_FILES = (
    "FINAL_COMMIT.json",
    "EXTERNAL_AUDIT_RESOLUTION.json",
    "CANDIDATE_A_B_ROUNDTRIP_GATE.json",
    "CHATGPT_FINDINGS_WRITEBACK_GATE.json",
    "CONSENSUS_OPERATIONAL_GATE.json",
    "CODEX_SUBSCRIPTION_COORDINATOR_GATE.json",
    "REVIEW_CENTER_GATE.json",
    "USAGE_EVIDENCE_COMPLETE_GATE.json",
    "ISSUE_TASK_PACKAGE_GATE.json",
    "CHROME_PAIRING_GATE.json",
    "GITHUB_REMOTE_VERIFY_GATE.json",
    "V1_1_DUAL_EXPERT_LIVE_ROUNDTRIP_TRACE.json",
    "UI_GOLDEN_FRESHNESS.json",
    "KNOWN_GAPS_CONSISTENCY_GATE.json",
    "DREAMINA_REAL_PROVIDER_READINESS.json",
    "KNOWN_LIMITATIONS.md",
    "FILE_SHA256SUMS.txt",
)
REQUIRED_UI_SURFACES = {
    "report_issue_entry",
    "report_paste_attachment",
    "issue_detail",
    "evidence_completeness",
    "codex_assessment_status",
    "chatgpt_assessment_status",
    "consensus_delta",
    "consensus_proposal",
    "findings",
    "candidate_history",
    "chrome_pairing_code",
    "chrome_send_ack",
    "owner_decision",
    "architecture_options",
    "dual_signoff",
    "pilot_gate",
    "document_readable",
    "document_markdown",
}


def canonical_hash(value: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def require_result(results: dict[str, dict[str, Any]], check_id: str) -> dict[str, Any]:
    value = results.get(check_id)
    if not value or value.get("status") != "PASSED":
        raise RuntimeError(f"passing {check_id} result is required")
    return value


def verify_live_trace(path: Path, final_commit: str) -> dict[str, Any]:
    trace = load_json(path)
    payload = dict(trace)
    claimed = payload.pop("content_hash", None)
    if claimed != canonical_hash(payload):
        raise RuntimeError("Live Trace content hash mismatch")
    requirements = {
        "gate_id": "V1-1-DUAL-EXPERT-LIVE-ROUNDTRIP-001",
        "status": "PASSED",
        "candidate_rounds": 2,
        "codex_signoff": "LOCAL_ACCEPTED",
        "chatgpt_signoff": "EXTERNAL_APPROVED",
        "machine_verdict": "PASS",
        "open_p0": 0,
        "formal_github_remote_evidence": True,
        "openai_model_api_calls": 0,
        "real_provider_operations": 0,
        "real_provider_cost": 0,
    }
    for key, expected in requirements.items():
        if trace.get(key) != expected:
            raise RuntimeError(f"Live Trace requirement failed: {key}")
    if trace.get("candidate_a", {}).get("status") != "SUPERSEDED":
        raise RuntimeError("Candidate A must be superseded")
    if trace.get("candidate_b", {}).get("status") != "APPROVED" or trace.get("candidate_b", {}).get("commit") != final_commit:
        raise RuntimeError("Candidate B must be the approved final commit")
    if trace.get("restart_recovery_count", 0) < 1 or trace.get("event_chain_verified") is not True:
        raise RuntimeError("restart and event-chain evidence are required")
    writebacks = trace.get("chatgpt_user_gesture_writebacks", {})
    if writebacks != {"exact_count": 4, "assessment": 1, "consensus": 1, "candidate_reviews": 2}:
        raise RuntimeError("exact four-step ChatGPT user-gesture writeback trace is required")
    for label in ("candidate_a", "candidate_b"):
        candidate = trace.get(label, {})
        for key in ("commit", "tree", "github_run_id", "artifact_id", "artifact_digest", "evidence_index_hash", "github_verification_receipt_hash"):
            if not candidate.get(key):
                raise RuntimeError(f"{label} is missing {key}")
    return trace


def gate(gate_id: str, binding: dict[str, Any], sources: list[str], **details: Any) -> dict[str, Any]:
    value = {"schema_version": "1.0.0", "gate_id": gate_id, "status": "PASSED", "binding": binding, "sources": sources, **details}
    return {**value, "content_hash": canonical_hash(value)}


def copy_evidence(receipt_path: Path, receipt: dict[str, Any], destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copy2(receipt_path, destination / "receipt.json")
    selected = {
        "review-bus-governance", "review-cli-watcher", "review-bridge-contract",
        "use-driven-dual-expert", "dual-expert-operational", "desktop-release-build",
        "web-typecheck", "web-production-build", "evidence-index-contract",
        "acceptance-privacy", "rc-recovery",
    }
    for result in receipt.get("results", []):
        if result.get("check_id") not in selected:
            continue
        check_id = str(result["check_id"])
        shutil.copy2(receipt_path.parent / str(result["log"]), destination / f"{check_id}.log")
        artifact = result.get("artifact")
        if artifact:
            shutil.copy2(receipt_path.parent / str(artifact["path"]), destination / f"{check_id}-artifact.json")


def verify_ui_golden(ui_root: Path, freshness_path: Path, release: dict[str, Any]) -> dict[str, Any]:
    if not ui_root.is_dir() or not freshness_path.is_file():
        raise RuntimeError("fresh packaged-App UI Golden evidence is required")
    value = load_json(freshness_path)
    if value.get("status") != "PASSED" or value.get("ui_source_fingerprint") != value.get("packaged_app_source_fingerprint"):
        raise RuntimeError("UI Golden freshness did not bind the packaged App to source")
    for key in ("git_commit_sha", "git_tree_sha", "build_id"):
        if value.get(key) != release.get(key):
            raise RuntimeError(f"UI Golden release binding mismatch: {key}")
    environment = value.get("capture_environment")
    if not isinstance(environment, dict) or environment.get("packaged_app") != "FilmOS Studio.app" or environment.get("network") != "loopback-only":
        raise RuntimeError("UI Golden packaged-App capture environment is incomplete")
    if environment.get("external_network_requests") != 0 or environment.get("openai_model_api_calls") != 0 or environment.get("paid_provider_operations") != 0:
        raise RuntimeError("UI Golden capture crossed the zero-cost boundary")
    captures = value.get("captures")
    if not isinstance(captures, list):
        raise RuntimeError("UI Golden capture manifest is required")
    surfaces = {capture.get("surface") for capture in captures if isinstance(capture, dict)}
    missing = sorted(REQUIRED_UI_SURFACES - surfaces)
    if missing:
        raise RuntimeError(f"UI Golden surfaces are missing: {missing}")
    for capture in captures:
        if not isinstance(capture, dict):
            raise RuntimeError("UI Golden capture entry must be an object")
        image = capture.get("image")
        if not isinstance(image, str) or Path(image).is_absolute() or ".." in Path(image).parts:
            raise RuntimeError("UI Golden image path must be package-relative")
        image_path = (ui_root / image).resolve()
        if ui_root.resolve() not in image_path.parents or not image_path.is_file() or image_path.stat().st_size < 1024:
            raise RuntimeError(f"UI Golden image is missing or empty: {image}")
        expected = {
            "git_commit_sha": release["git_commit_sha"],
            "git_tree_sha": release["git_tree_sha"],
            "build_id": release["build_id"],
            "image_sha256": sha256_file(image_path),
        }
        for key, expected_value in expected.items():
            if capture.get(key) != expected_value:
                raise RuntimeError(f"UI Golden binding mismatch for {capture.get('surface')}: {key}")
        if not capture.get("route") or not capture.get("fixture") or not isinstance(capture.get("feature_flags"), dict):
            raise RuntimeError(f"UI Golden context binding is incomplete: {capture.get('surface')}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--release-manifest", required=True, type=Path)
    parser.add_argument("--artifact-root", required=True, type=Path)
    parser.add_argument("--live-trace", required=True, type=Path)
    parser.add_argument("--ui-root", required=True, type=Path)
    parser.add_argument("--ui-freshness", required=True, type=Path)
    args = parser.parse_args()

    receipt_path = args.receipt.resolve()
    release_path = args.release_manifest.resolve()
    receipt = verify_receipt(receipt_path)
    release = load_json(release_path)
    verify_release(release, receipt)
    if release.get("repository") != REPOSITORY:
        raise RuntimeError("formal handoff repository mismatch")
    results = result_index(receipt)
    for check_id in (
        "review-bus-governance", "review-cli-watcher", "review-bridge-contract",
        "use-driven-dual-expert", "dual-expert-operational", "desktop-release-build",
        "web-typecheck", "web-production-build", "evidence-index-contract", "acceptance-privacy",
    ):
        require_result(results, check_id)

    commit = str(release["git_commit_sha"])
    tree = str(release["git_tree_sha"])
    trace = verify_live_trace(args.live_trace.resolve(), commit)
    output_root = args.artifact_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    if list(output_root.glob("FilmOS_V1_1_Dual_Expert_Operational_Closure_Handoff_*.zip")):
        raise RuntimeError("formal artifact root already contains a V1.1 handoff ZIP")
    zip_path = output_root / f"FilmOS_V1_1_Dual_Expert_Operational_Closure_Handoff_{commit[:8]}.zip"
    binding = {
        "repository": REPOSITORY,
        "git_commit_sha": commit,
        "git_tree_sha": tree,
        "github_build_id": release["build_id"],
        "acceptance_receipt_sha256": receipt["receipt_sha256"],
        "release_manifest_sha256": sha256_file(release_path),
        "live_trace_sha256": sha256_file(args.live_trace.resolve()),
        "live_trace_content_hash": trace["content_hash"],
    }

    with tempfile.TemporaryDirectory(prefix="filmos-v1-1-operational-handoff-") as temporary:
        package = Path(temporary) / zip_path.stem
        package.mkdir()
        write_json(package / "FINAL_COMMIT.json", {
            "schema_version": "1.0.0", **binding,
            "fixed_base_commit": BASE_COMMIT, "rc1_tag_created": False,
            "notice": "Formal truth is this fixed commit, GitHub Run, Artifact, and Live Trace.",
        })
        shutil.copy2(release_path, package / "RELEASE_MANIFEST.json")
        shutil.copy2(args.live_trace.resolve(), package / "V1_1_DUAL_EXPERT_LIVE_ROUNDTRIP_TRACE.json")
        shutil.copy2(ROOT / "acceptance" / "EVIDENCE_INDEX.json", package / "EVIDENCE_INDEX.json")
        shutil.copy2(ROOT / "acceptance" / "MANIFEST.json", package / "ACCEPTANCE_MANIFEST.json")

        write_json(package / "EXTERNAL_AUDIT_RESOLUTION.json", gate(
            "V1-1-EXTERNAL-AUDIT-RESOLUTION-001", binding,
            ["implementation/v1-1-operational-closure/EXTERNAL_AUDIT_FINDINGS.md"],
            candidate_multi_round="CLOSED", chatgpt_findings_writeback="CLOSED",
            consensus_orchestration="CLOSED", codex_subscription_coordination="CLOSED",
            review_center="CLOSED", evidence_pack="CLOSED", issue_task_package="CLOSED",
            chrome_pairing="CLOSED", live_roundtrip="CLOSED", open_p0=0,
        ))
        write_json(package / "CANDIDATE_A_B_ROUNDTRIP_GATE.json", gate(
            "CANDIDATE-A-B-ROUNDTRIP-001", binding,
            ["services/filmos-review-bus/src/service.mjs", "services/filmos-review-bus/src/live-roundtrip-trace.mjs"],
            candidate_a=trace["candidate_a"], candidate_b=trace["candidate_b"], rounds=2,
            restart_recovery_count=trace["restart_recovery_count"], event_chain_verified=True,
        ))
        write_json(package / "CHATGPT_FINDINGS_WRITEBACK_GATE.json", gate(
            "CHATGPT-FINDINGS-WRITEBACK-001", binding,
            ["extensions/filmos-review-bridge", "services/filmos-review-bus/src/server.mjs"],
            exact_user_gesture_writebacks=trace["chatgpt_user_gesture_writebacks"],
            candidate_a_verdict="CHANGES_REQUIRED", candidate_b_verdict="EXTERNAL_APPROVED", open_p0=0,
        ))
        write_json(package / "CONSENSUS_OPERATIONAL_GATE.json", gate(
            "CONSENSUS-OPERATIONAL-001", binding, ["services/filmos-review-bus/src/service.mjs"],
            consensus_record_hash=trace["consensus_record_hash"], codex_accepted=True, chatgpt_accepted=True,
        ))
        write_json(package / "CODEX_SUBSCRIPTION_COORDINATOR_GATE.json", gate(
            "CODEX-SUBSCRIPTION-COORDINATOR-001", binding,
            ["canvas-agent/src/brains/review-codex-coordinator.ts", "canvas-agent/src/brains/generic-agent-runtime.ts"],
            coordination=trace["codex_coordination"], model_api_calls=0, project_and_global_issue_discovery=True,
        ))
        write_json(package / "REVIEW_CENTER_GATE.json", gate(
            "REVIEW-CENTER-001", binding, ["web/src/pages/admin/review-center/review-center-page.tsx"],
            issues=True, evidence=True, assessments=True, consensus=True, findings=True,
            candidate_history=True, ci_artifact=True, pairing_management=True,
        ))
        write_json(package / "USAGE_EVIDENCE_COMPLETE_GATE.json", gate(
            "USAGE-EVIDENCE-COMPLETE-001", binding,
            ["web/src/film/governance/report-issue.ts", "services/filmos-review-bus/src/store.mjs"],
            manifest_hash=trace["evidence_manifest_hash"], attachments=trace["attachment_hashes"],
            pasted_screenshot_bytes_durable=True, redacted_external_projection=True,
        ))
        write_json(package / "ISSUE_TASK_PACKAGE_GATE.json", gate(
            "ISSUE-TASK-PACKAGE-001", binding, ["services/filmos-review-bus/src/service.mjs", "cli/filmos-review/filmos"],
            task_package_hash=trace["issue_task_package_hash"], issue_scoped=True, immutable=True,
        ))
        write_json(package / "CHROME_PAIRING_GATE.json", gate(
            "CHROME-PAIRING-001", binding, ["extensions/filmos-review-bridge", "services/filmos-review-bus/src/store.mjs"],
            one_time_six_digit_code=True, raw_long_token_paste=False, session_token_hash_only=True,
            revoke_supported=True, restart_persistent=True,
        ))
        write_json(package / "GITHUB_REMOTE_VERIFY_GATE.json", gate(
            "GITHUB-REMOTE-VERIFY-001", binding, ["services/filmos-review-bus/src/github-evidence-verifier.mjs"],
            repository=REPOSITORY, candidate_a=trace["candidate_a"], candidate_b=trace["candidate_b"],
            independent_commit_tree_run_artifact_and_evidence_index_verification=True,
        ))
        write_json(package / "KNOWN_GAPS_CONSISTENCY_GATE.json", gate(
            "KNOWN-GAPS-CONSISTENCY-001", binding,
            ["implementation/v1-1-operational-closure/EXTERNAL_AUDIT_FINDINGS.md"],
            open_p0=0, unresolved_delivery_blockers=[], rc1=False, paid_generation="NOT_EXECUTED_NOT_AUTHORIZED",
        ))
        write_json(package / "DREAMINA_REAL_PROVIDER_READINESS.json", gate(
            "DREAMINA-REAL-PROVIDER-READINESS-001", binding,
            ["canvas-agent/src/modules/dreamina-http.ts", "canvas-agent/src/dreamina-cli.ts"],
            readiness="READY_FOR_USER_AUTHORIZATION", real_submit="NOT_EXECUTED", real_provider_operations=0, real_provider_cost=0,
        ))

        ui_root = args.ui_root.resolve()
        freshness = args.ui_freshness.resolve()
        verify_ui_golden(ui_root, freshness, release)
        shutil.copytree(ui_root, package / "ui")
        shutil.copy2(freshness, package / "UI_GOLDEN_FRESHNESS.json")
        copy_evidence(receipt_path, receipt, package / "evidence")
        shutil.copytree(ROOT / "extensions" / "filmos-review-bridge", package / "extension", ignore=shutil.ignore_patterns("test", "node_modules", ".DS_Store"))

        (package / "KNOWN_LIMITATIONS.md").write_text(
            "# Known Limitations\n\n"
            "- 本轮未获授权执行任何真实图片、视频或外部Provider付费生成。\n"
            "- ChatGPT Findings写回坚持用户明确点击；本次Live Trace记录的固定手势次数为4。\n"
            "- 本交付未创建或移动RC1 Tag，也未修改main。\n",
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
                archive.write(path, path.relative_to(package.parent).as_posix())

    result = {"path": str(zip_path), "sha256": sha256_file(zip_path), "bytes": zip_path.stat().st_size, "commit": commit, "live_trace_content_hash": trace["content_hash"]}
    write_json(output_root / "V1_1_HANDOFF_RESULT.json", result)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
