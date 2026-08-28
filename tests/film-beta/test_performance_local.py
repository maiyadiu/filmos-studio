from __future__ import annotations

from performance_local import run


def test_beta_performance_budgets_are_reproducible() -> None:
    result = run()

    assert result["test_status"] in {"PASSED", "PASSED_WITH_WARNING"}
    assert result["failures"] == []
    assert all(result["checks"].values())
    assert result["external_provider_calls"] == 0
    assert result["network_actions"] == 0
    assert result["web_bundle"]["blocked"] is False
