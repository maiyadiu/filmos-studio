from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

MAX_PROPOSAL_BYTES = 1024 * 1024
REQUIRED_FIELDS = {
    "schema_version",
    "proposal_id",
    "source_brain",
    "host_project_id",
    "base_state_hash",
    "base_versions",
    "proposal_type",
    "summary",
    "items",
    "created_at",
    "expires_at",
    "content_hash",
    "signature",
}
ALLOWED_OUTPUT_KINDS = {"Proposal", "Candidate", "Review Draft"}
FORBIDDEN_COMMAND_TOKENS = {
    "approved",
    "locked",
    "formal_apply",
    "formal apply",
    "paid_provider_task",
    "paid provider task",
    "delete",
    "command_apply",
    "review_approve",
    "script_lock",
    "task_create",
}
FORBIDDEN_STRUCTURE_KEYS = {"shell", "command", "script", "exec", "executable", "argv", "download", "download_url"}
ABSOLUTE_PATH = re.compile(r"(?:^|[\s\"'=])(?:/(?!/)[^\s]*|[A-Za-z]:[\\/]|\\\\)")
SCRIPT_OR_DOWNLOAD = re.compile(r"(?:^|\s)(?:curl|wget|powershell|pwsh|bash|zsh|sh|cmd(?:\.exe)?)(?:\s|$)|https?://|file://|&&|\|\||\$\(|`|^#!", re.IGNORECASE)


class FilmOSProposalImportError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ProposalPreviewItem:
    kind: str
    status: str
    source_index: int
    payload: Any


@dataclass(frozen=True)
class ProposalImportPreview:
    proposal_id: str
    content_hash: str
    host_project_id: str
    base_state_hash: str
    status: str
    outputs: tuple[ProposalPreviewItem, ...]
    audit_action: str
    formal_write_executed: bool
    provider_task_created: bool
    deletion_executed: bool
    idempotent_replay: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ProposalImportReceiptStore:
    """Local adapter receipt only; it is not a Film Core formal record."""

    def __init__(self) -> None:
        self._receipts: dict[str, ProposalImportPreview] = {}

    def get(self, proposal_id: str) -> ProposalImportPreview | None:
        return self._receipts.get(proposal_id)

    def put(self, preview: ProposalImportPreview) -> None:
        self._receipts[preview.proposal_id] = preview


class JsonProposalImportReceiptStore(ProposalImportReceiptStore):
    def __init__(self, path: str | Path) -> None:
        super().__init__()
        self.path = Path(path)
        if self.path.exists():
            if self.path.is_symlink() or not self.path.is_file():
                raise FilmOSProposalImportError("INVALID_RECEIPT_STORE", "receipt store must be a regular file")
            try:
                values = json.loads(self.path.read_text(encoding="utf-8"))
                for item in values:
                    outputs = tuple(ProposalPreviewItem(**output) for output in item.pop("outputs"))
                    preview = ProposalImportPreview(**item, outputs=outputs)
                    self._receipts[preview.proposal_id] = preview
            except (TypeError, KeyError, json.JSONDecodeError) as error:
                raise FilmOSProposalImportError("INVALID_RECEIPT_STORE", "receipt store is invalid") from error

    def put(self, preview: ProposalImportPreview) -> None:
        super().put(preview)
        if self.path.exists() and self.path.is_symlink():
            raise FilmOSProposalImportError("INVALID_RECEIPT_STORE", "receipt store cannot be a symlink")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.parent.is_symlink():
            raise FilmOSProposalImportError("INVALID_RECEIPT_STORE", "receipt store parent cannot be a symlink")
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent, prefix=".filmos-receipt-", suffix=".tmp", delete=False) as temporary:
                temporary_path = Path(temporary.name)
                json.dump([value.to_dict() for value in self._receipts.values()], temporary, ensure_ascii=False, indent=2)
                temporary.flush()
                os.fsync(temporary.fileno())
            temporary_path.chmod(0o600)
            os.replace(temporary_path, self.path)
            temporary_path = None
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)


def import_proposal_file(
    file_path: str | Path,
    *,
    signing_secret: str,
    expected_project_id: str,
    current_state_hash: str,
    current_versions: Mapping[str, int],
    receipts: ProposalImportReceiptStore,
    now: datetime | None = None,
) -> ProposalImportPreview:
    path = Path(file_path)
    if path.suffix.lower() != ".filmosproposal":
        raise FilmOSProposalImportError("INVALID_FILE_TYPE", "proposal file must use .filmosproposal")
    if path.is_symlink() or not path.is_file():
        raise FilmOSProposalImportError("INVALID_FILE", "proposal file must be a regular non-symlink file")
    size = path.stat().st_size
    if size <= 0 or size > MAX_PROPOSAL_BYTES:
        raise FilmOSProposalImportError("INVALID_FILE_SIZE", "proposal file size is outside the local import boundary")
    try:
        package = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise FilmOSProposalImportError("INVALID_JSON", "proposal file is not valid UTF-8 JSON") from error
    return preview_proposal_import(
        package,
        signing_secret=signing_secret,
        expected_project_id=expected_project_id,
        current_state_hash=current_state_hash,
        current_versions=current_versions,
        receipts=receipts,
        now=now,
    )


def preview_proposal_import(
    package: Any,
    *,
    signing_secret: str,
    expected_project_id: str,
    current_state_hash: str,
    current_versions: Mapping[str, int],
    receipts: ProposalImportReceiptStore,
    now: datetime | None = None,
) -> ProposalImportPreview:
    if not isinstance(package, dict) or set(package) != REQUIRED_FIELDS:
        raise FilmOSProposalImportError("INVALID_SCHEMA", "proposal fields do not match schema v1")
    if package["schema_version"] != "1.0.0" or package["source_brain"] != "chatgpt":
        raise FilmOSProposalImportError("UNSUPPORTED_SOURCE", "proposal schema/source is unsupported")
    proposal_id = require_text(package["proposal_id"], "proposal_id")
    require_text(package["summary"], "summary", max_length=2000)
    content_hash = require_hash(package["content_hash"], "content_hash")
    base_state_hash = require_hash(package["base_state_hash"], "base_state_hash")
    if package["host_project_id"] != expected_project_id:
        raise FilmOSProposalImportError("PROJECT_MISMATCH", "proposal belongs to another Host project")
    if base_state_hash != current_state_hash:
        raise FilmOSProposalImportError("STATE_HASH_CONFLICT", "project state changed; preview must be rebuilt")
    validate_versions(package["base_versions"], current_versions)
    validate_time_window(package, now or datetime.now(timezone.utc))
    verify_content_hash_and_signature(package, signing_secret, content_hash)
    if package["proposal_type"] not in ALLOWED_OUTPUT_KINDS:
        raise FilmOSProposalImportError("ILLEGAL_PROPOSAL_TYPE", "proposal output kind is not allowed")
    if not isinstance(package["items"], list) or not package["items"]:
        raise FilmOSProposalImportError("INVALID_ITEMS", "proposal items must be a non-empty array")
    validate_items(package["items"], expected_project_id)
    assert_no_forbidden_command(package["items"])

    previous = receipts.get(proposal_id)
    if previous:
        if previous.content_hash != content_hash:
            raise FilmOSProposalImportError("IDEMPOTENCY_CONFLICT", "proposal_id is already bound to another content hash")
        return ProposalImportPreview(**{**asdict(previous), "outputs": previous.outputs, "idempotent_replay": True})

    output_kind = package["proposal_type"]
    preview = ProposalImportPreview(
        proposal_id=proposal_id,
        content_hash=content_hash,
        host_project_id=expected_project_id,
        base_state_hash=base_state_hash,
        status="PREVIEW_REQUIRES_HUMAN_APPROVAL",
        outputs=tuple(
            ProposalPreviewItem(kind=output_kind, status="DRAFT", source_index=index, payload=item)
            for index, item in enumerate(package["items"])
        ),
        audit_action="external_brain.proposal.previewed",
        formal_write_executed=False,
        provider_task_created=False,
        deletion_executed=False,
        idempotent_replay=False,
    )
    receipts.put(preview)
    return preview


def verify_content_hash_and_signature(package: dict[str, Any], signing_secret: str, content_hash: str) -> None:
    if len(signing_secret) < 32:
        raise FilmOSProposalImportError("SIGNING_SECRET_UNAVAILABLE", "local proposal signing secret is unavailable")
    unsigned = {key: package[key] for key in package if key not in {"content_hash", "signature"}}
    actual_hash = hashlib.sha256(canonical_json(unsigned).encode("utf-8")).hexdigest()
    if not hmac.compare_digest(actual_hash, content_hash):
        raise FilmOSProposalImportError("CONTENT_HASH_MISMATCH", "proposal content hash is invalid")
    signature = package["signature"]
    if not isinstance(signature, str) or not signature.startswith("hmac-sha256:"):
        raise FilmOSProposalImportError("INVALID_SIGNATURE", "proposal signature format is invalid")
    expected = hmac.new(signing_secret.encode("utf-8"), content_hash.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature.removeprefix("hmac-sha256:"), expected):
        raise FilmOSProposalImportError("INVALID_SIGNATURE", "proposal signature does not match")


def validate_versions(base_versions: Any, current_versions: Mapping[str, int]) -> None:
    if not isinstance(base_versions, dict) or any(not isinstance(key, str) or not isinstance(value, int) or value < 1 for key, value in base_versions.items()):
        raise FilmOSProposalImportError("INVALID_BASE_VERSIONS", "base_versions must map stable URIs to positive versions")
    for uri, expected in base_versions.items():
        if current_versions.get(uri) != expected:
            raise FilmOSProposalImportError("VERSION_CONFLICT", f"version changed for {uri}")


def validate_time_window(package: dict[str, Any], now: datetime) -> None:
    try:
        created = datetime.fromisoformat(str(package["created_at"]).replace("Z", "+00:00"))
        expires = datetime.fromisoformat(str(package["expires_at"]).replace("Z", "+00:00"))
    except ValueError as error:
        raise FilmOSProposalImportError("INVALID_TIME", "proposal timestamps must be ISO-8601") from error
    if created.tzinfo is None or expires.tzinfo is None or expires <= created:
        raise FilmOSProposalImportError("INVALID_TIME", "proposal time window is invalid")
    if created > now:
        raise FilmOSProposalImportError("FUTURE_PROPOSAL", "proposal was created in the future")
    if expires <= now:
        raise FilmOSProposalImportError("PROPOSAL_EXPIRED", "proposal expired")


def assert_no_forbidden_command(value: Any) -> None:
    if isinstance(value, dict):
        for key in value:
            if key.strip().lower().replace("-", "_") in FORBIDDEN_STRUCTURE_KEYS:
                raise FilmOSProposalImportError("FORBIDDEN_COMMAND", "proposal contains an executable command/script field")
    for text in strings(value):
        normalized = text.strip().lower().replace("-", "_")
        if normalized in FORBIDDEN_STRUCTURE_KEYS:
            raise FilmOSProposalImportError("FORBIDDEN_COMMAND", "proposal contains an executable command/script field")
        if any(token in normalized for token in FORBIDDEN_COMMAND_TOKENS):
            raise FilmOSProposalImportError("FORBIDDEN_COMMAND", "proposal contains a prohibited FilmOS command or formal state")
        if ABSOLUTE_PATH.search(text.strip()):
            raise FilmOSProposalImportError("FORBIDDEN_LOCAL_PATH", "proposal contains an absolute local path")
        if SCRIPT_OR_DOWNLOAD.search(text.strip()):
            raise FilmOSProposalImportError("FORBIDDEN_EXTERNAL_SCRIPT", "proposal contains an external URL or executable script")


def validate_items(value: Any, project_id: str) -> None:
    required = {"item_id", "kind", "target_uri", "summary", "payload"}
    for item in value:
        if not isinstance(item, dict) or set(item) != required:
            raise FilmOSProposalImportError("INVALID_ITEMS", "proposal item fields do not match schema v1")
        require_text(item["item_id"], "item_id")
        require_text(item["summary"], "item.summary", max_length=2000)
        if item["kind"] not in ALLOWED_OUTPUT_KINDS:
            raise FilmOSProposalImportError("ILLEGAL_PROPOSAL_TYPE", "proposal item kind is not allowed")
        if not isinstance(item["target_uri"], str) or not item["target_uri"].startswith(f"filmos://project/{project_id}/"):
            raise FilmOSProposalImportError("PROJECT_MISMATCH", "proposal item target is outside the Host project")
        if not isinstance(item["payload"], dict):
            raise FilmOSProposalImportError("INVALID_ITEMS", "proposal item payload must be an object")


def strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from strings(item)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def require_text(value: Any, field: str, *, max_length: int = 256) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > max_length:
        raise FilmOSProposalImportError("INVALID_SCHEMA", f"{field} is invalid")
    return value


def require_hash(value: Any, field: str) -> str:
    if not isinstance(value, str) or len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise FilmOSProposalImportError("INVALID_SCHEMA", f"{field} must be lowercase SHA-256")
    return value
