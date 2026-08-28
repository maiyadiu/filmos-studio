from __future__ import annotations

import json
import math
import platform
import tempfile
import time
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from fastapi.testclient import TestClient

from film_production_core.api import create_app


ROOT = Path(__file__).resolve().parents[2]
SPEC_PATH = Path(__file__).with_name("beta-performance.json")


def percentile(samples: list[float], quantile: float) -> float:
    ordered = sorted(samples)
    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * quantile) - 1))
    return ordered[index]


def measure(call: Callable[[], Any], samples: int) -> dict[str, float]:
    durations: list[float] = []
    for _ in range(samples):
        started = time.perf_counter()
        call()
        durations.append((time.perf_counter() - started) * 1000)
    return {
        "p50_ms": round(percentile(durations, 0.50), 3),
        "p95_ms": round(percentile(durations, 0.95), 3),
        "max_ms": round(max(durations), 3),
    }


def states() -> dict[str, str]:
    return {
        "creative_stage": "draft",
        "execution_state": "not_started",
        "review_state": "not_reviewed",
        "lock_state": "unlocked",
        "delivery_state": "not_ready",
        "stale_state": "fresh",
    }


def create_command(entity_type: str, host: dict[str, str], **extra: Any) -> dict[str, Any]:
    return {
        "command_type": "entity.create",
        "target_id": None,
        "expected_version": 0,
        "actor_kind": "human",
        "payload": {
            "entity_type": entity_type,
            "host": host,
            "states": states(),
            **extra,
        },
    }


def web_bundle_metrics(warning_bytes: int) -> dict[str, Any]:
    asset_root = ROOT / "web" / "dist" / "assets"
    javascript = sorted(
        (
            {"name": path.name, "bytes": path.stat().st_size}
            for path in asset_root.glob("*.js")
            if path.is_file()
        ),
        key=lambda item: item["bytes"],
        reverse=True,
    )
    return {
        "dist_present": asset_root.is_dir(),
        "javascript_files": len(javascript),
        "largest_javascript": javascript[0] if javascript else None,
        "javascript_over_warning": sum(
            item["bytes"] > warning_bytes for item in javascript
        ),
    }


def run() -> dict[str, Any]:
    spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    dataset = spec["dataset"]
    budgets = spec["budgets_ms"]
    samples = int(dataset["samples"])
    failures: list[str] = []

    with tempfile.TemporaryDirectory(prefix="filmos-beta-performance-") as directory:
        root = Path(directory)
        init_samples = measure(
            lambda: create_app(root / f"init-{uuid4()}.sqlite"),
            min(samples, 20),
        )
        app = create_app(root / "film-core.sqlite")
        with TestClient(app) as client:
            project = client.post(
                "/commands/apply",
                json=create_command(
                    "film_project_extension",
                    {"host_project_id": "beta-project"},
                ),
            )
            if project.status_code != 200:
                raise RuntimeError(f"project seed failed: {project.text}")
            project_id = project.json()["entity"]["ref"]["film_entity_id"]

            for index in range(int(dataset["content_units"])):
                response = client.post(
                    "/commands/apply",
                    json=create_command(
                        "content_unit_extension",
                        {
                            "host_project_id": "beta-project",
                            "host_unit_id": f"beta-unit-{index:03d}",
                        },
                        unit_kind="episode",
                    ),
                )
                if response.status_code != 200:
                    raise RuntimeError(f"unit seed failed at {index}: {response.text}")

            director_id = str(uuid4())
            for index in range(int(dataset["shots"])):
                response = client.post(
                    "/commands/apply",
                    json=create_command(
                        "shot_extension",
                        {
                            "host_project_id": "beta-project",
                            "host_unit_id": f"beta-unit-{index % int(dataset['content_units']):03d}",
                            "host_shot_id": f"beta-shot-{index:03d}",
                        },
                        director_unit_ids=[director_id],
                    ),
                )
                if response.status_code != 200:
                    raise RuntimeError(f"shot seed failed at {index}: {response.text}")

            def context_read() -> None:
                response = client.get("/projects/beta-project/context")
                if response.status_code != 200:
                    raise RuntimeError("project context read failed")
                body = response.json()
                if len(body["content_units"]) != int(dataset["content_units"]):
                    raise RuntimeError("project context unit count drifted")
                if len(body["shots"]) != int(dataset["shots"]):
                    raise RuntimeError("project context shot count drifted")

            def entity_read() -> None:
                if client.get(f"/entities/{project_id}").status_code != 200:
                    raise RuntimeError("entity read failed")

            preview_command = {
                "command_type": "entity.set_states",
                "target_id": project_id,
                "expected_version": 1,
                "actor_kind": "deepseek",
                "payload": {"states": {**states(), "creative_stage": "authored"}},
            }

            def command_preview() -> None:
                response = client.post("/commands/preview", json=preview_command)
                if response.status_code != 200 or response.json()["resulting_version"] != 2:
                    raise RuntimeError("command preview failed")

            metrics = {
                "app_init": init_samples,
                "project_context": measure(context_read, samples),
                "entity_read": measure(entity_read, samples),
                "command_preview": measure(command_preview, samples),
            }
            database_bytes = (root / "film-core.sqlite").stat().st_size

    checks = {
        "app_init_p95": metrics["app_init"]["p95_ms"] <= budgets["app_init_p95"],
        "project_context_p95": metrics["project_context"]["p95_ms"]
        <= budgets["project_context_p95"],
        "entity_read_p95": metrics["entity_read"]["p95_ms"]
        <= budgets["entity_read_p95"],
        "command_preview_p95": metrics["command_preview"]["p95_ms"]
        <= budgets["command_preview_p95"],
    }
    failures.extend(name for name, passed in checks.items() if not passed)
    bundle_limits = spec["web_bundle"]
    bundle = web_bundle_metrics(int(bundle_limits["javascript_warning_bytes"]))
    largest = bundle["largest_javascript"]
    largest_bytes = int(largest["bytes"]) if largest else 0
    bundle_blocked = largest_bytes > int(bundle_limits["javascript_blocking_bytes"])
    bundle_warning = largest_bytes > int(bundle_limits["javascript_warning_bytes"])
    if bundle_blocked:
        failures.append("web_javascript_blocking_budget")

    return {
        "test_status": "PASSED_WITH_WARNING" if not failures and bundle_warning else (
            "PASSED" if not failures else "FAILED"
        ),
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
        },
        "dataset": dataset,
        "budgets_ms": budgets,
        "metrics": metrics,
        "database_bytes": database_bytes,
        "web_bundle": {
            **bundle,
            "warning_budget_bytes": bundle_limits["javascript_warning_bytes"],
            "blocking_budget_bytes": bundle_limits["javascript_blocking_bytes"],
            "warning": bundle_warning,
            "blocked": bundle_blocked,
        },
        "checks": checks,
        "failures": failures,
        "external_provider_calls": 0,
        "network_actions": 0,
    }


if __name__ == "__main__":
    result = run()
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    raise SystemExit(0 if result["test_status"] != "FAILED" else 1)
