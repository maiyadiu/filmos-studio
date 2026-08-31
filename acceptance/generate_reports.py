#!/usr/bin/env python3
"""Generate reviewer reports that remain bound to raw hashed Acceptance evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
REPORT_ROOT = ROOT / "acceptance" / "reports"
INDEX_PATH = REPORT_ROOT / "REPORT_INDEX.json"
REPORT_SPECS = {
    "KNOWN_LIMITATIONS.md": (
        "Known Limitations",
        (
            "desktop-release-build",
            "desktop-chatgpt-connection",
            "no-openai-model-api-billing",
            "agent-native-multibrain",
            "agent-codex-controlled-write",
            "agent-tool-contract-single-source",
            "agent-candidate-activation",
            "agent-browser-lifecycle",
            "agent-connection-probe-isolation",
            "chatgpt-host-restart-recovery",
            "chatgpt-handoff-state",
            "mcp-actual-tool-count",
            "architecture-drift-gate",
            "review-bus-governance",
            "review-cli-watcher",
            "review-bridge-contract",
            "pilot-project-copy",
            "use-driven-dual-expert",
            "performance-local",
            "remote-acceptance-contract",
        ),
    ),
    "MIGRATION_REPORT.md": (
        "Migration Report",
        (
            "rc-recovery", "upstream-compatibility", "desktop-backup-restore",
            "generation-routing-contracts", "pilot-project-copy", "use-driven-dual-expert",
        ),
    ),
    "UPSTREAM_COMPATIBILITY_REPORT.md": (
        "Upstream Compatibility Report",
        ("upstream-compatibility", "rc-recovery"),
    ),
    "SECURITY_REPORT.md": (
        "Security Report",
        (
            "desktop-local-auth",
            "desktop-backup-restore",
            "canvas-agent",
            "chatgpt-handoff-local",
            "chatgpt-golden-real",
            "desktop-chatgpt-connection",
            "no-openai-model-api-billing",
            "agent-native-multibrain",
            "agent-codex-controlled-write",
            "agent-tool-contract-single-source",
            "agent-candidate-activation",
            "agent-browser-lifecycle",
            "agent-connection-probe-isolation",
            "chatgpt-host-restart-recovery",
            "chatgpt-handoff-state",
            "mcp-actual-tool-count",
            "architecture-drift-gate",
            "review-bus-governance",
            "review-cli-watcher",
            "review-bridge-contract",
            "pilot-project-copy",
            "use-driven-dual-expert",
            "acceptance-privacy",
        ),
    ),
    "PERFORMANCE_REPORT.md": (
        "Performance Report",
        ("web-production-build", "performance-local"),
    ),
    "GOLDEN_TEST_REPORT.md": (
        "Golden Test Report",
        (
            "desktop-backup-restore",
            "golden-abc-real-http",
            "acceptance-full-chain",
            "chatgpt-golden-real",
            "desktop-chatgpt-connection",
            "agent-native-multibrain",
            "agent-codex-controlled-write",
            "agent-tool-contract-single-source",
            "agent-candidate-activation",
            "agent-browser-lifecycle",
            "agent-connection-probe-isolation",
            "chatgpt-host-restart-recovery",
            "chatgpt-handoff-state",
            "mcp-actual-tool-count",
            "no-openai-model-api-billing",
            "architecture-drift-gate",
            "review-bus-governance",
            "review-cli-watcher",
            "review-bridge-contract",
            "pilot-project-copy",
            "use-driven-dual-expert",
        ),
    ),
}
RAW_SOURCES = (
    "CHANGELOG.md",
    "acceptance/MANIFEST.json",
    "acceptance/FilmOS_Acceptance_Project/项目.json",
    "implementation/MIGRATION_MAP.md",
    "implementation/UPSTREAM_COMPATIBILITY.md",
    "tests/film-beta/beta-performance.json",
    "tests/film-rc/rc-recovery-receipt.json",
    "services/filmos-chatgpt-app/evidence/real-golden-receipt.json",
    "services/filmos-chatgpt-app/evidence/external-account-blocked.json",
    "acceptance/EXTERNAL_AUDIT_P0_RESOLUTION.json",
    "acceptance/evidence/runs/agent-codex-subscription-controlled-write-001/CODEX_CONTROLLED_WRITE_GATE.json",
    "acceptance/evidence/runs/agent-codex-subscription-controlled-write-001/audit-trace.jsonl",
    "packages/filmos-agent-tool-contracts/generated/canonical-tools.json",
    "acceptance/evidence/runs/20260829T153743Z-bbedc297c1b2-rc-real-agent/codex-subscription-real-receipt.json",
    "implementation/agent-native-multibrain/evidence/WP-09.json",
    "implementation/agent-native-multibrain/evidence/UI-01.json",
    "output/playwright/agent-native-multibrain.png",
    "output/playwright/chatgpt-host-boundary.png",
    "governance/FILMOS_CONSTITUTION.json",
    "implementation/use-driven-dual-expert-v1-1/PILOT_BASE_0_MANIFEST.json",
    "implementation/use-driven-dual-expert-v1-1/CURRENT_CAPABILITY_MATRIX.json",
    "implementation/use-driven-dual-expert-v1-1/CURRENT_KNOWN_GAPS.json",
    "extensions/filmos-review-bridge/manifest.json",
)


def canonical(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verified_receipt(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    body = dict(value)
    claimed = body.pop("receipt_sha256", "")
    if hashlib.sha256(canonical(body)).hexdigest() != claimed:
        raise ValueError("receipt hash mismatch")
    for result in value.get("results", []):
        log = path.parent / result["log"]
        if not log.is_file() or sha256_file(log) != result["log_sha256"]:
            raise ValueError(f"receipt log mismatch: {result['check_id']}")
    return value


def evidence_rows(
    receipt: dict[str, Any], check_ids: Iterable[str]
) -> list[dict[str, Any]]:
    by_id = {result["check_id"]: result for result in receipt["results"]}
    rows = []
    for check_id in check_ids:
        if check_id not in by_id:
            rows.append(
                {
                    "check_id": check_id,
                    "status": "NOT_IN_LOCAL_SUITE",
                    "log": None,
                    "log_sha256": None,
                }
            )
            continue
        result = by_id[check_id]
        rows.append(
            {
                "check_id": check_id,
                "status": result["status"],
                "log": f"acceptance/evidence/runs/{receipt['run_id']}/{result['log']}",
                "log_sha256": result["log_sha256"],
            }
        )
    return rows


def markdown_table(rows: list[dict[str, Any]]) -> str:
    lines = [
        "| Check | Status | Raw log | SHA-256 |",
        "| --- | --- | --- | --- |",
    ]
    for row in rows:
        lines.append(
            f"| `{row['check_id']}` | `{row['status']}` | "
            f"`{row['log'] or '-'}` | `{row['log_sha256'] or '-'}` |"
        )
    return "\n".join(lines)


def check_json(
    receipt_path: Path, receipt: dict[str, Any], check_id: str
) -> dict[str, Any] | None:
    result = next(
        (item for item in receipt["results"] if item["check_id"] == check_id), None
    )
    if result is None:
        return None
    lines = (receipt_path.parent / result["log"]).read_text(
        encoding="utf-8", errors="replace"
    ).splitlines()
    for line in reversed(lines):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def report_notes(
    filename: str, receipt_path: Path, receipt: dict[str, Any]
) -> str:
    dirty = not receipt.get("clean_worktree", False)
    common = (
        "This report is an evidence view, not an independent pass declaration. "
        "The raw receipt and logs above are authoritative."
    )
    performance = check_json(receipt_path, receipt, "performance-local") or {}
    core = performance.get("core", {})
    surface = performance.get("surface", {})
    core_metrics = core.get("metrics", {})
    surface_metrics = surface.get("metrics", {})
    bundle = core.get("web_bundle", {})
    performance_details = (
        "Measured p95: app init "
        f"`{core_metrics.get('app_init', {}).get('p95_ms', 'n/a')} ms`, project context "
        f"`{core_metrics.get('project_context', {}).get('p95_ms', 'n/a')} ms`, entity read "
        f"`{core_metrics.get('entity_read', {}).get('p95_ms', 'n/a')} ms`, command preview "
        f"`{core_metrics.get('command_preview', {}).get('p95_ms', 'n/a')} ms`, Remote preview "
        f"`{surface_metrics.get('remote_preview', {}).get('p95_ms', 'n/a')} ms`, Agent read/preview/deny "
        f"`{surface_metrics.get('agent_read_preview_apply_denied', {}).get('p95_ms', 'n/a')} ms`. "
        f"Largest JavaScript is `{bundle.get('largest_javascript', {}).get('bytes', 'n/a')}` bytes; "
        f"warning chunks `{bundle.get('javascript_over_warning', 'n/a')}`, blocking "
        f"`{str(bundle.get('blocked', 'n/a')).lower()}`."
    )
    notes = {
        "KNOWN_LIMITATIONS.md": (
            "- Current evidence was generated from a "
            f"{'dirty development' if dirty else 'clean fixed-commit'} source worktree.\n"
            "- Real Codex Subscription evidence is a separate receipt because it requires "
            "managed account authorization; the report index hashes both the controlled-write "
            "receipt and its append-only audit trace as raw sources.\n"
            "- No paid Provider or model API generation was performed for this P0 correction; "
            "the Local-first chain uses `LOCAL_MANUAL_CANDIDATE_IMPORT`.\n"
            "- Dreamina执行端口已达到 `READY_FOR_USER_AUTHORIZATION`；本轮只校验动态CLI身份、"
            "Catalog和零提交硬门禁，未执行付费生成。\n"
            "- Review Bus与Chrome Bridge均为本机开发治理；ChatGPT保持只读MCP，"
            "Decision写回仍需用户在Chrome明确点击一次。\n"
            "- ChatGPT External Live Gate remains `BLOCKED_EXTERNAL_ACCOUNT`; local MCP, Widget "
            "and handoff checks do not replace independent account-side acknowledgement.\n"
            "- `NO-OPENAI-MODEL-API-001` proves the checked-in runtime has no model API "
            "endpoint path; the final external Live Gate must add its own time-bounded receipt.\n"
            "- Resume history is provider-specific: Codex is rebuilt from `thread/read`; ChatGPT "
            "shows the persisted Handoff timeline only; API and Local profiles currently state "
            "that Provider conversation history is not persisted instead of showing invented history.\n"
            "- Real user database migration and real rollback remain outside the synthetic "
            "recovery drill.\n"
            "- The app is an internal unsigned macOS build; signing, notarization and public "
            "distribution are not claimed.\n"
            "- The controlled-write operator entered one shortened expected node ID during the "
            "restart readback; the receipt preserves that typo and binds the recovered object to "
            "the complete DOM node ID instead of rewriting the historical trace.\n"
            "- Web JavaScript may exceed the warning budget, but must remain below the "
            "blocking budget."
        ),
        "MIGRATION_REPORT.md": (
            "Synthetic migration, exact recovery and backup restoration are automated. "
            "The recovery runner creates an isolated bare repository by fetching the exact "
            "frozen Yingce Stable and Candidate objects and verifies both trees before the drill. "
            "No real user database is opened by this report. Upstream remains "
            "`C_MIGRATION_REQUIRED` until a separately authorized real migration and rollback "
            "receipt exists. ProjectGenerationPolicy V1 is deterministically mapped to V2 "
            "one-element connection, route, budget, binding and lock collections; the V1 reader "
            "remains available for rollback. Pilot uses a project-scoped copy and never mutates "
            "the only formal database."
        ),
        "UPSTREAM_COMPATIBILITY_REPORT.md": (
            "Pinned upstream compatibility and rollback tests bootstrap the exact frozen "
            "commits from the declared public Yingce repository into isolated refs; no pre-existing "
            "workstation remote or tracking ref is used. The current "
            "candidate classification remains `C_MIGRATION_REQUIRED`; this report does not "
            "authorize merge, rebase, push or data migration."
        ),
        "SECURITY_REPORT.md": (
            "The covered checks enforce loopback-only desktop auth, human-only approval, "
            "credential exclusion from backup/evidence, signed project scopes, replay-safe "
            "controlled writes, generated tool-risk schemas, ChatGPT preview boundaries and a "
            "redacted evidence package. Review Bus binds loopback-only tokens, SQLite WAL events, "
            "candidate commit/tree/artifact/nonce and replay-safe Chrome challenges; the extension "
            "does not read Cookie or ChatGPT Token. Browser sessions bind create/cancel/close to one Profile; "
            "connection probes are non-networking and fail-soft. Runtime Key is Keychain-only, Tunnel and ChatGPT "
            "reachability remain separate states, and model API endpoint use is blocked. "
            "Passing local checks does not prove public deployment "
            "security or Apple notarization."
        ),
        "PERFORMANCE_REPORT.md": (
            "Performance is measured against the checked-in 80-unit/80-shot and 60-sample "
            "budgets. Network actions, uploads, external Provider calls and Agent Apply remain "
            "zero. Bundle warning and blocking thresholds are reported separately.\n\n"
            + performance_details
        ),
        "GOLDEN_TEST_REPORT.md": (
            "Golden evidence combines real temporary HTTP Sidecars, the fixed Acceptance "
            "Project, desktop backup/restore, production multi-brain composition, Candidate App "
            "activation, a real Codex Subscription reject/approve/restart drill and real local "
            "ChatGPT handoff. The final lifecycle gates add process-level Host restart, scoped "
            "Grant rotation, formal waiting_host receipts and Handoff expiry recovery. V1.1 also "
            "runs the single Issue/Evidence path, blind dual assessments, Consensus, three lanes, "
            "Chrome one-click writeback, Pilot copy/backup, Policy V2 and Dreamina zero-submit readiness. Local "
            "Provider import is never relabeled as real CLI generation."
        ),
    }
    return notes[filename] + "\n\n" + common


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate hashed FilmOS acceptance reports")
    parser.add_argument("receipt", type=Path)
    args = parser.parse_args()
    receipt_path = args.receipt.resolve()
    receipt = verified_receipt(receipt_path)
    relative_receipt = receipt_path.relative_to(ROOT).as_posix()
    raw_sources = []
    for relative in RAW_SOURCES:
        path = ROOT / relative
        if not path.is_file():
            raise SystemExit(f"required raw report source is missing: {relative}")
        raw_sources.append(
            {"path": relative, "sha256": sha256_file(path), "bytes": path.stat().st_size}
        )

    REPORT_ROOT.mkdir(parents=True, exist_ok=True)
    reports = []
    evidence_status = (
        "DEVELOPMENT_EVIDENCE_DIRTY"
        if not receipt.get("clean_worktree", False)
        else "CLEAN_LOCAL_EVIDENCE_NOT_FROZEN"
    )
    for filename, (title, check_ids) in REPORT_SPECS.items():
        rows = evidence_rows(receipt, check_ids)
        body = (
            f"# {title}\n\n"
            f"- Evidence status: `{evidence_status}`\n"
            f"- Receipt: `{relative_receipt}`\n"
            f"- Receipt SHA-256: `{receipt['receipt_sha256']}`\n"
            f"- Started from Commit: `{receipt['started_from_commit']}`\n"
            f"- Source snapshot SHA-256: `{receipt['source_snapshot_sha256']}`\n\n"
            "## Machine evidence\n\n"
            f"{markdown_table(rows)}\n\n"
            "## Scope and boundary\n\n"
            f"{report_notes(filename, receipt_path, receipt)}\n"
        )
        path = REPORT_ROOT / filename
        path.write_text(body, encoding="utf-8")
        reports.append(
            {
                "path": path.relative_to(ROOT).as_posix(),
                "sha256": sha256_file(path),
                "bytes": path.stat().st_size,
                "check_ids": list(check_ids),
            }
        )

    index = {
        "schema_version": "1.0.0",
        "evidence_status": evidence_status,
        "receipt": relative_receipt,
        "receipt_sha256": receipt["receipt_sha256"],
        "started_from_commit": receipt["started_from_commit"],
        "source_snapshot_sha256": receipt["source_snapshot_sha256"],
        "reports": reports,
        "raw_sources": raw_sources,
    }
    INDEX_PATH.write_text(
        json.dumps(index, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    print(INDEX_PATH.relative_to(ROOT).as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
