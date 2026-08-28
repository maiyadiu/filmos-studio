from __future__ import annotations

import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient


REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPOSITORY_ROOT / "film-core" / "src"))
sys.path.insert(0, str(REPOSITORY_ROOT / "film-core" / "tests"))

from film_production_core.api import create_app  # noqa: E402
from test_golden_core import (  # noqa: E402
    HASH_A,
    HASH_C,
    compile_prompt,
    create_formal,
    create_guard,
    create_source_chain,
    version_guard,
)
from test_spatial_versions import scene_payload, spatial_write  # noqa: E402


def main() -> None:
    database_path = Path(sys.argv[1])
    states = {
        "creative_stage": "draft",
        "execution_state": "not_started",
        "review_state": "not_reviewed",
        "lock_state": "unlocked",
        "delivery_state": "not_ready",
        "stale_state": "fresh",
    }
    with TestClient(create_app(database_path)) as client:
        chain = create_source_chain(client, states)
        compiled = compile_prompt(client, chain)
        generation_package = create_formal(
            client,
            "generation_package",
            prompt_draft=version_guard(compiled["prompt_draft"]),
            host_project_id="host-project-1",
            provider_id="dreamina",
            capability_id="image",
            parameters={"aspect_ratio": "16:9", "seed": 7},
        )
        imported_response = client.post(
            "/manual-results/import",
            json={
                "evidence_write": create_guard(),
                "candidate_write": create_guard(),
                "actor_kind": "human",
                "generation_package": version_guard(generation_package),
                "provider_task_id": "local-fixture-task-1",
                "receipt": {"receipt_id": "local-fixture-receipt-1", "content_hash": HASH_C, "captured_at": "2026-08-28T10:00:00Z"},
                "manual_source": {
                    "source_id": "local-fixture-import-1",
                    "source_kind": "provider_console",
                    "imported_by": "golden-test",
                    "imported_at": "2026-08-28T10:01:00Z",
                    "authorization_evidence_id": "local-fixture-authorization-1",
                },
                "outputs": [{"host_resource_id": "local-fixture-resource-1", "output_kind": "image", "content_hash": HASH_A, "mime_type": "image/png", "bytes": 1024}],
            },
        )
        imported_response.raise_for_status()
        candidate = imported_response.json()["candidate"]
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
        review_response.raise_for_status()
        scene = spatial_write(client, "track14-real-scene", scene_payload(chain, states))
        print(
            json.dumps(
                {
                    "project_id": "host-project-1",
                    "unit_id": "host-unit-1",
                    "shot_id": "host-shot-1",
                    "asset_id": chain["asset"]["ref"]["film_entity_id"],
                    "scene_twin_id": scene["entity"]["ref"]["film_entity_id"],
                    "candidate_id": candidate["ref"]["film_entity_id"],
                    "review_id": review_response.json()["ref"]["film_entity_id"],
                }
            )
        )


if __name__ == "__main__":
    main()
