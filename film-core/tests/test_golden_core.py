from __future__ import annotations

import sqlite3
import hashlib
import json
from copy import deepcopy
from uuid import UUID

import pytest
from jsonschema import Draft202012Validator, FormatChecker

from film_production_core.contracts import repository_root


ZERO_HASH = "0" * 64
HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def validate_contract(definition: str, value: dict) -> None:
    schema = json.loads(
        (repository_root() / "film-contracts" / "schemas" / "core.schema.json").read_text(
            encoding="utf-8"
        )
    )
    Draft202012Validator(
        {"$ref": f"#/$defs/{definition}", "$defs": schema["$defs"]},
        format_checker=FormatChecker(),
    ).validate(value)


def create_guard() -> dict:
    return {
        "target_id": None,
        "expected_version": 0,
        "expected_content_hash": ZERO_HASH,
    }


def version_guard(entity: dict) -> dict:
    return {
        "film_entity_id": entity["ref"]["film_entity_id"],
        "expected_version": entity["ref"]["version"],
        "expected_content_hash": entity["ref"]["content_hash"],
    }


def bound(entity: dict) -> dict:
    return {
        **version_guard(entity),
        "entity_type": entity["ref"]["entity_type"],
        "host": entity.get("host", {}),
    }


def create_legacy(client, states, entity_type: str, host: dict, **extra) -> dict:
    response = client.post(
        "/commands/apply",
        json={
            "command_type": "entity.create",
            "target_id": None,
            "expected_version": 0,
            "actor_kind": "human",
            "payload": {
                "entity_type": entity_type,
                "host": host,
                "states": states,
                **extra,
            },
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["entity"]


def create_formal(client, entity_type: str, **payload) -> dict:
    response = client.post(
        "/formal-records",
        json={
            "write": create_guard(),
            "actor_kind": "codex",
            "payload": {"entity_type": entity_type, **payload},
        },
    )
    assert response.status_code == 200, response.text
    entity = response.json()["entity"]
    assert UUID(entity["ref"]["film_entity_id"]).version == 4
    assert UUID(response.json()["audit_event_id"]).version == 4
    return entity


def lock_script(client, source: dict, actor_kind: str = "human") -> dict:
    response = client.post(
        "/script-versions/lock",
        json={
            "locked_write": create_guard(),
            "decision_write": create_guard(),
            "actor_kind": actor_kind,
            "source_script_version": version_guard(source),
            "approved_by": "head-writer-1",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def create_source_chain(client, states) -> dict[str, dict]:
    director_ir_text = "beat: A hesitates, then reaches with the right hand"
    visual_lock_text = "axis=left_to_right; prop_contact=right_hand_on_cup"
    project = create_legacy(
        client,
        states,
        "film_project_extension",
        {"host_project_id": "host-project-1"},
    )
    unit = create_legacy(
        client,
        states,
        "content_unit_extension",
        {"host_project_id": "host-project-1", "host_unit_id": "host-unit-1"},
        unit_kind="episode",
    )
    shot = create_legacy(
        client,
        states,
        "shot_extension",
        {
            "host_project_id": "host-project-1",
            "host_unit_id": "host-unit-1",
            "host_shot_id": "host-shot-1",
        },
        director_unit_ids=[],
    )
    source_script = create_formal(
        client,
        "script_version",
        host={"host_project_id": "host-project-1", "host_unit_id": "host-unit-1"},
        states=states,
        script_text="INT. ROOM - DAY\nA reaches for the cup.",
    )
    locked = lock_script(client, source_script)
    script = locked["locked_script_version"]
    decision = locked["decision"]
    director = create_formal(
        client,
        "director_unit",
        script_version=version_guard(script),
        script_decision=version_guard(decision),
        states=states,
        director_ir_text=director_ir_text,
        director_ir_hash=sha256_text(director_ir_text),
        narrative_purpose="A decides to leave",
        performance_beats=["hesitates", "reaches"],
    )
    coverage = create_formal(
        client,
        "coverage_link",
        director_unit=version_guard(director),
        shot=version_guard(shot),
        purpose="master coverage",
    )
    visual_lock = create_formal(
        client,
        "visual_lock_set",
        project=version_guard(project),
        shot=version_guard(shot),
        states=states,
        visual_lock_text=visual_lock_text,
        visual_lock_hash=sha256_text(visual_lock_text),
        locks={
            "screen_direction": "left_to_right",
            "prop_contact": "right_hand_on_cup",
        },
    )
    asset = create_formal(
        client,
        "asset_binding",
        project=version_guard(project),
        host={
            "host_project_id": "host-project-1",
            "host_asset_id": "host-asset-cup",
            "host_asset_version_id": "host-asset-cup-v1",
        },
        role="hero_prop",
        priority=100,
        asset_content_hash=HASH_A,
    )
    return {
        "project": project,
        "unit": unit,
        "shot": shot,
        "source_script": source_script,
        "script": script,
        "script_decision": decision,
        "director": director,
        "coverage": coverage,
        "visual_lock": visual_lock,
        "asset": asset,
    }


def compile_prompt(client, chain) -> dict:
    response = client.post(
        "/prompts/compile",
        json={
            "draft_write": create_guard(),
            "provenance_write": create_guard(),
            "actor_kind": "codex",
            "states": {
                "creative_stage": "authored",
                "execution_state": "not_started",
                "review_state": "not_reviewed",
                "lock_state": "unlocked",
                "delivery_state": "not_ready",
                "stale_state": "fresh",
            },
            "director_ir_hash": chain["director"]["director_ir_hash"],
            "visual_lock_hash": chain["visual_lock"]["visual_lock_hash"],
            "model_capability_profile": "dreamina.image.v1",
            "prompt_text": "Locked room, A reaches for the cup, medium shot.",
            "project": bound(chain["project"]),
            "shot": bound(chain["shot"]),
            "director_unit": bound(chain["director"]),
            "visual_lock": bound(chain["visual_lock"]),
            "prompt_template": {
                "host_prompt_template_id": "host-template-1",
                "operation": "image.generate",
                "version": 1,
                "content_hash": HASH_B,
            },
            "assets": [
                {
                    "binding": bound(chain["asset"]),
                    "asset_content_hash": chain["asset"]["asset_content_hash"],
                }
            ],
            "capability_profile": {
                "profile_id": "dreamina.image.v1",
                "profile_version": 1,
                "provider_id": "dreamina",
                "output_kind": "image",
                "dialect": "image-prompt",
                "capabilities": {"reference_images": True},
            },
            "provider_parameters": {
                "aspect_ratio": "16:9",
                "duration_seconds": None,
                "seed": 7,
                "negative_prompt": "extra fingers",
            },
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_script_lock_is_human_only_immutable_and_decision_bound(client, states) -> None:
    locked_states = {**states, "creative_stage": "locked", "lock_state": "locked"}
    direct_lock = client.post(
        "/formal-records",
        json={
            "write": create_guard(),
            "actor_kind": "human",
            "payload": {
                "entity_type": "script_version",
                "host": {
                    "host_project_id": "host-project-1",
                    "host_unit_id": "host-unit-1",
                },
                "states": locked_states,
                "script_text": "cannot be born locked",
            },
        },
    )
    assert direct_lock.status_code == 409
    assert direct_lock.json()["detail"]["code"] == "script_lock_action_required"
    assert client.app.state.formal_service.repository.formal_counts() == (0, 0)

    source = create_formal(
        client,
        "script_version",
        host={"host_project_id": "host-project-1", "host_unit_id": "host-unit-1"},
        states=states,
        script_text="locked only after a human decision",
    )
    lock_request = {
        "locked_write": create_guard(),
        "decision_write": create_guard(),
        "actor_kind": "codex",
        "source_script_version": version_guard(source),
        "approved_by": "head-writer-1",
    }
    agent_lock = client.post("/script-versions/lock", json=lock_request)
    assert agent_lock.status_code == 409
    assert agent_lock.json()["detail"]["code"] == "human_script_lock_required"
    assert client.app.state.formal_service.repository.formal_counts() == (1, 1)

    stale_request = deepcopy(lock_request)
    stale_request["actor_kind"] = "human"
    stale_request["source_script_version"]["expected_content_hash"] = HASH_C
    stale_lock = client.post("/script-versions/lock", json=stale_request)
    assert stale_lock.status_code == 409
    assert stale_lock.json()["detail"]["code"] == "content_hash_conflict"
    assert client.app.state.formal_service.repository.formal_counts() == (1, 1)

    stale_version_request = deepcopy(lock_request)
    stale_version_request["actor_kind"] = "human"
    stale_version_request["source_script_version"]["expected_version"] = 2
    stale_version_lock = client.post(
        "/script-versions/lock", json=stale_version_request
    )
    assert stale_version_lock.status_code == 409
    assert stale_version_lock.json()["detail"]["code"] == "version_conflict"
    assert client.app.state.formal_service.repository.formal_counts() == (1, 1)

    locked = lock_script(client, source)
    locked_script = locked["locked_script_version"]
    decision = locked["decision"]
    assert len(locked["audit_event_ids"]) == 2
    assert client.app.state.formal_service.repository.formal_counts() == (3, 3)
    assert locked_script["ref"]["film_entity_id"] != source["ref"]["film_entity_id"]
    assert locked_script["source_script_version_id"] == source["ref"]["film_entity_id"]
    assert locked_script["script_text"] == source["script_text"]
    assert locked_script["script_text_hash"] == source["script_text_hash"]
    assert locked_script["states"]["lock_state"] == "locked"
    assert decision["locked_script_version_id"] == locked_script["ref"]["film_entity_id"]
    assert (
        decision["locked_script_version_content_hash"]
        == locked_script["ref"]["content_hash"]
    )
    validate_contract("ScriptVersion", locked_script)
    validate_contract("ScriptDecision", decision)

    other_source = create_formal(
        client,
        "script_version",
        host={"host_project_id": "host-project-1", "host_unit_id": "host-unit-1"},
        states=states,
        script_text="a different immutable source",
    )
    other_decision = lock_script(client, other_source)["decision"]
    before = client.app.state.formal_service.repository.formal_counts()
    mismatched = client.post(
        "/formal-records",
        json={
            "write": create_guard(),
            "actor_kind": "codex",
            "payload": {
                "entity_type": "director_unit",
                "script_version": version_guard(locked_script),
                "script_decision": version_guard(other_decision),
                "states": states,
                "director_ir_text": "beat: mismatch must fail closed",
                "director_ir_hash": sha256_text("beat: mismatch must fail closed"),
                "narrative_purpose": "invalid",
                "performance_beats": [],
            },
        },
    )
    assert mismatched.status_code == 409
    assert mismatched.json()["detail"]["code"] == "script_decision_mismatch"
    assert client.app.state.formal_service.repository.formal_counts() == before


def test_golden_a_persists_candidate_review_and_separate_human_approval(
    client, states
) -> None:
    chain = create_source_chain(client, states)
    compiled = compile_prompt(client, chain)
    prompt = compiled["prompt_draft"]
    provenance = compiled["provenance"]

    assert UUID(prompt["ref"]["film_entity_id"]).version == 4
    assert UUID(provenance["ref"]["film_entity_id"]).version == 4
    assert provenance["visual_lock"] == bound(chain["visual_lock"])
    assert provenance["director_ir_hash"] == chain["director"]["director_ir_hash"]
    assert provenance["visual_lock_hash"] == chain["visual_lock"]["visual_lock_hash"]
    assert provenance["assets"] == [
        {
            "binding": bound(chain["asset"]),
            "asset_content_hash": chain["asset"]["asset_content_hash"],
        }
    ]
    assert provenance["submission_state"] == "NOT_SUBMITTED"
    assert provenance["generated_result_state"] == "CANDIDATE_ONLY"

    package = create_formal(
        client,
        "generation_package",
        prompt_draft=version_guard(prompt),
        host_project_id="host-project-1",
        provider_id="dreamina",
        capability_id="image",
        parameters={"aspect_ratio": "16:9", "seed": 7},
    )
    assert package["submission_state"] == "NOT_SUBMITTED"

    imported = client.post(
        "/manual-results/import",
        json={
            "evidence_write": create_guard(),
            "candidate_write": create_guard(),
            "actor_kind": "human",
            "generation_package": version_guard(package),
            "provider_task_id": "dreamina-task-1",
            "receipt": {
                "receipt_id": "receipt-1",
                "content_hash": HASH_C,
                "captured_at": "2026-08-28T10:00:00Z",
            },
            "manual_source": {
                "source_id": "manual-import-1",
                "source_kind": "provider_console",
                "imported_by": "director-1",
                "imported_at": "2026-08-28T10:01:00Z",
                "authorization_evidence_id": "authorization-1",
            },
            "outputs": [
                {
                    "host_resource_id": "host-resource-1",
                    "output_kind": "image",
                    "content_hash": HASH_A,
                    "mime_type": "image/png",
                    "bytes": 1024,
                }
            ],
        },
    )
    assert imported.status_code == 200, imported.text
    evidence = imported.json()["evidence"]
    candidate = imported.json()["candidate"]
    assert evidence["provider_id"] == "dreamina"
    assert evidence["parameter_hash"] == package["parameter_hash"]
    assert UUID(evidence["outputs"][0]["film_representation_id"]).version == 4
    assert candidate["states"]["review_state"] == "pending"
    assert candidate["states"]["review_state"] != "approved"

    rejected_response = client.post(
        "/reviews",
        json={
            "write": create_guard(),
            "actor_kind": "codex",
            "candidate": version_guard(candidate),
            "review_state": "rejected",
            "reviewer_kind": "automated_qc",
            "findings": ["prop contact drift"],
        },
    )
    assert rejected_response.status_code == 200, rejected_response.text
    rejected_approval = client.post(
        "/approvals",
        json={
            "write": create_guard(),
            "actor_kind": "human",
            "candidate": version_guard(candidate),
            "passed_review": version_guard(rejected_response.json()),
            "approved_by": "director-1",
        },
    )
    assert rejected_approval.status_code == 409
    assert rejected_approval.json()["detail"]["code"] == "passed_review_required"

    review_response = client.post(
        "/reviews",
        json={
            "write": create_guard(),
            "actor_kind": "codex",
            "candidate": version_guard(candidate),
            "review_state": "passed",
            "reviewer_kind": "automated_qc",
            "findings": [],
        },
    )
    assert review_response.status_code == 200, review_response.text
    review = review_response.json()
    assert review["target_content_hash"] == candidate["ref"]["content_hash"]
    assert client.get(f"/formal-records/{candidate['ref']['film_entity_id']}").json() == candidate
    assert client.app.state.formal_service.repository.formal_counts() == (14, 14)

    stale_candidate = version_guard(candidate)
    stale_candidate["expected_content_hash"] = HASH_C
    stale_approval = client.post(
        "/approvals",
        json={
            "write": create_guard(),
            "actor_kind": "human",
            "candidate": stale_candidate,
            "passed_review": version_guard(review),
            "approved_by": "director-1",
        },
    )
    assert stale_approval.status_code == 409
    assert stale_approval.json()["detail"]["code"] == "content_hash_conflict"
    assert client.app.state.formal_service.repository.formal_counts() == (14, 14)

    nonhuman = client.post(
        "/approvals",
        json={
            "write": create_guard(),
            "actor_kind": "codex",
            "candidate": version_guard(candidate),
            "passed_review": version_guard(review),
            "approved_by": "director-1",
        },
    )
    assert nonhuman.status_code == 409
    assert nonhuman.json()["detail"]["code"] == "human_approval_required"

    approval_response = client.post(
        "/approvals",
        json={
            "write": create_guard(),
            "actor_kind": "human",
            "candidate": version_guard(candidate),
            "passed_review": version_guard(review),
            "approved_by": "director-1",
        },
    )
    assert approval_response.status_code == 200, approval_response.text
    approval = approval_response.json()
    assert approval["approved_content_hash"] == candidate["ref"]["content_hash"]
    assert approval["target_id"] == candidate["ref"]["film_entity_id"]
    assert approval["ref"]["film_entity_id"] != candidate["ref"]["film_entity_id"]
    assert client.get(f"/formal-records/{candidate['ref']['film_entity_id']}").json() == candidate
    assert client.get(f"/entities/{candidate['ref']['film_entity_id']}").status_code == 404
    for definition, entity in (
        ("ScriptVersion", chain["source_script"]),
        ("ScriptVersion", chain["script"]),
        ("ScriptDecision", chain["script_decision"]),
        ("DirectorUnit", chain["director"]),
        ("CoverageLink", chain["coverage"]),
        ("VisualLockSet", chain["visual_lock"]),
        ("AssetBinding", chain["asset"]),
        ("PromptDraft", prompt),
        ("PromptDraftProvenance", provenance),
        ("GenerationPackage", package),
        ("GenerationAttemptEvidence", evidence),
        ("Candidate", candidate),
        ("Review", review),
        ("Approval", approval),
    ):
        validate_contract(definition, entity)


def test_source_hash_guards_fail_closed_without_partial_formal_writes(
    client, states
) -> None:
    chain = create_source_chain(client, states)
    before = client.app.state.formal_service.repository.formal_counts()
    request = {
        "draft_write": create_guard(),
        "provenance_write": create_guard(),
        "actor_kind": "codex",
        "states": states,
        "director_ir_hash": chain["director"]["director_ir_hash"],
        "visual_lock_hash": chain["visual_lock"]["visual_lock_hash"],
        "model_capability_profile": "dreamina.image.v1",
        "prompt_text": "test prompt",
        "project": bound(chain["project"]),
        "shot": bound(chain["shot"]),
        "director_unit": bound(chain["director"]),
        "visual_lock": bound(chain["visual_lock"]),
        "prompt_template": {
            "host_prompt_template_id": "host-template-1",
            "operation": "image.generate",
            "version": 1,
            "content_hash": HASH_B,
        },
        "assets": [
            {
                "binding": bound(chain["asset"]),
                "asset_content_hash": chain["asset"]["asset_content_hash"],
            }
        ],
        "capability_profile": {
            "profile_id": "dreamina.image.v1",
            "profile_version": 1,
            "provider_id": "dreamina",
            "output_kind": "image",
            "dialect": "image-prompt",
            "capabilities": {},
        },
        "provider_parameters": {
            "aspect_ratio": None,
            "duration_seconds": None,
            "seed": None,
            "negative_prompt": None,
        },
    }
    stale = deepcopy(request)
    stale["visual_lock"]["expected_content_hash"] = HASH_C
    response = client.post("/prompts/compile", json=stale)

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "content_hash_conflict"
    assert client.app.state.formal_service.repository.formal_counts() == before

    raw_hash_mismatch = deepcopy(request)
    raw_hash_mismatch["director_ir_hash"] = HASH_C
    response = client.post("/prompts/compile", json=raw_hash_mismatch)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "director_ir_hash_mismatch"
    assert client.app.state.formal_service.repository.formal_counts() == before

    missing_asset = deepcopy(request)
    missing_asset["assets"] = []
    assert client.post("/prompts/compile", json=missing_asset).status_code == 422
    assert client.app.state.formal_service.repository.formal_counts() == before


@pytest.mark.parametrize(
    "parameters",
    [
        {"api_key": "secret-value"},
        {"cookie": "session-value"},
        {"reference": "data:image/png;base64,AAAA"},
        {"reference": "/Users/example/output.png"},
        {"reference": "https://provider.example/output.png"},
    ],
)
def test_generation_package_rejects_secrets_and_locators(
    client, states, parameters
) -> None:
    chain = create_source_chain(client, states)
    prompt = compile_prompt(client, chain)["prompt_draft"]
    response = client.post(
        "/formal-records",
        json={
            "write": create_guard(),
            "actor_kind": "human",
            "payload": {
                "entity_type": "generation_package",
                "prompt_draft": version_guard(prompt),
                "host_project_id": "host-project-1",
                "provider_id": "dreamina",
                "capability_id": "image",
                "parameters": parameters,
            },
        },
    )

    assert response.status_code == 422


def test_manual_import_rejects_secrets_and_all_locator_forms(client, states) -> None:
    chain = create_source_chain(client, states)
    prompt = compile_prompt(client, chain)["prompt_draft"]
    package = create_formal(
        client,
        "generation_package",
        prompt_draft=version_guard(prompt),
        host_project_id="host-project-1",
        provider_id="dreamina",
        capability_id="image",
        parameters={"seed": 7},
    )
    base = {
        "evidence_write": create_guard(),
        "candidate_write": create_guard(),
        "actor_kind": "human",
        "generation_package": version_guard(package),
        "provider_task_id": "dreamina-task-1",
        "receipt": {
            "receipt_id": "receipt-1",
            "content_hash": HASH_C,
            "captured_at": "2026-08-28T10:00:00Z",
        },
        "manual_source": {
            "source_id": "manual-import-1",
            "source_kind": "provider_console",
            "imported_by": "director-1",
            "imported_at": "2026-08-28T10:01:00Z",
            "authorization_evidence_id": "authorization-1",
        },
        "outputs": [
            {
                "host_resource_id": "host-resource-1",
                "output_kind": "image",
                "content_hash": HASH_A,
                "mime_type": "image/png",
                "bytes": 1024,
            }
        ],
    }
    invalid_requests = []
    for field, value in (
        ("provider_task_id", "https://provider.example/task/1"),
        ("provider_task_id", "/Users/example/task.json"),
    ):
        request = deepcopy(base)
        request[field] = value
        invalid_requests.append(request)
    cookie = deepcopy(base)
    cookie["manual_source"]["cookie"] = "session-value"
    invalid_requests.append(cookie)
    data_url = deepcopy(base)
    data_url["outputs"][0]["host_resource_id"] = "data:image/png;base64,AAAA"
    invalid_requests.append(data_url)
    external_url = deepcopy(base)
    external_url["manual_source"]["authorization_evidence_id"] = (
        "https://provider.example/authorization/1"
    )
    invalid_requests.append(external_url)

    before = client.app.state.formal_service.repository.formal_counts()
    for request in invalid_requests:
        response = client.post("/manual-results/import", json=request)
        assert response.status_code == 422, response.text
        assert client.app.state.formal_service.repository.formal_counts() == before


def test_continuity_check_persists_structured_blockers(client, states) -> None:
    chain = create_source_chain(client, states)
    prior = create_legacy(
        client,
        states,
        "shot_extension",
        {"host_project_id": "host-project-1", "host_shot_id": "host-shot-0"},
        director_unit_ids=[],
    )
    response = client.post(
        "/continuity/check",
        json={
            "write": create_guard(),
            "actor_kind": "codex",
            "previous_shot": version_guard(prior),
            "current_shot": version_guard(chain["shot"]),
            "checks": [
                {
                    "dimension": "prop_contact",
                    "subject_id": "host-asset-cup",
                    "expected_value": "right_hand",
                    "actual_value": "left_hand",
                }
            ],
        },
    )

    assert response.status_code == 200, response.text
    result = response.json()
    assert result["passed"] is False
    assert result["blockers"] == [
        {
            "code": "PROP_CONTACT_CONTINUITY_BROKEN",
            "dimension": "prop_contact",
            "subject_id": "host-asset-cup",
            "expected_value": "right_hand",
            "actual_value": "left_hand",
        }
    ]
    validate_contract("ContinuityCheckResult", result)


def test_formal_audit_events_are_append_only(client, states) -> None:
    chain = create_source_chain(client, states)
    target_id = chain["asset"]["ref"]["film_entity_id"]
    database = client.app.state.formal_service.repository.database

    with database.connect() as connection:
        event_id = connection.execute(
            "SELECT event_id FROM formal_audit_events WHERE target_id = ?",
            (target_id,),
        ).fetchone()["event_id"]
        try:
            with pytest.raises(sqlite3.DatabaseError, match="append-only"):
                connection.execute(
                    "UPDATE formal_audit_events SET action = 'tampered' WHERE event_id = ?",
                    (event_id,),
                )
            with pytest.raises(sqlite3.DatabaseError, match="append-only"):
                connection.execute(
                    "DELETE FROM formal_audit_events WHERE event_id = ?", (event_id,)
                )
        finally:
            connection.rollback()
