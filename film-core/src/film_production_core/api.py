from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated

from fastapi import Body, FastAPI, Query, Request
from fastapi.responses import JSONResponse
from pydantic import UUID4

from film_production_core.cors import (
    LoopbackCORSMiddleware,
    configured_cors_origins,
)
from film_production_core.database import SQLiteDatabase
from film_production_core.errors import (
    ContentHashConflict,
    DomainRuleViolation,
    EntityNotFound,
    HostMappingNotFound,
    VersionConflict,
)
from film_production_core.formal_models import (
    Approval,
    ApprovalCreateRequest,
    ContinuityCheckRequest,
    ContinuityCheckResult,
    FormalEntity,
    FormalRecordApplyResult,
    FormalRecordCreateRequest,
    ManualResultImportRequest,
    ManualResultImportResult,
    PromptCompileRequest,
    PromptCompileResult,
    Review,
    ReviewCreateRequest,
    ScriptVersionLockRequest,
    ScriptVersionLockResult,
)
from film_production_core.formal_service import FormalService
from film_production_core.impact_models import (
    ImpactEdge,
    ImpactEdgeCreateRequest,
    ImpactQueryResult,
    ScriptStructureMap,
    ScriptStructureMapCreateRequest,
    StalePropagationRequest,
    StalePropagationResult,
)
from film_production_core.impact_repository import ImpactRepository
from film_production_core.impact_service import ImpactService
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
    cors_origins = configured_cors_origins()
    database = SQLiteDatabase(database_path or default_database_path())
    repository = FilmRepository(database)
    impact_repository = ImpactRepository(database)
    service = FilmService(repository)
    formal_service = FormalService(repository)
    impact_service = ImpactService(impact_repository, formal_service)
    app = FastAPI(
        title="FilmOS Studio Film Core API",
        version="0.3.0",
        description=(
            "Sidecar Film Core contract. Yingce remains authoritative for generic "
            "Host Project, ProjectUnit, Shot, Asset, Workflow and Task entities."
        ),
        servers=[{"url": "/film"}],
    )
    app.add_middleware(
        LoopbackCORSMiddleware,
        exact_origins=cors_origins,
    )
    app.state.film_service = service
    app.state.formal_service = formal_service
    app.state.impact_service = impact_service

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

    @app.exception_handler(ContentHashConflict)
    async def content_hash_conflict_handler(
        _request: Request, error: ContentHashConflict
    ) -> JSONResponse:
        return JSONResponse(
            status_code=409,
            content={
                "detail": {
                    "code": "content_hash_conflict",
                    "message": str(error),
                    "target_id": error.target_id,
                    "expected_content_hash": error.expected_content_hash,
                    "current_content_hash": error.current_content_hash,
                }
            },
        )

    @app.exception_handler(DomainRuleViolation)
    async def domain_rule_handler(
        _request: Request, error: DomainRuleViolation
    ) -> JSONResponse:
        return JSONResponse(
            status_code=409,
            content={"detail": {"code": error.code, "message": str(error)}},
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

    @app.get(
        "/formal-records/{filmEntityId}",
        response_model=FormalEntity,
        operation_id="filmFormalRecordGet",
        responses={404: {"model": ErrorResponse}},
    )
    def formal_record_get(filmEntityId: UUID4) -> FormalEntity:
        return formal_service.formal_record(str(filmEntityId))

    @app.post(
        "/formal-records",
        response_model=FormalRecordApplyResult,
        operation_id="filmFormalRecordCreate",
        responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
    )
    def formal_record_create(
        request: FormalRecordCreateRequest,
    ) -> FormalRecordApplyResult:
        return formal_service.create_record(request)

    @app.get(
        "/script-structure-maps/{filmEntityId}",
        response_model=ScriptStructureMap,
        operation_id="filmScriptStructureMapGet",
        responses={404: {"model": ErrorResponse}},
    )
    def script_structure_map_get(filmEntityId: UUID4) -> ScriptStructureMap:
        return impact_service.script_structure_map(str(filmEntityId))

    @app.post(
        "/script-structure-maps",
        response_model=ScriptStructureMap,
        operation_id="filmScriptStructureMapCreate",
        responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
    )
    def script_structure_map_create(
        request: ScriptStructureMapCreateRequest,
    ) -> ScriptStructureMap:
        return impact_service.create_script_structure_map(request)

    @app.post(
        "/impacts",
        response_model=ImpactEdge,
        operation_id="filmImpactCreate",
        responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
    )
    def impact_create(request: ImpactEdgeCreateRequest) -> ImpactEdge:
        return impact_service.create_impact_edge(request)

    @app.get(
        "/impacts/{entityId}",
        response_model=ImpactQueryResult,
        operation_id="filmImpactGet",
        responses={404: {"model": ErrorResponse}},
    )
    def impact_get(entityId: UUID4) -> ImpactQueryResult:
        return impact_service.impact_query(str(entityId))

    @app.post(
        "/impacts/propagate-stale",
        response_model=StalePropagationResult,
        operation_id="filmImpactPropagateStale",
        responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
    )
    def impact_propagate_stale(
        request: StalePropagationRequest,
    ) -> StalePropagationResult:
        return impact_service.propagate_stale(request)

    @app.post(
        "/script-versions/lock",
        response_model=ScriptVersionLockResult,
        operation_id="filmScriptVersionLock",
        responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
    )
    def script_version_lock(
        request: ScriptVersionLockRequest,
    ) -> ScriptVersionLockResult:
        return formal_service.lock_script_version(request)

    @app.post(
        "/prompts/compile",
        response_model=PromptCompileResult,
        operation_id="filmPromptCompile",
        responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
    )
    def prompt_compile(request: PromptCompileRequest) -> PromptCompileResult:
        return formal_service.compile_prompt(request)

    @app.post(
        "/manual-results/import",
        response_model=ManualResultImportResult,
        operation_id="filmManualResultImport",
        responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
    )
    def manual_result_import(
        request: ManualResultImportRequest,
    ) -> ManualResultImportResult:
        return formal_service.import_manual_result(request)

    @app.post(
        "/reviews",
        response_model=Review,
        operation_id="filmReviewSubmit",
        responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
    )
    def review_submit(request: ReviewCreateRequest) -> Review:
        return formal_service.create_review(request)

    @app.post(
        "/approvals",
        response_model=Approval,
        operation_id="filmApprovalCreate",
        responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
    )
    def approval_create(request: ApprovalCreateRequest) -> Approval:
        return formal_service.create_approval(request)

    @app.post(
        "/continuity/check",
        response_model=ContinuityCheckResult,
        operation_id="filmContinuityCheck",
        responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
    )
    def continuity_check(
        request: ContinuityCheckRequest,
    ) -> ContinuityCheckResult:
        return formal_service.check_continuity(request)

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
