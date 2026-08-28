#!/usr/bin/env python3
"""Real Golden B adapter for dialogue, continuity, approved locks and STALE.

The adapter starts a temporary Film Core Sidecar and uses the checked-in Web
modules for local-only approval and J-cut receipts. It never substitutes a mock
formal store and never performs Provider execution.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any
from uuid import uuid4

from golden_a_real import (
    FORMAL_STATES,
    HASH_A,
    HASH_B,
    HASH_C,
    FilmCoreHttpClient,
    GoldenARealError,
    TemporaryFilmCoreSidecar,
    bound,
    continuity_check,
    create_formal,
    create_guard,
    create_legacy,
    expect_core_error,
    require_uuid4,
    sha256_text,
    version_guard,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
REQUIRED_D0006_OPERATIONS = (
    ("POST", "/script-structure-maps"),
    ("GET", "/script-structure-maps/{filmEntityId}"),
    ("POST", "/impacts"),
    ("GET", "/impacts/{entityId}"),
    ("POST", "/impacts/propagate-stale"),
)
LOCKED_APPROVED_STATES = {
    **FORMAL_STATES,
    "creative_stage": "locked",
    "review_state": "approved",
    "lock_state": "locked",
}
OCCURRED_AT = "2026-08-28T10:00:00Z"


def run_real_golden_b(*, python_executable: str | None = None) -> dict[str, Any]:
    trace_id = str(uuid4())
    with TemporaryFilmCoreSidecar(python_executable=python_executable) as client:
        health = client.get("/health")
        operations = client.operations()
        missing = [
            f"{method} {path}"
            for method, path in REQUIRED_D0006_OPERATIONS
            if (method, path) not in operations
        ]
        if missing:
            return {
                "golden_id": "GOLDEN-B-REAL",
                "test_status": "BLOCKED_MISSING_CORE_OPERATION",
                "prepared": False,
                "persisted": False,
                "reviewed": False,
                "continuity_verified": False,
                "external_provider_calls": 0,
                "fallback_mock_used": False,
                "missing_operations": missing,
                "trace_id": trace_id,
                "sidecar": {
                    "health": health["status"],
                    "service": health["service"],
                    "database": "temporary_sqlite_sidecar",
                },
            }

        project = create_legacy(
            client,
            "film_project_extension",
            {"host_project_id": "host-project-golden-b"},
        )
        unit = create_legacy(
            client,
            "content_unit_extension",
            {
                "host_project_id": "host-project-golden-b",
                "host_unit_id": "host-unit-golden-b",
            },
            unit_kind="episode",
        )
        shots = [
            create_legacy(
                client,
                "shot_extension",
                {
                    "host_project_id": "host-project-golden-b",
                    "host_unit_id": "host-unit-golden-b",
                    "host_shot_id": f"host-shot-golden-b-{index}",
                },
                director_unit_ids=[],
            )
            for index in range(1, 4)
        ]

        cue_ids = {name: str(uuid4()) for name in (
            "a-01", "b-01", "c-01", "a-02", "b-03", "c-02"
        )}
        section_id = str(uuid4())
        source_cues = dialogue_cues(cue_ids, "我不同意。")
        target_cues = dialogue_cues(cue_ids, "我不同意，现在就说清楚。")
        source_script, source_decision = create_locked_script(
            client, script_text(source_cues), "golden-b-source-director"
        )
        current_script, current_decision = create_locked_script(
            client, script_text(target_cues), "golden-b-current-director"
        )
        source_structure = create_structure_map(
            client, source_script, section_id, source_cues
        )
        current_structure = create_structure_map(
            client, current_script, section_id, target_cues
        )

        directors = [
            create_formal(
                client,
                "director_unit",
                script_version=version_guard(source_script),
                script_decision=version_guard(source_decision),
                states=LOCKED_APPROVED_STATES,
                director_ir_text=text,
                director_ir_hash=sha256_text(text),
                narrative_purpose=purpose,
                performance_beats=beats,
            )
            for text, purpose, beats in (
                (
                    "A在左、B在右、C在后景；B面向A，三人围绕桌边对话。",
                    "建立三人对话与主轴线",
                    ["A追问", "B回避", "C介入"],
                ),
                (
                    "B保持右侧座位转向门口，C视线越过A指向画外。",
                    "推进冲突并衔接门外声音",
                    ["B说清楚", "C发现门外", "A停顿"],
                ),
            )
        ]
        coverage_pairs = ((0, 0), (0, 1), (1, 1), (1, 2))
        coverages = [
            create_formal(
                client,
                "coverage_link",
                director_unit=version_guard(directors[director_index]),
                shot=version_guard(shots[shot_index]),
                purpose=f"golden-b-coverage-{index}",
            )
            for index, (director_index, shot_index) in enumerate(
                coverage_pairs, start=1
            )
        ]

        asset_specs = (
            ("character-a", "character_identity", "character", HASH_A),
            ("character-b", "character_identity", "character", HASH_B),
            ("character-c", "character_identity", "character", HASH_C),
            ("costume-a", "costume_reference", "costume", "d" * 64),
            ("costume-b-v1", "costume_reference", "costume", "e" * 64),
            ("costume-b-v2", "costume_reference", "costume", "f" * 64),
        )
        assets = {
            role: create_formal(
                client,
                "asset_binding",
                project=version_guard(project),
                host={
                    "host_project_id": "host-project-golden-b",
                    "host_asset_id": f"host-asset-{role}",
                    "host_asset_version_id": f"host-version-{role}",
                    "host_resource_id": f"host-resource-{role}",
                },
                role=role,
                priority=100,
                asset_content_hash=content_hash,
            )
            for role, _purpose, _semantic, content_hash in asset_specs
        }
        asset_local = run_asset_segment(
            assets=assets,
            specs=asset_specs,
            director_unit_id=directors[1]["ref"]["film_entity_id"],
            scope_id=shots[1]["ref"]["film_entity_id"],
        )
        previous_local_lock = asset_local["previousVisualLock"]
        next_local_lock = asset_local["nextVisualLock"]

        lock_one = create_visual_lock(
            client,
            project,
            shots[0],
            "Golden B Shot 1 axis and gaze lock",
            {
                "dependency_hashes": {
                    "axis": sha256_text("left_to_right"),
                    "eyeline:character-a": sha256_text("character-b"),
                },
                "axis": "left_to_right",
                "eyeline": "character-a-to-character-b",
            },
        )
        previous_lock = create_visual_lock(
            client,
            project,
            shots[1],
            "Golden B Shot 2 approved character and costume lock v1",
            core_locks(previous_local_lock),
        )
        next_locks = core_locks(next_local_lock)
        next_locks["dependency_hashes"]["lightingProfileVersion"] = HASH_B
        next_lock = create_visual_lock(
            client,
            project,
            shots[1],
            "Golden B Shot 2 approved character and costume lock v2",
            next_locks,
        )
        lock_three = create_visual_lock(
            client,
            project,
            shots[2],
            "Golden B Shot 3 door-side continuity lock",
            {
                "dependency_hashes": {
                    "axis": sha256_text("left_to_right"),
                    "prop_contact": sha256_text("door_closed"),
                },
                "axis": "left_to_right",
                "prop_contact": "door_closed",
            },
        )

        prompt_cue = compile_prompt(
            client, project, shots[0], directors[0], lock_one,
            assets["character-b"], "B的关键台词近景"
        )
        prompt_other = compile_prompt(
            client, project, shots[2], directors[1], lock_three,
            assets["character-c"], "C看向门外，保持原有站位"
        )
        prompt_costume = compile_prompt(
            client, project, shots[1], directors[1], previous_lock,
            assets["costume-b-v1"], "B的服装与右侧座位连续"
        )
        fresh_candidate = import_local_candidate(
            client,
            create_formal(
                client,
                "generation_package",
                prompt_draft=version_guard(prompt_other),
                host_project_id="host-project-golden-b",
                provider_id="manual_web",
                capability_id="video",
                parameters={"aspect_ratio": "9:16", "duration_seconds": 6},
            ),
        )

        continuity = client.post(
            "/continuity/check",
            {
                "write": create_guard(),
                "actor_kind": "codex",
                "previous_shot": version_guard(shots[0]),
                "current_shot": version_guard(shots[1]),
                "checks": [
                    continuity_check("axis", "axis-main", "left_to_right"),
                    continuity_check("eyeline", "character-b", "character-a"),
                    continuity_check("blocking", "character-b", "seat-right"),
                    continuity_check("action", "character-b", "turns-to-door"),
                    continuity_check("prop_contact", "door", "closed"),
                ],
            },
        )
        local = run_dialogue_segment(
            source_script=source_script,
            current_script=current_script,
            source_cues=source_cues,
            target_cues=target_cues,
            section_id=section_id,
            prompt_cue=prompt_cue,
            prompt_other=prompt_other,
            fresh_candidate=fresh_candidate,
            previous_lock=previous_local_lock,
            next_lock=next_local_lock,
            prompt_costume=prompt_costume,
            shots=shots,
        )

        script_edges = [
            create_impact(
                client,
                current_script,
                current_structure,
                current_script,
                prompt_cue,
                f"cue:{cue_ids['b-03']}",
                {"kind": "script_cue", "cue_id": cue_ids["b-03"]},
                "dialogue_prompt_dependency",
            ),
            create_impact(
                client,
                current_script,
                current_structure,
                current_script,
                prompt_other,
                f"cue:{cue_ids['a-01']}",
                {"kind": "script_cue", "cue_id": cue_ids["a-01"]},
                "dialogue_prompt_dependency",
            ),
        ]
        costume_key = "referenceRoleMap:costume:character-b"
        character_key = "referenceRoleMap:character:character-b"
        visual_edges = [
            create_impact(
                client, next_lock, None, next_lock, prompt_costume,
                costume_key,
                {"kind": "visual_lock_component", "component_key": costume_key},
                "visual_prompt_dependency",
            ),
            create_impact(
                client, next_lock, None, next_lock, fresh_candidate,
                character_key,
                {"kind": "visual_lock_component", "component_key": character_key},
                "visual_candidate_dependency",
            ),
        ]

        cue_change = {
            "dependency_key": f"cue:{cue_ids['b-03']}",
            "scope": {"kind": "script_cue", "cue_id": cue_ids["b-03"]},
            "previous_dependency_hash": sha256_text(source_cues[4]["text"]),
            "current_dependency_hash": sha256_text(target_cues[4]["text"]),
        }
        script_payload = {
            "idempotency_key": f"golden-b-script-{trace_id}",
            "actor_kind": "codex",
            "dependency_owner": version_guard(current_script),
            "script_structure_map": version_guard(current_structure),
            "changes": [cue_change],
        }
        prompt_before = client.get(
            f"/formal-records/{prompt_cue['ref']['film_entity_id']}"
        )
        audits_before = client.get(
            f"/audit-events?targetId={prompt_cue['ref']['film_entity_id']}"
        )
        stale_guard_payload = json.loads(json.dumps(script_payload))
        stale_guard_payload["idempotency_key"] += "-bad-guard"
        stale_guard_payload["dependency_owner"]["expected_content_hash"] = HASH_C
        stale_guard = expect_core_error(
            lambda: client.post(
                "/impacts/propagate-stale", stale_guard_payload
            ),
            status=409,
            code="content_hash_conflict",
        )
        prompt_after_failed_guard = client.get(
            f"/formal-records/{prompt_cue['ref']['film_entity_id']}"
        )
        audits_after_failed_guard = client.get(
            f"/audit-events?targetId={prompt_cue['ref']['film_entity_id']}"
        )

        script_stale = client.post("/impacts/propagate-stale", script_payload)
        script_replay = client.post("/impacts/propagate-stale", script_payload)
        prompt_after_script = client.get(
            f"/formal-records/{prompt_cue['ref']['film_entity_id']}"
        )
        script_target_audits = client.get(
            f"/audit-events?targetId={prompt_cue['ref']['film_entity_id']}"
        )

        visual_payload = {
            "idempotency_key": f"golden-b-visual-{trace_id}",
            "actor_kind": "codex",
            "dependency_owner": version_guard(next_lock),
            "script_structure_map": None,
            "changes": [
                {
                    "dependency_key": costume_key,
                    "scope": {
                        "kind": "visual_lock_component",
                        "component_key": costume_key,
                    },
                    "previous_dependency_hash": previous_local_lock[
                        "dependencyHashes"
                    ][costume_key],
                    "current_dependency_hash": next_local_lock[
                        "dependencyHashes"
                    ][costume_key],
                },
                {
                    "dependency_key": "lightingProfileVersion",
                    "scope": {
                        "kind": "visual_lock_component",
                        "component_key": "lightingProfileVersion",
                    },
                    "previous_dependency_hash": HASH_A,
                    "current_dependency_hash": HASH_B,
                },
            ],
        }
        visual_stale = client.post("/impacts/propagate-stale", visual_payload)
        visual_replay = client.post("/impacts/propagate-stale", visual_payload)
        prompt_after_costume = client.get(
            f"/formal-records/{prompt_costume['ref']['film_entity_id']}"
        )
        fresh_prompt = client.get(
            f"/formal-records/{prompt_other['ref']['film_entity_id']}"
        )
        fresh_candidate_current = client.get(
            f"/formal-records/{fresh_candidate['ref']['film_entity_id']}"
        )

        script_query = client.get(
            f"/impacts/{current_script['ref']['film_entity_id']}"
        )
        costume_query = client.get(
            f"/impacts/{prompt_costume['ref']['film_entity_id']}"
        )
        approved = asset_local["approvedBindings"]
        all_formal = [
            project,
            unit,
            *shots,
            source_script,
            current_script,
            source_decision,
            current_decision,
            *directors,
            *coverages,
            *assets.values(),
            lock_one,
            previous_lock,
            next_lock,
            lock_three,
            prompt_cue,
            prompt_other,
            prompt_costume,
            fresh_candidate,
            continuity,
            *script_edges,
            *visual_edges,
        ]
        for entity in all_formal:
            require_uuid4(entity["ref"]["film_entity_id"], entity["ref"]["entity_type"])

        failed_guard_atomic = (
            prompt_before == prompt_after_failed_guard
            and audits_before == audits_after_failed_guard
        )
        script_precise = set(script_stale["stale_entity_ids"]) == {
            prompt_cue["ref"]["film_entity_id"]
        }
        visual_precise = set(visual_stale["stale_entity_ids"]) == {
            prompt_costume["ref"]["film_entity_id"]
        }
        unresolved = visual_stale.get("unresolved_changes", [])
        lighting_unresolved = any(
            item.get("dependency_key") == "lightingProfileVersion"
            for item in unresolved
        )
        state_axes_preserved = all(
            before["states"][axis] == after["states"][axis]
            for before, after in (
                (prompt_before, prompt_after_script),
                (prompt_costume, prompt_after_costume),
            )
            for axis in ("review_state", "lock_state")
        )
        fresh_preserved = all(
            item["states"]["stale_state"] == "fresh"
            and item["ref"]["version"] == 1
            for item in (fresh_prompt, fresh_candidate_current)
        )
        replay_idempotent = (
            script_replay["replayed"] is True
            and visual_replay["replayed"] is True
            and script_replay["audit_event_ids"] == script_stale["audit_event_ids"]
            and visual_replay["audit_event_ids"] == visual_stale["audit_event_ids"]
            and len(script_target_audits) == len(audits_before) + 1
        )
        approval_counts = {
            "character": sum(
                item["asset"]["semantic"] == "character" for item in approved
            ),
            "costume": sum(
                item["asset"]["semantic"] == "costume" for item in approved
            ),
        }
        passed = all(
            (
                len(target_cues) >= 6,
                len(directors) >= 2,
                len(shots) >= 3,
                len(coverages) >= 4,
                approval_counts["character"] >= 3,
                approval_counts["costume"] >= 2,
                local["dialogue"]["changedCueIds"] == [cue_ids["b-03"]],
                local["continuity"]["state"] == "ready",
                local["continuity"]["jCutApplied"] is True,
                continuity["passed"] is True,
                script_precise,
                visual_precise,
                lighting_unresolved,
                failed_guard_atomic,
                stale_guard.status == 409,
                replay_idempotent,
                state_axes_preserved,
                fresh_preserved,
            )
        )
        return {
            "golden_id": "GOLDEN-B-REAL",
            "test_status": "PASSED" if passed else "FAILED",
            "prepared": True,
            "persisted": passed,
            "reviewed": state_axes_preserved,
            "continuity_verified": continuity["passed"],
            "external_provider_calls": 0,
            "fallback_mock_used": False,
            "trace_id": trace_id,
            "sidecar": {
                "health": health["status"],
                "service": health["service"],
                "database": "temporary_sqlite_sidecar",
            },
            "operations": {
                f"{method} {path}": operations[(method, path)].operation_id
                for method, path in REQUIRED_D0006_OPERATIONS
            },
            "project_id": project["ref"]["film_entity_id"],
            "unit_id": unit["ref"]["film_entity_id"],
            "script_version_id": current_script["ref"]["film_entity_id"],
            "script_structure_map_id": current_structure["ref"]["film_entity_id"],
            "source_script_structure_map_id": source_structure["ref"]["film_entity_id"],
            "director_unit_ids": [item["ref"]["film_entity_id"] for item in directors],
            "shot_ids": [item["ref"]["film_entity_id"] for item in shots],
            "coverage_link_ids": [item["ref"]["film_entity_id"] for item in coverages],
            "visual_lock_ids": [
                lock_one["ref"]["film_entity_id"],
                previous_lock["ref"]["film_entity_id"],
                next_lock["ref"]["film_entity_id"],
                lock_three["ref"]["film_entity_id"],
            ],
            "impact_edge_ids": [
                item["ref"]["film_entity_id"]
                for item in (*script_edges, *visual_edges)
            ],
            "stale_target_ids": [
                *script_stale["stale_entity_ids"],
                *visual_stale["stale_entity_ids"],
            ],
            "fresh_target_ids": [
                fresh_prompt["ref"]["film_entity_id"],
                fresh_candidate_current["ref"]["film_entity_id"],
            ],
            "audit_event_ids": [
                *script_stale["audit_event_ids"],
                *visual_stale["audit_event_ids"],
                *asset_local["approvalAuditIds"],
            ],
            "dialogue": {
                "cast": sorted({item["speaker"] for item in target_cues}),
                "cue_count": len(target_cues),
                "changed_cue_ids": local["dialogue"]["changedCueIds"],
                "script_stale_precise": script_precise,
            },
            "coverage": {
                "director_units": len(directors),
                "shots": len(shots),
                "links": len(coverages),
                "many_to_many": len({pair[0] for pair in coverage_pairs}) > 1
                and len({pair[1] for pair in coverage_pairs}) > 2,
            },
            "approved_asset_bindings": approval_counts,
            "continuity": {
                "core_passed": continuity["passed"],
                "dimensions": [
                    "axis",
                    "eyeline",
                    "blocking",
                    "action",
                    "prop_contact",
                ],
                "j_cut_state": local["continuity"]["state"],
                "j_cut_applied": local["continuity"]["jCutApplied"],
                "j_cut_formal_apply": local["continuity"][
                    "formalMutationAllowed"
                ],
            },
            "stale": {
                "script_precise": script_precise,
                "visual_precise": visual_precise,
                "unresolved_changes": unresolved,
                "lighting_unresolved": lighting_unresolved,
                "state_axes_preserved": state_axes_preserved,
                "fresh_preserved": fresh_preserved,
            },
            "conflict_recovery": {
                "stale_guard_blocked": stale_guard.status == 409,
                "zero_partial_writes": failed_guard_atomic,
                "recovered_with_current_guard": script_stale["replayed"] is False,
            },
            "idempotency": {
                "script_replayed": script_replay["replayed"],
                "visual_replayed": visual_replay["replayed"],
                "same_audit_ids": replay_idempotent,
            },
            "impact_queries": {
                "script_outgoing": len(script_query["outgoing"]),
                "costume_incoming": len(costume_query["incoming"]),
            },
        }


def dialogue_cues(cue_ids: dict[str, str], changed_text: str) -> list[dict[str, str]]:
    return [
        {"cue_id": cue_ids["a-01"], "speaker": "A", "text": "你早就知道。"},
        {"cue_id": cue_ids["b-01"], "speaker": "B", "text": "我只知道一部分。"},
        {"cue_id": cue_ids["c-01"], "speaker": "C", "text": "那就从头说。"},
        {"cue_id": cue_ids["a-02"], "speaker": "A", "text": "从雨夜开始。"},
        {"cue_id": cue_ids["b-03"], "speaker": "B", "text": changed_text},
        {"cue_id": cue_ids["c-02"], "speaker": "C", "text": "门外有人。"},
    ]


def script_text(cues: list[dict[str, str]]) -> str:
    return "INT. DINING ROOM - NIGHT\n" + "\n".join(
        f"{item['speaker']}：{item['text']}" for item in cues
    )


def create_locked_script(
    client: FilmCoreHttpClient, text: str, approved_by: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    source = create_formal(
        client,
        "script_version",
        host={
            "host_project_id": "host-project-golden-b",
            "host_unit_id": "host-unit-golden-b",
        },
        states=FORMAL_STATES,
        script_text=text,
    )
    result = client.post(
        "/script-versions/lock",
        {
            "locked_write": create_guard(),
            "decision_write": create_guard(),
            "actor_kind": "human",
            "source_script_version": version_guard(source),
            "approved_by": approved_by,
        },
    )
    return result["locked_script_version"], result["decision"]


def create_structure_map(
    client: FilmCoreHttpClient,
    script: dict[str, Any],
    section_id: str,
    cues: list[dict[str, str]],
) -> dict[str, Any]:
    return client.post(
        "/script-structure-maps",
        {
            "write": create_guard(),
            "actor_kind": "codex",
            "script_version": version_guard(script),
            "sections": [
                {"section_id": section_id, "start_order": 1, "end_order": len(cues)}
            ],
            "cues": [
                {
                    "cue_id": item["cue_id"],
                    "section_id": section_id,
                    "speaker": item["speaker"],
                    "order": index,
                    "cue_text_hash": sha256_text(item["text"]),
                }
                for index, item in enumerate(cues, start=1)
            ],
        },
    )


def run_asset_segment(
    *,
    assets: dict[str, dict[str, Any]],
    specs: tuple[tuple[str, str, str, str], ...],
    director_unit_id: str,
    scope_id: str,
) -> dict[str, Any]:
    seeds = []
    for role, purpose, semantic, content_hash in specs:
        entity = assets[role]
        seeds.append(
            {
                "bindingId": entity["ref"]["film_entity_id"],
                "candidateId": str(uuid4()),
                "candidateAuditEventId": str(uuid4()),
                "approvalAuditEventId": str(uuid4()),
                "reviewId": str(uuid4()),
                "qcReportId": str(uuid4()),
                "role": role,
                "semantic": semantic,
                "purpose": purpose,
                "target": {"kind": "director_unit", "id": director_unit_id},
                "hostAssetId": entity["host"]["host_asset_id"],
                "hostAssetVersionId": entity["host"]["host_asset_version_id"],
                "hostResourceId": entity["host"]["host_resource_id"],
                "contentHash": content_hash,
            }
        )
    by_role = {item["role"]: item["bindingId"] for item in seeds}
    return run_bun_json(
        "tests/film-golden/golden_b_assets_local.ts",
        {
            "hostProjectId": "host-project-golden-b",
            "bindings": seeds,
            "previousRoles": {
                "character:character-a": by_role["character-a"],
                "character:character-b": by_role["character-b"],
                "character:character-c": by_role["character-c"],
                "costume:character-a": by_role["costume-a"],
                "costume:character-b": by_role["costume-b-v1"],
            },
            "nextRoles": {
                "character:character-a": by_role["character-a"],
                "character:character-b": by_role["character-b"],
                "character:character-c": by_role["character-c"],
                "costume:character-a": by_role["costume-a"],
                "costume:character-b": by_role["costume-b-v2"],
            },
            "previousVisualLockId": str(uuid4()),
            "nextVisualLockId": str(uuid4()),
            "scopeId": scope_id,
            "occurredAt": OCCURRED_AT,
        },
    )


def core_locks(local_lock: dict[str, Any]) -> dict[str, Any]:
    return {
        "components": local_lock["components"],
        "component_hashes": local_lock["componentHashes"],
        "dependency_hashes": dict(local_lock["dependencyHashes"]),
        "local_visual_lock_id": local_lock["id"],
        "local_visual_lock_version": local_lock["version"],
    }


def create_visual_lock(
    client: FilmCoreHttpClient,
    project: dict[str, Any],
    shot: dict[str, Any],
    text: str,
    locks: dict[str, Any],
) -> dict[str, Any]:
    return create_formal(
        client,
        "visual_lock_set",
        project=version_guard(project),
        shot=version_guard(shot),
        states=LOCKED_APPROVED_STATES,
        visual_lock_text=text,
        visual_lock_hash=sha256_text(text),
        locks=locks,
    )


def compile_prompt(
    client: FilmCoreHttpClient,
    project: dict[str, Any],
    shot: dict[str, Any],
    director: dict[str, Any],
    visual_lock: dict[str, Any],
    asset: dict[str, Any],
    prompt_text: str,
) -> dict[str, Any]:
    result = client.post(
        "/prompts/compile",
        {
            "draft_write": create_guard(),
            "provenance_write": create_guard(),
            "actor_kind": "codex",
            "states": FORMAL_STATES,
            "director_ir_hash": director["director_ir_hash"],
            "visual_lock_hash": visual_lock["visual_lock_hash"],
            "model_capability_profile": "manual.video.v1",
            "prompt_text": prompt_text,
            "project": bound(project),
            "shot": bound(shot),
            "director_unit": bound(director),
            "visual_lock": bound(visual_lock),
            "prompt_template": {
                "host_prompt_template_id": "host-prompt-template-golden-b",
                "operation": "film.prompt.compile",
                "version": 1,
                "content_hash": HASH_A,
            },
            "assets": [
                {
                    "binding": bound(asset),
                    "asset_content_hash": asset["asset_content_hash"],
                }
            ],
            "capability_profile": {
                "profile_id": "manual-video-v1",
                "profile_version": 1,
                "provider_id": "manual_web",
                "output_kind": "video",
                "dialect": "plain_zh",
                "capabilities": {
                    "reference_assets": True,
                    "negative_prompt": True,
                    "camera_control": True,
                },
            },
            "provider_parameters": {
                "aspect_ratio": "9:16",
                "duration_seconds": 6,
                "seed": None,
                "negative_prompt": "越轴，视线漂移，服装错误",
            },
        },
    )
    return result["prompt_draft"]


def import_local_candidate(
    client: FilmCoreHttpClient, package: dict[str, Any]
) -> dict[str, Any]:
    result = client.post(
        "/manual-results/import",
        {
            "evidence_write": create_guard(),
            "candidate_write": create_guard(),
            "actor_kind": "human",
            "generation_package": version_guard(package),
            "provider_task_id": "golden-b-local-task",
            "receipt": {
                "receipt_id": "golden-b-local-receipt",
                "content_hash": HASH_B,
                "captured_at": OCCURRED_AT,
            },
            "manual_source": {
                "source_id": "golden-b-local-source",
                "source_kind": "local_runtime_export",
                "imported_by": "golden-b-human",
                "imported_at": OCCURRED_AT,
                "authorization_evidence_id": "golden-b-local-authorization",
            },
            "outputs": [
                {
                    "host_resource_id": "host-resource-golden-b-fresh-candidate",
                    "output_kind": "video",
                    "content_hash": HASH_C,
                    "mime_type": "video/mp4",
                    "bytes": 2048,
                }
            ],
        },
    )
    return result["candidate"]


def run_dialogue_segment(
    *,
    source_script: dict[str, Any],
    current_script: dict[str, Any],
    source_cues: list[dict[str, str]],
    target_cues: list[dict[str, str]],
    section_id: str,
    prompt_cue: dict[str, Any],
    prompt_other: dict[str, Any],
    fresh_candidate: dict[str, Any],
    previous_lock: dict[str, Any],
    next_lock: dict[str, Any],
    prompt_costume: dict[str, Any],
    shots: list[dict[str, Any]],
) -> dict[str, Any]:
    def cue_web(item: dict[str, str]) -> dict[str, str]:
        return {
            "cueId": item["cue_id"],
            "speaker": item["speaker"],
            "text": item["text"],
        }
    return run_bun_json(
        "tests/film-golden/golden_b_local.ts",
        {
            "sourceScript": web_script(source_script, 1),
            "targetScript": web_script(current_script, 2, source_script),
            "sourceCues": [cue_web(item) for item in source_cues],
            "targetCues": [cue_web(item) for item in target_cues],
            "changedSectionIds": [section_id],
            "scriptDependencies": [
                {
                    "targetId": prompt_cue["ref"]["film_entity_id"],
                    "targetType": "prompt_draft",
                    "sourceContentHash": source_script["ref"]["content_hash"],
                    "dialogueCueIds": [source_cues[4]["cue_id"]],
                },
                {
                    "targetId": prompt_other["ref"]["film_entity_id"],
                    "targetType": "prompt_draft",
                    "sourceContentHash": source_script["ref"]["content_hash"],
                    "dialogueCueIds": [source_cues[0]["cue_id"]],
                },
                {
                    "targetId": fresh_candidate["ref"]["film_entity_id"],
                    "targetType": "other",
                    "sourceContentHash": HASH_C,
                    "dialogueCueIds": [source_cues[4]["cue_id"]],
                },
            ],
            "previousVisualLock": previous_lock,
            "nextVisualLock": next_lock,
            "visualConsumers": [
                {
                    "entityId": prompt_costume["ref"]["film_entity_id"],
                    "dependencies": ["referenceRoleMap:costume:character-b"],
                },
                {
                    "entityId": prompt_other["ref"]["film_entity_id"],
                    "dependencies": ["referenceRoleMap:character:character-b"],
                },
            ],
            "dialogueContinuity": {
                "enabled": True,
                "visualChecks": [
                    visual_check("axis", "axis-main", "left_to_right"),
                    visual_check("eyeline", "character-b", "character-a"),
                    visual_check("blocking", "character-b", "seat-right"),
                    visual_check("action", "character-b", "turns-to-door"),
                    visual_check("prop_contact", "door", "closed"),
                ],
                "audioLead": {
                    "dimension": "audio_lead",
                    "cueId": target_cues[4]["cue_id"],
                    "speakerId": "character-b",
                    "leadMilliseconds": 600,
                },
                "jCutException": {
                    "kind": "j_cut_audio_lead",
                    "cueId": target_cues[4]["cue_id"],
                    "speakerId": "character-b",
                    "fromShot": web_guard(shots[0]),
                    "toShot": web_guard(shots[1]),
                    "leadMilliseconds": 600,
                    "actorKind": "human",
                    "approvedBy": "director-golden-b",
                    "approvedAt": OCCURRED_AT,
                    "rationale": "声音先入，不改变任何画面连续性判定。",
                },
            },
        },
    )


def web_script(
    entity: dict[str, Any], version: int, parent: dict[str, Any] | None = None
) -> dict[str, Any]:
    return {
        "id": entity["ref"]["film_entity_id"],
        "scriptId": "golden-b-script",
        "hostProjectId": "host-project-golden-b",
        "hostUnitId": "host-unit-golden-b",
        **(
            {"parentVersionId": parent["ref"]["film_entity_id"]}
            if parent is not None
            else {}
        ),
        "version": version,
        "title": "Golden B",
        "scriptText": entity["script_text"],
        "contentHash": entity["ref"]["content_hash"],
        "sourceKind": "manual",
        "reviewState": entity["states"]["review_state"],
        "lockState": entity["states"]["lock_state"],
        "createdAt": OCCURRED_AT,
        "createdBy": "golden-b",
    }


def web_guard(entity: dict[str, Any]) -> dict[str, Any]:
    return {
        "filmEntityId": entity["ref"]["film_entity_id"],
        "expectedVersion": entity["ref"]["version"],
        "expectedContentHash": entity["ref"]["content_hash"],
    }


def visual_check(
    dimension: str, subject_id: str, value: str
) -> dict[str, str]:
    return {
        "dimension": dimension,
        "subjectId": subject_id,
        "expectedValue": value,
        "actualValue": value,
    }


def create_impact(
    client: FilmCoreHttpClient,
    owner: dict[str, Any],
    structure: dict[str, Any] | None,
    source: dict[str, Any],
    target: dict[str, Any],
    dependency_key: str,
    scope: dict[str, Any],
    relation: str,
) -> dict[str, Any]:
    return client.post(
        "/impacts",
        {
            "write": create_guard(),
            "actor_kind": "codex",
            "dependency_owner": version_guard(owner),
            "script_structure_map": (
                version_guard(structure) if structure is not None else None
            ),
            "source": version_guard(source),
            "target": version_guard(target),
            "dependency_key": dependency_key,
            "scope": scope,
            "relation": relation,
            "propagates_stale": True,
        },
    )


def run_bun_json(script: str, payload: dict[str, Any]) -> dict[str, Any]:
    process = subprocess.run(
        ["bun", script],
        cwd=REPOSITORY_ROOT,
        input=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        capture_output=True,
        text=True,
        check=False,
    )
    if process.returncode != 0:
        raise GoldenARealError(
            f"local Golden B segment failed ({script}): {process.stderr.strip()}"
        )
    try:
        value = json.loads(process.stdout)
    except json.JSONDecodeError as error:
        raise GoldenARealError(
            f"local Golden B segment returned invalid JSON ({script})"
        ) from error
    if not isinstance(value, dict):
        raise GoldenARealError("local Golden B segment must return an object")
    return value


if __name__ == "__main__":
    print(json.dumps(run_real_golden_b(), ensure_ascii=False, indent=2))
