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
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from acceptance.swift_toolchain import (
    SwiftToolchain,
    SwiftToolchainError,
    inspect_toolchain,
    probe_testing,
    run_swift,
)


PACKAGE = ROOT / "desktop" / "macos"
PACKAGE_MANIFEST = PACKAGE / "Package.swift"
TOOLS_VERSION = re.compile(r"^// swift-tools-version:\s*(\d+)\.(\d+)", re.MULTILINE)


class DesktopReleaseError(RuntimeError):
    pass


def xcode_value(toolchain: SwiftToolchain, *arguments: str) -> str:
    result = subprocess.run(
        ("/usr/bin/xcrun", "--sdk", "macosx", *arguments),
        cwd=ROOT,
        env=toolchain.environment(),
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    value = result.stdout.strip()
    if result.returncode or not value:
        raise DesktopReleaseError(value or "Xcode default toolchain is unavailable")
    return value


def verify_apple_c_toolchain(toolchain: SwiftToolchain, require_explicit: bool) -> str:
    expected_cc = Path(xcode_value(toolchain, "--find", "clang")).resolve()
    expected_sdk = Path(toolchain.macos_sdk_path).resolve()
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
        env=toolchain.environment(),
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
            env=toolchain.environment(),
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


def main() -> int:
    try:
        toolchain = inspect_toolchain()
        probe_testing(toolchain)
    except SwiftToolchainError as error:
        raise DesktopReleaseError(str(error)) from error
    installed = tuple(int(part) for part in toolchain.swift_version.split("."))

    declaration = TOOLS_VERSION.search(PACKAGE_MANIFEST.read_text(encoding="utf-8"))
    if not declaration:
        raise DesktopReleaseError("Package.swift is missing its swift-tools-version contract")
    required = tuple(int(part) for part in declaration.groups())
    if installed[:2] < required:
        raise DesktopReleaseError(
            f"Swift {installed[0]}.{installed[1]}.{installed[2]} cannot build the declared {required[0]}.{required[1]} package"
        )

    apple_clang = verify_apple_c_toolchain(
        toolchain,
        require_explicit=bool(os.environ.get("CI", "")),
    )

    print(
        json.dumps(
            {
                "kind": "FILMOS_DESKTOP_SWIFT_TOOLCHAIN",
                "installed": toolchain.swift_version,
                "package_tools_version": ".".join(str(part) for part in required),
                "toolchain": toolchain.receipt(),
                "apple_c_toolchain": apple_clang,
                "apple_c_stdlib_probe": "PASSED",
                "macos_sdk": toolchain.macos_sdk_version,
                "swift_6_contract_sources": [
                    "desktop/macos/Package.swift",
                    "desktop/macos/Tests/FilmOSDesktopCoreTests",
                ],
            },
            sort_keys=True,
        )
    )
    result = run_swift(
        toolchain,
        ("build", "--package-path", str(PACKAGE), "-c", "release"),
        cwd=ROOT,
    )
    sys.stdout.write(result.stdout)
    return result.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except DesktopReleaseError as error:
        print(f"DESKTOP_RELEASE_ERROR {error}", file=sys.stderr)
        raise SystemExit(1)
