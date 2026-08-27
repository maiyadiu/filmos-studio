from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from typing import Any, cast
from uuid import uuid4

from film_production_core.errors import (
    HostMappingConflict,
    HostMappingNotFound,
    VersionConflict,
)
from film_production_core.models import (
    AuditEvent,
    Command,
    CommandApplyResult,
    CommandPreviewResult,
    ContentUnitExtension,
    CreateContentUnitPayload,
    CreateEntityCommand,
    CreateFilmProjectPayload,
    CreateShotPayload,
    EntityType,
    FilmEntity,
    FilmEntityRef,
    FilmProjectContext,
    FilmProjectExtension,
    FormalStateAxes,
    HealthResult,
    HostReferences,
    SetStatesCommand,
    ShotExtension,
)
from film_production_core.repository import FilmRepository, canonical_json


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def content_hash(value: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


class FilmService:
    def __init__(self, repository: FilmRepository) -> None:
        self.repository = repository

    def health(self) -> HealthResult:
        schema_version, journal_mode = self.repository.health()
        return HealthResult(schema_version=schema_version, journal_mode=journal_mode)

    def entity(self, film_entity_id: str) -> FilmEntity:
        return self._entity_from_row(self.repository.entity(film_entity_id))

    def project_context(self, host_project_id: str) -> FilmProjectContext:
        project_row, unit_rows, shot_rows, audit_count = (
            self.repository.project_context_rows(host_project_id)
        )
        project = (
            cast(FilmProjectExtension, self._entity_from_row(project_row))
            if project_row is not None
            else None
        )
        return FilmProjectContext(
            host_project_id=host_project_id,
            film_project=project,
            content_units=[
                cast(ContentUnitExtension, self._entity_from_row(row))
                for row in unit_rows
            ],
            shots=[
                cast(ShotExtension, self._entity_from_row(row)) for row in shot_rows
            ],
            audit_event_count=audit_count,
        )

    def unit_by_host(self, host_unit_id: str) -> ContentUnitExtension:
        row = self.repository.entity_by_host(
            EntityType.CONTENT_UNIT_EXTENSION, host_unit_id
        )
        if row is None:
            raise HostMappingNotFound("content_unit_extension", host_unit_id)
        return cast(ContentUnitExtension, self._entity_from_row(row))

    def shot_by_host(self, host_shot_id: str) -> ShotExtension:
        row = self.repository.entity_by_host(
            EntityType.SHOT_EXTENSION, host_shot_id
        )
        if row is None:
            raise HostMappingNotFound("shot_extension", host_shot_id)
        return cast(ShotExtension, self._entity_from_row(row))

    def preview(self, command: Command) -> CommandPreviewResult:
        if isinstance(command, CreateEntityCommand):
            entity_type = self._enum_value(command.payload.entity_type)
            host_id = self._mapping_host_id(command.payload)
            existing = self.repository.entity_by_host(entity_type, host_id)
            if existing is not None:
                raise HostMappingConflict(
                    existing["film_entity_id"], int(existing["version"])
                )
            canonical = self._canonical_from_create_payload(command.payload)
            return CommandPreviewResult(
                command_type=command.command_type,
                target_id=None,
                current_version=0,
                resulting_version=1,
                content_hash=content_hash(canonical),
                changes=[
                    f"create {entity_type}",
                    f"bind {host_id}",
                    "append AuditEvent on apply",
                ],
            )

        current_row = self.repository.entity(str(command.target_id))
        current_version = int(current_row["version"])
        if current_version != command.expected_version:
            raise VersionConflict(
                command.target_id, command.expected_version, current_version
            )
        current_entity = self._entity_from_row(current_row)
        canonical = self._canonical_from_entity(
            current_entity, command.payload.states
        )
        current_states = current_entity.states.model_dump(mode="json")
        next_states = command.payload.states.model_dump(mode="json")
        changes = [
            f"{name}: {current_states[name]} -> {next_states[name]}"
            for name in current_states
            if current_states[name] != next_states[name]
        ]
        if not changes:
            changes.append("no state value change; apply still records a new revision")
        changes.append("append AuditEvent on apply")
        return CommandPreviewResult(
            command_type=command.command_type,
            target_id=command.target_id,
            current_version=current_version,
            resulting_version=current_version + 1,
            content_hash=content_hash(canonical),
            changes=changes,
        )

    def apply(self, command: Command) -> CommandApplyResult:
        if isinstance(command, CreateEntityCommand):
            return self._apply_create(command)
        return self._apply_set_states(command)

    def audit_events(
        self, target_id: str | None = None, limit: int = 100
    ) -> list[AuditEvent]:
        return [
            self._audit_from_row(row)
            for row in self.repository.audit_events(target_id, limit)
        ]

    def _apply_create(self, command: CreateEntityCommand) -> CommandApplyResult:
        now = utc_now()
        film_entity_id = str(uuid4())
        event_id = str(uuid4())
        canonical = self._canonical_from_create_payload(command.payload)
        payload = command.payload
        host = payload.host.model_dump(mode="json", exclude_none=True)
        entity_type = self._enum_value(payload.entity_type)
        states = payload.states.model_dump(mode="json")
        director_ids = (
            [str(value) for value in payload.director_unit_ids]
            if isinstance(payload, CreateShotPayload)
            else []
        )
        entity_values: dict[str, Any] = {
            "film_entity_id": film_entity_id,
            "entity_type": entity_type,
            "version": 1,
            "content_hash": content_hash(canonical),
            "host_project_id": host.get("host_project_id"),
            "host_unit_id": host.get("host_unit_id"),
            "host_shot_id": host.get("host_shot_id"),
            "host_asset_id": host.get("host_asset_id"),
            "host_asset_version_id": host.get("host_asset_version_id"),
            "host_canvas_id": host.get("host_canvas_id"),
            "host_resource_id": host.get("host_resource_id"),
            **states,
            "unit_kind": (
                self._enum_value(payload.unit_kind)
                if isinstance(payload, CreateContentUnitPayload)
                else None
            ),
            "director_unit_ids_json": canonical_json(director_ids),
            "created_at": now,
            "updated_at": now,
        }
        audit_values = self._audit_values(
            event_id=event_id,
            actor_kind=self._enum_value(command.actor_kind),
            action="entity.created",
            target_id=film_entity_id,
            previous_version=None,
            resulting_version=1,
            command=command,
            recorded_at=now,
        )
        try:
            entity_row, audit_row = self.repository.create_entity_with_audit(
                entity_values, audit_values
            )
        except sqlite3.IntegrityError:
            host_id = self._mapping_host_id(payload)
            existing = self.repository.entity_by_host(entity_type, host_id)
            if existing is not None:
                raise HostMappingConflict(
                    existing["film_entity_id"], int(existing["version"])
                ) from None
            raise
        return CommandApplyResult(
            entity=self._entity_from_row(entity_row),
            audit_event=self._audit_from_row(audit_row),
        )

    def _apply_set_states(self, command: SetStatesCommand) -> CommandApplyResult:
        current_row = self.repository.entity(str(command.target_id))
        current_entity = self._entity_from_row(current_row)
        canonical = self._canonical_from_entity(
            current_entity, command.payload.states
        )
        now = utc_now()
        event_id = str(uuid4())
        audit_values = self._audit_values(
            event_id=event_id,
            actor_kind=self._enum_value(command.actor_kind),
            action="entity.states_updated",
            target_id=str(command.target_id),
            previous_version=command.expected_version,
            resulting_version=command.expected_version + 1,
            command=command,
            recorded_at=now,
        )
        entity_row, audit_row = self.repository.update_states_with_audit(
            film_entity_id=str(command.target_id),
            expected_version=command.expected_version,
            states=command.payload.states.model_dump(mode="json"),
            content_hash=content_hash(canonical),
            updated_at=now,
            audit=audit_values,
        )
        return CommandApplyResult(
            entity=self._entity_from_row(entity_row),
            audit_event=self._audit_from_row(audit_row),
        )

    def _entity_from_row(self, row: sqlite3.Row) -> FilmEntity:
        host = HostReferences(
            **{
                key: row[key]
                for key in (
                    "host_project_id",
                    "host_unit_id",
                    "host_shot_id",
                    "host_asset_id",
                    "host_asset_version_id",
                    "host_canvas_id",
                    "host_resource_id",
                )
                if row[key] is not None
            }
        )
        states = FormalStateAxes(
            creative_stage=row["creative_stage"],
            execution_state=row["execution_state"],
            review_state=row["review_state"],
            lock_state=row["lock_state"],
            delivery_state=row["delivery_state"],
            stale_state=row["stale_state"],
        )
        reference = FilmEntityRef(
            film_entity_id=row["film_entity_id"],
            entity_type=row["entity_type"],
            version=row["version"],
            content_hash=row["content_hash"],
        )
        if row["entity_type"] == EntityType.FILM_PROJECT_EXTENSION.value:
            return FilmProjectExtension(ref=reference, host=host, states=states)
        if row["entity_type"] == EntityType.CONTENT_UNIT_EXTENSION.value:
            return ContentUnitExtension(
                ref=reference,
                host=host,
                states=states,
                unit_kind=row["unit_kind"],
            )
        if row["entity_type"] == EntityType.SHOT_EXTENSION.value:
            return ShotExtension(
                ref=reference,
                host=host,
                states=states,
                director_unit_ids=json_ids(row["director_unit_ids_json"]),
            )
        raise ValueError(f"Unsupported persisted entity type: {row['entity_type']}")

    @staticmethod
    def _audit_from_row(row: sqlite3.Row) -> AuditEvent:
        return AuditEvent(
            event_id=row["event_id"],
            actor_kind=row["actor_kind"],
            action=row["action"],
            target_id=row["target_id"],
            recorded_at=row["recorded_at"],
        )

    @staticmethod
    def _canonical_from_create_payload(
        payload: CreateFilmProjectPayload
        | CreateContentUnitPayload
        | CreateShotPayload,
    ) -> dict[str, Any]:
        value = payload.model_dump(mode="json", exclude={"entity_type"})
        return {
            "entity_type": FilmService._enum_value(payload.entity_type),
            **value,
        }

    @staticmethod
    def _canonical_from_entity(
        entity: FilmEntity, states: FormalStateAxes
    ) -> dict[str, Any]:
        value: dict[str, Any] = {
            "entity_type": FilmService._enum_value(entity.ref.entity_type),
            "host": entity.host.model_dump(mode="json", exclude_none=True),
            "states": states.model_dump(mode="json"),
        }
        if isinstance(entity, ContentUnitExtension):
            value["unit_kind"] = FilmService._enum_value(entity.unit_kind)
        if isinstance(entity, ShotExtension):
            value["director_unit_ids"] = [
                str(identifier) for identifier in entity.director_unit_ids
            ]
        return value

    @staticmethod
    def _mapping_host_id(
        payload: CreateFilmProjectPayload
        | CreateContentUnitPayload
        | CreateShotPayload,
    ) -> str:
        if isinstance(payload, CreateFilmProjectPayload):
            return cast(str, payload.host.host_project_id)
        if isinstance(payload, CreateContentUnitPayload):
            return cast(str, payload.host.host_unit_id)
        return cast(str, payload.host.host_shot_id)

    @staticmethod
    def _audit_values(
        *,
        event_id: str,
        actor_kind: str,
        action: str,
        target_id: str,
        previous_version: int | None,
        resulting_version: int,
        command: Command,
        recorded_at: str,
    ) -> dict[str, Any]:
        return {
            "event_id": event_id,
            "actor_kind": actor_kind,
            "action": action,
            "target_id": target_id,
            "previous_version": previous_version,
            "resulting_version": resulting_version,
            "command_type": command.command_type,
            "command_payload_json": canonical_json(
                command.model_dump(mode="json")
            ),
            "recorded_at": recorded_at,
        }

    @staticmethod
    def _enum_value(value: Any) -> str:
        return str(getattr(value, "value", value))


def json_ids(raw: str) -> list[str]:
    value = json.loads(raw)
    if not isinstance(value, list):
        raise ValueError("director_unit_ids_json must be a list")
    return [str(identifier) for identifier in value]
