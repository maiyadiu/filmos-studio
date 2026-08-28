#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "acceptance" / "EVIDENCE_INDEX.json"


def canonical(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Bind a verified acceptance receipt into EVIDENCE_INDEX.json")
    parser.add_argument("receipt", type=Path)
    args = parser.parse_args()
    receipt_path = args.receipt.resolve()
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    receipt_body = dict(receipt)
    claimed_hash = receipt_body.pop("receipt_sha256", "")
    if hashlib.sha256(canonical(receipt_body)).hexdigest() != claimed_hash:
        raise SystemExit("refusing to index an invalid receipt hash")
    for result in receipt.get("results", []):
        log = receipt_path.parent / result["log"]
        if not log.is_file() or sha256_file(log) != result["log_sha256"]:
            raise SystemExit(f"refusing to index an invalid log: {log.name}")
    index = json.loads(INDEX.read_text(encoding="utf-8"))
    commit = str(receipt.get("started_from_commit", ""))
    snapshot = str(receipt.get("source_snapshot_sha256", ""))
    relative_receipt = receipt_path.relative_to(ROOT).as_posix()
    by_track: dict[str, list[dict[str, object]]] = {}
    for result in receipt.get("results", []):
        for track in result.get("tracks", []):
            by_track.setdefault(track, []).append(result)
    for track in index["tracks"]:
        track_id = track["track_id"]
        results = by_track.get(track_id, [])
        if not results:
            continue
        track["current_commit"] = commit
        track["last_receipt"] = relative_receipt
        if track.get("evidence_source_snapshot_sha256") != snapshot:
            track["runtime_logs"] = []
        track["evidence_source_snapshot_sha256"] = snapshot
        current_logs = {item["check_id"]: item for item in track.get("runtime_logs", [])}
        current_logs.update({
            result["check_id"]: {
                "check_id": result["check_id"],
                "path": (receipt_path.parent / result["log"]).relative_to(ROOT).as_posix(),
                "sha256": result["log_sha256"],
                "exit_code": result["exit_code"],
            }
            for result in results
        })
        track["runtime_logs"] = list(current_logs.values())
        present_passes = {
            item["check_id"]
            for item in track["runtime_logs"]
            if item["exit_code"] == 0
        }
        required_local = set(track.get("required_local_check_ids", []))
        if not receipt.get("clean_worktree", False):
            track["acceptance_status"] = "DEVELOPMENT_EVIDENCE_DIRTY"
        elif required_local.issubset(present_passes):
            track["acceptance_status"] = "AUTOMATED_LOCAL_EVIDENCE_PASSED"
        else:
            track["acceptance_status"] = "PENDING_MISSING_AUTOMATED_CHECKS"
    index["current_commit"] = commit
    local_complete = all(
        set(track.get("required_local_check_ids", [])).issubset(
            {
                item["check_id"]
                for item in track.get("runtime_logs", [])
                if item["exit_code"] == 0
            }
        )
        for track in index["tracks"]
    )
    if local_complete and receipt.get("clean_worktree", False):
        index["index_status"] = "AUTOMATED_LOCAL_EVIDENCE_PASSED_EXTERNAL_GATES_PENDING"
    elif local_complete:
        index["index_status"] = "DEVELOPMENT_LOCAL_EVIDENCE_PASSED_DIRTY"
    else:
        index["index_status"] = "IN_PROGRESS_REPLAY_REQUIRED"
    INDEX.write_text(json.dumps(index, ensure_ascii=False, sort_keys=False, indent=2) + "\n", encoding="utf-8")
    print(INDEX)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
