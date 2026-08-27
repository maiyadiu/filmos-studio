from __future__ import annotations

import hashlib
import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

FEATURE_DEFAULT_ENABLED = False
SANDBOX_MARKER = ".filmos-migration-sandbox"
MANIFEST_NAME = "manifest.json"
MANIFEST_HASH_NAME = "manifest.sha256"
VERIFICATION_NAME = "verification.json"
ALLOWED_ORIGINS = {"system-a-fixture", "three-homes-fixture", "generic-fixture"}


class MigrationSafetyError(RuntimeError):
    pass


@dataclass(frozen=True)
class IdBinding:
    source_path: str
    film_entity_id: str
    entity_type: str
    version: int


@dataclass(frozen=True)
class InventoryItem:
    source_path: str
    bytes: int
    sha256: str


@dataclass(frozen=True)
class Inventory:
    source_root: str
    source_origin: str
    source_hash: str
    items: tuple[InventoryItem, ...]


class SandboxMigration:
    """A dry-run/export harness that cannot leave a marker-bound sandbox."""

    def __init__(self, sandbox_root: str | Path, *, enabled: bool = FEATURE_DEFAULT_ENABLED):
        root = Path(sandbox_root)
        if root.is_symlink():
            raise MigrationSafetyError("sandbox root must not be a symlink")
        self.root = root.resolve(strict=True)
        marker = self.root / SANDBOX_MARKER
        if not marker.is_file() or marker.is_symlink():
            raise MigrationSafetyError(f"sandbox marker missing: {SANDBOX_MARKER}")
        self.enabled = enabled

    def inventory(self, source_dir: str | Path, *, source_origin: str) -> Inventory:
        self._require_enabled()
        if source_origin not in ALLOWED_ORIGINS:
            raise MigrationSafetyError("only fixture origins are allowed in the first migration slice")
        source = self._contained_directory(source_dir, "source")
        items: list[InventoryItem] = []
        for path in sorted(source.rglob("*"), key=lambda item: item.as_posix()):
            if path.is_symlink():
                raise MigrationSafetyError(f"symlinks are not allowed: {path.relative_to(source).as_posix()}")
            if not path.is_file():
                continue
            relative = path.relative_to(source).as_posix()
            digest, size = hash_file(path)
            items.append(InventoryItem(source_path=relative, bytes=size, sha256=digest))
        source_hash = sha256_bytes(canonical_json([item.__dict__ for item in items]))
        return Inventory(
            source_root=source.relative_to(self.root).as_posix(),
            source_origin=source_origin,
            source_hash=source_hash,
            items=tuple(items),
        )

    def build_dry_run_manifest(self, inventory: Inventory, bindings: Iterable[IdBinding]) -> dict[str, Any]:
        self._require_enabled()
        binding_by_path: dict[str, IdBinding] = {}
        blockers: list[dict[str, str]] = []
        film_ids: dict[str, str] = {}
        for binding in bindings:
            path = normalized_relative_path(binding.source_path)
            if path in binding_by_path:
                blockers.append(blocker("DUPLICATE_SOURCE_BINDING", path, "同一来源路径存在重复 ID Binding"))
                continue
            binding_by_path[path] = binding
            if not is_uuid_v4(binding.film_entity_id):
                blockers.append(blocker("FILM_UUID_V4_REQUIRED", path, "正式目标 ID 必须是 Film Core 预分配 UUIDv4"))
            if not binding.entity_type.strip():
                blockers.append(blocker("ENTITY_TYPE_REQUIRED", path, "ID Binding 必须声明实体类型"))
            if not isinstance(binding.version, int) or isinstance(binding.version, bool) or binding.version < 0:
                blockers.append(blocker("VERSION_INVALID", path, "版本必须是非负整数"))
            previous_path = film_ids.get(binding.film_entity_id)
            if previous_path and previous_path != path:
                blockers.append(blocker("FILM_ID_REUSED", path, f"Film ID 已绑定到 {previous_path}"))
            film_ids[binding.film_entity_id] = path

        inventory_paths = {item.source_path for item in inventory.items}
        if not inventory.items:
            blockers.append(blocker("EMPTY_SOURCE_INVENTORY", inventory.source_root, "空来源不能形成可导出的迁移预演"))
        manifest_items: list[dict[str, Any]] = []
        for item in inventory.items:
            binding = binding_by_path.get(item.source_path)
            if not binding:
                blockers.append(blocker("FILM_ID_BINDING_MISSING", item.source_path, "来源文件尚未绑定 Film Core UUIDv4 与版本"))
            manifest_items.append(
                {
                    "source_path": item.source_path,
                    "source_origin": inventory.source_origin,
                    "source_sha256": item.sha256,
                    "bytes": item.bytes,
                    "film_entity_id": binding.film_entity_id if binding else None,
                    "entity_type": binding.entity_type.strip() if binding else None,
                    "version": binding.version if binding else None,
                }
            )
        for extra in sorted(set(binding_by_path) - inventory_paths):
            blockers.append(blocker("SOURCE_PATH_MISSING", extra, "ID Binding 指向的来源文件不存在"))

        blockers.sort(key=lambda item: (item["path"], item["code"]))
        return {
            "schema_version": 1,
            "mode": "dry_run",
            "formal_apply": False,
            "candidate_only": True,
            "status": "BLOCKED" if blockers else "READY_FOR_SANDBOX_EXPORT",
            "source": {
                "origin": inventory.source_origin,
                "root": inventory.source_root,
                "sha256": inventory.source_hash,
                "item_count": len(inventory.items),
            },
            "items": manifest_items,
            "blockers": blockers,
            "backup": {
                "strategy": "immutable_source",
                "source_sha256": inventory.source_hash,
                "formal_import_requirement": "经批准的独立目标备份回执；本首切片不会打开或修改数据库",
            },
            "rollback_plan": {
                "automatic_actions": [],
                "steps": [
                    "停止在 dry-run/export 阶段，不执行 formal apply",
                    "保留来源目录并复核 source sha256 未变化",
                    "仅在单独授权后丢弃 sandbox export；本工具不提供删除命令",
                    "未来正式导入若失败，按目标备份回执恢复并重新核对 ID Mapping 与引用",
                ],
            },
        }

    def write_dry_run_manifest(self, manifest: dict[str, Any], output_dir: str | Path) -> dict[str, str]:
        self._require_enabled()
        output = self._contained_output(output_dir, "manifest output")
        output.mkdir(parents=True, exist_ok=True)
        encoded = canonical_json(manifest)
        digest = sha256_bytes(encoded)
        write_once(output / MANIFEST_NAME, encoded)
        write_once(output / MANIFEST_HASH_NAME, f"{digest}  {MANIFEST_NAME}\n".encode())
        return {"manifest": str(output / MANIFEST_NAME), "sha256": digest}

    def export_and_verify(self, source_dir: str | Path, package_dir: str | Path, manifest: dict[str, Any]) -> dict[str, Any]:
        self._require_enabled()
        validate_export_manifest(manifest)
        source = self._contained_directory(source_dir, "source")
        package = self._contained_output(package_dir, "package")
        if is_within(package, source) or is_within(source, package):
            raise MigrationSafetyError("source and package directories must not contain each other")

        before = self.inventory(source, source_origin=manifest["source"]["origin"])
        if before.source_root != manifest["source"]["root"]:
            raise MigrationSafetyError("source path does not match the locked dry-run manifest")
        if before.source_hash != manifest["source"]["sha256"]:
            raise MigrationSafetyError("source changed after dry-run inventory")

        package.mkdir(parents=True, exist_ok=True)
        payload = package / "payload"
        payload.mkdir(parents=True, exist_ok=True)
        for item in manifest["items"]:
            relative = normalized_relative_path(item["source_path"])
            source_file = checked_child(source, relative)
            destination = checked_child(payload, relative, must_exist=False)
            destination.parent.mkdir(parents=True, exist_ok=True)
            copy_once(source_file, destination, item["source_sha256"], item["bytes"])

        self.write_dry_run_manifest(manifest, package)
        verification = self.verify_export(package)
        after = self.inventory(source, source_origin=manifest["source"]["origin"])
        if after.source_hash != before.source_hash:
            raise MigrationSafetyError("source changed during sandbox export")
        report = {
            **verification,
            "source_unchanged": True,
            "rollback_plan_present": bool(manifest.get("rollback_plan", {}).get("steps")),
        }
        write_once(package / VERIFICATION_NAME, canonical_json(report))
        return report

    def verify_export(self, package_dir: str | Path) -> dict[str, Any]:
        self._require_enabled()
        package = self._contained_directory(package_dir, "package")
        manifest_path = package / MANIFEST_NAME
        hash_path = package / MANIFEST_HASH_NAME
        if not manifest_path.is_file() or manifest_path.is_symlink() or not hash_path.is_file() or hash_path.is_symlink():
            raise MigrationSafetyError("manifest or hash sidecar missing")
        encoded = manifest_path.read_bytes()
        digest = sha256_bytes(encoded)
        expected_sidecar = f"{digest}  {MANIFEST_NAME}\n"
        if hash_path.read_text() != expected_sidecar:
            raise MigrationSafetyError("manifest hash sidecar mismatch")
        manifest = json.loads(encoded)
        validate_export_manifest(manifest)

        payload = package / "payload"
        expected_paths = {normalized_relative_path(item["source_path"]) for item in manifest["items"]}
        actual_paths: set[str] = set()
        for path in payload.rglob("*"):
            if path.is_symlink():
                raise MigrationSafetyError("payload contains a symlink")
            if path.is_file():
                actual_paths.add(path.relative_to(payload).as_posix())
        if actual_paths != expected_paths:
            raise MigrationSafetyError("payload file set does not match manifest")
        for item in manifest["items"]:
            path = checked_child(payload, item["source_path"])
            digest_value, size = hash_file(path)
            if digest_value != item["source_sha256"] or size != item["bytes"]:
                raise MigrationSafetyError(f"payload verification failed: {item['source_path']}")
        return {
            "verified": True,
            "formal_apply": False,
            "candidate_only": True,
            "manifest_sha256": digest,
            "source_sha256": manifest["source"]["sha256"],
            "item_count": len(manifest["items"]),
        }

    def _require_enabled(self) -> None:
        if not self.enabled:
            raise MigrationSafetyError("film migration preview is disabled by default")

    def _contained_directory(self, path: str | Path, label: str) -> Path:
        resolved = self._contained(path, label, must_exist=True)
        if not resolved.is_dir() or resolved.is_symlink():
            raise MigrationSafetyError(f"{label} must be a real directory")
        return resolved

    def _contained_output(self, path: str | Path, label: str) -> Path:
        resolved = self._contained(path, label, must_exist=False)
        if resolved == self.root:
            raise MigrationSafetyError(f"{label} must not be the sandbox root")
        if resolved.exists() and (not resolved.is_dir() or resolved.is_symlink()):
            raise MigrationSafetyError(f"{label} must be a real directory")
        return resolved

    def _contained(self, path: str | Path, label: str, *, must_exist: bool) -> Path:
        candidate = Path(path)
        if candidate.is_symlink():
            raise MigrationSafetyError(f"{label} must not be a symlink")
        try:
            resolved = candidate.resolve(strict=must_exist)
        except FileNotFoundError as error:
            raise MigrationSafetyError(f"{label} does not exist") from error
        if resolved == self.root or not is_within(resolved, self.root):
            raise MigrationSafetyError(f"{label} must stay inside the marked sandbox")
        return resolved


def normalized_relative_path(value: str) -> str:
    path = Path(value)
    if path.is_absolute() or not value.strip() or ".." in path.parts:
        raise MigrationSafetyError(f"unsafe relative path: {value}")
    normalized = path.as_posix()
    if normalized in {".", ""}:
        raise MigrationSafetyError(f"unsafe relative path: {value}")
    return normalized


def checked_child(root: Path, relative: str, *, must_exist: bool = True) -> Path:
    normalized = normalized_relative_path(relative)
    candidate = root / normalized
    if candidate.is_symlink():
        raise MigrationSafetyError(f"symlink path rejected: {relative}")
    resolved = candidate.resolve(strict=must_exist)
    if not is_within(resolved, root):
        raise MigrationSafetyError(f"path escapes root: {relative}")
    return resolved


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def hash_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def is_uuid_v4(value: str) -> bool:
    import uuid

    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        return False
    return parsed.version == 4 and str(parsed) == value


def validate_export_manifest(manifest: dict[str, Any]) -> None:
    if manifest.get("schema_version") != 1:
        raise MigrationSafetyError("manifest schema version is invalid")
    if manifest.get("mode") != "dry_run" or manifest.get("formal_apply") is not False or manifest.get("candidate_only") is not True:
        raise MigrationSafetyError("only a non-formal dry-run candidate manifest can be exported")
    if manifest.get("status") != "READY_FOR_SANDBOX_EXPORT" or manifest.get("blockers"):
        raise MigrationSafetyError("blocked manifest cannot be exported")
    source = manifest.get("source")
    if not isinstance(source, dict) or source.get("origin") not in ALLOWED_ORIGINS or not is_sha256(source.get("sha256")):
        raise MigrationSafetyError("manifest source identity is invalid")
    if not isinstance(source.get("root"), str):
        raise MigrationSafetyError("manifest source root is invalid")
    normalized_relative_path(source["root"])
    items = manifest.get("items")
    if not isinstance(items, list) or source.get("item_count") != len(items):
        raise MigrationSafetyError("manifest item count is invalid")
    paths: set[str] = set()
    film_ids: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise MigrationSafetyError("manifest item is invalid")
        path = normalized_relative_path(item.get("source_path", ""))
        film_id = item.get("film_entity_id")
        version = item.get("version")
        if path in paths or film_id in film_ids:
            raise MigrationSafetyError("manifest paths and Film IDs must be unique")
        if item.get("source_origin") != source["origin"] or not is_sha256(item.get("source_sha256")):
            raise MigrationSafetyError(f"manifest source binding is invalid: {path}")
        if not is_uuid_v4(film_id) or not isinstance(item.get("entity_type"), str) or not item["entity_type"].strip():
            raise MigrationSafetyError(f"manifest Film identity is invalid: {path}")
        if not isinstance(version, int) or isinstance(version, bool) or version < 0:
            raise MigrationSafetyError(f"manifest version is invalid: {path}")
        if not isinstance(item.get("bytes"), int) or isinstance(item["bytes"], bool) or item["bytes"] < 0:
            raise MigrationSafetyError(f"manifest byte count is invalid: {path}")
        paths.add(path)
        film_ids.add(film_id)
    backup = manifest.get("backup")
    rollback = manifest.get("rollback_plan")
    if (
        not isinstance(backup, dict)
        or backup.get("strategy") != "immutable_source"
        or backup.get("source_sha256") != source["sha256"]
        or not isinstance(backup.get("formal_import_requirement"), str)
        or not backup["formal_import_requirement"].strip()
    ):
        raise MigrationSafetyError("manifest backup binding is invalid")
    if (
        not isinstance(rollback, dict)
        or rollback.get("automatic_actions") != []
        or not isinstance(rollback.get("steps"), list)
        or not rollback["steps"]
        or any(not isinstance(step, str) or not step.strip() for step in rollback["steps"])
    ):
        raise MigrationSafetyError("manifest rollback plan is invalid")


def is_sha256(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def blocker(code: str, path: str, message: str) -> dict[str, str]:
    return {"code": code, "path": path, "message": message}


def write_once(path: Path, data: bytes) -> None:
    if path.exists():
        if path.is_symlink() or not path.is_file() or path.read_bytes() != data:
            raise MigrationSafetyError(f"refusing to overwrite existing artifact: {path.name}")
        return
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def copy_once(source: Path, destination: Path, expected_hash: str, expected_bytes: int) -> None:
    if destination.exists():
        if destination.is_symlink() or not destination.is_file():
            raise MigrationSafetyError(f"refusing to overwrite mismatched payload: {destination.name}")
        digest, size = hash_file(destination)
        if digest != expected_hash or size != expected_bytes:
            raise MigrationSafetyError(f"refusing to overwrite mismatched payload: {destination.name}")
        return
    with source.open("rb") as input_stream, destination.open("xb") as output_stream:
        shutil.copyfileobj(input_stream, output_stream, length=1024 * 1024)
        output_stream.flush()
        os.fsync(output_stream.fileno())
    digest, size = hash_file(destination)
    if digest != expected_hash or size != expected_bytes:
        raise MigrationSafetyError(f"copied payload failed verification: {destination.name}")
