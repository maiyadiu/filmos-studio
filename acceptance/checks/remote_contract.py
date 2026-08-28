#!/usr/bin/env python3
"""Validate the stable Acceptance manifest and exclusive remote contract."""

from __future__ import annotations

import json
import re
import subprocess
import hashlib
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "acceptance" / "MANIFEST.json"
EXPECTED_SLUG = "maiyadiu/filmos-studio"
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class RemoteContractError(RuntimeError):
    pass


def git(*args: str, check: bool = True) -> str:
    result = subprocess.run(
        ("git", *args), cwd=ROOT, text=True, capture_output=True, check=False
    )
    if check and result.returncode != 0:
        raise RemoteContractError(
            f"git {' '.join(args)} failed with exit {result.returncode}"
        )
    return result.stdout.strip()


def repository_slug(value: str) -> str:
    raw = value.strip()
    if raw.startswith("git@github.com:"):
        path = raw.removeprefix("git@github.com:")
    elif raw.startswith("ssh://") or raw.startswith("https://"):
        parsed = urlparse(raw)
        if parsed.hostname != "github.com":
            raise RemoteContractError("acceptance remote host must be github.com")
        path = parsed.path.lstrip("/")
    else:
        raise RemoteContractError("unsupported acceptance remote URL")
    return path.removesuffix(".git").strip("/")


def require_sha(value: object, label: str) -> str:
    text = str(value or "")
    if not SHA_PATTERN.fullmatch(text):
        raise RemoteContractError(f"{label} must be a full lowercase Git SHA")
    return text


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_declared_paths(manifest: dict[str, object]) -> None:
    hashed = (
        manifest.get("acceptance_spec"),
        manifest.get("evidence_index"),
        manifest.get("golden_project"),
        manifest.get("yingce_upstream", {}).get("contract"),
        manifest.get("schema_versions", {}).get("film_core"),
        manifest.get("schema_versions", {}).get("mcp"),
    )
    for item in hashed:
        if not isinstance(item, dict):
            raise RemoteContractError("hashed manifest entries must be objects")
        relative = str(item.get("path", ""))
        claimed = str(item.get("sha256", ""))
        if not HASH_PATTERN.fullmatch(claimed):
            raise RemoteContractError(f"invalid manifest hash: {relative}")
        path = ROOT / relative
        if not path.is_file() or sha256_file(path) != claimed:
            raise RemoteContractError(f"manifest hash mismatch: {relative}")

    paths = (str(manifest.get("ci_workflow", "")),) + tuple(
        str(item) for item in manifest.get("required_reports", [])
    )
    for relative in paths:
        if not relative or relative.startswith("/") or ".." in Path(relative).parts:
            raise RemoteContractError(f"unsafe manifest path: {relative!r}")
        if not (ROOT / relative).is_file():
            raise RemoteContractError(f"manifest path is missing: {relative}")


def main() -> int:
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        canonical = manifest.get("canonical_remote")
        if not isinstance(canonical, dict):
            raise RemoteContractError("canonical_remote must be an object")
        if canonical.get("slug") != EXPECTED_SLUG:
            raise RemoteContractError("canonical acceptance repository changed")
        if canonical.get("remote_name") != "origin":
            raise RemoteContractError("canonical remote name must be origin")
        if canonical.get("exclusive_for_external_acceptance") is not True:
            raise RemoteContractError("external acceptance remote must be exclusive")

        fetch_slug = repository_slug(git("remote", "get-url", "origin"))
        push_slug = repository_slug(git("remote", "get-url", "--push", "origin"))
        if fetch_slug != EXPECTED_SLUG or push_slug != EXPECTED_SLUG:
            raise RemoteContractError(
                f"origin mismatch: fetch={fetch_slug} push={push_slug}"
            )

        forbidden = {
            "archive_commit_sha",
            "commit_sha_encoding",
            "acceptance_phase",
            "pre_rc",
            "rc",
            "git_commit_sha",
            "git_tree_sha",
        }
        present = sorted(forbidden.intersection(manifest))
        if present:
            raise RemoteContractError(
                "repository manifest contains release identity fields: "
                + ", ".join(present)
            )
        release = manifest.get("release_manifest")
        if not isinstance(release, dict):
            raise RemoteContractError("release_manifest contract is missing")
        if release.get("artifact_only") is not True or release.get("must_not_be_committed") is not True:
            raise RemoteContractError("release manifest must remain artifact-only")
        required = set(release.get("required_fields", []))
        expected = {
            "repository", "git_commit_sha", "git_tree_sha",
            "acceptance_manifest_hash", "evidence_index_hash",
            "receipt_hash", "build_id", "timestamp",
        }
        if required != expected:
            raise RemoteContractError("release manifest required fields changed")
        if manifest.get("planned_rc_tag") != "filmos-v1.0.0-rc1":
            raise RemoteContractError("planned immutable RC tag contract changed")

        validate_declared_paths(manifest)
        print(
            json.dumps(
                {
                    "golden_id": "REMOTE-ACCEPTANCE-CONTRACT-001",
                    "test_status": "PASSED",
                    "canonical_repository": EXPECTED_SLUG,
                    "fetch_slug": fetch_slug,
                    "push_slug": push_slug,
                    "manifest_schema_version": manifest["schema_version"],
                    "release_manifest_artifact_only": True,
                    "planned_rc_tag": manifest["planned_rc_tag"],
                },
                sort_keys=True,
            )
        )
        return 0
    except (OSError, ValueError, json.JSONDecodeError, RemoteContractError) as error:
        print(
            json.dumps(
                {
                    "golden_id": "REMOTE-ACCEPTANCE-CONTRACT-001",
                    "test_status": "FAILED",
                    "error_type": type(error).__name__,
                    "error": str(error),
                },
                sort_keys=True,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
