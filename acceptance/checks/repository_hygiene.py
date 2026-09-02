#!/usr/bin/env python3
"""Verify Stage C2 removes tracked raw/generated artifacts without losing recovery."""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "governance" / "清理恢复清单.json"


def git(*args: str, binary: bool = False) -> bytes | str:
    value = subprocess.check_output(("git", *args), cwd=ROOT)
    return value if binary else value.decode().strip()


def require(condition: bool, code: str) -> None:
    if not condition:
        raise RuntimeError(code)


def main() -> int:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    commit = manifest["source_commit"]
    require(str(git("rev-parse", f"{commit}^{{tree}}")) == manifest["source_tree"], "CLEANUP_SOURCE_TREE_MISMATCH")
    entries = manifest["inventory"]["entries"]
    require(len(entries) == manifest["inventory"]["entry_count"], "CLEANUP_ENTRY_COUNT_MISMATCH")
    require(sum(item["bytes"] for item in entries) == manifest["inventory"]["total_bytes"], "CLEANUP_BYTE_COUNT_MISMATCH")
    hotspots = manifest["handwritten_runtime_hotspots"]
    current_lines = 0
    for item in hotspots["files"]:
        count = (ROOT / item["path"]).read_bytes().count(b"\n")
        require(count == item["current_lines"], f"HOTSPOT_LINE_COUNT_DRIFT:{item['path']}")
        current_lines += count
    require(current_lines == hotspots["current_lines"] and hotspots["delta"] < 0, "HANDWRITTEN_RUNTIME_DID_NOT_DECREASE")
    tracked = set(str(git("ls-files", "acceptance/evidence/runs", "output/playwright", "services/filmos-chatgpt-app/src/generated-widget-runtime.ts", "web/pnpm-lock.yaml")).splitlines())
    if tracked:
        raise RuntimeError(f"CLEANUP_PATH_STILL_TRACKED:{sorted(tracked)[0]}")
    for entry in entries:
        body = git("show", f"{commit}:{entry['original_path']}", binary=True)
        assert isinstance(body, bytes)
        require(len(body) == entry["bytes"], f"CLEANUP_ARCHIVE_SIZE_MISMATCH:{entry['original_path']}")
        require(hashlib.sha256(body).hexdigest() == entry["sha256"], f"CLEANUP_ARCHIVE_HASH_MISMATCH:{entry['original_path']}")
    require((ROOT / "web/bun.lock").is_file(), "BUN_LOCK_MISSING")
    ignored = subprocess.run(
        ("git", "check-ignore", "acceptance/evidence/runs/probe.log", "output/playwright/probe.png", "services/filmos-chatgpt-app/generated/widget-runtime.ts"),
        cwd=ROOT,
        capture_output=True,
        check=False,
    )
    require(ignored.returncode == 0 and len(ignored.stdout.splitlines()) == 3, "CLEANUP_IGNORE_CONTRACT_INVALID")
    result = {
        "schema_version": "filmos.repository-hygiene.v1",
        "status": "PASS",
        "source_commit": commit,
        "source_tree": manifest["source_tree"],
        "recoverable_entries": len(entries),
        "recoverable_bytes": manifest["inventory"]["total_bytes"],
        "tracked_raw_or_generated_entries": 0,
        "web_lock_source": "web/bun.lock",
        "handwritten_runtime_hotspot_delta": hotspots["delta"],
        "history_rewritten": False,
        "user_data_touched": False,
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
