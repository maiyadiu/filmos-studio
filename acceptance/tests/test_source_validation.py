from __future__ import annotations

import importlib.util
from importlib.machinery import SourceFileLoader
import ast
import json
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

import pytest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("source_acceptance_run", ROOT / "acceptance/run.py")
assert SPEC is not None and SPEC.loader is not None
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)


def test_source_suite_has_real_diff_and_fixture_contracts_without_app_or_user_data_tests() -> None:
    checks = runner.selected_checks("source")
    ids = {check.check_id for check in checks}
    assert len(ids) == len(checks)
    assert {
        "architecture-current-diff", "review-bus-governance", "external-read-runner-contract",
        "known-dependency-security", "portrait-image-compatibility",
    } <= ids
    assert not {"desktop-release-build", "desktop-runtime", "desktop-review-vertical-canary"} & ids
    for check in checks:
        command = " ".join(check.command)
        assert "install-local-app" not in command
        assert "test-filmos-source-host" not in command
        assert "test-filmos-source-lifecycle" not in command


@pytest.mark.parametrize("entry", ["scripts/test-filmos-source-host", "scripts/test-filmos-source-lifecycle", "acceptance/run_all"])
def test_unsafe_legacy_entry_fails_before_any_start_or_data_access(entry: str) -> None:
    result = subprocess.run(["sh", str(ROOT / entry)], capture_output=True, text=True, timeout=5)
    assert result.returncode == 2
    assert "AUTHORIZATION_REQUIRED" in result.stderr
    assert result.stdout == ""


@pytest.mark.parametrize("suite", ["current", "rc-local"])
def test_app_suite_cannot_start_accidentally(suite: str) -> None:
    result = subprocess.run([sys.executable, str(ROOT / "acceptance/run.py"), "--suite", suite], capture_output=True, text=True, timeout=5)
    assert result.returncode == 2
    assert "APP_ACCEPTANCE_AUTHORIZATION_REQUIRED" in result.stderr


def test_source_environment_does_not_inherit_production_or_model_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("FILMOS_REVIEW_BUS_LOCAL_DIR", "FILMOS_CORE_DB_PATH", "FILMOS_V1_1_EXTERNAL_LIVE_TRACE", "CANVAS_BACKEND_DATA_DIR", "OPENAI_API_KEY"):
        monkeypatch.setenv(key, "must-not-inherit")
    monkeypatch.setenv("FILMOS_DIFF_BASE", "fixture-base")
    env, ready = runner.acceptance_environment(source_only=True)
    assert ready
    assert "must-not-inherit" not in env.values()
    assert env["FILMOS_DIFF_BASE"] == "fixture-base"


def test_workflow_never_builds_app_for_push_or_pull_request() -> None:
    workflow = (ROOT / ".github/workflows/acceptance.yml").read_text()
    source_job = workflow.split("  source:\n", 1)[1].split("  rc-local:\n", 1)[0]
    app_job = workflow.split("  rc-local:\n", 1)[1]
    assert "acceptance/run_all" not in source_job
    assert "--suite source" in source_job
    assert "github.event_name == 'workflow_dispatch' && inputs.authorize_app_acceptance == true" in app_job
    assert "acceptance/run_all --authorize-app-acceptance" in app_job
    assert "FILMOS_DIFF_BASE" in source_job and "FILMOS_DIFF_HEAD" in source_job


def test_source_identity_includes_real_launcher_helper_and_metadata() -> None:
    tree = ast.parse((ROOT / "desktop/macos/scripts/source-fingerprint").read_text())
    scopes = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "SOURCE_SCOPES" for target in node.targets))
    assert {"scripts/filmos-source-start", "scripts/filmos-source-helper", "scripts/source-runtime-metadata.mjs", "源码启动.command"} <= set(scopes)


def test_source_fingerprint_detects_helper_bytes_and_executable_mode(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    loader = SourceFileLoader("baseline_fingerprint", str(ROOT / "desktop/macos/scripts/source-fingerprint"))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    helper = tmp_path / "filmos-source-helper"
    helper.write_text("#!/bin/sh\nexit 0\n")
    helper.chmod(0o755)
    original = module.fingerprint([helper])
    helper.write_text("#!/bin/sh\nexit 1\n")
    changed = module.fingerprint([helper])
    assert changed != original
    helper.chmod(0o644)
    assert module.fingerprint([helper]) != changed


@pytest.mark.parametrize("foreign_home", [False, True])
def test_portable_binding_and_path_checks_need_no_ignored_files(tmp_path: Path, foreign_home: bool) -> None:
    scripts = tmp_path / "isolated source" / "scripts"
    scripts.mkdir(parents=True)
    for name in ("filmos-external-read-runtime.mjs", "test-filmos-external-read-runtime.mjs"):
        shutil.copy2(ROOT / "scripts" / name, scripts / name)
    command = ["node"]
    if foreign_home:
        # Override only this disposable Node process's OS function, never the
        # user's HOME/environment or any actual profile/data directory.
        preload = (
            "import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module';"
            f"os.homedir=()=>{json.dumps(str(tmp_path / 'runner-profile'))};syncBuiltinESMExports();"
        )
        command += ["--import", "data:text/javascript," + quote(preload, safe="")]
    command += ["--test", "--test-reporter=tap", "--test-name-pattern", "Phase 6 binding|source-independent path", str(scripts / "test-filmos-external-read-runtime.mjs")]
    result = subprocess.run(command, cwd=tmp_path, capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "# pass 2" in result.stdout
    assert not (scripts.parent / ".local").exists()
