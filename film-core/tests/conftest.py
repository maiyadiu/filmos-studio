from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from film_production_core.api import create_app


@pytest.fixture
def client(tmp_path) -> Iterator[TestClient]:
    app = create_app(tmp_path / "film-core.sqlite")
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def states() -> dict[str, str]:
    return {
        "creative_stage": "draft",
        "execution_state": "not_started",
        "review_state": "not_reviewed",
        "lock_state": "unlocked",
        "delivery_state": "not_ready",
        "stale_state": "fresh",
    }


@pytest.fixture
def project_create_command(states) -> dict:
    return {
        "command_type": "entity.create",
        "target_id": None,
        "expected_version": 0,
        "actor_kind": "human",
        "payload": {
            "entity_type": "film_project_extension",
            "host": {"host_project_id": "host-project-1"},
            "states": states,
        },
    }
