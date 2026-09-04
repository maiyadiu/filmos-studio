"""Self-contained loopback Film Core used by the FilmOS desktop connection manager."""

from __future__ import annotations

import os
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from film_production_core.api import create_app
from film_production_core.database import SQLiteDatabase
from film_production_core.repository import FilmRepository
from film_production_core.service import FilmService


EXTERNAL_READ_MODE = "external-read"
EXTERNAL_READ_PROJECT_ID = "ca40511be3ae12112101cc1de6059b95"
EXTERNAL_READ_DATABASE_PATH = (
    "/Users/apple/Library/Application Support/FilmOS Studio/ChatGPTConnection/"
    "FilmCore/film-core.sqlite"
)
EXTERNAL_READ_DATABASE_IDENTITY: dict[str, Any] = {
    "path": EXTERNAL_READ_DATABASE_PATH,
    "device": 16777234,
    "inode": 98502137,
    "size": 368640,
    "sha256": "5756128081ed9e410ee58558cab2560d4dd235fa4b644dc8e9d3417ee983a47f",
    "wal": {
        "device": 16777234,
        "inode": 106184316,
        "size": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    "shm": {
        "device": 16777234,
        "inode": 106184317,
        "size": 32768,
        "sha256": "fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb",
    },
}
EXTERNAL_READ_PROJECT_MAPPING = {
    "film_entity_id": "a7b9d814-ea33-4d99-afde-6ccfcd93421c",
    "version": 1,
    "content_hash": "3bdf5e830e542def63117b976c7026109834a7e5806a4fe46f0e43aff186f977",
    "project_count": 1,
    "content_unit_count": 1,
    "shot_count": 0,
}


def build_app(
    *, external_read_test_only: dict[str, Any] | None = None
) -> FastAPI:
    database_path = os.environ["FILMOS_CORE_DB_PATH"]
    if os.environ.get("FILMOS_CORE_RUNTIME_MODE") == EXTERNAL_READ_MODE:
        configuration = external_read_test_only or {
            "database_path": EXTERNAL_READ_DATABASE_PATH,
            "database_identity": EXTERNAL_READ_DATABASE_IDENTITY,
            "project_id": EXTERNAL_READ_PROJECT_ID,
            "project_mapping": EXTERNAL_READ_PROJECT_MAPPING,
        }
        if database_path != configuration["database_path"]:
            raise RuntimeError("FILM_CORE_READ_ONLY_DATABASE_REQUIRED")
        return build_external_read_app(**configuration)

    app = FastAPI(title="FilmOS Desktop Film Core")
    core = create_app(database_path)

    @app.get("/health")
    def health() -> dict[str, object]:
        return {"ok": True, "service": "filmos-film-core", "mounted_base": "/film"}

    app.mount("/film", core)
    return app


def build_external_read_app(
    *,
    database_path: str,
    database_identity: dict[str, Any],
    project_id: str,
    project_mapping: dict[str, Any],
) -> FastAPI:
    database = SQLiteDatabase(
        database_path,
        read_only=True,
        expected_identity=database_identity,
    )
    repository = FilmRepository(database)
    service = FilmService(repository)
    _assert_external_read_mapping(repository, service, project_id, project_mapping)
    app = FastAPI(
        title="FilmOS External Read Film Core",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.film_service = service
    app.state.runtime_mode = EXTERNAL_READ_MODE
    allowed_paths = {
        "/health",
        f"/film/projects/{project_id}/context",
    }

    @app.middleware("http")
    async def external_read_allowlist(request: Request, call_next):
        if (
            request.method != "GET"
            or request.url.path not in allowed_paths
            or request.url.query
        ):
            return JSONResponse(
                status_code=404,
                content={"code": "FILM_CORE_EXTERNAL_READ_ROUTE_DENIED"},
            )
        return await call_next(request)

    @app.get("/health")
    def health() -> dict[str, object]:
        result = service.health()
        return {
            "ok": True,
            "service": "filmos-film-core",
            "runtime_mode": EXTERNAL_READ_MODE,
            "schema_version": result.schema_version,
            "journal_mode": result.journal_mode,
            "project_id": project_id,
        }

    @app.get(f"/film/projects/{project_id}/context")
    def project_context():
        return service.project_context(project_id)

    return app


def _assert_external_read_mapping(
    repository: FilmRepository,
    service: FilmService,
    project_id: str,
    expected: dict[str, Any],
) -> None:
    with repository.database.connect() as connection:
        counts = {
            row["entity_type"]: int(row["count"])
            for row in connection.execute(
                "SELECT entity_type, COUNT(*) AS count FROM film_entities "
                "GROUP BY entity_type"
            ).fetchall()
        }
    context = service.project_context(project_id)
    project = context.film_project
    if (
        project is None
        or str(project.ref.film_entity_id) != expected["film_entity_id"]
        or project.ref.version != expected["version"]
        or project.ref.content_hash != expected["content_hash"]
        or len(context.content_units) != expected["content_unit_count"]
        or len(context.shots) != expected["shot_count"]
        or counts.get("film_project_extension", 0) != expected["project_count"]
        or counts.get("content_unit_extension", 0) != expected["content_unit_count"]
        or counts.get("shot_extension", 0) != expected["shot_count"]
    ):
        raise RuntimeError("FILM_CORE_EXTERNAL_READ_MAPPING_MISMATCH")


def main() -> None:
    runtime_mode = os.environ.get("FILMOS_CORE_RUNTIME_MODE")
    host = os.environ.get("FILMOS_CORE_HOST", "127.0.0.1")
    port = int(os.environ.get("FILMOS_CORE_PORT", "17650"))
    if runtime_mode == EXTERNAL_READ_MODE and (host != "127.0.0.1" or port != 17650):
        raise RuntimeError("FILM_CORE_EXTERNAL_READ_LISTENER_MISMATCH")
    uvicorn.run(
        build_app(),
        host=host,
        port=port,
        log_level="warning",
    )


if __name__ == "__main__":
    main()
