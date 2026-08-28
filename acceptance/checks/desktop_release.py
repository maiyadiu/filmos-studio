#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
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


def xcode_default(*arguments: str) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["TOOLCHAINS"] = "com.apple.dt.toolchain.XcodeDefault"
    return subprocess.run(
        ("/usr/bin/xcrun", "--sdk", "macosx", *arguments),
        cwd=ROOT,
        env=environment,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def xcode_value(*arguments: str) -> str:
    result = xcode_default(*arguments)
    value = result.stdout.strip()
    if result.returncode or not value:
        raise DesktopReleaseError(value or "Xcode default toolchain is unavailable")
    return value


def verify_apple_c_toolchain(require_explicit: bool) -> str:
    expected_cc = Path(xcode_value("--find", "clang")).resolve()
    expected_sdk = Path(xcode_value("--show-sdk-path")).resolve()
    configured_cc = os.environ.get("CC", "").strip()
    configured_sdk = os.environ.get("SDKROOT", "").strip()
    if require_explicit and (not configured_cc or not configured_sdk):
        raise DesktopReleaseError(
            "GitHub Desktop build must explicitly select the Xcode default CC and macOS SDKROOT"
        )

    cc = Path(configured_cc).resolve() if configured_cc else expected_cc
    sdk = Path(configured_sdk).resolve() if configured_sdk else expected_sdk
    if cc != expected_cc or sdk != expected_sdk:
        raise DesktopReleaseError(
            "Desktop C toolchain drifted from the Xcode default clang/macOS SDK"
        )
    if not cc.is_file() or not os.access(cc, os.X_OK) or not sdk.is_dir():
        raise DesktopReleaseError("Desktop C toolchain paths are unavailable")

    version = subprocess.run(
        (str(cc), "--version"),
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    first_line = version.stdout.splitlines()[0].strip() if version.stdout else ""
    if version.returncode or "Apple clang version" not in first_line:
        raise DesktopReleaseError("Desktop CC is not the Apple clang toolchain")

    with tempfile.TemporaryDirectory(prefix="filmos-c-toolchain-") as directory:
        source = Path(directory) / "probe.c"
        output = Path(directory) / "probe.o"
        source.write_text(
            "#include <stdlib.h>\nint filmos_c_toolchain_probe(void) { return EXIT_SUCCESS; }\n",
            encoding="utf-8",
        )
        probe = subprocess.run(
            (str(cc), "-isysroot", str(sdk), "-c", str(source), "-o", str(output)),
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        if probe.returncode or not output.is_file():
            raise DesktopReleaseError(
                probe.stdout.strip() or "Apple C toolchain could not compile the Desktop probe"
            )
    return first_line


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

    apple_clang = verify_apple_c_toolchain(require_explicit=bool(pinned))

    print(
        json.dumps(
            {
                "kind": "FILMOS_DESKTOP_SWIFT_TOOLCHAIN",
                "installed": ".".join(str(part) for part in installed),
                "package_tools_version": ".".join(str(part) for part in required),
                "github_pin": pinned or None,
                "apple_c_toolchain": apple_clang,
                "apple_c_stdlib_probe": "PASSED",
                "macos_sdk": "XcodeDefault/macosx",
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
