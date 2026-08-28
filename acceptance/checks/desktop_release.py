#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "desktop" / "macos"
PACKAGE_MANIFEST = PACKAGE / "Package.swift"
VERSION = re.compile(r"Swift version (\d+)\.(\d+)(?:\.(\d+))?")
TOOLS_VERSION = re.compile(r"^// swift-tools-version:\s*(\d+)\.(\d+)", re.MULTILINE)


class DesktopReleaseError(RuntimeError):
    pass


def command(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def parsed_version(value: str) -> tuple[int, int, int]:
    match = VERSION.search(value)
    if not match:
        raise DesktopReleaseError(
            "swift --version did not expose a parseable toolchain version"
        )
    return tuple(int(part or 0) for part in match.groups())


def main() -> int:
    probe = command("swift", "--version")
    if probe.returncode:
        raise DesktopReleaseError(
            probe.stdout.strip() or "Swift toolchain is unavailable"
        )
    installed = parsed_version(probe.stdout)

    declaration = TOOLS_VERSION.search(PACKAGE_MANIFEST.read_text(encoding="utf-8"))
    if not declaration:
        raise DesktopReleaseError("Package.swift is missing its swift-tools-version contract")
    required = tuple(int(part) for part in declaration.groups())
    if installed[:2] < required:
        raise DesktopReleaseError(
            f"Swift {installed[0]}.{installed[1]}.{installed[2]} cannot build the declared {required[0]}.{required[1]} package"
        )

    pinned = os.environ.get("FILMOS_DESKTOP_SWIFT_VERSION", "").strip()
    try:
        pinned_version = tuple(int(part) for part in pinned.split(".")) if pinned else ()
    except ValueError as error:
        raise DesktopReleaseError("FILMOS_DESKTOP_SWIFT_VERSION is invalid") from error
    if pinned and installed != pinned_version:
        raise DesktopReleaseError(
            f"GitHub Desktop toolchain drifted: expected {pinned}, got {installed[0]}.{installed[1]}.{installed[2]}"
        )

    print(
        json.dumps(
            {
                "kind": "FILMOS_DESKTOP_SWIFT_TOOLCHAIN",
                "installed": ".".join(str(part) for part in installed),
                "package_tools_version": ".".join(str(part) for part in required),
                "github_pin": pinned or None,
                "swift_6_contract_sources": [
                    "desktop/macos/Package.swift",
                    "desktop/macos/Tests/FilmOSDesktopCoreTests",
                ],
            },
            sort_keys=True,
        )
    )
    result = command(
        "swift", "build", "--package-path", str(PACKAGE), "-c", "release"
    )
    sys.stdout.write(result.stdout)
    return result.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except DesktopReleaseError as error:
        print(f"DESKTOP_RELEASE_ERROR {error}", file=sys.stderr)
        raise SystemExit(1)
