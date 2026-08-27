#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = ROOT / "film-contracts" / "schemas" / "core.schema.json"
OPENAPI_PATH = ROOT / "film-contracts" / "openapi.json"

EXPECTED_AXES = {
    "creative_stage",
    "execution_state",
    "review_state",
    "lock_state",
    "delivery_state",
    "stale_state",
}
EXPECTED_PATHS = {
    "/projects/{hostProjectId}/context",
    "/units/{hostUnitId}",
    "/shots/{hostShotId}",
    "/commands/preview",
    "/commands/apply",
    "/impacts/{entityId}",
    "/reviews",
    "/prompts/compile",
    "/continuity/check",
}
REQUIRED_CHAIN_DEFS = {
    "ContentUnitExtension",
    "ScriptVersion",
    "DirectorUnit",
    "ShotExtension",
    "PromptDraft",
    "GenerationPackage",
    "Candidate",
    "Review",
    "Approval",
}


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def main() -> None:
    schema = load_json(SCHEMA_PATH)
    openapi = load_json(OPENAPI_PATH)
    definitions = schema["$defs"]

    assert schema["schema_version"] == "0.1.0"
    assert REQUIRED_CHAIN_DEFS <= set(definitions)

    axes = definitions["FormalStateAxes"]
    assert set(axes["required"]) == EXPECTED_AXES
    assert set(axes["properties"]) == EXPECTED_AXES
    assert "status" not in axes["properties"]
    for name, definition in axes["properties"].items():
        values = definition["enum"]
        assert values, f"{name} must not be empty"
        assert len(values) == len(set(values)), f"{name} contains duplicate states"

    id_pattern = re.compile(definitions["FilmEntityId"]["pattern"])
    assert id_pattern.fullmatch("123e4567-e89b-42d3-a456-426614174000")
    assert not id_pattern.fullmatch("project-1")

    assert openapi["openapi"] == "3.1.0"
    assert set(openapi["paths"]) == EXPECTED_PATHS
    apply_schema = openapi["components"]["requestBodies"]["Command"]["content"]["application/json"]["schema"]
    assert "expected_version" in apply_schema["required"]

    print(f"FILM_CONTRACTS_OK schema={schema['schema_version']} paths={len(EXPECTED_PATHS)} axes={len(EXPECTED_AXES)}")


if __name__ == "__main__":
    main()

