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
EXPECTED_IMPLEMENTED_PATHS = {
    "/health",
    "/projects/{hostProjectId}/context",
    "/units/{hostUnitId}",
    "/shots/{hostShotId}",
    "/entities/{filmEntityId}",
    "/formal-records/{filmEntityId}",
    "/formal-records",
    "/script-structure-maps/{filmEntityId}",
    "/script-structure-maps",
    "/impacts",
    "/impacts/{entityId}",
    "/impacts/propagate-stale",
    "/script-versions/lock",
    "/prompts/compile",
    "/manual-results/import",
    "/reviews",
    "/approvals",
    "/continuity/check",
    "/spatial-versions",
    "/spatial-versions/{filmEntityId}",
    "/commands/preview",
    "/commands/apply",
    "/audit-events",
    "/generation-production/acceptance-authority",
    "/generation-production/acceptance-authority/{projectId}",
    "/generation-production/authority-trace",
    "/generation-production/authorization-reconciliation",
    "/generation-production/authorization-release",
    "/generation-production/authorizations",
    "/generation-production/authorizations/{authorizedSubmissionId}",
    "/generation-production/candidates/by-attempt/{generationAttemptId}",
    "/generation-production/execution-results",
    "/generation-production/previews",
    "/generation-production/previews/{proposalId}",
    "/generation-production/previews/{proposalId}/reject",
    "/generation-production/project-authority",
    "/generation-production/project-authority/{projectId}",
    "/generation-production/provider-receipts/{idempotencyKey}",
}
EXPECTED_PLANNED_PATHS: set[str] = set()
EXPECTED_PATHS = EXPECTED_IMPLEMENTED_PATHS | EXPECTED_PLANNED_PATHS
REQUIRED_CHAIN_DEFS = {
    "ContentUnitExtension",
    "ScriptVersion",
    "ScriptDecision",
    "DirectorUnit",
    "CoverageLink",
    "VisualLockSet",
    "AssetBinding",
    "ShotExtension",
    "PromptDraft",
    "PromptDraftProvenance",
    "GenerationPackage",
    "GenerationAttemptEvidence",
    "Candidate",
    "Review",
    "Approval",
    "ContinuityCheckResult",
    "SceneTwinVersion",
    "CameraVersion",
    "BlockingVersion",
    "CompositionVersion",
    "ScriptStructureMap",
    "ImpactEdge",
    "ImpactQueryResult",
    "DependencyChange",
    "StalePropagationResult",
}


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def main() -> None:
    schema = load_json(SCHEMA_PATH)
    openapi = load_json(OPENAPI_PATH)
    definitions = schema["$defs"]

    assert schema["schema_version"] == "0.4.0"
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

    implementation_states = {}
    for path, path_item in openapi["paths"].items():
        states = {
            operation.get("x-implementation-state")
            for operation in path_item.values()
            if isinstance(operation, dict) and "x-implementation-state" in operation
        }
        assert len(states) == 1, f"{path} must declare one implementation state"
        implementation_states[path] = states.pop()

    assert {
        path for path, state in implementation_states.items() if state == "implemented"
    } == EXPECTED_IMPLEMENTED_PATHS
    assert {
        path for path, state in implementation_states.items() if state == "planned"
    } == EXPECTED_PLANNED_PATHS

    apply_schema = openapi["paths"]["/commands/apply"]["post"]["requestBody"][
        "content"
    ]["application/json"]["schema"]
    command_refs = {item["$ref"] for item in apply_schema["anyOf"]}
    assert command_refs == {
        "#/components/schemas/CreateEntityCommand",
        "#/components/schemas/SetStatesCommand",
    }
    for command_name in ("CreateEntityCommand", "SetStatesCommand"):
        assert "expected_version" in openapi["components"]["schemas"][command_name][
            "required"
        ]

    create_guard = openapi["components"]["schemas"]["CreateTargetGuard"]
    assert {
        "target_id",
        "expected_version",
        "expected_content_hash",
    } <= set(create_guard["required"])
    for request_name in (
        "FormalRecordCreateRequest",
        "ScriptVersionLockRequest",
        "PromptCompileRequest",
        "ManualResultImportRequest",
        "ReviewCreateRequest",
        "ApprovalCreateRequest",
        "ContinuityCheckRequest",
        "ScriptStructureMapCreateRequest",
        "ImpactEdgeCreateRequest",
        "StalePropagationRequest",
        "SpatialVersionCreateRequest",
        "SpatialVersionUpdateRequest",
        "SpatialVersionApplyResult",
    ):
        assert request_name in openapi["components"]["schemas"]

    impact_edge = definitions["ImpactEdge"]
    assert {
        "dependency_owner_version",
        "dependency_owner_content_hash",
        "dependency_key",
        "dependency_content_hash",
        "scope",
    } <= set(impact_edge["required"])
    stale_result = definitions["StalePropagationResult"]
    assert "unresolved_changes" in stale_result["required"]

    print(
        f"FILM_CONTRACTS_OK schema={schema['schema_version']} "
        f"paths={len(EXPECTED_PATHS)} implemented={len(EXPECTED_IMPLEMENTED_PATHS)} "
        f"planned={len(EXPECTED_PLANNED_PATHS)} axes={len(EXPECTED_AXES)}"
    )


if __name__ == "__main__":
    main()
