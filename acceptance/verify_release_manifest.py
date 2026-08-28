#!/usr/bin/env python3
"""Verify an artifact-only release identity against its fixed checkout and receipt."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ACCEPTANCE_MANIFEST = ROOT / "acceptance" / "MANIFEST.json"
EVIDENCE_INDEX = ROOT / "acceptance" / "EVIDENCE_INDEX.json"
EXPECTED_REPOSITORY = "maiyadiu/filmos-studio"
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")


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


def git(*args: str) -> str:
    return subprocess.run(
        ("git", *args), cwd=ROOT, text=True, capture_output=True, check=True
    ).stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify FilmOS RELEASE_MANIFEST.json")
    parser.add_argument("release_manifest", type=Path)
    parser.add_argument("receipt", type=Path)
    args = parser.parse_args()

    release = json.loads(args.release_manifest.read_text(encoding="utf-8"))
    receipt = json.loads(args.receipt.read_text(encoding="utf-8"))
    required = {
        "repository", "git_commit_sha", "git_tree_sha",
        "acceptance_manifest_hash", "evidence_index_hash",
        "receipt_hash", "build_id", "timestamp",
    }
    if not required.issubset(release):
        raise SystemExit("release manifest required fields are missing")
    if release["repository"] != EXPECTED_REPOSITORY:
        raise SystemExit("release repository mismatch")
    if not SHA_PATTERN.fullmatch(str(release["git_commit_sha"])):
        raise SystemExit("release commit SHA is invalid")
    if not SHA_PATTERN.fullmatch(str(release["git_tree_sha"])):
        raise SystemExit("release tree SHA is invalid")
    for field in (
        "acceptance_manifest_hash", "evidence_index_hash", "receipt_hash"
    ):
        if not HASH_PATTERN.fullmatch(str(release[field])):
            raise SystemExit(f"{field} is invalid")
    if release["git_commit_sha"] != git("rev-parse", "HEAD"):
        raise SystemExit("release commit does not match checkout")
    if release["git_tree_sha"] != git("rev-parse", "HEAD^{tree}"):
        raise SystemExit("release tree does not match checkout")
    if release["acceptance_manifest_hash"] != sha256_file(ACCEPTANCE_MANIFEST):
        raise SystemExit("Acceptance MANIFEST hash mismatch")
    if release["evidence_index_hash"] != sha256_file(EVIDENCE_INDEX):
        raise SystemExit("Evidence Index hash mismatch")
    body = dict(receipt)
    claimed = body.pop("receipt_sha256", "")
    if hashlib.sha256(canonical(body)).hexdigest() != claimed:
        raise SystemExit("receipt hash mismatch")
    if release["receipt_hash"] != claimed:
        raise SystemExit("release receipt binding mismatch")
    if receipt.get("started_from_commit") != release["git_commit_sha"]:
        raise SystemExit("receipt commit binding mismatch")
    if receipt.get("status") != "PASSED" or receipt.get("clean_worktree") is not True:
        raise SystemExit("release receipt is not a clean pass")
    if not str(release["build_id"]).strip():
        raise SystemExit("build_id is empty")
    datetime.fromisoformat(str(release["timestamp"]).replace("Z", "+00:00"))
    print(
        json.dumps(
            {
                "status": "PASSED",
                "repository": release["repository"],
                "git_commit_sha": release["git_commit_sha"],
                "git_tree_sha": release["git_tree_sha"],
                "receipt_hash": release["receipt_hash"],
                "build_id": release["build_id"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
