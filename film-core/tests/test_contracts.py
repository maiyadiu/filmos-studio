from __future__ import annotations

import json

from jsonschema import Draft202012Validator, FormatChecker

from film_production_core.contracts import exported_openapi, repository_root


def _validator(definition: str) -> Draft202012Validator:
    contract = json.loads(
        (repository_root() / "film-contracts" / "schemas" / "core.schema.json").read_text(
            encoding="utf-8"
        )
    )
    return Draft202012Validator(
        {"$ref": f"#/$defs/{definition}", "$defs": contract["$defs"]},
        format_checker=FormatChecker(),
    )


def test_runtime_entities_and_audit_validate_against_core_schema(
    client, project_create_command
) -> None:
    response = client.post("/commands/apply", json=project_create_command)

    assert response.status_code == 200
    _validator("FilmProjectExtension").validate(response.json()["entity"])
    _validator("AuditEvent").validate(response.json()["audit_event"])


def test_committed_openapi_matches_export_and_marks_implementation_state() -> None:
    committed_path = repository_root() / "film-contracts" / "openapi.json"
    committed = json.loads(committed_path.read_text(encoding="utf-8"))
    exported = exported_openapi()

    assert committed == exported
    implemented_paths = {
        path
        for path, path_item in committed["paths"].items()
        if any(
            isinstance(operation, dict)
            and operation.get("x-implementation-state") == "implemented"
            for operation in path_item.values()
        )
    }
    planned_paths = {
        path
        for path, path_item in committed["paths"].items()
        if any(
            isinstance(operation, dict)
            and operation.get("x-implementation-state") == "planned"
            for operation in path_item.values()
        )
    }
    assert implemented_paths == {
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
        "/commands/preview",
        "/commands/apply",
        "/audit-events",
    }
    assert planned_paths == set()


def test_impact_contract_paths_are_registered_as_runtime_routes(tmp_path) -> None:
    from film_production_core.api import create_app

    app = create_app(tmp_path / "runtime.sqlite")
    runtime_paths = {route.path for route in app.routes}

    assert "/impacts/{entityId}" in runtime_paths
    assert "/impacts" in runtime_paths
    assert "/impacts/propagate-stale" in runtime_paths
    assert "/script-structure-maps" in runtime_paths
    assert "/reviews" in runtime_paths
    assert "/prompts/compile" in runtime_paths
    assert "/continuity/check" in runtime_paths
