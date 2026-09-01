#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


CHECKS = Path(__file__).resolve().parents[1] / "checks"
sys.path.insert(0, str(CHECKS))

from desktop_runtime import bind_acceptance_build_id  # noqa: E402
from ui_golden import finalize  # noqa: E402


class BuildIDBindingTests(unittest.TestCase):
    def test_formal_acceptance_build_id_is_forwarded_exactly(self) -> None:
        environment = {
            "FILMOS_ACCEPTANCE_BUILD_ID": "github-33480196017-1",
            "FILMOS_DESKTOP_BUILD_ID": "candidate-old-build",
        }

        result = bind_acceptance_build_id(environment)

        self.assertIs(result, environment)
        self.assertEqual(result["FILMOS_DESKTOP_BUILD_ID"], "github-33480196017-1")

    def test_missing_acceptance_build_id_preserves_existing_desktop_build_id(self) -> None:
        environment = {"FILMOS_DESKTOP_BUILD_ID": "development-local"}

        result = bind_acceptance_build_id(environment)

        self.assertEqual(result["FILMOS_DESKTOP_BUILD_ID"], "development-local")

    def test_empty_acceptance_build_id_does_not_override_default_path(self) -> None:
        environment = {"FILMOS_ACCEPTANCE_BUILD_ID": ""}

        result = bind_acceptance_build_id(environment)

        self.assertNotIn("FILMOS_DESKTOP_BUILD_ID", result)

    def test_ui_golden_build_id_mismatch_still_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="filmos-build-id-binding-") as directory:
            root = Path(directory)
            (root / "CAPTURE_CONTEXT.json").write_text(
                json.dumps({
                    "git_commit_sha": "a" * 40,
                    "git_tree_sha": "b" * 40,
                    "build_id": "candidate-old-build",
                }),
                encoding="utf-8",
            )
            manifest = root / "RELEASE_MANIFEST.json"
            manifest.write_text(
                json.dumps({
                    "git_commit_sha": "a" * 40,
                    "git_tree_sha": "b" * 40,
                    "build_id": "github-33480196017-1",
                }),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(RuntimeError, "UI Golden release binding mismatch: build_id"):
                finalize(root, manifest)


if __name__ == "__main__":
    unittest.main()
