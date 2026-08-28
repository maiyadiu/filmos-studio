#!/usr/bin/env python3
"""Generate an artifact-only release identity after a candidate commit is fixed."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
ACCEPTANCE_MANIFEST = ROOT / "acceptance" / "MANIFEST.json"
EVIDENCE_INDEX = ROOT / "acceptance" / "EVIDENCE_INDEX.json"
EXPECTED_REPOSITORY = "maiyadiu/filmos-studio"
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")


class ReleaseManifestError(RuntimeError):
    pass


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
    result = subprocess.run(
        ("git", *args), cwd=ROOT, text=True, capture_output=True, check=False
    )
    if result.returncode != 0:
        raise ReleaseManifestError(f"git {' '.join(args)} failed")
    return result.stdout.strip()


def verified_receipt(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    body = dict(value)
    claimed = str(body.pop("receipt_sha256", ""))
    if hashlib.sha256(canonical(body)).hexdigest() != claimed:
        raise ReleaseManifestError("receipt hash mismatch")
    for result in value.get("results", []):
        log = path.parent / result["log"]
        if not log.is_file() or sha256_file(log) != result["log_sha256"]:
            raise ReleaseManifestError(f"receipt log mismatch: {result['check_id']}")
    return value


def ensure_artifact_only(output: Path) -> None:
    resolved = output.resolve()
    try:
        relative = resolved.relative_to(ROOT)
    except ValueError:
        return
    tracked = subprocess.run(
        ("git", "ls-files", "--error-unmatch", relative.as_posix()),
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if tracked.returncode == 0:
        raise ReleaseManifestError("RELEASE_MANIFEST.json must not be tracked")
    ignored = subprocess.run(
        ("git", "check-ignore", "-q", relative.as_posix()), cwd=ROOT, check=False
    )
    if ignored.returncode != 0:
        raise ReleaseManifestError(
            "repository-local release artifacts must be written under an ignored path"
        )


def default_build_id(receipt: dict[str, Any]) -> str:
    github_run = os.environ.get("GITHUB_RUN_ID", "").strip()
    github_attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "").strip()
    if github_run:
        return f"github-{github_run}-{github_attempt or '1'}"
    return f"local-{receipt['run_id']}"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate an untracked FilmOS RELEASE_MANIFEST.json artifact"
    )
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--build-id")
    args = parser.parse_args()

    output = args.output.resolve()
    ensure_artifact_only(output)
    receipt_path = args.receipt.resolve()
    receipt = verified_receipt(receipt_path)
    commit = git("rev-parse", "HEAD")
    tree = git("rev-parse", "HEAD^{tree}")
    if not SHA_PATTERN.fullmatch(commit) or not SHA_PATTERN.fullmatch(tree):
        raise ReleaseManifestError("candidate commit or tree SHA is invalid")
    if receipt.get("status") != "PASSED" or receipt.get("suite") != "rc-local":
        raise ReleaseManifestError("release manifest requires a passing rc-local receipt")
    if receipt.get("clean_worktree") is not True:
        raise ReleaseManifestError("release manifest requires a clean acceptance run")
    if receipt.get("started_from_commit") != commit:
        raise ReleaseManifestError("receipt does not belong to the fixed candidate commit")
    if git("status", "--porcelain"):
        raise ReleaseManifestError("release manifest requires a clean current worktree")

    manifest = json.loads(ACCEPTANCE_MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("canonical_remote", {}).get("slug") != EXPECTED_REPOSITORY:
        raise ReleaseManifestError("canonical repository contract changed")
    if manifest.get("evidence_index", {}).get("sha256") != sha256_file(EVIDENCE_INDEX):
        raise ReleaseManifestError("Acceptance MANIFEST evidence index hash mismatch")

    payload = {
        "schema_version": "1.0.0",
        "repository": EXPECTED_REPOSITORY,
        "git_commit_sha": commit,
        "git_tree_sha": tree,
        "acceptance_manifest_hash": sha256_file(ACCEPTANCE_MANIFEST),
        "evidence_index_hash": sha256_file(EVIDENCE_INDEX),
        "receipt_hash": receipt["receipt_sha256"],
        "build_id": (args.build_id or default_build_id(receipt)).strip(),
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    if not payload["build_id"]:
        raise ReleaseManifestError("build_id must not be empty")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
