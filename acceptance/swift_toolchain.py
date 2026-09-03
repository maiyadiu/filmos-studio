#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Mapping, Sequence


XCODE_VERSION = re.compile(r"^Xcode\s+(\S+)\nBuild version\s+(\S+)$", re.MULTILINE)
SWIFT_VERSION = re.compile(r"Apple Swift version\s+(\d+\.\d+\.\d+)")
SWIFT_TARGET = re.compile(r"^Target:\s+(\S+)$", re.MULTILINE)
EXPECTED_TUPLE = {
    "xcode_product_version": "26.6",
    "xcode_build": "17F113",
    "swift_version": "6.3.3",
    "swift_target": "arm64-apple-macosx26.0",
    "macos_sdk_version": "26.5",
    "macos_sdk_build": "25F70",
}
PIN_ENVIRONMENT = {
    "FILMOS_XCODE_PRODUCT_VERSION": "xcode_product_version",
    "FILMOS_XCODE_BUILD": "xcode_build",
    "FILMOS_DESKTOP_SWIFT_VERSION": "swift_version",
    "FILMOS_SWIFT_TARGET": "swift_target",
    "FILMOS_MACOS_SDK_VERSION": "macos_sdk_version",
    "FILMOS_MACOS_SDK_BUILD": "macos_sdk_build",
}


class SwiftToolchainError(RuntimeError):
    code = "FILMOS_SWIFT_TEST_TOOLCHAIN_UNAVAILABLE"

    def __init__(self, detail: str) -> None:
        super().__init__(f"{self.code}: {detail}")
        self.detail = detail


@dataclass(frozen=True)
class SwiftToolchain:
    developer_dir: str
    xcode_product_version: str
    xcode_build: str
    swift_version: str
    swift_target: str
    macos_sdk_version: str
    macos_sdk_build: str
    macos_sdk_path: str
    macos_platform_path: str
    runner_image: str

    def environment(self, base: Mapping[str, str] | None = None) -> dict[str, str]:
        environment = dict(base or os.environ)
        environment["DEVELOPER_DIR"] = self.developer_dir
        environment["TOOLCHAINS"] = "com.apple.dt.toolchain.XcodeDefault"
        return environment

    def receipt(self) -> dict[str, str]:
        return {"failure_code": SwiftToolchainError.code, **asdict(self)}


def _run(
    arguments: Sequence[str],
    *,
    developer_dir: Path,
    cwd: Path | None = None,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["DEVELOPER_DIR"] = str(developer_dir)
    environment["TOOLCHAINS"] = "com.apple.dt.toolchain.XcodeDefault"
    return subprocess.run(
        tuple(arguments),
        cwd=cwd,
        env=environment,
        input=input_text,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def _value(arguments: Sequence[str], *, developer_dir: Path) -> str:
    result = _run(arguments, developer_dir=developer_dir)
    value = result.stdout.strip()
    if result.returncode or not value:
        raise SwiftToolchainError(value or f"command failed: {' '.join(arguments)}")
    return value


def parse_xcode_version(value: str) -> tuple[str, str]:
    match = XCODE_VERSION.search(value.strip())
    if not match:
        raise SwiftToolchainError("xcodebuild -version returned an unsupported format")
    return match.group(1), match.group(2)


def parse_swift_version(value: str) -> tuple[str, str]:
    version = SWIFT_VERSION.search(value)
    target = SWIFT_TARGET.search(value)
    if not version or not target:
        raise SwiftToolchainError("swift --version did not expose version and target")
    return version.group(1), target.group(1)


def select_developer_dir(environment: Mapping[str, str] | None = None) -> Path:
    values = environment or os.environ
    configured = values.get("FILMOS_XCODE_DEVELOPER_DIR", "").strip()
    candidate = Path(configured) if configured else Path("/Applications/Xcode.app/Contents/Developer")
    if not candidate.is_absolute() or not candidate.is_dir():
        raise SwiftToolchainError("full Xcode Developer directory is unavailable")
    if not (candidate / "usr" / "bin" / "xcodebuild").is_file():
        raise SwiftToolchainError("selected directory is not a full Xcode installation")
    return candidate


def inspect_toolchain(environment: Mapping[str, str] | None = None) -> SwiftToolchain:
    values = environment or os.environ
    configured_runner = values.get("FILMOS_RUNNER_IMAGE", "").strip()
    if configured_runner and configured_runner != "macos-26":
        raise SwiftToolchainError(
            f"runner image drift: expected macos-26, got {configured_runner}"
        )
    developer_dir = select_developer_dir(values)
    xcode_product_version, xcode_build = parse_xcode_version(
        _value(("/usr/bin/xcodebuild", "-version"), developer_dir=developer_dir)
    )
    swift_version, swift_target = parse_swift_version(
        _value(("/usr/bin/xcrun", "swift", "--version"), developer_dir=developer_dir)
    )
    toolchain = SwiftToolchain(
        developer_dir=str(developer_dir),
        xcode_product_version=xcode_product_version,
        xcode_build=xcode_build,
        swift_version=swift_version,
        swift_target=swift_target,
        macos_sdk_version=_value(
            ("/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-version"),
            developer_dir=developer_dir,
        ),
        macos_sdk_build=_value(
            ("/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-build-version"),
            developer_dir=developer_dir,
        ),
        macos_sdk_path=_value(
            ("/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-path"),
            developer_dir=developer_dir,
        ),
        macos_platform_path=_value(
            ("/usr/bin/xcrun", "--sdk", "macosx", "--show-sdk-platform-path"),
            developer_dir=developer_dir,
        ),
        runner_image=configured_runner or "local-macos",
    )
    observed = asdict(toolchain)
    for field, expected in EXPECTED_TUPLE.items():
        if observed[field] != expected:
            raise SwiftToolchainError(
                f"toolchain tuple drift for {field}: expected {expected}, got {observed[field]}"
            )
    for environment_name, field in PIN_ENVIRONMENT.items():
        configured = values.get(environment_name, "").strip()
        if configured and configured != observed[field]:
            raise SwiftToolchainError(
                f"{environment_name} drift: expected selected {observed[field]}, got {configured}"
            )
    return toolchain


def probe_testing(toolchain: SwiftToolchain) -> None:
    frameworks = Path(toolchain.macos_platform_path) / "Developer" / "Library" / "Frameworks"
    if not frameworks.is_dir():
        raise SwiftToolchainError("Swift Testing framework directory is unavailable")
    result = _run(
        (
            "/usr/bin/xcrun",
            "swiftc",
            "-F",
            str(frameworks),
            "-typecheck",
            "-",
        ),
        developer_dir=Path(toolchain.developer_dir),
        input_text="import Testing\n",
    )
    if result.returncode:
        raise SwiftToolchainError(
            result.stdout.strip() or "the selected toolchain cannot import Testing"
        )


def run_swift(
    toolchain: SwiftToolchain,
    arguments: Sequence[str],
    *,
    cwd: Path,
) -> subprocess.CompletedProcess[str]:
    return _run(
        ("/usr/bin/xcrun", "swift", *arguments),
        developer_dir=Path(toolchain.developer_dir),
        cwd=cwd,
    )


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
    print(json.dumps({"status": "PASSED", **toolchain.receipt()}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
