#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EVIDENCE_ROOT = ROOT / "acceptance" / "evidence" / "runs"


@dataclass(frozen=True)
class Check:
    check_id: str
    title: str
    command: tuple[str, ...]
    cwd: Path
    tracks: tuple[str, ...]


CURRENT_CHECKS = (
    Check(
        "desktop-brand",
        "FilmOS desktop icon and visible brand contract",
        (sys.executable, "acceptance/checks/desktop_brand.py"),
        ROOT,
        ("01-desktop", "03-project-ui"),
    ),
    Check(
        "desktop-local-auth",
        "Loopback-only desktop local authentication and self-contained web service",
        ("go", "test", "./internal/service", "./internal/handler", "./cmd/server", "./cmd/desktop-web"),
        ROOT / "backend",
        ("01-desktop", "02-film-core"),
    ),
    Check(
        "web-typecheck",
        "Web TypeScript contract",
        ("bun", "run", "typecheck"),
        ROOT / "web",
        ("03-project-ui", "14-chatgpt-app"),
    ),
    Check(
        "web-production-build",
        "Web production build",
        ("bun", "run", "build"),
        ROOT / "web",
        ("03-project-ui", "14-chatgpt-app"),
    ),
    Check(
        "desktop-release-build",
        "Pinned Swift 6 formal Desktop release build contract",
        (sys.executable, "acceptance/checks/desktop_release.py"),
        ROOT,
        ("01-desktop",),
    ),
    Check(
        "desktop-swift-test",
        "Pinned Xcode Swift Testing capability and Desktop test suite",
        (sys.executable, "acceptance/checks/desktop_swift_test.py"),
        ROOT,
        ("01-desktop", "13-qa"),
    ),
    Check(
        "no-openai-model-api-billing",
        "Subscription-only ChatGPT connection with zero OpenAI model API endpoints",
        (sys.executable, "acceptance/checks/no_openai_model_api_billing.py"),
        ROOT,
        ("01-desktop", "13-qa", "14-chatgpt-app"),
    ),
)


RC_LOCAL_CHECKS = CURRENT_CHECKS + (
    Check(
        "acceptance-runner-environment",
        "Clone-local Film Core Python path and dependency contract",
        (sys.executable, "-m", "pytest", "-q", "acceptance/tests/test_run_environment.py"),
        ROOT,
        ("02-film-core", "13-qa"),
    ),
    Check(
        "canonical-review-contract",
        "Canonical Review Contract and generated runtime bindings",
        ("node", "--test", "test/contract.test.mjs"),
        ROOT / "packages" / "filmos-review-contract",
        ("01-desktop", "03-project-ui", "08-agent", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "host-boundary-contract",
        "Typed Host contribution slots and executable FilmOS import boundary",
        ("bun", "test", "test/film-host-boundary.test.ts", "test/desktop-rpc-client.test.ts"),
        ROOT / "web",
        ("01-desktop", "03-project-ui", "08-agent", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "repository-hygiene",
        "Recoverable tracked artifact cleanup, generated output and canonical lock contract",
        (sys.executable, "acceptance/checks/repository_hygiene.py"),
        ROOT,
        ("00-upstream", "01-desktop", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "architecture-drift-gate",
        "FilmOS Constitution hash and architecture drift regression gates",
        ("node", "--test", "governance/test/architecture-drift-gate.test.mjs"),
        ROOT,
        ("00-upstream", "02-film-core", "08-agent", "13-qa"),
    ),
    Check(
        "architecture-current-diff",
        "Actual Git diff structural guard and non-blocking keyword review signals",
        ("node", "governance/architecture-drift-gate.mjs"),
        ROOT,
        ("00-upstream", "02-film-core", "08-agent", "13-qa"),
    ),
    Check(
        "review-bus-governance",
        "SQLite WAL Review Bus, evidence, consensus, lane and Pilot gates",
        ("npm", "test"),
        ROOT / "services" / "filmos-review-bus",
        ("08-agent", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "review-bus-stage-b-canary",
        "Installed SourceIdentity, Owner gate, v2 Evidence and legacy Anchor canary",
        ("npm", "run", "canary:stage-b"),
        ROOT / "services" / "filmos-review-bus",
        ("01-desktop", "08-agent", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "desktop-review-vertical-canary",
        "Packaged App lost-receipt restart through Review Bus, Coordinator and MCP Projection",
        (sys.executable, "acceptance/checks/desktop_review_vertical_canary.py"),
        ROOT,
        ("01-desktop", "03-project-ui", "08-agent", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "review-cli-watcher",
        "Codex local issue CLI and Review Watcher contract",
        ("npm", "test"),
        ROOT / "cli" / "filmos-review",
        ("08-agent", "13-qa"),
    ),
    Check(
        "review-bridge-contract",
        "Chrome user-gesture, loopback, challenge, replay and revoke contract",
        ("node", "--test", "extensions/filmos-review-bridge/test/bridge-contract.test.mjs"),
        ROOT,
        ("13-qa", "14-chatgpt-app"),
    ),
    Check(
        "pilot-project-copy",
        "Project-scoped Pilot copy, privacy reset, backup and restore contract",
        ("sh", "desktop/macos/Tests/pilot-data-scripts.test.sh"),
        ROOT,
        ("01-desktop", "02-film-core", "11-migration", "13-qa"),
    ),
    Check(
        "review-source-repository",
        "Internal no-network source clone and isolated Codex review worktree bootstrap",
        ("sh", "desktop/macos/Tests/review-source-repository.test.sh"),
        ROOT,
        ("01-desktop", "08-agent", "13-qa"),
    ),
    Check(
        "use-driven-dual-expert",
        "V1.1 static smoke for single issue entry, governance and zero-cost readiness bindings",
        (sys.executable, "acceptance/checks/use_driven_dual_expert.py"),
        ROOT,
        ("01-desktop", "03-project-ui", "08-agent", "10-providers", "11-migration", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "dual-expert-operational",
        "V1.1 process-level Candidate A to B, restart, pairing, writeback and dual-signoff operational preflight",
        ("node", "acceptance/checks/v1_1_dual_expert_operational.mjs"),
        ROOT,
        ("01-desktop", "03-project-ui", "08-agent", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "generation-routing-contracts",
        "V2.4 deterministic brain, catalog, route, authorization, prompt, budget and redaction contracts",
        ("npm", "test"),
        ROOT / "packages" / "filmos-generation-contracts",
        ("03-project-ui", "08-agent", "10-providers", "11-migration", "13-qa"),
    ),
    Check(
        "brain-generation-routing",
        "V2.4 static smoke for architecture freeze, discoverability and zero-cost provider readiness",
        (sys.executable, "acceptance/checks/brain_generation_routing.py"),
        ROOT,
        ("03-project-ui", "08-agent", "10-providers", "11-migration", "13-qa"),
    ),
    Check(
        "production-generation-composition",
        "V2.4 real Production Composition with persistent Film Core and zero-network local Mock Provider",
        (sys.executable, "acceptance/checks/production_generation_composition.py"),
        ROOT,
        ("02-film-core", "03-project-ui", "08-agent", "10-providers", "13-qa"),
    ),
    Check(
        "brain-generation-performance",
        "V2.4 deterministic selector, cached catalog and composer performance samples",
        ("node", "acceptance/checks/brain_generation_performance.mjs"),
        ROOT,
        ("03-project-ui", "08-agent", "10-providers", "13-qa"),
    ),
    Check(
        "agent-native-multibrain",
        "Native multi-brain production composition, adapter registry and broker instrumentation",
        (sys.executable, "acceptance/checks/agent_native_multibrain.py"),
        ROOT,
        ("08-agent", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "agent-codex-controlled-write",
        "Real Codex subscription reject, approve, restart and replay-safe controlled write evidence",
        (sys.executable, "acceptance/checks/agent_codex_controlled_write.py"),
        ROOT,
        ("08-agent", "13-qa"),
    ),
    Check(
        "agent-tool-contract-single-source",
        "Generated canonical Agent Tool schema, risk and surface contract",
        (sys.executable, "acceptance/checks/agent_tool_contract_single_source.py"),
        ROOT,
        ("08-agent", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "agent-candidate-activation",
        "Packaged Candidate App atomically activates all ten Agent dependencies",
        (sys.executable, "acceptance/checks/agent_candidate_activation.py"),
        ROOT,
        ("01-desktop", "08-agent", "13-qa"),
    ),
    Check(
        "mcp-actual-tool-count",
        "Actual Streamable HTTP MCP listTools and dynamic risk inventory",
        ("npx", "tsx", "scripts/mcp-manifest-receipt.ts"),
        ROOT / "services" / "filmos-chatgpt-app",
        ("08-agent", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "desktop-chatgpt-connection",
        "Desktop-managed Film Core, MCP, Keychain, Secure Tunnel lifecycle and Live Gate",
        (sys.executable, "acceptance/checks/desktop_chatgpt_connection.py"),
        ROOT,
        ("01-desktop", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "film-core-environment",
        "Acceptance-owned Film Core Python dependency contract",
        (sys.executable, "acceptance/checks/film_core_environment.py"),
        ROOT,
        ("02-film-core", "08-agent", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "desktop-runtime",
        "Double-click lifecycle, loopback services and cookie-free local session",
        (sys.executable, "acceptance/checks/desktop_runtime.py"),
        ROOT,
        ("01-desktop", "03-project-ui"),
    ),
    Check(
        "desktop-backup-restore",
        "Local data export, manifest verification and clean restart restore",
        (sys.executable, "acceptance/checks/desktop_backup_restore.py"),
        ROOT,
        ("01-desktop", "02-film-core", "13-qa"),
    ),
    Check(
        "film-contracts",
        "Film contract validation",
        (sys.executable, "tests/film-contract/validate_contracts.py"),
        ROOT,
        ("02-film-core", "13-qa"),
    ),
    Check(
        "golden-abc-real-http",
        "Golden A/B/C real temporary Film Core HTTP chain",
        (
            sys.executable,
            "-m",
            "pytest",
            "-q",
            "tests/film-golden/test_golden_a_real.py",
            "tests/film-golden/test_golden_b_real.py",
            "tests/film-golden/test_golden_c_real.py",
        ),
        ROOT,
        ("02-film-core", "04-story", "05-production-canvas", "06-assets", "07-prompt", "09-director", "10-providers", "13-qa"),
    ),
    Check(
        "acceptance-full-chain",
        "Fixed FilmOS Acceptance Project full Local-first chain",
        (sys.executable, "acceptance/checks/full_chain.py"),
        ROOT,
        ("02-film-core", "04-story", "05-production-canvas", "06-assets", "07-prompt", "09-director", "10-providers", "13-qa"),
    ),
    Check(
        "performance-local",
        "Film Core, Web bundle, Remote and Agent reproducible budgets",
        (sys.executable, "acceptance/checks/performance.py"),
        ROOT,
        ("02-film-core", "03-project-ui", "08-agent", "12-remote", "13-qa"),
    ),
    Check(
        "rc-recovery",
        "Unified restart, migration, source integrity and rollback drill",
        ("scripts/recovery/RC恢复演练", "--synthetic"),
        ROOT,
        ("02-film-core", "08-agent", "11-migration", "12-remote", "13-qa"),
    ),
    Check(
        "agent-browser-lifecycle",
        "Browser API and Local create, cancel, close profile lifecycle",
        (sys.executable, "acceptance/checks/agent_lifecycle_receipt.py", "AGENT-BROWSER-LIFECYCLE-001"),
        ROOT,
        ("08-agent", "13-qa"),
    ),
    Check(
        "agent-connection-probe-isolation",
        "Seven-profile independent non-network connection probe matrix",
        (sys.executable, "acceptance/checks/agent_lifecycle_receipt.py", "AGENT-CONNECTION-PROBE-ISOLATION-001"),
        ROOT,
        ("08-agent", "13-qa"),
    ),
    Check(
        "chatgpt-host-restart-recovery",
        "Process-level ChatGPT Host session and scoped grant recovery",
        (sys.executable, "acceptance/checks/agent_lifecycle_receipt.py", "CHATGPT-HOST-RESTART-RECOVERY-001"),
        ROOT,
        ("08-agent", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "chatgpt-handoff-state",
        "Formal ChatGPT waiting_host, Handoff events, receipts and expiry",
        (sys.executable, "acceptance/checks/agent_lifecycle_receipt.py", "CHATGPT-HANDOFF-STATE-001"),
        ROOT,
        ("08-agent", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "canvas-agent",
        "Codex Agent regression and build",
        ("npm", "test"),
        ROOT / "canvas-agent",
        ("08-agent", "13-qa"),
    ),
    Check(
        "chatgpt-handoff-local",
        "ChatGPT MCP, Widget and local handoff regression",
        ("npm", "test"),
        ROOT / "services" / "filmos-chatgpt-app",
        ("13-qa", "14-chatgpt-app"),
    ),
    Check(
        "chatgpt-golden-real",
        "Real Film Core to MCP, Widget and proposal CLI Golden",
        ("npm", "run", "test:golden-real"),
        ROOT / "services" / "filmos-chatgpt-app",
        ("13-qa", "14-chatgpt-app"),
    ),
    Check(
        "upstream-compatibility",
        "Pinned upstream compatibility and rollback tests",
        (sys.executable, "-m", "unittest", "discover", "-s", "scripts/upstream/tests", "-v"),
        ROOT,
        ("00-upstream", "11-migration", "13-qa"),
    ),
    Check(
        "remote-acceptance-contract",
        "Stable Acceptance manifest and exclusive maiyadiu/filmos-studio remote contract",
        (sys.executable, "acceptance/checks/remote_contract.py"),
        ROOT,
        ("12-remote", "13-qa"),
    ),
    Check(
        "acceptance-reports",
        "Hashed Acceptance reports bound to original receipts and raw sources",
        (sys.executable, "acceptance/checks/reports.py"),
        ROOT,
        ("00-upstream", "02-film-core", "11-migration", "12-remote", "13-qa"),
    ),
    Check(
        "evidence-index-contract",
        "Stable Track evidence contract without runtime or release identity",
        (sys.executable, "acceptance/checks/evidence_index.py"),
        ROOT,
        ("13-qa",),
    ),
    Check(
        "acceptance-privacy",
        "Acceptance evidence privacy and secret scan",
        (sys.executable, "acceptance/checks/privacy.py"),
        ROOT,
        ("13-qa",),
    ),
)


SOURCE_CHECK_IDS = frozenset({
    "desktop-local-auth", "web-typecheck", "web-production-build",
    "no-openai-model-api-billing", "acceptance-runner-environment",
    "canonical-review-contract", "host-boundary-contract", "repository-hygiene",
    "architecture-drift-gate", "architecture-current-diff", "review-bus-governance",
    "desktop-backup-restore", "acceptance-full-chain",
})

# This is intentionally not rc-local minus a few App checks: each included
# entry must have fixture/temporary storage and no live credential dependency.
SOURCE_CHECKS = tuple(check for check in RC_LOCAL_CHECKS if check.check_id in SOURCE_CHECK_IDS) + (
    Check(
        "source-supervisor-lifecycle",
        "Source Swift supervisor/window/configuration tests (mock/owned processes, no Keychain suite)",
        ("xcrun", "swift", "test", "--package-path", "desktop/macos", "--scratch-path", ".local/source-swift-test", "--filter", "ServiceSupervisorTests|DesktopWindowLifecycleTests|InternalWorkbenchConfigurationTests"),
        ROOT,
        ("01-desktop", "13-qa"),
    ),
    Check(
        "external-read-runner-contract",
        "External runner unit contracts with temporary storage and owned mock processes (not live acceptance)",
        ("node", "--test", "scripts/test-filmos-external-read-runtime.mjs"),
        ROOT,
        ("13-qa", "14-chatgpt-app"),
    ),
    Check(
        "source-validation-contract",
        "Source CI scope, isolated test entry and evidence classification regression",
        (sys.executable, "-m", "pytest", "-q", "acceptance/tests/test_source_validation.py"),
        ROOT,
        ("01-desktop", "13-qa"),
    ),
    Check(
        "known-dependency-security",
        "Known advisory floors, actual nested dependency resolution and parser contracts (not a full security audit)",
        ("node", "--test", "scripts/test-依赖安全.mjs"),
        ROOT,
        ("03-project-ui", "08-agent", "13-qa", "14-chatgpt-app"),
    ),
    Check(
        "portrait-image-compatibility",
        "Portrait image decode/transform/output and storage fixtures without live models",
        ("node_modules/.bin/tsx", "--test", "test/portrait-clearance.test.ts"),
        ROOT / "canvas-agent",
        ("08-agent", "13-qa"),
    ),
)


REAL_AGENT_CHECKS = (
    Check(
        "codex-subscription-real",
        "Real ChatGPT-managed Codex subscription context, MCP, restart and audit Golden",
        ("npx", "tsx", "scripts/codex-subscription-golden.ts"),
        ROOT / "canvas-agent",
        ("08-agent", "13-qa"),
    ),
)


CHECK_ARTIFACT_NAMES = {
    "repository-hygiene": "repository-hygiene-receipt.json",
    "desktop-review-vertical-canary": "desktop-review-vertical-canary-receipt.json",
    "use-driven-dual-expert": "use-driven-dual-expert-receipt.json",
    "dual-expert-operational": "dual-expert-operational-receipt.json",
    "no-openai-model-api-billing": "no-openai-model-api-billing-receipt.json",
    "agent-native-multibrain": "agent-native-multibrain-receipt.json",
    "agent-codex-controlled-write": "agent-codex-controlled-write-receipt.json",
    "agent-tool-contract-single-source": "agent-tool-contract-single-source-receipt.json",
    "agent-candidate-activation": "agent-candidate-activation-receipt.json",
    "mcp-actual-tool-count": "mcp-actual-tool-count-receipt.json",
    "agent-browser-lifecycle": "agent-browser-lifecycle-receipt.json",
    "agent-connection-probe-isolation": "agent-connection-probe-isolation-receipt.json",
    "chatgpt-host-restart-recovery": "chatgpt-host-restart-recovery-receipt.json",
    "chatgpt-handoff-state": "chatgpt-handoff-state-receipt.json",
    "codex-subscription-real": "codex-subscription-real-receipt.json",
    "brain-generation-routing": "brain-generation-routing-receipt.json",
    "production-generation-composition": "production-generation-composition-receipt.json",
    "brain-generation-performance": "brain-generation-performance-receipt.json",
}


def canonical(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def redact_text(text: str) -> str:
    replacements = {
        str(ROOT): "$REPO",
        str(Path.home()): "$HOME",
    }
    for source, target in sorted(replacements.items(), key=lambda item: len(item[0]), reverse=True):
        if source:
            text = text.replace(source, target)
    text = re.sub(r"/(?:private/)?var/folders/[^\s]+", "$TMP", text)
    patterns = (
        (r"(?i)(authorization:\s*bearer\s+)[^\s]+", r"\1[REDACTED]"),
        (r"(?i)(cookie:\s*)[^\r\n]+", r"\1[REDACTED]"),
        (r"(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[=:]\s*)[^\s,;]+", r"\1[REDACTED]"),
        (r"\bsk-[A-Za-z0-9_-]{12,}\b", "[REDACTED_API_KEY]"),
    )
    for pattern, replacement in patterns:
        text = re.sub(pattern, replacement, text)
    return text


def redact_log(value: bytes) -> bytes:
    text = redact_text(value.decode("utf-8", errors="replace"))
    normalized = "\n".join(line.rstrip() for line in text.splitlines())
    if text.endswith(("\n", "\r")):
        normalized += "\n"
    return normalized.encode("utf-8")


def json_artifact_from_log(value: bytes, check_id: str) -> object:
    text = value.decode("utf-8")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        for line in reversed(text.splitlines()):
            candidate = line.strip()
            if not candidate:
                continue
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                continue
    raise RuntimeError(f"{check_id} passed without a machine-readable JSON artifact")


def git_value(*args: str) -> str:
    result = subprocess.run(("git", *args), cwd=ROOT, text=True, capture_output=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else ""


def source_snapshot_sha256() -> str:
    result = subprocess.run(
        ("git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"),
        cwd=ROOT,
        capture_output=True,
        check=True,
    )
    digest = hashlib.sha256()
    for raw_path in sorted(item for item in result.stdout.split(b"\0") if item):
        relative = raw_path.decode("utf-8", errors="surrogateescape")
        path = ROOT / relative
        digest.update(raw_path + b"\0")
        if path.is_symlink():
            digest.update(b"SYMLINK\0" + os.readlink(path).encode("utf-8", errors="surrogateescape"))
        elif path.is_file():
            digest.update(b"FILE\0")
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
        else:
            digest.update(b"MISSING\0")
        digest.update(b"\0")
    return digest.hexdigest()


def selected_checks(suite: str) -> Sequence[Check]:
    if suite == "source-pinned":
        return (Check(
            "external-read-physical-contract",
            "Frozen workstation physical file pins and minimal command resolution (no services)",
            ("node", "--test", "scripts/test-外部物理绑定.mjs"),
            ROOT,
            ("13-qa", "14-chatgpt-app"),
        ),)
    if suite == "source":
        return SOURCE_CHECKS
    if suite == "current":
        return CURRENT_CHECKS
    if suite == "rc-local":
        return RC_LOCAL_CHECKS
    if suite == "rc-real-agent":
        return REAL_AGENT_CHECKS
    raise ValueError(suite)


class FilmCorePythonError(RuntimeError):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


def clone_film_core_python(root: Path = ROOT) -> Path:
    return (root.absolute() / ".local" / "acceptance-venv" / "bin" / "python")


def resolve_film_core_python(
    environment: dict[str, str],
    *,
    root: Path = ROOT,
    probe: bool = True,
) -> str:
    expected = clone_film_core_python(root)
    expected_text = str(expected)
    configured = {
        name: environment.get(name, "").strip()
        for name in ("FILMOS_CORE_PYTHON", "FILMOS_TEST_PYTHON")
    }
    for name, raw_value in configured.items():
        if not raw_value:
            continue
        candidate = Path(raw_value)
        if not candidate.is_absolute() or os.path.normpath(raw_value) != expected_text:
            raise FilmCorePythonError(
                "FILMOS_CORE_PYTHON_INVALID",
                f"{name} must equal the current clone interpreter",
            )
    if not expected.is_file() or not os.access(expected, os.X_OK):
        raise FilmCorePythonError(
            "FILMOS_CORE_PYTHON_UNAVAILABLE",
            "current clone acceptance interpreter is missing or not executable",
        )
    if probe:
        result = subprocess.run(
            (
                expected_text,
                "-c",
                "import fastapi,httpx,jsonschema,pydantic,pytest,uvicorn",
            ),
            cwd=root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode != 0:
            raise FilmCorePythonError(
                "FILMOS_CORE_PYTHON_DEPENDENCIES_INCOMPLETE",
                "current clone acceptance interpreter failed the dependency probe",
            )
    return expected_text


def acceptance_environment(*, source_only: bool = False) -> tuple[dict[str, str], bool]:
    environment = os.environ.copy()
    if source_only:
        # Do not pass ambient Production URLs, database paths, grants or model
        # credentials to ordinary tests. Tests supply their own fixture config.
        allowed_film_keys = {"FILMOS_DIFF_BASE", "FILMOS_DIFF_HEAD", "FILMOS_CORE_PYTHON", "FILMOS_TEST_PYTHON"}
        for key in list(environment):
            if (key.startswith(("FILMOS_", "CANVAS_", "FRAMEFIELD_", "OPENAI_", "ANTHROPIC_", "GOOGLE_", "GEMINI_"))
                    and key not in allowed_film_keys):
                del environment[key]
    python = resolve_film_core_python(environment)
    environment["FILMOS_CORE_PYTHON"] = python
    environment["FILMOS_TEST_PYTHON"] = python
    return environment, True


def run_check(check: Check, run_dir: Path, environment: dict[str, str]) -> dict[str, object]:
    log_path = run_dir / f"{check.check_id}.log"
    started = time.monotonic()
    process = subprocess.run(
        check.command,
        cwd=check.cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=environment,
        check=False,
    )
    redacted = redact_log(process.stdout or b"")
    log_path.write_bytes(redacted)
    artifact = None
    artifact_name = CHECK_ARTIFACT_NAMES.get(check.check_id)
    if artifact_name and process.returncode == 0:
        payload = json_artifact_from_log(redacted, check.check_id)
        artifact_path = run_dir / artifact_name
        artifact_path.write_bytes(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2).encode() + b"\n")
        artifact = {
            "path": artifact_path.name,
            "sha256": sha256_file(artifact_path),
            "bytes": artifact_path.stat().st_size,
        }
    duration_ms = round((time.monotonic() - started) * 1000, 3)
    result = {
        "check_id": check.check_id,
        "title": check.title,
        "tracks": list(check.tracks),
        "status": "PASSED" if process.returncode == 0 else "FAILED",
        "exit_code": process.returncode,
        "duration_ms": duration_ms,
        "cwd": str(check.cwd.relative_to(ROOT)) or ".",
        "command": [redact_text(value) for value in check.command],
        "log": log_path.name,
        "log_sha256": sha256_file(log_path),
        "log_bytes": log_path.stat().st_size,
    }
    if artifact:
        result["artifact"] = artifact
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="FilmOS reproducible acceptance runner")
    parser.add_argument("--suite", choices=("source", "source-pinned", "current", "rc-local", "rc-real-agent"), default="source")
    parser.add_argument("--only", action="append", default=[], help="run only the named check; repeatable")
    parser.add_argument("--evidence-root", type=Path, default=DEFAULT_EVIDENCE_ROOT)
    parser.add_argument("--receipt-path-file", type=Path)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--authorize-app-acceptance", action="store_true", help="only after explicit user authorization for App packaging")
    args = parser.parse_args()

    checks = list(selected_checks(args.suite))
    if args.only:
        requested = set(args.only)
        checks = [check for check in checks if check.check_id in requested]
        missing = requested - {check.check_id for check in checks}
        if missing:
            parser.error(f"unknown checks: {', '.join(sorted(missing))}")
    if args.list:
        for check in checks:
            print(check.check_id)
        return 0

    if args.suite in {"current", "rc-local"} and not args.authorize_app_acceptance:
        parser.error("APP_ACCEPTANCE_AUTHORIZATION_REQUIRED: use --suite source for ordinary development")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    short_head = git_value("rev-parse", "--short=12", "HEAD") or "no-git"
    initial_worktree_porcelain = git_value("status", "--short")
    initial_source_snapshot = source_snapshot_sha256()
    initial_commit = git_value("rev-parse", "HEAD")
    initial_tree = git_value("rev-parse", "HEAD^{tree}")
    try:
        environment, film_core_python_ready = acceptance_environment(source_only=args.suite.startswith("source"))
    except FilmCorePythonError as error:
        print(json.dumps({
            "status": "CONFIGURATION_ERROR",
            "error_code": error.code,
            "detail": error.detail,
        }, sort_keys=True), file=sys.stderr)
        return 2
    run_id = f"{timestamp}-{short_head}-{args.suite}"
    run_dir = args.evidence_root.resolve() / run_id
    run_dir.mkdir(parents=True, exist_ok=False)

    results = []
    for check in checks:
        print(f"[{check.check_id}] {check.title}", flush=True)
        result = run_check(check, run_dir, environment)
        results.append(result)
        print(f"[{check.check_id}] {result['status']} ({result['duration_ms']} ms)", flush=True)

    source_unchanged = initial_source_snapshot == source_snapshot_sha256() and initial_commit == git_value("rev-parse", "HEAD")
    payload: dict[str, object] = {
        "schema_version": "1.0.0",
        "run_id": run_id,
        "suite": args.suite,
        "validation_class": "SOURCE_VALIDATION" if args.suite.startswith("source") else ("EXTERNAL_LIVE_ACCEPTANCE" if args.suite == "rc-real-agent" else "APP_ACCEPTANCE"),
        "coverage_scope": "SELECTED_CHECKS_ONLY" if args.only else "SUITE_CHECKS_ONLY",
        "source_unchanged_during_validation": source_unchanged,
        "status": "PASSED" if source_unchanged and all(result["status"] == "PASSED" for result in results) else "FAILED",
        "started_from_commit": initial_commit,
        "started_from_tree": initial_tree,
        "branch": git_value("branch", "--show-current"),
        "clean_worktree": initial_worktree_porcelain == "",
        "source_snapshot_sha256": initial_source_snapshot,
        "worktree_porcelain": initial_worktree_porcelain,
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "film_core_python_ready": film_core_python_ready,
        "results": results,
    }
    payload["receipt_sha256"] = hashlib.sha256(canonical(payload)).hexdigest()
    receipt_path = run_dir / "receipt.json"
    receipt_path.write_bytes(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2).encode() + b"\n")
    if args.receipt_path_file:
        args.receipt_path_file.write_text(str(receipt_path) + "\n", encoding="utf-8")
    print(receipt_path)
    return 0 if payload["status"] == "PASSED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
