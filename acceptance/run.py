#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EVIDENCE_ROOT = ROOT / "acceptance" / "evidence" / "runs"


@dataclass(frozen=True)
class Check:
    check_id: str
    title: str
    command: tuple[str, ...]
    cwd: Path
    tracks: tuple[str, ...]


CURRENT_CHECKS = (
    Check(
        "desktop-brand",
        "FilmOS desktop icon and visible brand contract",
        (sys.executable, "acceptance/checks/desktop_brand.py"),
        ROOT,
        ("01-desktop", "03-project-ui"),
    ),
    Check(
        "desktop-local-auth",
        "Loopback-only desktop local authentication and self-contained web service",
        ("go", "test", "./internal/service", "./internal/handler", "./cmd/server", "./cmd/desktop-web"),
        ROOT / "backend",
        ("01-desktop", "02-film-core"),
    ),
    Check(
        "web-typecheck",
        "Web TypeScript contract",
        ("bun", "run", "typecheck"),
        ROOT / "web",
        ("03-project-ui", "14-chatgpt-app"),
    ),
    Check(
        "web-production-build",
        "Web production build",
        ("bun", "run", "build"),
        ROOT / "web",
        ("03-project-ui", "14-chatgpt-app"),
    ),
    Check(
        "desktop-release-build",
        "Pinned Swift 6 formal Desktop release build contract",
        (sys.executable, "acceptance/checks/desktop_release.py"),
        ROOT,
        ("01-desktop",),
    ),
)


RC_LOCAL_CHECKS = CURRENT_CHECKS + (
    Check(
        "film-core-environment",
        "Acceptance-owned Film Core Python dependency contract",
        (sys.executable, "acceptance/checks/film_core_environment.py"),
        ROOT,
        ("02-film-core", "08-agent", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "desktop-runtime",
        "Double-click lifecycle, loopback services and cookie-free local session",
        (sys.executable, "acceptance/checks/desktop_runtime.py"),
        ROOT,
        ("01-desktop", "03-project-ui"),
    ),
    Check(
        "desktop-backup-restore",
        "Local data export, manifest verification and clean restart restore",
        (sys.executable, "acceptance/checks/desktop_backup_restore.py"),
        ROOT,
        ("01-desktop", "02-film-core", "13-qa"),
    ),
    Check(
        "film-contracts",
        "Film contract validation",
        (sys.executable, "tests/film-contract/validate_contracts.py"),
        ROOT,
        ("02-film-core", "13-qa"),
    ),
    Check(
        "golden-abc-real-http",
        "Golden A/B/C real temporary Film Core HTTP chain",
        (
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "tests/film-golden/test_golden_a_real.py",
            "tests/film-golden/test_golden_b_real.py",
            "tests/film-golden/test_golden_c_real.py",
        ),
        ROOT,
        ("02-film-core", "04-story", "05-production-canvas", "06-assets", "07-prompt", "09-director", "10-providers", "13-qa"),
    ),
    Check(
        "acceptance-full-chain",
        "Fixed FilmOS Acceptance Project full Local-first chain",
        (sys.executable, "acceptance/checks/full_chain.py"),
        ROOT,
        ("02-film-core", "04-story", "05-production-canvas", "06-assets", "07-prompt", "09-director", "10-providers", "13-qa"),
    ),
    Check(
        "performance-local",
        "Film Core, Web bundle, Remote and Agent reproducible budgets",
        (sys.executable, "acceptance/checks/performance.py"),
        ROOT,
        ("02-film-core", "03-project-ui", "08-agent", "12-remote", "13-qa"),
    ),
    Check(
        "rc-recovery",
        "Unified restart, migration, source integrity and rollback drill",
        ("scripts/recovery/RC恢复演练", "--synthetic"),
        ROOT,
        ("02-film-core", "08-agent", "11-migration", "12-remote", "13-qa"),
    ),
    Check(
        "canvas-agent",
        "Codex Agent regression and build",
        ("npm", "test"),
        ROOT / "canvas-agent",
        ("08-agent", "13-qa"),
    ),
    Check(
        "chatgpt-handoff-local",
        "ChatGPT MCP, Widget and local handoff regression",
        ("npm", "test"),
        ROOT / "services" / "filmos-chatgpt-app",
        ("13-qa", "14-chatgpt-app"),
    ),
    Check(
        "chatgpt-golden-real",
        "Real Film Core to MCP, Widget and proposal CLI Golden",
        ("npm", "run", "test:golden-real"),
        ROOT / "services" / "filmos-chatgpt-app",
        ("13-qa", "14-chatgpt-app"),
    ),
    Check(
        "upstream-compatibility",
        "Pinned upstream compatibility and rollback tests",
        (sys.executable, "-m", "unittest", "discover", "-s", "scripts/upstream/tests", "-v"),
        ROOT,
        ("00-upstream", "11-migration", "13-qa"),
    ),
    Check(
        "remote-acceptance-contract",
        "Stable Acceptance manifest and exclusive maiyadiu/filmos-studio remote contract",
        (sys.executable, "acceptance/checks/remote_contract.py"),
        ROOT,
        ("12-remote", "13-qa"),
    ),
    Check(
        "acceptance-reports",
        "Hashed Acceptance reports bound to original receipts and raw sources",
        (sys.executable, "acceptance/checks/reports.py"),
        ROOT,
        ("00-upstream", "02-film-core", "11-migration", "12-remote", "13-qa"),
    ),
    Check(
        "evidence-index-contract",
        "Stable Track evidence contract without runtime or release identity",
        (sys.executable, "acceptance/checks/evidence_index.py"),
        ROOT,
        ("13-qa",),
    ),
    Check(
        "acceptance-privacy",
        "Acceptance evidence privacy and secret scan",
        (sys.executable, "acceptance/checks/privacy.py"),
        ROOT,
        ("13-qa",),
    ),
)


def canonical(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def redact_text(text: str) -> str:
    replacements = {
        str(ROOT): "$REPO",
        str(Path.home()): "$HOME",
    }
    for source, target in sorted(replacements.items(), key=lambda item: len(item[0]), reverse=True):
        if source:
            text = text.replace(source, target)
    text = re.sub(r"/(?:private/)?var/folders/[^\s]+", "$TMP", text)
    patterns = (
        (r"(?i)(authorization:\s*bearer\s+)[^\s]+", r"\1[REDACTED]"),
        (r"(?i)(cookie:\s*)[^\r\n]+", r"\1[REDACTED]"),
        (r"(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[=:]\s*)[^\s,;]+", r"\1[REDACTED]"),
        (r"\bsk-[A-Za-z0-9_-]{12,}\b", "[REDACTED_API_KEY]"),
    )
    for pattern, replacement in patterns:
        text = re.sub(pattern, replacement, text)
    return text


def redact_log(value: bytes) -> bytes:
    text = redact_text(value.decode("utf-8", errors="replace"))
    normalized = "\n".join(line.rstrip() for line in text.splitlines())
    if text.endswith(("\n", "\r")):
        normalized += "\n"
    return normalized.encode("utf-8")


def git_value(*args: str) -> str:
    result = subprocess.run(("git", *args), cwd=ROOT, text=True, capture_output=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


def source_snapshot_sha256() -> str:
    result = subprocess.run(
        ("git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"),
        cwd=ROOT,
        capture_output=True,
        check=True,
    )
    digest = hashlib.sha256()
    for raw_path in sorted(item for item in result.stdout.split(b"\0") if item):
        relative = raw_path.decode("utf-8", errors="surrogateescape")
        path = ROOT / relative
        digest.update(raw_path + b"\0")
        if path.is_symlink():
            digest.update(b"SYMLINK\0" + os.readlink(path).encode("utf-8", errors="surrogateescape"))
        elif path.is_file():
            digest.update(b"FILE\0")
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
        else:
            digest.update(b"MISSING\0")
        digest.update(b"\0")
    return digest.hexdigest()


def selected_checks(suite: str) -> Sequence[Check]:
    if suite == "current":
        return CURRENT_CHECKS
    if suite == "rc-local":
        return RC_LOCAL_CHECKS
    raise ValueError(suite)


def resolve_film_core_python(environment: dict[str, str]) -> str | None:
    candidates = (
        environment.get("FILMOS_CORE_PYTHON", ""),
        environment.get("FILMOS_TEST_PYTHON", ""),
        str(ROOT / ".local" / "acceptance-venv" / "bin" / "python"),
        sys.executable,
    )
    seen: set[str] = set()
    for raw_candidate in candidates:
        candidate = raw_candidate.strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        executable = candidate if Path(candidate).is_absolute() else shutil.which(candidate)
        if not executable:
            continue
        probe = subprocess.run(
            (
                executable,
                "-c",
                "import fastapi,httpx,jsonschema,pydantic,pytest,uvicorn",
            ),
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if probe.returncode == 0:
            return executable
    return None


def acceptance_environment() -> tuple[dict[str, str], bool]:
    environment = os.environ.copy()
    python = resolve_film_core_python(environment)
    if python:
        environment["FILMOS_CORE_PYTHON"] = python
        environment["FILMOS_TEST_PYTHON"] = python
    else:
        environment.pop("FILMOS_CORE_PYTHON", None)
        environment.pop("FILMOS_TEST_PYTHON", None)
    return environment, python is not None


def run_check(check: Check, run_dir: Path, environment: dict[str, str]) -> dict[str, object]:
    log_path = run_dir / f"{check.check_id}.log"
    started = time.monotonic()
    process = subprocess.run(
        check.command,
        cwd=check.cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=environment,
        check=False,
    )
    log_path.write_bytes(redact_log(process.stdout or b""))
    duration_ms = round((time.monotonic() - started) * 1000, 3)
    return {
        "check_id": check.check_id,
        "title": check.title,
        "tracks": list(check.tracks),
        "status": "PASSED" if process.returncode == 0 else "FAILED",
        "exit_code": process.returncode,
        "duration_ms": duration_ms,
        "cwd": str(check.cwd.relative_to(ROOT)) or ".",
        "command": [redact_text(value) for value in check.command],
        "log": log_path.name,
        "log_sha256": sha256_file(log_path),
        "log_bytes": log_path.stat().st_size,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="FilmOS reproducible acceptance runner")
    parser.add_argument("--suite", choices=("current", "rc-local"), default="current")
    parser.add_argument("--only", action="append", default=[], help="run only the named check; repeatable")
    parser.add_argument("--evidence-root", type=Path, default=DEFAULT_EVIDENCE_ROOT)
    parser.add_argument("--receipt-path-file", type=Path)
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()

    checks = list(selected_checks(args.suite))
    if args.only:
        requested = set(args.only)
        checks = [check for check in checks if check.check_id in requested]
        missing = requested - {check.check_id for check in checks}
        if missing:
            parser.error(f"unknown checks: {', '.join(sorted(missing))}")
    if args.list:
        for check in checks:
            print(check.check_id)
        return 0

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    short_head = git_value("rev-parse", "--short=12", "HEAD") or "no-git"
    initial_worktree_porcelain = git_value("status", "--short")
    initial_source_snapshot = source_snapshot_sha256()
    environment, film_core_python_ready = acceptance_environment()
    run_id = f"{timestamp}-{short_head}-{args.suite}"
    run_dir = args.evidence_root.resolve() / run_id
    run_dir.mkdir(parents=True, exist_ok=False)

    results = []
    for check in checks:
        print(f"[{check.check_id}] {check.title}", flush=True)
        result = run_check(check, run_dir, environment)
        results.append(result)
        print(f"[{check.check_id}] {result['status']} ({result['duration_ms']} ms)", flush=True)

    payload: dict[str, object] = {
        "schema_version": "1.0.0",
        "run_id": run_id,
        "suite": args.suite,
        "status": "PASSED" if all(result["status"] == "PASSED" for result in results) else "FAILED",
        "started_from_commit": git_value("rev-parse", "HEAD"),
        "branch": git_value("branch", "--show-current"),
        "clean_worktree": initial_worktree_porcelain == "",
        "source_snapshot_sha256": initial_source_snapshot,
        "worktree_porcelain": initial_worktree_porcelain,
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "film_core_python_ready": film_core_python_ready,
        "results": results,
    }
    payload["receipt_sha256"] = hashlib.sha256(canonical(payload)).hexdigest()
    receipt_path = run_dir / "receipt.json"
    receipt_path.write_bytes(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2).encode() + b"\n")
    if args.receipt_path_file:
        args.receipt_path_file.write_text(str(receipt_path) + "\n", encoding="utf-8")
    print(receipt_path)
    return 0 if payload["status"] == "PASSED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
