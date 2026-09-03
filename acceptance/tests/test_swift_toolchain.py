from __future__ import annotations

from pathlib import Path

import pytest

from acceptance.swift_toolchain import (
    SwiftToolchainError,
    parse_swift_version,
    parse_xcode_version,
    select_developer_dir,
)


def test_parses_frozen_xcode_identity() -> None:
    assert parse_xcode_version("Xcode 26.6\nBuild version 17F113\n") == ("26.6", "17F113")


def test_parses_frozen_swift_identity_and_target() -> None:
    value = (
        "swift-driver version: 1.148.6 Apple Swift version 6.3.3 "
        "(swiftlang-6.3.3.1.3 clang-2100.1.1.101)\n"
        "Target: arm64-apple-macosx26.0\n"
    )
    assert parse_swift_version(value) == ("6.3.3", "arm64-apple-macosx26.0")


@pytest.mark.parametrize("configured", ["Xcode.app/Contents/Developer", "/missing/Xcode.app/Contents/Developer"])
def test_rejects_non_full_xcode(configured: str) -> None:
    with pytest.raises(SwiftToolchainError) as caught:
        select_developer_dir({"FILMOS_XCODE_DEVELOPER_DIR": configured})
    assert caught.value.code == "FILMOS_SWIFT_TEST_TOOLCHAIN_UNAVAILABLE"


def test_accepts_full_xcode_directory_shape(tmp_path: Path) -> None:
    developer = tmp_path / "Xcode.app" / "Contents" / "Developer"
    xcodebuild = developer / "usr" / "bin" / "xcodebuild"
    xcodebuild.parent.mkdir(parents=True)
    xcodebuild.write_text("", encoding="utf-8")
    assert select_developer_dir({"FILMOS_XCODE_DEVELOPER_DIR": str(developer)}) == developer
