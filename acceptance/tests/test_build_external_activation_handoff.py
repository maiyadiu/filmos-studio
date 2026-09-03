from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from acceptance.build_external_activation_handoff import build_handoff


PROJECT = "project-current"
ISSUE = "FILMOS-ISSUE-current"
SUBMISSION = "FILMOS-SUBMISSION-current"


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


def fixture_files(root: Path, *, grant: str = "grant-current", challenge: str = "live_current_12345678") -> dict[str, Path]:
    identity = {
        "schema_version": "1.0.0",
        "build_id": "development-12345678-abcdef12",
        "repository": "maiyadiu/filmos-studio",
        "git_commit_sha": "1" * 40,
        "git_tree_sha": "2" * 40,
        "source_fingerprint_sha256": "3" * 64,
        "release_channel": "development",
        "source_clean": True,
        "source_file_count": 1,
        "source_scopes": [],
        "external_paid_submit_enabled": False,
    }
    paths = {name: root / name for name in ("audit.jsonl", "grants.json", "challenge.id", "identity.json", "context.json", "receipt.json", "trace.jsonl", "result.json", "handoff.md")}
    write_json(paths["grants.json"], [{
        "grant_id": grant,
        "project_id": PROJECT,
        "issued_at": "2099-01-01T00:00:00Z",
        "expires_at": "2099-01-01T01:00:00Z",
        "revoked_at": None,
    }])
    paths["challenge.id"].write_text(challenge, encoding="utf-8")
    write_json(paths["identity.json"], identity)
    write_json(paths["context.json"], {"source_identity": identity})
    write_json(paths["receipt.json"], {"status": "PASS"})
    paths["trace.jsonl"].write_text('{"status":"PASS"}\n', encoding="utf-8")
    write_json(paths["result.json"], {
        "status": "PASS",
        "identity": {"commit": "1" * 40, "tree": "2" * 40, "source_fingerprint": "3" * 64},
    })
    paths["audit.jsonl"].write_text(json.dumps({
        "event_id": "publish-current",
        "recorded_at": "2099-01-01T00:05:00Z",
        "action": "handoff.live_context.publish",
        "outcome": "ALLOW",
        "project_id": PROJECT,
        "grant_id": grant,
        "challenge_id": challenge,
        "output_hash": "a" * 64,
        "context_receipt_id": f"filmos-live:{'b' * 64}",
    }) + "\n", encoding="utf-8")
    return paths


def build(paths: dict[str, Path]) -> dict[str, object]:
    return build_handoff(
        audit_log=paths["audit.jsonl"],
        grant_store=paths["grants.json"],
        challenge_file=paths["challenge.id"],
        source_identity_file=paths["identity.json"],
        canary_context=paths["context.json"],
        canary_receipt=paths["receipt.json"],
        canary_trace=paths["trace.jsonl"],
        canary_result=paths["result.json"],
        project_id=PROJECT,
        issue_id=ISSUE,
        submission_id=SUBMISSION,
        output=paths["handoff.md"],
        now=datetime(2099, 1, 1, 0, 10, tzinfo=timezone.utc),
    )


def test_handoff_separates_canvas_hash_from_current_live_receipt(tmp_path: Path) -> None:
    paths = fixture_files(tmp_path)
    result = build(paths)
    text = paths["handoff.md"].read_text(encoding="utf-8")
    assert result["binding"]["canvas_state_hash"] == "a" * 64
    assert result["binding"]["live_context_receipt_id"] == f"filmos-live:{'b' * 64}"
    assert f"workbench:{'a' * 64}" not in text
    assert "Live Context 顶层 `context_receipt_id`、`binding.context_receipt_id` 与 Blockers" in text
    assert "structuredContent.error_code=PROJECT_SCOPE_DENIED" in text
    assert '"expected_project_id":"filmos-negative-project-probe"' in text


def test_handoff_fails_closed_after_grant_or_challenge_rotation(tmp_path: Path) -> None:
    paths = fixture_files(tmp_path)
    old = build(paths)
    old_text = paths["handoff.md"].read_text(encoding="utf-8")
    assert "HANDOFF_STALE_REGENERATE" in old_text
    assert old["binding"]["project_grant_id"] == "grant-current"

    paths["challenge.id"].write_text("live_rotated_12345678", encoding="utf-8")
    with pytest.raises(RuntimeError, match="current Grant and Challenge"):
        build(paths)


def test_handoff_rejects_workbench_hash_as_external_receipt(tmp_path: Path) -> None:
    paths = fixture_files(tmp_path)
    event = json.loads(paths["audit.jsonl"].read_text(encoding="utf-8"))
    event["context_receipt_id"] = f"workbench:{'a' * 64}"
    paths["audit.jsonl"].write_text(json.dumps(event) + "\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="accepted filmos-live receipt"):
        build(paths)
