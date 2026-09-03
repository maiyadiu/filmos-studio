#!/usr/bin/env python3
"""Build an External Live Activation handoff from the current publish receipt."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")
LIVE_RECEIPT_PATTERN = re.compile(r"^filmos-live:[0-9a-f]{64}$")


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"JSON object required: {path}")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"{field} is required")
    return value.strip()


def current_grant(path: Path, project_id: str, now: datetime | None = None) -> dict[str, Any]:
    values = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(values, list):
        raise RuntimeError("Project Grant store must be an array")
    instant = now or datetime.now(timezone.utc)
    candidates: list[dict[str, Any]] = []
    for value in values:
        if not isinstance(value, dict) or value.get("project_id") != project_id or value.get("revoked_at") is not None:
            continue
        expires_at = datetime.fromisoformat(require_text(value.get("expires_at"), "expires_at").replace("Z", "+00:00"))
        if expires_at > instant:
            candidates.append(value)
    if not candidates:
        raise RuntimeError("No current Project Grant matches the handoff project")
    return max(candidates, key=lambda item: require_text(item.get("issued_at"), "issued_at"))


def latest_publish(
    path: Path,
    *,
    project_id: str,
    grant_id: str,
    challenge_id: str,
) -> dict[str, Any]:
    matches: list[dict[str, Any]] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"Invalid audit JSONL at line {number}") from error
        if not isinstance(value, dict):
            continue
        if (
            value.get("action") == "handoff.live_context.publish"
            and value.get("outcome") == "ALLOW"
            and value.get("project_id") == project_id
            and value.get("grant_id") == grant_id
            and value.get("challenge_id") == challenge_id
        ):
            matches.append(value)
    if not matches:
        raise RuntimeError("No live-context publish receipt matches the current Grant and Challenge")
    return max(matches, key=lambda item: require_text(item.get("recorded_at"), "recorded_at"))


def build_handoff(
    *,
    audit_log: Path,
    grant_store: Path,
    challenge_file: Path,
    source_identity_file: Path,
    canary_context: Path,
    canary_receipt: Path,
    canary_trace: Path,
    canary_result: Path,
    project_id: str,
    issue_id: str,
    submission_id: str,
    output: Path,
    now: datetime | None = None,
) -> dict[str, Any]:
    project_id = require_text(project_id, "project_id")
    issue_id = require_text(issue_id, "issue_id")
    submission_id = require_text(submission_id, "submission_id")
    challenge_id = require_text(challenge_file.read_text(encoding="utf-8"), "challenge_id")
    if not re.fullmatch(r"live_[A-Za-z0-9_-]{8,96}", challenge_id):
        raise RuntimeError("Current Tunnel Challenge is invalid")

    grant = current_grant(grant_store, project_id, now)
    grant_id = require_text(grant.get("grant_id"), "grant_id")
    publish = latest_publish(
        audit_log,
        project_id=project_id,
        grant_id=grant_id,
        challenge_id=challenge_id,
    )
    canvas_state_hash = require_text(publish.get("output_hash"), "canvas_state_hash")
    live_context_receipt_id = require_text(publish.get("context_receipt_id"), "live_context_receipt_id")
    if not HASH_PATTERN.fullmatch(canvas_state_hash):
        raise RuntimeError("Published canvas_state_hash is invalid")
    if not LIVE_RECEIPT_PATTERN.fullmatch(live_context_receipt_id):
        raise RuntimeError("External Live Receipt must be the accepted filmos-live receipt")
    if live_context_receipt_id == f"workbench:{canvas_state_hash}":
        raise RuntimeError("canvas_state_hash cannot be used as the External Live Receipt")

    source_identity = load_json(source_identity_file)
    required_identity = {
        "build_id": require_text(source_identity.get("build_id"), "build_id"),
        "git_commit_sha": require_text(source_identity.get("git_commit_sha"), "git_commit_sha"),
        "git_tree_sha": require_text(source_identity.get("git_tree_sha"), "git_tree_sha"),
        "source_fingerprint_sha256": require_text(source_identity.get("source_fingerprint_sha256"), "source_fingerprint_sha256"),
        "release_channel": require_text(source_identity.get("release_channel"), "release_channel"),
        "source_clean": source_identity.get("source_clean"),
    }
    if required_identity["source_clean"] is not True:
        raise RuntimeError("Source identity must be clean")
    for field in ("git_commit_sha", "git_tree_sha", "source_fingerprint_sha256"):
        value = required_identity[field]
        expected_length = 64 if field == "source_fingerprint_sha256" else 40
        if not isinstance(value, str) or not re.fullmatch(rf"[0-9a-f]{{{expected_length}}}", value):
            raise RuntimeError(f"Invalid source identity field: {field}")

    context = load_json(canary_context)
    result = load_json(canary_result)
    if result.get("status") != "PASS":
        raise RuntimeError("Post-Cleanup Canary must pass before handoff generation")
    context_identity = context.get("source_identity")
    if not isinstance(context_identity, dict) or any(context_identity.get(key) != value for key, value in required_identity.items()):
        raise RuntimeError("Canary and current Source Runtime Identity do not match")
    result_identity = result.get("identity")
    if not isinstance(result_identity, dict) or (
        result_identity.get("commit") != required_identity["git_commit_sha"]
        or result_identity.get("tree") != required_identity["git_tree_sha"]
        or result_identity.get("source_fingerprint") != required_identity["source_fingerprint_sha256"]
    ):
        raise RuntimeError("Canary result is not bound to the current source identity")

    canary_hashes = {
        "context_sha256": sha256_file(canary_context),
        "receipt_sha256": sha256_file(canary_receipt),
        "trace_sha256": sha256_file(canary_trace),
        "result_sha256": sha256_file(canary_result),
    }
    binding = {
        "project_id": project_id,
        "project_grant_id": grant_id,
        "challenge_id": challenge_id,
        "canvas_state_hash": canvas_state_hash,
        "live_context_receipt_id": live_context_receipt_id,
        "publish_event_id": require_text(publish.get("event_id"), "publish_event_id"),
        "publish_recorded_at": require_text(publish.get("recorded_at"), "publish_recorded_at"),
        "source_identity": required_identity,
        "canary": canary_hashes,
    }
    binding_json = json.dumps(binding, ensure_ascii=False, indent=2, sort_keys=True)
    text = f"""# External Live Activation 指令

请通过当前已连接的 FilmOS Studio 连接器执行真实只读复核。不得根据期望值猜测结果，不得调用写入、模型 API、Provider、生成、上传、审批或外部项目创建能力。

## 当前固定范围

- Project：`{project_id}`
- Issue：`{issue_id}`
- Submission：`{submission_id}`
- Commit：`{required_identity['git_commit_sha']}`
- Tree：`{required_identity['git_tree_sha']}`
- Build：`{required_identity['build_id']}`
- Source Fingerprint：`{required_identity['source_fingerprint_sha256']}`
- Project Grant：`{grant_id}`
- Tunnel Challenge：`{challenge_id}`
- canvas_state_hash：`{canvas_state_hash}`
- live_context_receipt_id：`{live_context_receipt_id}`
- Canary context SHA-256：`{canary_hashes['context_sha256']}`
- Canary receipt SHA-256：`{canary_hashes['receipt_sha256']}`
- Canary trace SHA-256：`{canary_hashes['trace_sha256']}`
- Canary result SHA-256：`{canary_hashes['result_sha256']}`

```json
{binding_json}
```

如果工具返回的 Grant、Challenge、Project、Source Runtime Identity 或 live_context_receipt_id 与上述当前值不同，停止判定并返回 `HANDOFF_STALE_REGENERATE`，不得拼接新旧绑定。

## 必须按顺序真实调用

1. `issue_list_pending`，参数 `{{}}`。
2. `issue_get_evidence`，参数 `{{"issue_id":"{issue_id}","expected_project_id":"{project_id}"}}`。
3. `issue_get_constitution`，参数 `{{}}`。
4. `review_get_architecture_options`，参数 `{{"issue_id":"{issue_id}","expected_project_id":"{project_id}"}}`。
5. `filmos_get_project_context`，参数 `{{}}`。
6. `filmos_get_live_workbench_context`，参数 `{{}}`。
7. `filmos_get_blockers`，参数 `{{}}`。
8. 负向探针：`issue_get_evidence`，参数 `{{"issue_id":"{issue_id}","expected_project_id":"filmos-negative-project-probe"}}`。

必须核验 Live Context 顶层 `context_receipt_id`、`binding.context_receipt_id` 与 Blockers `evidence.live_context_receipt_id` 三者均精确等于 `{live_context_receipt_id}`；同时核验 `canvas_state_hash` 精确等于 `{canvas_state_hash}`，不得把两种字段混用。负向探针必须同时满足 `isError=true`、`content.code=PROJECT_SCOPE_DENIED`、`structuredContent.error_code=PROJECT_SCOPE_DENIED`，且不得包含 Evidence、Submission 或 manifest 数据。真正的参数格式错误必须继续为 `INVALID_ARGUMENT`。

只在全部真实调用满足时返回 `EXTERNAL_CHATGPT_LIVE_ACTIVATION=PASS`；否则返回 `FAIL` 并列出实际值与期望值。Codex 本机验收不得替代本次真实连接器复核。
"""
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(output)
    return {
        "output": str(output),
        "output_sha256": sha256_file(output),
        "binding": binding,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-log", required=True, type=Path)
    parser.add_argument("--grant-store", required=True, type=Path)
    parser.add_argument("--challenge-file", required=True, type=Path)
    parser.add_argument("--source-identity", required=True, type=Path)
    parser.add_argument("--canary-context", required=True, type=Path)
    parser.add_argument("--canary-receipt", required=True, type=Path)
    parser.add_argument("--canary-trace", required=True, type=Path)
    parser.add_argument("--canary-result", required=True, type=Path)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--issue-id", required=True)
    parser.add_argument("--submission-id", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    value = build_handoff(
        audit_log=args.audit_log,
        grant_store=args.grant_store,
        challenge_file=args.challenge_file,
        source_identity_file=args.source_identity,
        canary_context=args.canary_context,
        canary_receipt=args.canary_receipt,
        canary_trace=args.canary_trace,
        canary_result=args.canary_result,
        project_id=args.project_id,
        issue_id=args.issue_id,
        submission_id=args.submission_id,
        output=args.output,
    )
    print(json.dumps(value, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
