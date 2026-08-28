#!/usr/bin/env python3
"""Verify generated reports, raw sources and their bound Acceptance receipt."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "acceptance" / "reports" / "REPORT_INDEX.json"


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


def main() -> int:
    value = json.loads(INDEX.read_text(encoding="utf-8"))
    receipt_path = ROOT / value["receipt"]
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    body = dict(receipt)
    claimed = body.pop("receipt_sha256", "")
    if hashlib.sha256(canonical(body)).hexdigest() != claimed:
        raise RuntimeError("report receipt hash mismatch")
    if claimed != value["receipt_sha256"]:
        raise RuntimeError("report index points to another receipt")
    if value["started_from_commit"] != receipt["started_from_commit"]:
        raise RuntimeError("report commit binding mismatch")
    if value["source_snapshot_sha256"] != receipt["source_snapshot_sha256"]:
        raise RuntimeError("report source snapshot binding mismatch")

    checked = 0
    for item in [*value["reports"], *value["raw_sources"]]:
        path = ROOT / item["path"]
        if not path.is_file() or sha256_file(path) != item["sha256"]:
            raise RuntimeError(f"report artifact hash mismatch: {item['path']}")
        if path.stat().st_size != item["bytes"]:
            raise RuntimeError(f"report artifact size mismatch: {item['path']}")
        checked += 1
    for result in receipt["results"]:
        log = receipt_path.parent / result["log"]
        if not log.is_file() or sha256_file(log) != result["log_sha256"]:
            raise RuntimeError(f"report source log mismatch: {result['check_id']}")
        checked += 1
    print(
        json.dumps(
            {
                "golden_id": "ACCEPTANCE-REPORT-BUNDLE-001",
                "test_status": "PASSED",
                "evidence_status": value["evidence_status"],
                "receipt_sha256": claimed,
                "artifacts_checked": checked,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
