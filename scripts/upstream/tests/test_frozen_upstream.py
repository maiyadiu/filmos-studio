from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
UPSTREAM_SCRIPTS = ROOT / "scripts" / "upstream"

sys.path.insert(0, str(UPSTREAM_SCRIPTS))

import frozen_upstream  # noqa: E402
from frozen_upstream import (  # noqa: E402
    LOCAL_CANDIDATE_REF,
    LOCAL_STABLE_REF,
    FrozenUpstreamError,
    prepare_frozen_upstream,
)


class FrozenUpstreamBootstrapTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(
            prefix="filmos-frozen-upstream-test-"
        )
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.git("init", "--quiet", "-b", "main", str(self.source), cwd=self.root)
        self.git("config", "user.name", "FilmOS Acceptance", cwd=self.source)
        self.git("config", "user.email", "acceptance@invalid.example", cwd=self.source)
        (self.source / "contract.txt").write_text("stable\n", encoding="utf-8")
        self.git("add", "contract.txt", cwd=self.source)
        self.git("commit", "--quiet", "-m", "stable", cwd=self.source)
        self.stable_commit = self.git("rev-parse", "HEAD", cwd=self.source)
        self.stable_tree = self.git("rev-parse", "HEAD^{tree}", cwd=self.source)
        self.git("tag", "stable", cwd=self.source)
        (self.source / "contract.txt").write_text("candidate\n", encoding="utf-8")
        self.git("commit", "--quiet", "-am", "candidate", cwd=self.source)
        self.candidate_commit = self.git("rev-parse", "HEAD", cwd=self.source)
        self.candidate_tree = self.git("rev-parse", "HEAD^{tree}", cwd=self.source)
        self.contract = {
            "repository": "fixture/frozen-upstream",
            "repository_url": str(self.source),
            "stable": {
                "source_ref": "refs/tags/stable",
                "commit": self.stable_commit,
                "tree": self.stable_tree,
            },
            "candidate": {
                "source_ref": "refs/heads/main",
                "commit": self.candidate_commit,
                "tree": self.candidate_tree,
            },
        }

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def git(*arguments: str, cwd: Path) -> str:
        return subprocess.run(
            ["git", *arguments],
            cwd=cwd,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def test_clean_repository_fetches_only_exact_frozen_objects(self) -> None:
        destination = self.root / "acceptance-upstream.git"
        receipt = prepare_frozen_upstream(destination, contract=self.contract)
        self.assertEqual(receipt["status"], "PASSED_EXACT_OBJECT_BOOTSTRAP")
        self.assertEqual(
            self.git("rev-parse", f"{LOCAL_STABLE_REF}^{{commit}}", cwd=destination),
            self.stable_commit,
        )
        self.assertEqual(
            self.git("rev-parse", f"{LOCAL_CANDIDATE_REF}^{{commit}}", cwd=destination),
            self.candidate_commit,
        )
        self.assertEqual(self.git("remote", cwd=destination), "")

    def test_tree_mismatch_rejects_and_removes_half_trusted_repository(self) -> None:
        destination = self.root / "rejected-upstream.git"
        self.contract["candidate"] = {
            **self.contract["candidate"],
            "tree": "0" * 40,
        }
        with self.assertRaisesRegex(FrozenUpstreamError, "Candidate object"):
            prepare_frozen_upstream(destination, contract=self.contract)
        self.assertFalse(destination.exists())

    def test_transient_fetch_failure_retries_without_changing_frozen_objects(self) -> None:
        destination = self.root / "retried-upstream.git"
        original_git = frozen_upstream._git
        attempts = 0

        def transient(repo: Path, *arguments: str) -> str:
            nonlocal attempts
            if arguments and arguments[0] == "fetch":
                attempts += 1
                if attempts == 1:
                    raise FrozenUpstreamError("transient fetch interruption")
            return original_git(repo, *arguments)

        with mock.patch.object(frozen_upstream, "_git", side_effect=transient), mock.patch.object(frozen_upstream.time, "sleep"):
            receipt = prepare_frozen_upstream(destination, contract=self.contract)

        self.assertEqual(attempts, 2)
        self.assertEqual(receipt["fetch_attempts"], 2)
        self.assertEqual(
            self.git("rev-parse", f"{LOCAL_CANDIDATE_REF}^{{commit}}", cwd=destination),
            self.candidate_commit,
        )


if __name__ == "__main__":
    unittest.main()
