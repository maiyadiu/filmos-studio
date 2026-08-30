#!/usr/bin/env python3
"""Run reproducible Film Core, Web bundle, Remote and Agent performance budgets."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
BETA = ROOT / "tests" / "film-beta"


def run_core() -> dict[str, Any]:
    core_python = os.environ.get("FILMOS_CORE_PYTHON", "").strip()
    if not core_python:
        raise RuntimeError("FILMOS_CORE_PYTHON is not acceptance-ready")
    result = subprocess.run(
        (core_python, str(BETA / "performance_local.py")),
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Film Core performance failed with exit {result.returncode}: "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    return json.loads(result.stdout)


def run_surface() -> dict[str, Any]:
    result = subprocess.run(
        ("bun", "tests/film-beta/performance_surface.ts"),
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"surface performance failed with exit {result.returncode}: "
            f"{result.stderr.strip()}"
        )
    return json.loads(result.stdout)


def main() -> int:
    try:
        core = run_core()
        surface = run_surface()
        passed = (
            core["test_status"] in {"PASSED", "PASSED_WITH_WARNING"}
            and not core["failures"]
            and surface["test_status"] == "PASSED"
            and not surface["failures"]
        )
        result = {
            "golden_id": "PERFORMANCE-LOCAL-001",
            "test_status": "PASSED" if passed else "FAILED",
            "core": core,
            "surface": surface,
            "external_provider_calls": 0,
            "network_actions": 0,
        }
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        result = {
            "golden_id": "PERFORMANCE-LOCAL-001",
            "test_status": "FAILED",
            "error_type": type(error).__name__,
            "error": str(error),
        }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["test_status"] == "PASSED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
