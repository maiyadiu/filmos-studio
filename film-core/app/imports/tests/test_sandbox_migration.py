from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from app.imports import FEATURE_DEFAULT_ENABLED, IdBinding, MigrationSafetyError, SandboxMigration


class SandboxMigrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / ".filmos-migration-sandbox").write_text("fixture only\n")
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "剧本.md").write_text("第一场\n")
        (self.source / "assets").mkdir()
        (self.source / "assets" / "角色.txt").write_text("角色A\n")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_disabled_by_default(self) -> None:
        self.assertFalse(FEATURE_DEFAULT_ENABLED)
        engine = SandboxMigration(self.root)
        with self.assertRaisesRegex(MigrationSafetyError, "disabled by default"):
            engine.inventory(self.source, source_origin="generic-fixture")

    def test_requires_marker_and_rejects_paths_outside_sandbox(self) -> None:
        unmarked = self.root / "unmarked"
        unmarked.mkdir()
        with self.assertRaisesRegex(MigrationSafetyError, "marker missing"):
            SandboxMigration(unmarked, enabled=True)
        engine = SandboxMigration(self.root, enabled=True)
        with self.assertRaisesRegex(MigrationSafetyError, "inside the marked sandbox"):
            engine.inventory(Path(self.temporary.name).parent, source_origin="generic-fixture")

    def test_inventory_is_deterministic_and_rejects_symlinks(self) -> None:
        engine = SandboxMigration(self.root, enabled=True)
        first = engine.inventory(self.source, source_origin="system-a-fixture")
        second = engine.inventory(self.source, source_origin="system-a-fixture")
        self.assertEqual(first, second)
        self.assertEqual([item.source_path for item in first.items], ["assets/角色.txt", "剧本.md"])
        (self.source / "escape").symlink_to(self.root / ".filmos-migration-sandbox")
        with self.assertRaisesRegex(MigrationSafetyError, "symlinks are not allowed"):
            engine.inventory(self.source, source_origin="system-a-fixture")

    def test_dry_run_requires_uuid_versions_and_records_rollback(self) -> None:
        engine = SandboxMigration(self.root, enabled=True)
        inventory = engine.inventory(self.source, source_origin="three-homes-fixture")
        blocked = engine.build_dry_run_manifest(inventory, [])
        self.assertEqual(blocked["status"], "BLOCKED")
        self.assertEqual([item["code"] for item in blocked["blockers"]], ["FILM_ID_BINDING_MISSING", "FILM_ID_BINDING_MISSING"])

        manifest = engine.build_dry_run_manifest(inventory, bindings())
        self.assertEqual(manifest["status"], "READY_FOR_SANDBOX_EXPORT")
        self.assertFalse(manifest["formal_apply"])
        self.assertTrue(manifest["candidate_only"])
        self.assertEqual(manifest["backup"]["source_sha256"], inventory.source_hash)
        self.assertGreaterEqual(len(manifest["rollback_plan"]["steps"]), 4)
        self.assertTrue(all(item["version"] >= 0 and len(item["source_sha256"]) == 64 for item in manifest["items"]))

    def test_invalid_or_reused_film_ids_block_export(self) -> None:
        engine = SandboxMigration(self.root, enabled=True)
        inventory = engine.inventory(self.source, source_origin="generic-fixture")
        duplicate = "10000000-0000-4000-8000-000000000001"
        manifest = engine.build_dry_run_manifest(
            inventory,
            [
                IdBinding("assets/角色.txt", duplicate, "AssetVersion", 1),
                IdBinding("剧本.md", duplicate, "ScriptVersion", 2),
            ],
        )
        self.assertEqual(manifest["status"], "BLOCKED")
        self.assertIn("FILM_ID_REUSED", [item["code"] for item in manifest["blockers"]])
        with self.assertRaisesRegex(MigrationSafetyError, "blocked manifest"):
            engine.export_and_verify(self.source, self.root / "package", manifest)

        forged = engine.build_dry_run_manifest(inventory, bindings())
        forged = copy.deepcopy(forged)
        forged["items"][0]["film_entity_id"] = "not-a-film-id"
        with self.assertRaisesRegex(MigrationSafetyError, "Film identity is invalid"):
            engine.export_and_verify(self.source, self.root / "forged-package", forged)

        uppercase = engine.build_dry_run_manifest(
            inventory,
            [
                IdBinding("assets/角色.txt", "A0000000-0000-4000-8000-000000000001", "AssetVersion", 1),
                bindings()[1],
            ],
        )
        self.assertIn("FILM_UUID_V4_REQUIRED", [item["code"] for item in uppercase["blockers"]])

    def test_empty_or_schema_less_manifest_cannot_export(self) -> None:
        engine = SandboxMigration(self.root, enabled=True)
        empty_source = self.root / "empty"
        empty_source.mkdir()
        empty_inventory = engine.inventory(empty_source, source_origin="generic-fixture")
        empty_manifest = engine.build_dry_run_manifest(empty_inventory, [])
        self.assertIn("EMPTY_SOURCE_INVENTORY", [item["code"] for item in empty_manifest["blockers"]])

        manifest = engine.build_dry_run_manifest(engine.inventory(self.source, source_origin="generic-fixture"), bindings())
        del manifest["schema_version"]
        with self.assertRaisesRegex(MigrationSafetyError, "schema version"):
            engine.export_and_verify(self.source, self.root / "schema-less", manifest)

    def test_export_verify_is_idempotent_and_source_remains_unchanged(self) -> None:
        engine = SandboxMigration(self.root, enabled=True)
        inventory = engine.inventory(self.source, source_origin="system-a-fixture")
        manifest = engine.build_dry_run_manifest(inventory, bindings())
        preview = engine.write_dry_run_manifest(manifest, self.root / "preview")
        self.assertEqual(len(preview["sha256"]), 64)

        first = engine.export_and_verify(self.source, self.root / "package", manifest)
        second = engine.export_and_verify(self.source, self.root / "package", manifest)
        self.assertEqual(first, second)
        self.assertTrue(first["verified"])
        self.assertTrue(first["source_unchanged"])
        self.assertEqual(engine.inventory(self.source, source_origin="system-a-fixture").source_hash, inventory.source_hash)
        verification = json.loads((self.root / "package" / "verification.json").read_text())
        self.assertFalse(verification["formal_apply"])

    def test_verify_detects_tamper_and_never_overwrites(self) -> None:
        engine = SandboxMigration(self.root, enabled=True)
        inventory = engine.inventory(self.source, source_origin="generic-fixture")
        manifest = engine.build_dry_run_manifest(inventory, bindings())
        engine.export_and_verify(self.source, self.root / "package", manifest)
        payload = self.root / "package" / "payload" / "剧本.md"
        payload.write_text("被篡改\n")
        with self.assertRaisesRegex(MigrationSafetyError, "payload verification failed"):
            engine.verify_export(self.root / "package")
        with self.assertRaisesRegex(MigrationSafetyError, "refusing to overwrite mismatched payload"):
            engine.export_and_verify(self.source, self.root / "package", manifest)


def bindings() -> list[IdBinding]:
    return [
        IdBinding("assets/角色.txt", "10000000-0000-4000-8000-000000000001", "AssetVersion", 1),
        IdBinding("剧本.md", "20000000-0000-4000-8000-000000000002", "ScriptVersion", 3),
    ]


if __name__ == "__main__":
    unittest.main()
