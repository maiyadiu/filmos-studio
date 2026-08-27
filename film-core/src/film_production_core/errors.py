from __future__ import annotations

from uuid import UUID


class FilmCoreError(Exception):
    """Base class for safe Film Core service errors."""


class EntityNotFound(FilmCoreError):
    def __init__(self, target_id: UUID | str) -> None:
        self.target_id = str(target_id)
        super().__init__(f"Film entity {self.target_id} was not found")


class HostMappingNotFound(FilmCoreError):
    def __init__(self, mapping_kind: str, host_id: str) -> None:
        self.mapping_kind = mapping_kind
        self.host_id = host_id
        super().__init__(f"No {mapping_kind} mapping exists for Host ID {host_id}")


class VersionConflict(FilmCoreError):
    def __init__(
        self,
        target_id: UUID | str | None,
        expected_version: int,
        current_version: int,
        message: str = "expected_version does not match current version",
    ) -> None:
        self.target_id = None if target_id is None else str(target_id)
        self.expected_version = expected_version
        self.current_version = current_version
        super().__init__(message)


class HostMappingConflict(VersionConflict):
    def __init__(self, target_id: UUID | str, current_version: int) -> None:
        super().__init__(
            target_id=target_id,
            expected_version=0,
            current_version=current_version,
            message="Host mapping already has a Film entity",
        )
