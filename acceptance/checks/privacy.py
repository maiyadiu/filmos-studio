#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "acceptance" / "evidence"
DELIVERY_ROOTS = (ROOT / "acceptance", ROOT / "implementation", ROOT / ".github")
CHECKED_FILES = [ROOT / "CHANGELOG.md"]
SCANNED_SUFFIXES = {".csv", ".json", ".log", ".md", ".txt", ".yaml", ".yml"}
SECRET_PATTERNS = (
    re.compile(rb"/Users/[^/\s]+/"),
    re.compile(rb"/(?:private/)?var/folders/[^\s]+"),
    re.compile(rb"(?i)authorization:\s*bearer\s+(?!\[REDACTED\])\S+"),
    re.compile(rb"(?i)cookie:\s*(?!\[REDACTED\])[^\r\n]+"),
    re.compile(rb"\bsk-[A-Za-z0-9_-]{12,}\b"),
)


def main() -> None:
    files = list(CHECKED_FILES)
    for root in DELIVERY_ROOTS:
        files.extend(
            path
            for path in root.rglob("*")
            if path.is_file()
            and "__pycache__" not in path.parts
            and path.suffix.lower() in SCANNED_SUFFIXES
        )
    violations: list[str] = []
    for path in files:
        value = path.read_bytes()
        for pattern in SECRET_PATTERNS:
            if pattern.search(value):
                violations.append(f"{path.relative_to(ROOT)}:{pattern.pattern.decode(errors='replace')}")
    if violations:
        raise RuntimeError("privacy scan failed: " + ", ".join(violations))
    print(json.dumps({"status": "PASSED", "files_scanned": len(files), "violations": 0}, sort_keys=True))


if __name__ == "__main__":
    main()
