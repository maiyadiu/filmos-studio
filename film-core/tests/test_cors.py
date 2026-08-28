from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from film_production_core.api import create_app
from film_production_core.cors import CORS_ORIGINS_ENV


@pytest.mark.parametrize(
    "origin",
    [
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://[::1]:4173",
        "http://[0:0:0:0:0:0:0:1]:5173",
    ],
)
def test_loopback_origin_is_echoed_without_wildcard(
    tmp_path, monkeypatch, origin
) -> None:
    monkeypatch.delenv(CORS_ORIGINS_ENV, raising=False)
    with TestClient(create_app(tmp_path / "cors.sqlite")) as client:
        response = client.get("/health", headers={"Origin": origin})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert response.headers["access-control-allow-origin"] != "*"
    assert "access-control-allow-credentials" not in response.headers


def test_loopback_preflight_allows_required_methods_and_headers(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.delenv(CORS_ORIGINS_ENV, raising=False)
    with TestClient(create_app(tmp_path / "preflight.sqlite")) as client:
        response = client.options(
            "/prompts/compile",
            headers={
                "Origin": "http://127.0.0.1:5173",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type, Accept",
            },
        )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == (
        "http://127.0.0.1:5173"
    )
    methods = {
        item.strip()
        for item in response.headers["access-control-allow-methods"].split(",")
    }
    assert {"GET", "POST", "OPTIONS"} <= methods
    headers = {
        item.strip().lower()
        for item in response.headers["access-control-allow-headers"].split(",")
    }
    assert {"accept", "content-type"} <= headers


@pytest.mark.parametrize(
    "origin",
    [
        "http://example.com:5173",
        "https://127.0.0.1:5173",
        "http://127.0.0.1",
        "http://127.0.0.1:0",
        "http://127.0.0.2:5173",
        "http://[::2]:5173",
        "null",
    ],
)
def test_remote_or_noncanonical_origin_is_not_authorized(
    tmp_path, monkeypatch, origin
) -> None:
    monkeypatch.delenv(CORS_ORIGINS_ENV, raising=False)
    with TestClient(create_app(tmp_path / "denied.sqlite")) as client:
        simple = client.get("/health", headers={"Origin": origin})
        preflight = client.options(
            "/health",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
            },
        )

    assert simple.status_code == 200
    assert "access-control-allow-origin" not in simple.headers
    assert preflight.status_code == 400
    assert "access-control-allow-origin" not in preflight.headers


def test_explicit_env_allowlist_narrows_default_loopback_origins(
    tmp_path, monkeypatch
) -> None:
    allowed = "http://localhost:5173"
    monkeypatch.setenv(CORS_ORIGINS_ENV, allowed)
    with TestClient(create_app(tmp_path / "allowlist.sqlite")) as client:
        accepted = client.get("/health", headers={"Origin": allowed})
        denied = client.get(
            "/health", headers={"Origin": "http://127.0.0.1:5173"}
        )

    assert accepted.headers["access-control-allow-origin"] == allowed
    assert "access-control-allow-origin" not in denied.headers


@pytest.mark.parametrize(
    "configured",
    ["*", "https://localhost:5173", "http://example.com:5173"],
)
def test_explicit_env_allowlist_rejects_non_loopback_values(
    tmp_path, monkeypatch, configured
) -> None:
    monkeypatch.setenv(CORS_ORIGINS_ENV, configured)
    database_path = tmp_path / "invalid-allowlist.sqlite"

    with pytest.raises(ValueError, match="only explicit loopback HTTP origins"):
        create_app(database_path)
    assert not database_path.exists()
