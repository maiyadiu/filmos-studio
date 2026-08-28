#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def canonical(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify one FilmOS acceptance receipt and its logs")
    parser.add_argument("receipt", type=Path)
    args = parser.parse_args()
    receipt = args.receipt.resolve()
    value = json.loads(receipt.read_text(encoding="utf-8"))
    claimed = value.pop("receipt_sha256", "")
    actual = hashlib.sha256(canonical(value)).hexdigest()
    if claimed != actual:
        raise SystemExit(f"receipt hash mismatch: {claimed} != {actual}")
    for result in value.get("results", []):
        log = receipt.parent / result["log"]
        if not log.is_file() or sha256_file(log) != result["log_sha256"]:
            raise SystemExit(f"log verification failed: {log}")
    print(f"ACCEPTANCE_RECEIPT_VERIFIED {claimed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
