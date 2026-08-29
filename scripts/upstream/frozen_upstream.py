from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SCRIPT_DIR / "baseline.json"
DEFAULT_LOCAL_OBJECT_REPOSITORY = SCRIPT_DIR.parent.parent
LOCAL_STABLE_REF = "refs/filmos/upstream/stable"
LOCAL_CANDIDATE_REF = "refs/filmos/upstream/candidate"
SHA1 = re.compile(r"^[0-9a-f]{40}$")


class FrozenUpstreamError(RuntimeError):
    pass


def load_frozen_contract(config_path: str | Path = DEFAULT_CONFIG) -> dict[str, Any]:
    path = Path(config_path)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FrozenUpstreamError(f"cannot read frozen upstream contract: {error}") from error
    stable = payload.get("stable")
    candidate = payload.get("candidate")
    repository_url = payload.get("repository_url")
    if (
        not isinstance(stable, dict)
        or not isinstance(candidate, dict)
        or not isinstance(repository_url, str)
    ):
        raise FrozenUpstreamError(
            "frozen upstream repository/stable/candidate contract is incomplete"
        )
    for name, value in (
        ("stable.commit", stable.get("commit")),
        ("stable.tree", stable.get("tree")),
        ("candidate.commit", candidate.get("commit")),
        ("candidate.tree", candidate.get("tree")),
    ):
        if not isinstance(value, str) or not SHA1.fullmatch(value):
            raise FrozenUpstreamError(f"{name} must be one fixed Git object id")
    for name, value in (
        ("stable.source_ref", stable.get("source_ref")),
        ("candidate.source_ref", candidate.get("source_ref")),
    ):
        if not isinstance(value, str) or not value.startswith("refs/"):
            raise FrozenUpstreamError(f"{name} must be one full upstream ref")
    return {
        "repository": payload.get("repository"),
        "repository_url": repository_url,
        "stable": {
            "source_ref": stable["source_ref"],
            "commit": stable["commit"],
            "tree": stable["tree"],
        },
        "candidate": {
            "source_ref": candidate["source_ref"],
            "commit": candidate["commit"],
            "tree": candidate["tree"],
        },
    }


def _git(repo: Path, *arguments: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *arguments],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise FrozenUpstreamError(
            result.stderr.strip() or result.stdout.strip() or "git bootstrap failed"
        )
    return result.stdout.strip()


def prepare_frozen_upstream(
    destination: str | Path,
    *,
    contract: dict[str, Any] | None = None,
    local_object_repository: str | Path | None = DEFAULT_LOCAL_OBJECT_REPOSITORY,
) -> dict[str, Any]:
    frozen = contract or load_frozen_contract()
    target = Path(destination)
    if target.is_symlink() or target.exists():
        raise FrozenUpstreamError("frozen upstream destination must be a new path")
    target.parent.mkdir(parents=True, exist_ok=True)
    _git(target.parent, "init", "--bare", "--quiet", str(target))
    fetch_attempts = 0
    fetch_strategy = "exact_commit_shallow"
    try:
        stable = frozen["stable"]
        candidate = frozen["candidate"]
        local_source = Path(local_object_repository) if local_object_repository else None
        local_objects_ready = bool(
            local_source
            and _is_git_repository(local_source)
            and _has_commit(local_source, stable["commit"])
            and _has_commit(local_source, candidate["commit"])
        )
        if local_objects_ready and local_source:
            _git(
                target,
                "fetch",
                "--quiet",
                "--no-tags",
                str(local_source.resolve()),
                f"{stable['commit']}:{LOCAL_STABLE_REF}",
                f"{candidate['commit']}:{LOCAL_CANDIDATE_REF}",
            )
            fetch_strategy = "exact_commit_verified_local_object_cache"
        else:
            for fetch_attempts in range(1, 4):
                try:
                    _git(
                        target,
                        "fetch",
                        "--quiet",
                        "--depth=1",
                        "--no-tags",
                        frozen["repository_url"],
                        f"{stable['commit']}:{LOCAL_STABLE_REF}",
                        f"{candidate['commit']}:{LOCAL_CANDIDATE_REF}",
                    )
                    break
                except FrozenUpstreamError:
                    if fetch_attempts == 3:
                        raise
                    time.sleep(fetch_attempts)
        resolved_stable = _git(target, "rev-parse", f"{LOCAL_STABLE_REF}^{{commit}}")
        resolved_candidate = _git(target, "rev-parse", f"{LOCAL_CANDIDATE_REF}^{{commit}}")
        stable_tree = _git(target, "rev-parse", f"{LOCAL_STABLE_REF}^{{tree}}")
        candidate_tree = _git(target, "rev-parse", f"{LOCAL_CANDIDATE_REF}^{{tree}}")
        if resolved_stable != stable["commit"] or stable_tree != stable["tree"]:
            raise FrozenUpstreamError("fetched Stable object does not match the frozen contract")
        if resolved_candidate != candidate["commit"] or candidate_tree != candidate["tree"]:
            raise FrozenUpstreamError("fetched Candidate object does not match the frozen contract")
    except Exception:
        # The enclosing RC sandbox is temporary. Keep no half-trusted repository
        # after a failed fetch or object verification.
        shutil.rmtree(target, ignore_errors=True)
        raise
    return {
        "kind": "FILMOS_FROZEN_YINGCE_UPSTREAM_BOOTSTRAP",
        "status": "PASSED_EXACT_OBJECT_BOOTSTRAP",
        "repository": frozen["repository"],
        "repository_url": frozen["repository_url"],
        "fetch_strategy": fetch_strategy,
        "fetch_attempts": fetch_attempts,
        "stable": {**stable, "local_ref": LOCAL_STABLE_REF},
        "candidate": {**candidate, "local_ref": LOCAL_CANDIDATE_REF},
    }


def _has_commit(repository: Path, commit: str) -> bool:
    result = subprocess.run(
        ["git", "-C", str(repository), "cat-file", "-e", f"{commit}^{{commit}}"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0


def _is_git_repository(repository: Path) -> bool:
    result = subprocess.run(
        ["git", "-C", str(repository), "rev-parse", "--git-dir"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return result.returncode == 0
