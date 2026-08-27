#!/usr/bin/env python3

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "_compat.py"


class UpstreamCompatTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = Path(tempfile.mkdtemp(prefix="filmos-upstream-test-"))
        self.repo = self.temp / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "FilmOS Test")
        self.git("config", "user.email", "filmos-test@example.invalid")
        self.write(
            "backend/internal/handler/items.go",
            'package handler\nfunc routes(r Router) { r.GET("/items", nil) }\n',
        )
        self.write(
            "backend/internal/model/models.go",
            'package model\ntype Item struct {\n ID string `json:"id" gorm:"primaryKey"`\n}\n',
        )
        self.write(
            "backend/internal/database/schema.go",
            "package database\nfunc MigrateSchema() { AutoMigrate(Item{}) }\n",
        )
        self.write(
            "web/src/lib/canvas/canvas-document.ts",
            'export type CanvasNode = { id: string; kind: "text" };\n',
        )
        self.write(
            "canvas-agent/src/schemas.ts",
            'import { z } from "zod";\nexport const toolNames = ["canvas_get_state"] as const;\nexport const toolInputSchemas = {\n canvas_get_state: z.object({}),\n};\n',
        )
        self.write("plugins/yingce/.mcp.json", '{"mcpServers":{}}\n')
        self.git("add", ".")
        self.git("commit", "-qm", "stable")
        self.stable = self.git("rev-parse", "HEAD").stdout.strip()
        self.stable_tree = self.git("rev-parse", "HEAD^{tree}").stdout.strip()
        self.git("tag", "-a", "v1.2.1", "-m", "v1.2.1")
        self.git("tag", "filmos-upstream-v1.2.1")

        self.git("switch", "-qc", "candidate")
        self.write(
            "backend/internal/handler/items.go",
            'package handler\nfunc routes(r Router) { r.GET("/items", nil); r.POST("/items", nil) }\n',
        )
        self.write(
            "backend/internal/model/models.go",
            'package model\ntype Item struct {\n ID string `json:"id" gorm:"primaryKey"`\n Name string `json:"name"`\n}\n',
        )
        self.write(
            "backend/internal/database/schema.go",
            "package database\nfunc MigrateSchema() { AutoMigrate(Item{}, Audit{}) }\n",
        )
        self.write(
            "web/src/lib/canvas/canvas-document.ts",
            'export type CanvasNode = { id: string; kind: "text" | "image" };\n',
        )
        self.write(
            "canvas-agent/src/schemas.ts",
            'import { z } from "zod";\nexport const toolNames = ["canvas_get_state", "canvas_apply_ops"] as const;\nexport const toolInputSchemas = {\n canvas_get_state: z.object({}),\n canvas_apply_ops: z.object({ ops: z.array(z.unknown()) }),\n};\n',
        )
        self.git("add", ".")
        self.git("commit", "-qm", "candidate")

        self.git("switch", "-qc", "dev", self.stable)
        self.write("filmos.txt", "dev thin patch\n")
        self.git("add", ".")
        self.git("commit", "-qm", "dev")

        empty_tree = subprocess.run(
            ["git", "-C", str(self.repo), "mktree"],
            input="",
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        ).stdout.strip()
        unrelated = subprocess.run(
            ["git", "-C", str(self.repo), "commit-tree", empty_tree],
            input="unrelated\n",
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        ).stdout.strip()
        self.git("update-ref", "refs/heads/unrelated", unrelated)

        self.config = self.temp / "baseline.json"
        self.config.write_text(
            json.dumps(
                {
                    "repository": "fixture/repo",
                    "release_api": "https://example.invalid/releases/latest",
                    "stable": {
                        "tag": "v1.2.1",
                        "alias_tag": "filmos-upstream-v1.2.1",
                        "commit": self.stable,
                        "tree": self.stable_tree,
                    },
                    "candidate_ref": "candidate",
                    "dev_ref": "dev",
                    "remotes": {},
                    "read_only_reference_remotes": [],
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.temp, ignore_errors=True)

    def git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", str(self.repo), *args],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )

    def write(self, relative: str, content: str) -> None:
        path = self.repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def command(self, command: str, *args: str, expected: int = 0) -> dict[str, object]:
        process = subprocess.run(
            [
                "python3",
                str(SCRIPT),
                command,
                "--repo",
                str(self.repo),
                "--config",
                str(self.config),
                "--json",
                *args,
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(process.returncode, expected, process.stderr or process.stdout)
        return json.loads(process.stdout)

    def test_fixed_baseline_and_all_classifications(self) -> None:
        no_change = self.command("diff-api", "--candidate", "v1.2.1")
        self.assertEqual(no_change["classification"], "A_AUTO_COMPATIBLE")
        self.assertEqual(self.command("diff-api")["classification"], "B_ADAPTER_CHANGE")
        self.assertEqual(self.command("diff-models")["classification"], "C_MIGRATION_REQUIRED")
        self.assertEqual(self.command("diff-migrations")["classification"], "C_MIGRATION_REQUIRED")
        self.assertEqual(self.command("diff-canvas-schema")["classification"], "B_ADAPTER_CHANGE")
        self.assertEqual(self.command("diff-mcp")["classification"], "B_ADAPTER_CHANGE")

    def test_offline_release_degrades_without_claiming_current_release(self) -> None:
        result = self.command("check-release", "--offline")
        self.assertEqual(result["classification"], "B_ADAPTER_CHANGE")
        self.assertEqual(result["network_status"], "OFFLINE")
        self.assertIsNone(result["latest_release"])

    def test_non_descendant_candidate_is_blocked(self) -> None:
        result = self.command("diff-api", "--candidate", "unrelated", expected=2)
        self.assertEqual(result["classification"], "D_BLOCKED")
        self.assertTrue(any("not a descendant" in item for item in result["states"]["problems"]))

    def test_baseline_hash_drift_is_blocked(self) -> None:
        payload = json.loads(self.config.read_text(encoding="utf-8"))
        payload["stable"]["commit"] = "0" * 40
        bad_config = self.temp / "bad-baseline.json"
        bad_config.write_text(json.dumps(payload), encoding="utf-8")
        original = self.config
        self.config = bad_config
        try:
            result = self.command("diff-api", expected=2)
        finally:
            self.config = original
        self.assertEqual(result["classification"], "D_BLOCKED")
        self.assertTrue(any("stable tag drift" in item for item in result["states"]["problems"]))

    def test_report_manifests_and_rollback_dry_run(self) -> None:
        output = self.temp / "report"
        result = self.command("run-compat", "--offline", "--output", str(output))
        self.assertEqual(result["classification"], "C_MIGRATION_REQUIRED")
        self.assertTrue((output / "summary.json").is_file())
        self.assertTrue((output / "summary.md").is_file())
        self.assertIn("filmos.txt", (output / "thin-patch-manifest.tsv").read_text(encoding="utf-8"))
        self.assertIn("backend/internal/model/models.go", (output / "upstream-changes.tsv").read_text(encoding="utf-8"))
        rollback_result = self.command("rollback", "--dry-run")
        self.assertEqual(rollback_result["classification"], "A_AUTO_COMPATIBLE")
        self.assertEqual(rollback_result["target"], self.stable)
        unavailable_candidate = self.command("rollback", "--dry-run", "--candidate", "missing-candidate")
        self.assertEqual(unavailable_candidate["classification"], "A_AUTO_COMPATIBLE")


if __name__ == "__main__":
    unittest.main()
