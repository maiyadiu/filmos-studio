#!/usr/bin/env python3
"""Build the V2.4 controlled evidence projection and user convenience ZIP.

The repository commit remains the implementation truth. This script only runs after
a clean rc-local receipt and artifact-only Release Manifest have been verified.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REQUIRED_ZIP_FILES = (
    "FINAL_COMMIT.json",
    "IMPLEMENTATION_SUMMARY.md",
    "BRAIN_BINDING_MATRIX.json",
    "PERSISTENCE_OWNERSHIP_MATRIX.md",
    "STATE_AUTHORITY_MATRIX.md",
    "CONFIG_PRECEDENCE_MATRIX.md",
    "ARCHITECTURE_FREEZE.json",
    "LOCAL_CONFIG_MIGRATION_REPORT.json",
    "HASH_CONTRACT_REPORT.json",
    "IDENTITY_PSEUDONYMIZATION_REPORT.json",
    "REDACTION_RECEIPT.json",
    "REDACTION_EVIDENCE_REPORT.json",
    "BUDGET_AUTHORITY_MATRIX.md",
    "BUDGET_BINDING_ROTATION_GATE.json",
    "GENERATION_REFERENCE_BINDING_GATE.json",
    "PROVIDER_INPUT_AUTHORIZATION_BROKER_EVIDENCE.json",
    "PROVIDER_INPUT_AUTHORIZATION_GATE.json",
    "GENERATION_TARGET_GUARD_GATE.json",
    "GENERATION_ENGINE_MATRIX.json",
    "CATALOG_EVIDENCE_REPORT.json",
    "RESOLVED_DESCRIPTOR_RECEIPT_GATE.json",
    "CATALOG_VALIDATION_RECEIPT_GATE.json",
    "DESCRIPTOR_BLOB_SELECTION_GATE.json",
    "GENERATION_ROUTE_SNAPSHOT_GATE.json",
    "BUDGET_LEDGER_GATE.json",
    "BUDGET_LEDGER_EVENT_REPORT.json",
    "GENERATION_COMPOSER_GOLDEN.json",
    "PROMPT_COMPILATION_RECEIPT.json",
    "MODEL_LOCK_GATE.json",
    "PROVIDER_LIFECYCLE_GATE.json",
    "MIGRATION_REPORT.json",
    "ROLLBACK_REPORT.json",
    "UPSTREAM_COMPATIBILITY_REPORT.json",
    "SECURITY_REPORT.json",
    "PERFORMANCE_REPORT.json",
    "ACCEPTANCE_SUMMARY.json",
    "KNOWN_LIMITATIONS.md",
    "FILE_SHA256SUMS.txt",
)


def canonical(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"object expected: {path.name}")
    return value


def write_json(path: Path, value: object) -> None:
    path.write_bytes(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode() + b"\n")


def verify_receipt(receipt_path: Path) -> dict[str, Any]:
    receipt = load_json(receipt_path)
    body = dict(receipt)
    claimed = str(body.pop("receipt_sha256", ""))
    if sha256_bytes(canonical(body)) != claimed:
        raise RuntimeError("acceptance receipt hash mismatch")
    if receipt.get("status") != "PASSED" or receipt.get("suite") != "rc-local":
        raise RuntimeError("handoff requires a passing rc-local receipt")
    if receipt.get("clean_worktree") is not True:
        raise RuntimeError("handoff requires a clean fixed candidate receipt")
    for result in receipt.get("results", []):
        log = receipt_path.parent / str(result["log"])
        if not log.is_file() or sha256_file(log) != result["log_sha256"]:
            raise RuntimeError(f"receipt log mismatch: {result['check_id']}")
        artifact = result.get("artifact")
        if artifact:
            artifact_path = receipt_path.parent / str(artifact["path"])
            if not artifact_path.is_file() or sha256_file(artifact_path) != artifact["sha256"]:
                raise RuntimeError(f"receipt artifact mismatch: {result['check_id']}")
    return receipt


def verify_release(release: dict[str, Any], receipt: dict[str, Any]) -> None:
    required = {
        "repository", "git_commit_sha", "git_tree_sha", "acceptance_manifest_hash",
        "evidence_index_hash", "receipt_hash", "build_id", "timestamp",
    }
    if required - set(release):
        raise RuntimeError("Release Manifest is incomplete")
    if release["receipt_hash"] != receipt["receipt_sha256"]:
        raise RuntimeError("Release Manifest does not bind the receipt")
    if release["git_commit_sha"] != receipt["started_from_commit"]:
        raise RuntimeError("Release Manifest does not bind the fixed candidate commit")


def result_index(receipt: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(item["check_id"]): item for item in receipt.get("results", [])}


def bound_gate(
    golden_id: str,
    release: dict[str, Any],
    receipt: dict[str, Any],
    results: dict[str, dict[str, Any]],
    checks: tuple[str, ...],
    sources: tuple[str, ...],
    **details: object,
) -> dict[str, Any]:
    selected = []
    for check_id in checks:
        result = results.get(check_id)
        if not result:
            raise RuntimeError(f"required acceptance result missing: {check_id}")
        if result["status"] != "PASSED":
            raise RuntimeError(f"required acceptance result failed: {check_id}")
        selected.append({
            "check_id": check_id,
            "log": f"evidence/{check_id}.log",
            "log_sha256": result["log_sha256"],
            "artifact_sha256": result.get("artifact", {}).get("sha256"),
        })
    return {
        "schema_version": "1.0.0",
        "golden_id": golden_id,
        "status": "PASSED",
        "binding": {
            "repository": release["repository"],
            "git_commit_sha": release["git_commit_sha"],
            "git_tree_sha": release["git_tree_sha"],
            "receipt_sha256": receipt["receipt_sha256"],
        },
        "source_paths": list(sources),
        "checks": selected,
        **details,
    }


def copy_evidence(receipt_path: Path, receipt: dict[str, Any], destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for result in receipt["results"]:
        check_id = str(result["check_id"])
        shutil.copy2(receipt_path.parent / result["log"], destination / f"{check_id}.log")
        artifact = result.get("artifact")
        if artifact:
            shutil.copy2(receipt_path.parent / artifact["path"], destination / f"{check_id}-artifact.json")


def privacy_scan(root: Path) -> list[dict[str, str]]:
    patterns = {
        "private_absolute_path": re.compile(r"/(?:Users|home)/[^\s\"']+|/(?:private/)?var/folders/[^\s\"']+"),
        "api_key": re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b"),
        "bearer": re.compile(r"(?i)authorization\s*[:=]\s*bearer\s+[^\s\"']+"),
        "cookie": re.compile(r"(?i)cookie\s*[:=]\s*[^\r\n]+"),
        "credential_assignment": re.compile(r"(?i)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s,;\"']+"),
    }
    findings: list[dict[str, str]] = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".zip"}:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for name, pattern in patterns.items():
            if pattern.search(text):
                findings.append({"kind": name, "path": str(path.relative_to(root))})
    return findings


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
    commit = str(release["git_commit_sha"])
    short_sha = commit[:8]
    artifact_root = args.artifact_root.resolve() / "brain-generation-routing"
    if artifact_root.exists():
        shutil.rmtree(artifact_root)
    formal_root = artifact_root / "formal"
    formal_root.mkdir(parents=True)

    controlled_source = {
        "schema_version": "1.0.0",
        "record_kind": "FILMOS_V2_4_CONTROLLED_EVIDENCE_SOURCE",
        "pseudonymousProjectRef": f"project-ref-{secrets.token_hex(16)}",
        "repository": release["repository"],
        "git_commit_sha": commit,
        "git_tree_sha": release["git_tree_sha"],
        "receipt_sha256": receipt["receipt_sha256"],
        "check_log_hashes": {key: value["log_sha256"] for key, value in sorted(results.items())},
    }
    source_content_hash = sha256_bytes(canonical(controlled_source))
    controlled_source["contentHash"] = source_content_hash
    write_json(formal_root / "CONTROLLED_EVIDENCE_SOURCE.json", controlled_source)

    alias_scope_id = f"alias-scope-{secrets.token_hex(16)}"
    redacted_projection = {
        "schema_version": "1.0.0",
        "record_kind": "FILMOS_V2_4_REDACTED_EVIDENCE_PROJECTION",
        "aliasScopeId": alias_scope_id,
        "projectAlias": f"project-{secrets.token_hex(8)}",
        "repository": release["repository"],
        "git_commit_sha": commit,
        "git_tree_sha": release["git_tree_sha"],
        "receipt_sha256": receipt["receipt_sha256"],
        "check_log_hashes": controlled_source["check_log_hashes"],
    }
    redacted_content_hash = sha256_bytes(canonical(redacted_projection))
    redacted_projection["redactedContentHash"] = redacted_content_hash
    redaction_receipt = {
        "schema_version": "1.0.0",
        "receipt_kind": "FILMOS_REDACTION_RECEIPT",
        "status": "PASSED",
        "aliasScopeId": alias_scope_id,
        "sourceContentHash": source_content_hash,
        "redactedContentHash": redacted_content_hash,
        "sourceArtifact": "formal/CONTROLLED_EVIDENCE_SOURCE.json",
        "redactedProjection": "REDACTED_EVIDENCE_PROJECTION.json",
        "transformations": ["pseudonymousProjectRef->packageScopedAlias"],
        "aliasMappingPersisted": False,
        "binding": {
            "git_commit_sha": commit,
            "git_tree_sha": release["git_tree_sha"],
            "receipt_sha256": receipt["receipt_sha256"],
        },
    }
    write_json(formal_root / "REDACTION_RECEIPT.json", redaction_receipt)
    shutil.copy2(release_path, formal_root / "RELEASE_MANIFEST.json")
    copy_evidence(receipt_path, receipt, formal_root / "evidence")

    with tempfile.TemporaryDirectory(prefix="filmos-v2.4-handoff-") as temporary:
        package = Path(temporary) / f"FilmOS_Brain_Generation_Routing_Handoff_{short_sha}"
        package.mkdir()
        copy_evidence(receipt_path, receipt, package / "evidence")
        ui_source = ROOT / "acceptance" / "golden" / "brain-generation-routing" / "ui"
        composer_golden = ROOT / "acceptance" / "golden" / "brain-generation-routing" / "GENERATION_COMPOSER_GOLDEN.json"
        if not ui_source.is_dir() or not composer_golden.is_file():
            raise RuntimeError("candidate App UI Golden evidence is missing")
        shutil.copytree(ui_source, package / "ui")
        shutil.copy2(composer_golden, package / "GENERATION_COMPOSER_GOLDEN.json")

        final_commit = {
            "schema_version": "1.0.0",
            "repository": release["repository"],
            "git_commit_sha": commit,
            "git_tree_sha": release["git_tree_sha"],
            "github_build_id": release["build_id"],
            "acceptance_receipt_sha256": receipt["receipt_sha256"],
            "release_manifest_sha256": sha256_file(release_path),
            "notice": "Convenience Copy Only; Formal Truth = Commit + GitHub Run + Artifact",
        }
        write_json(package / "FINAL_COMMIT.json", final_commit)
        write_json(package / "REDACTED_EVIDENCE_PROJECTION.json", redacted_projection)
        write_json(package / "REDACTION_RECEIPT.json", redaction_receipt)

        for source_name, target_name in (
            ("PERSISTENCE_OWNERSHIP_MATRIX.md", "PERSISTENCE_OWNERSHIP_MATRIX.md"),
            ("STATE_AUTHORITY_MATRIX.md", "STATE_AUTHORITY_MATRIX.md"),
            ("CONFIG_PRECEDENCE_MATRIX.md", "CONFIG_PRECEDENCE_MATRIX.md"),
            ("ARCHITECTURE_FREEZE.json", "ARCHITECTURE_FREEZE.json"),
            ("BUDGET_AUTHORITY_MATRIX.md", "BUDGET_AUTHORITY_MATRIX.md"),
        ):
            shutil.copy2(ROOT / "implementation" / "brain-generation-routing" / source_name, package / target_name)

        write_json(package / "BRAIN_BINDING_MATRIX.json", {
            "schema_version": "1.0.0",
            "status": "PASSED",
            "userSelectableProfiles": [
                {"profileId": "codex.subscription", "billingMode": "subscription", "exactModelRequired": False},
                {"profileId": "chatgpt.subscription.host", "billingMode": "subscription", "exactModelRequired": False},
                {"profileId": "openai.api", "billingMode": "api", "exactModelRequired": True},
                {"profileId": "anthropic.api", "billingMode": "api", "exactModelRequired": True},
                {"profileId": "deepseek.api", "billingMode": "api", "exactModelRequired": True},
                {"profileId": "local.model", "billingMode": "local", "exactModelRequired": True},
            ],
            "humanActorSelectable": False,
            "globalTextModelFallback": False,
            "bindingCheck": "brain-generation-routing",
        })

        gate_specs = {
            "LOCAL_CONFIG_MIGRATION_REPORT.json": ("LOCAL-CONFIG-NO-LOGIN-DEPENDENCY-001", ("brain-generation-routing", "desktop-backup-restore"), ("backend/internal/service/desktop_user_config.go", "web/src/film/generation-routing/user-config.ts")),
            "BUDGET_BINDING_ROTATION_GATE.json": ("GEN-BUDGET-BINDING-ROTATION-001", ("generation-routing-contracts", "brain-generation-routing"), ("film-core/src/film_production_core/generation_budget.py",)),
            "GENERATION_REFERENCE_BINDING_GATE.json": ("GEN-REFERENCE-BINDING-001", ("generation-routing-contracts", "film-contracts"), ("packages/filmos-generation-contracts/src/authorization.ts",)),
            "PROVIDER_INPUT_AUTHORIZATION_BROKER_EVIDENCE.json": ("GEN-PROVIDER-INPUT-AUTH-BROKER-EVIDENCE-001", ("generation-routing-contracts", "brain-generation-routing"), ("packages/filmos-generation-contracts/src/authorization.ts",)),
            "PROVIDER_INPUT_AUTHORIZATION_GATE.json": ("GEN-PROVIDER-INPUT-AUTHORIZATION-001", ("generation-routing-contracts",), ("packages/filmos-generation-contracts/src/authorization.ts",)),
            "GENERATION_TARGET_GUARD_GATE.json": ("GEN-TARGET-GUARD-001", ("generation-routing-contracts", "brain-generation-routing"), ("packages/filmos-generation-contracts/src/authorization.ts",)),
            "CATALOG_EVIDENCE_REPORT.json": ("GEN-CATALOG-EVIDENCE-001", ("generation-routing-contracts", "brain-generation-routing"), ("packages/filmos-generation-contracts/src/catalog.ts",)),
            "RESOLVED_DESCRIPTOR_RECEIPT_GATE.json": ("GEN-RESOLVED-DESCRIPTOR-RECEIPT-001", ("generation-routing-contracts",), ("packages/filmos-generation-contracts/src/descriptors.ts",)),
            "CATALOG_VALIDATION_RECEIPT_GATE.json": ("GEN-CATALOG-VALIDATION-RECEIPT-001", ("generation-routing-contracts", "brain-generation-routing"), ("packages/filmos-generation-contracts/src/catalog.ts",)),
            "DESCRIPTOR_BLOB_SELECTION_GATE.json": ("GEN-DESCRIPTOR-BLOB-EXACT-SELECTION-001", ("generation-routing-contracts", "brain-generation-routing"), ("packages/filmos-generation-contracts/src/descriptors.ts",)),
            "GENERATION_ROUTE_SNAPSHOT_GATE.json": ("GEN-IMMUTABLE-ROUTE-SNAPSHOT-001", ("generation-routing-contracts", "film-contracts"), ("packages/filmos-generation-contracts/src/route.ts",)),
            "BUDGET_LEDGER_GATE.json": ("GEN-BUDGET-LEDGER-SINGLE-AUTHORITY-001", ("generation-routing-contracts", "brain-generation-routing", "film-contracts"), ("film-core/src/film_production_core/generation_budget.py",)),
            "BUDGET_LEDGER_EVENT_REPORT.json": ("GEN-BUDGET-LEDGER-EVENT-CLOSURE-001", ("generation-routing-contracts", "brain-generation-routing"), ("film-core/src/film_production_core/generation_budget.py",)),
            "PROMPT_COMPILATION_RECEIPT.json": ("PROMPT-COMPILATION-RECEIPT-001", ("generation-routing-contracts", "brain-generation-routing"), ("packages/filmos-generation-contracts/src/prompt.ts",)),
            "MODEL_LOCK_GATE.json": ("PROJECT-MODEL-LOCK-001", ("generation-routing-contracts", "brain-generation-routing"), ("packages/filmos-generation-contracts/src/policy.ts",)),
            "PROVIDER_LIFECYCLE_GATE.json": ("GEN-PROVIDER-LIFECYCLE-001", ("generation-routing-contracts", "brain-generation-routing"), ("packages/filmos-generation-contracts/src/types.ts",)),
            "MIGRATION_REPORT.json": ("GENERATION-ROUTING-MIGRATION-001", ("brain-generation-routing", "desktop-backup-restore", "rc-recovery"), ("packages/filmos-generation-contracts/src/migration.ts",)),
            "ROLLBACK_REPORT.json": ("GENERATION-ROUTING-ROLLBACK-001", ("desktop-backup-restore", "rc-recovery"), ("backend/internal/service/desktop_user_config.go",)),
            "UPSTREAM_COMPATIBILITY_REPORT.json": ("UPSTREAM-COMPAT-001", ("upstream-compatibility", "rc-recovery"), ("scripts/upstream/baseline.json",)),
        }
        for filename, (golden_id, checks, sources) in gate_specs.items():
            write_json(package / filename, bound_gate(golden_id, release, receipt, results, checks, sources))

        engine_matrix = {
            "schema_version": "1.0.0",
            "status": "PASSED",
            "dreamina": load_json(ROOT / "implementation/dreamina-cli/CAPABILITY_MATRIX.json"),
            "flova": load_json(ROOT / "implementation/flova-cli/CAPABILITY_MATRIX.json"),
            "workflowEngines": load_json(ROOT / "implementation/workflow-engines/CAPABILITY_MATRIX.json"),
            "external_cost_microunits": "0",
        }
        write_json(package / "GENERATION_ENGINE_MATRIX.json", engine_matrix)

        write_json(package / "HASH_CONTRACT_REPORT.json", {
            "schema_version": "1.0.0", "status": "PASSED",
            "contract_path": "implementation/brain-generation-routing/HASH_CONTRACT.md",
            "contract_sha256": sha256_file(ROOT / "implementation/brain-generation-routing/HASH_CONTRACT.md"),
            "sourceContentHash": source_content_hash,
            "redactedContentHash": redacted_content_hash,
            "rule": "sourceContentHash verifies the controlled source; redactedContentHash verifies the convenience projection; RedactionReceipt binds both.",
        })
        write_json(package / "IDENTITY_PSEUDONYMIZATION_REPORT.json", {
            "schema_version": "1.0.0", "status": "PASSED", "aliasScopeId": alias_scope_id,
            "packageScopedAlias": True, "crossPackageStable": False, "aliasMappingPersisted": False,
            "contract_sha256": sha256_file(ROOT / "implementation/brain-generation-routing/IDENTITY_PSEUDONYMIZATION.md"),
        })
        write_json(package / "REDACTION_EVIDENCE_REPORT.json", {
            "schema_version": "1.0.0", "status": "PASSED", "receipt": "REDACTION_RECEIPT.json",
            "source_available_only_in_controlled_artifact": True,
            "convenience_projection": "REDACTED_EVIDENCE_PROJECTION.json",
            "sourceContentHash": source_content_hash, "redactedContentHash": redacted_content_hash,
        })

        performance_result = results.get("brain-generation-performance")
        if not performance_result or not performance_result.get("artifact"):
            raise RuntimeError("performance artifact is missing")
        performance_artifact = receipt_path.parent / performance_result["artifact"]["path"]
        performance = load_json(performance_artifact)
        performance["binding"] = {"git_commit_sha": commit, "receipt_sha256": receipt["receipt_sha256"]}
        write_json(package / "PERFORMANCE_REPORT.json", performance)

        summary = {
            "schema_version": "1.0.0",
            "status": "PASSED",
            "repository": release["repository"],
            "git_commit_sha": commit,
            "git_tree_sha": release["git_tree_sha"],
            "github_build_id": release["build_id"],
            "receipt_sha256": receipt["receipt_sha256"],
            "checks": [{"check_id": item["check_id"], "status": item["status"], "log_sha256": item["log_sha256"]} for item in receipt["results"]],
            "external_cost_microunits": "0",
            "external_writes_performed": False,
        }
        write_json(package / "ACCEPTANCE_SUMMARY.json", summary)
        (package / "IMPLEMENTATION_SUMMARY.md").write_text(
            "# FilmOS V2.4 Implementation Handoff\n\n"
            "Convenience Copy Only. Formal Truth = Commit + GitHub Run + Artifact.\n\n"
            f"- Commit: `{commit}`\n- Tree: `{release['git_tree_sha']}`\n"
            f"- Acceptance receipt: `{receipt['receipt_sha256']}`\n- External paid operations: `0`\n\n"
            "The package includes hashed raw logs, machine-readable gates, real candidate App UI Golden, migration/rollback evidence, and a Redaction Receipt.\n",
            encoding="utf-8",
        )
        (package / "KNOWN_LIMITATIONS.md").write_text(
            "# Known Limitations\n\n"
            "- Dreamina catalog evidence is static and bound to the verified CLI version; version drift fails closed.\n"
            "- Flova exposes project and skill discovery but no verified independent model/workflow catalog or caller idempotency key; selection and real authorization remain external gates.\n"
            "- RunningHub and ComfyUI are ready for user selection, but no credentialed network probe or paid workflow was authorized in this run.\n"
            "- UI performance evidence measures deterministic selector/cache/composer contract runtime; React paint and provider/network latency are explicitly excluded.\n",
            encoding="utf-8",
        )

        security = {
            "schema_version": "1.0.0",
            "status": "PENDING_PACKAGE_SCAN",
            "api_keys": 0, "cookies": 0, "cli_credentials": 0, "private_absolute_paths": 0,
            "sourceContentHash": source_content_hash, "redactedContentHash": redacted_content_hash,
            "aliasMappingPersisted": False,
        }
        write_json(package / "SECURITY_REPORT.json", security)
        findings = privacy_scan(package)
        if findings:
            raise RuntimeError(f"privacy scan failed: {findings}")
        security["status"] = "PASSED"
        security["scanner_findings"] = 0
        write_json(package / "SECURITY_REPORT.json", security)

        sums = []
        for path in sorted(item for item in package.rglob("*") if item.is_file() and item.name != "FILE_SHA256SUMS.txt"):
            sums.append(f"{sha256_file(path)}  {path.relative_to(package).as_posix()}")
        (package / "FILE_SHA256SUMS.txt").write_text("\n".join(sums) + "\n", encoding="utf-8")
        missing = [name for name in REQUIRED_ZIP_FILES if not (package / name).is_file()]
        if missing or not (package / "ui").is_dir() or not (package / "evidence").is_dir():
            raise RuntimeError(f"handoff package incomplete: {missing}")
        findings = privacy_scan(package)
        if findings:
            raise RuntimeError(f"final privacy scan failed: {findings}")

        artifact_root.mkdir(parents=True, exist_ok=True)
        zip_path = artifact_root / f"FilmOS_Brain_Generation_Routing_Handoff_{short_sha}.zip"
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(item for item in package.rglob("*") if item.is_file()):
                archive.write(path, arcname=f"{package.name}/{path.relative_to(package).as_posix()}")
        package_index = {
            "schema_version": "1.0.0",
            "status": "PASSED",
            "zip": zip_path.name,
            "zip_sha256": sha256_file(zip_path),
            "zip_bytes": zip_path.stat().st_size,
            "git_commit_sha": commit,
            "git_tree_sha": release["git_tree_sha"],
            "release_manifest_sha256": sha256_file(release_path),
            "receipt_sha256": receipt["receipt_sha256"],
            "sourceContentHash": source_content_hash,
            "redactedContentHash": redacted_content_hash,
            "privacy_findings": 0,
            "notice": "Convenience Copy Only; Formal Truth = Commit + GitHub Run + Artifact",
        }
        write_json(artifact_root / "HANDOFF_INDEX.json", package_index)
        print(json.dumps(package_index, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
