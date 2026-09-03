#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from acceptance.swift_toolchain import (
    SwiftToolchainError,
    inspect_toolchain,
    probe_testing,
    run_swift,
)


PACKAGE = ROOT / "desktop" / "macos"
SCRATCH = ROOT / ".local" / "acceptance-swift-test"


def main() -> int:
    try:
        toolchain = inspect_toolchain()
        probe_testing(toolchain)
    except SwiftToolchainError as error:
        print(json.dumps({
            "status": "FAILED",
            "error_code": error.code,
            "detail": error.detail,
        }, sort_keys=True))
        return 2
    print(json.dumps({
        "status": "TOOLCHAIN_READY",
        "testing_probe": "PASSED",
        "toolchain": toolchain.receipt(),
    }, sort_keys=True))
    result = run_swift(
        toolchain,
        ("test", "--package-path", str(PACKAGE), "--scratch-path", str(SCRATCH)),
        cwd=ROOT,
    )
    sys.stdout.write(result.stdout)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
