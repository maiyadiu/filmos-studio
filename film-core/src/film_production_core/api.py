from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated

from fastapi import Body, FastAPI, Query, Request
from fastapi.responses import JSONResponse
from pydantic import UUID4

from film_production_core.database import SQLiteDatabase
from film_production_core.errors import (
    EntityNotFound,
    HostMappingNotFound,
    VersionConflict,
)
from film_production_core.models import (
    AuditEvent,
    Command,
    CommandApplyResult,
    CommandPreviewResult,
    ContentUnitExtension,
    ErrorResponse,
    FilmEntity,
    FilmProjectContext,
    HealthResult,
    ShotExtension,
)
from film_production_core.repository import FilmRepository
from film_production_core.service import FilmService


def default_database_path() -> Path:
    configured = os.environ.get("FILMOS_CORE_DB_PATH", "").strip()
    if configured:
        return Path(configured)
    return Path.cwd() / ".local" / "film-core.sqlite"


def create_app(database_path: str | Path | None = None) -> FastAPI:
    repository = FilmRepository(SQLiteDatabase(database_path or default_database_path()))
    service = FilmService(repository)
    app = FastAPI(
        title="FilmOS Studio Film Core API",
        version="0.1.0",
        description=(
            "Sidecar Film Core contract. Yingce remains authoritative for generic "
            "Host Project, ProjectUnit, Shot, Asset, Workflow and Task entities."
        ),
        servers=[{"url": "/film"}],
    )
    app.state.film_service = service

    @app.exception_handler(VersionConflict)
    async def version_conflict_handler(
        _request: Request, error: VersionConflict
    ) -> JSONResponse:
        return JSONResponse(
            status_code=409,
            content={
                "detail": {
                    "code": "version_conflict",
                    "message": str(error),
                    "target_id": error.target_id,
                    "expected_version": error.expected_version,
                    "current_version": error.current_version,
                }
            },
        )

    @app.exception_handler(EntityNotFound)
    async def entity_not_found_handler(
        _request: Request, error: EntityNotFound
    ) -> JSONResponse:
        return JSONResponse(
            status_code=404,
            content={
                "detail": {
                    "code": "film_entity_not_found",
                    "message": str(error),
                    "target_id": error.target_id,
                }
            },
        )

    @app.exception_handler(HostMappingNotFound)
    async def mapping_not_found_handler(
        _request: Request, error: HostMappingNotFound
    ) -> JSONResponse:
        return JSONResponse(
            status_code=404,
            content={
                "detail": {
                    "code": "host_mapping_not_found",
                    "message": str(error),
                }
            },
        )

    @app.get(
        "/health",
        response_model=HealthResult,
        operation_id="filmHealthGet",
    )
    def health() -> HealthResult:
        return service.health()

    @app.get(
        "/projects/{hostProjectId}/context",
        response_model=FilmProjectContext,
        operation_id="filmProjectContextGet",
    )
    def project_context(hostProjectId: str) -> FilmProjectContext:
        return service.project_context(hostProjectId)

    @app.get(
        "/units/{hostUnitId}",
        response_model=ContentUnitExtension,
        operation_id="filmUnitGet",
        responses={404: {"model": ErrorResponse}},
    )
    def unit_get(hostUnitId: str) -> ContentUnitExtension:
        return service.unit_by_host(hostUnitId)

    @app.get(
        "/shots/{hostShotId}",
        response_model=ShotExtension,
        operation_id="filmShotGet",
        responses={404: {"model": ErrorResponse}},
    )
    def shot_get(hostShotId: str) -> ShotExtension:
        return service.shot_by_host(hostShotId)

    @app.get(
        "/entities/{filmEntityId}",
        response_model=FilmEntity,
        operation_id="filmEntityGet",
        responses={404: {"model": ErrorResponse}},
    )
    def entity_get(filmEntityId: UUID4) -> FilmEntity:
        return service.entity(str(filmEntityId))

    @app.post(
        "/commands/preview",
        response_model=CommandPreviewResult,
        operation_id="filmCommandPreview",
        responses={409: {"model": ErrorResponse}},
    )
    def command_preview(command: Annotated[Command, Body()]) -> CommandPreviewResult:
        return service.preview(command)

    @app.post(
        "/commands/apply",
        response_model=CommandApplyResult,
        operation_id="filmCommandApply",
        responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
    )
    def command_apply(command: Annotated[Command, Body()]) -> CommandApplyResult:
        return service.apply(command)

    @app.get(
        "/audit-events",
        response_model=list[AuditEvent],
        operation_id="filmAuditEventsGet",
    )
    def audit_events(
        target_id: UUID4 | None = Query(default=None, alias="targetId"),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> list[AuditEvent]:
        return service.audit_events(
            None if target_id is None else str(target_id), limit
        )

    return app
