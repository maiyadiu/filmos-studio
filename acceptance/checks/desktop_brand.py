#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def require_text(path: Path, required: tuple[str, ...], forbidden: tuple[str, ...] = ()) -> None:
    value = path.read_text(encoding="utf-8")
    for token in required:
        if token not in value:
            raise RuntimeError(f"{path.relative_to(ROOT)} is missing {token!r}")
    for token in forbidden:
        if token in value:
            raise RuntimeError(f"{path.relative_to(ROOT)} still contains {token!r}")


def image_facts(path: Path) -> dict[str, str]:
    result = subprocess.run(
        ("sips", "-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", str(path)),
        text=True,
        capture_output=True,
        check=True,
    )
    facts: dict[str, str] = {}
    for line in result.stdout.splitlines()[1:]:
        key, separator, value = line.strip().partition(":")
        if separator:
            facts[key] = value.strip()
    return facts


def main() -> None:
    auth_scene = ROOT / "web/src/pages/auth/auth-scene.tsx"
    require_text(
        auth_scene,
        ("FilmOS Studio", "FILMOS STUDIO", "/filmos-icon.png", "从文字走向银幕。"),
        ("YINGCE STUDIO", "影策品牌影片"),
    )
    require_text(
        ROOT / "web/index.html",
        ("<title>FilmOS Studio</title>", 'href="/filmos-icon.png"'),
        ("<title>影策</title>",),
    )
    require_text(
        ROOT / "desktop/macos/Sources/FilmOSStudioDesktop/main.swift",
        (
            'backendEnvironment["CANVAS_DESKTOP_LOCAL_AUTH_ENABLED"] = "true"',
            'for: .applicationSupportDirectory',
            'appendingPathComponent("FilmOSWeb")',
            'title: "打开 FilmOS 数据目录"',
            'title: "导出 FilmOS 备份包…"',
            '"X-FilmOS-Backup-SHA256"',
        ),
        ("configuration.workspaceRootURL", "configuration.bunExecutableURL"),
    )
    require_text(
        ROOT / "web/src/lib/desktop-backup-bridge.ts",
        ("filmOSFlushForBackup", "flushCanvasStorePersistence", "flushAssetStorePersistence", "saveRemoteUserDataNow"),
    )
    require_text(
        ROOT / "backend/internal/service/desktop_backup.go",
        ('DesktopBackupFormat = "filmos.local-backup/v1"', "BackupSQLite", '"WebKit rebuildable local cache"'),
    )
    require_text(
        ROOT / ".env.example",
        ("CANVAS_DESKTOP_LOCAL_AUTH_ENABLED=false", "公开/线上部署必须保持 false"),
    )
    master = image_facts(ROOT / "desktop/macos/App/FilmOS图标.png")
    web = image_facts(ROOT / "web/public/filmos-icon.png")
    if master != {"pixelWidth": "1024", "pixelHeight": "1024", "hasAlpha": "yes"}:
        raise RuntimeError(f"desktop icon facts mismatch: {master}")
    if web != {"pixelWidth": "128", "pixelHeight": "128", "hasAlpha": "yes"}:
        raise RuntimeError(f"web icon facts mismatch: {web}")
    print(json.dumps({"status": "PASSED", "desktop_icon": master, "web_icon": web}, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
