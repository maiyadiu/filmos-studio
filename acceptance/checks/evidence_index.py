#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "acceptance" / "EVIDENCE_INDEX.json"
RUNNER = ROOT / "acceptance" / "run.py"
TOP_LEVEL_KEYS = {"schema_version", "contract_kind", "tracks"}
TRACK_KEYS = {
    "track_id",
    "source_paths",
    "automated_tests",
    "golden_case_ids",
    "required_local_check_ids",
    "required_final_check_ids",
}
FORBIDDEN_KEYS = {
    "acceptance_status",
    "current_commit",
    "delivery_status",
    "evidence_source_snapshot_sha256",
    "index_status",
    "last_receipt",
    "receipt",
    "runtime_logs",
}


def runner_check_ids() -> set[str]:
    spec = importlib.util.spec_from_file_location("filmos_acceptance_runner", RUNNER)
    if not spec or not spec.loader:
        raise RuntimeError("cannot load acceptance runner contract")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return {check.check_id for check in module.RC_LOCAL_CHECKS}


def main() -> int:
    payload = json.loads(INDEX.read_text(encoding="utf-8"))
    if set(payload) != TOP_LEVEL_KEYS:
        raise RuntimeError("Evidence Index top-level fields are not stable-contract only")
    if (
        payload["schema_version"] != "1.2.0"
        or payload["contract_kind"] != "FILMOS_STABLE_TRACK_EVIDENCE_CONTRACT"
    ):
        raise RuntimeError("Evidence Index contract identity changed")
    tracks = payload.get("tracks")
    if not isinstance(tracks, list) or len(tracks) != 15:
        raise RuntimeError("Evidence Index must contain Track 00 through Track 14")
    expected_tracks = {f"{number:02d}" for number in range(15)}
    available_checks = runner_check_ids()
    seen: set[str] = set()
    for track in tracks:
        if not isinstance(track, dict) or set(track) != TRACK_KEYS:
            raise RuntimeError("Evidence Index Track fields are not stable-contract only")
        track_id = str(track["track_id"])
        prefix = track_id.split("-", 1)[0]
        if prefix not in expected_tracks or prefix in seen:
            raise RuntimeError(f"invalid or duplicate Track id: {track_id}")
        seen.add(prefix)
        for field in TRACK_KEYS - {"track_id"}:
            values = track[field]
            if (
                not isinstance(values, list)
                or not values
                or any(not isinstance(value, str) or not value for value in values)
            ):
                raise RuntimeError(f"{track_id}.{field} must be a non-empty stable string list")
        unknown = set(track["required_local_check_ids"]) - available_checks
        if unknown:
            raise RuntimeError(f"{track_id} references unknown local checks: {', '.join(sorted(unknown))}")
    encoded = json.dumps(payload, ensure_ascii=False)
    if any(f'"{key}"' in encoded for key in FORBIDDEN_KEYS):
        raise RuntimeError("Evidence Index contains runtime or release identity fields")
    if "/Users/" in encoded or "acceptance/evidence/runs/" in encoded:
        raise RuntimeError("Evidence Index contains a private or runtime evidence path")
    print(
        json.dumps(
            {
                "golden_id": "EVIDENCE-INDEX-STABLE-001",
                "status": "PASSED",
                "track_count": len(tracks),
                "runtime_identity_fields": 0,
                "known_local_checks": len(available_checks),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
