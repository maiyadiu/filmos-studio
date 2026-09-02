#!/usr/bin/env python3
"""Build and verify the recoverable Stage C2 tracked-artifact cleanup manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import shlex
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PATHS = (
    "acceptance/evidence/runs",
    "output/playwright",
    "services/filmos-chatgpt-app/src/generated-widget-runtime.ts",
    "web/pnpm-lock.yaml",
)
HOTSPOTS = (
    "desktop/macos/Sources/FilmOSStudioDesktop/main.swift",
    "web/src/film/governance/report-issue.ts",
    "services/filmos-review-bus/src/service.mjs",
    "canvas-agent/src/brains/review-codex-coordinator.ts",
    "web/src/pages/canvas/project.tsx",
    "web/src/components/canvas/canvas-assistant-panel.tsx",
    "web/src/components/canvas/canvas-local-agent-panel.tsx",
    "web/src/components/canvas/canvas-config-composer.tsx",
)


def git(*args: str, binary: bool = False) -> bytes | str:
    value = subprocess.check_output(("git", *args), cwd=ROOT)
    return value if binary else value.decode().strip()


def sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def consumers(path: str) -> list[str]:
    if path.startswith("acceptance/evidence/runs/"):
        result = ["acceptance historical receipt and log recovery"]
        if "agent-codex-subscription-controlled-write-001" in path:
            result.extend(("acceptance/checks/agent_codex_controlled_write.py", "acceptance/generate_reports.py"))
        return result
    if path.startswith("output/playwright/"):
        result = ["historical implementation UI evidence recovery"]
        if path.endswith(("agent-native-multibrain.png", "chatgpt-host-boundary.png")):
            result.append("acceptance/generate_reports.py")
        return result
    if path.endswith("generated-widget-runtime.ts"):
        return ["services/filmos-chatgpt-app/scripts/build-widget.mjs", "services/filmos-chatgpt-app/src/widgets.ts"]
    if path == "web/pnpm-lock.yaml":
        return ["retired pnpm dependency lock; Bun lock is the declared runtime source"]
    return ["historical recovery only"]


def file_type(path: str) -> str:
    suffix = Path(path).suffix.lower()
    return {
        ".json": "json",
        ".jsonl": "jsonl",
        ".log": "log",
        ".png": "image/png",
        ".ts": "generated/typescript",
        ".yaml": "lock/yaml",
    }.get(suffix, "binary")


def tracked_paths(commit: str) -> list[str]:
    raw = git("ls-tree", "-r", "-z", "--name-only", commit, "--", *DEFAULT_PATHS, binary=True)
    assert isinstance(raw, bytes)
    return sorted(item.decode() for item in raw.split(b"\0") if item)


def canary(log_path: Path) -> dict[str, object]:
    lines = [line for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    payload = json.loads(lines[-1])
    if payload.get("status") != "PASS":
        raise RuntimeError("pre-cleanup canary did not pass")
    return {
        "log_sha256": sha256(log_path.read_bytes()),
        "result_sha256": sha256((json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()),
        "result": payload,
    }


def line_count(value: bytes) -> int:
    return value.count(b"\n")


def hotspot_counts(baseline_commit: str) -> dict[str, object]:
    rows = []
    for path in HOTSPOTS:
        before = git("show", f"{baseline_commit}:{path}", binary=True)
        assert isinstance(before, bytes)
        after = (ROOT / path).read_bytes()
        rows.append({"path": path, "baseline_lines": line_count(before), "current_lines": line_count(after), "delta": line_count(after) - line_count(before)})
    baseline_total = sum(item["baseline_lines"] for item in rows)
    current_total = sum(item["current_lines"] for item in rows)
    return {"baseline_commit": baseline_commit, "baseline_lines": baseline_total, "current_lines": current_total, "delta": current_total - baseline_total, "files": rows}


def build(commit: str, baseline_commit: str, canary_log: Path) -> dict[str, object]:
    tree = str(git("rev-parse", f"{commit}^{{tree}}"))
    entries = []
    for path in tracked_paths(commit):
        body = git("show", f"{commit}:{path}", binary=True)
        assert isinstance(body, bytes)
        quoted = shlex.quote(path)
        entries.append(
            {
                "original_path": path,
                "sha256": sha256(body),
                "bytes": len(body),
                "source_commit": commit,
                "file_type": file_type(path),
                "consumers": consumers(path),
                "persistent_recovery_location": f"git-object://{commit}/{path}",
                "restore_command": f"git restore --source={commit} -- {quoted}",
            }
        )
    return {
        "schema_version": "filmos.repository-cleanup-recovery.v1",
        "source_commit": commit,
        "source_tree": tree,
        "scope": "Stage C2 tracked generated and raw artifacts only; no user data",
        "pre_cleanup_canary": canary(canary_log),
        "handwritten_runtime_hotspots": hotspot_counts(baseline_commit),
        "inventory": {
            "entry_count": len(entries),
            "total_bytes": sum(item["bytes"] for item in entries),
            "entries": entries,
        },
        "rollback": {
            "history_rewrite": False,
            "source_commit_must_remain_reachable": True,
            "restore_all_command": f"git restore --source={commit} -- {' '.join(shlex.quote(path) for path in DEFAULT_PATHS)}",
        },
    }


def verify(value: dict[str, object]) -> None:
    commit = str(value["source_commit"])
    if str(git("rev-parse", f"{commit}^{{tree}}")) != value["source_tree"]:
        raise RuntimeError("cleanup source tree mismatch")
    entries = value["inventory"]["entries"]  # type: ignore[index]
    if len(entries) != value["inventory"]["entry_count"]:  # type: ignore[index]
        raise RuntimeError("cleanup entry count mismatch")
    for entry in entries:
        body = git("show", f"{commit}:{entry['original_path']}", binary=True)
        assert isinstance(body, bytes)
        if len(body) != entry["bytes"] or sha256(body) != entry["sha256"]:
            raise RuntimeError(f"cleanup object mismatch: {entry['original_path']}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--baseline-commit", required=True)
    parser.add_argument("--canary-log", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "governance" / "清理恢复清单.json")
    args = parser.parse_args()
    value = build(args.source_commit, args.baseline_commit, args.canary_log.resolve())
    verify(value)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "PASS", "entries": value["inventory"]["entry_count"], "bytes": value["inventory"]["total_bytes"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
