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
        "project-script-persistence", "project-script-tools", "project-script-broker",
        "creative-agent-build", "creative-persistence-contracts", "creative-browser-contracts",
        "production-generation-composition",
    } <= ids
    assert not {"desktop-release-build", "desktop-runtime", "desktop-review-vertical-canary"} & ids
    for check in checks:
        command = " ".join(check.command)
        assert "install-local-app" not in command
        assert "test-filmos-source-host" not in command
        assert "test-filmos-source-lifecycle" not in command


def test_creative_source_checks_cover_native_contracts_without_live_provider_fixtures() -> None:
    checks = {check.check_id: check for check in runner.selected_checks("source")}
    browser = checks["creative-browser-contracts"].command
    assert {"test/canvas-prompts.test.ts", "test/canvas-sync-baseline.test.ts", "test/ai-message-markdown.test.tsx",
            "test/agent-session-observation.test.ts", "test/canvas-agent-workflow.test.ts"} <= set(browser)
    broker = checks["project-script-broker"].command
    assert {"test/agent-session-grant-recovery.test.ts", "test/codex-app-server-adapter.test.ts",
            "test/local-runtime-public-error.test.ts", "test/project-prompt-contract.test.ts"} <= set(broker)
    persistence = checks["creative-persistence-contracts"].command
    assert {"./internal/model", "./internal/repository", "./internal/service", "./internal/handler"} <= set(persistence)
    for command in (browser, broker, persistence):
        assert "creative-agent-fixture" not in " ".join(command)
        assert "FILMOS_SCRIPT_BROWSER_FIXTURE" not in " ".join(command)
        assert "TestProjectScriptBrowserFixture" not in " ".join(command)


def test_source_builds_agent_contracts_before_tests_that_import_their_package_exports() -> None:
    checks = runner.selected_checks("source")
    ids = [check.check_id for check in checks]
    # A clean checkout has no ignored dist/. Local build leftovers must not
    # decide whether the native module and public error tests can even load.
    assert ids.index("creative-agent-build") < ids.index("project-script-broker")
    build = checks[ids.index("creative-agent-build")]
    assert build.command == ("npm", "run", "build")
    assert build.cwd == ROOT / "canvas-agent"
    assert ids.index("creative-agent-build") < ids.index("production-generation-composition")


@pytest.mark.parametrize("stale", [False, True])
def test_bootstrap_materializes_built_contracts_in_bun_file_consumers(tmp_path: Path, stale: bool) -> None:
    bootstrap = (ROOT / "acceptance/bootstrap").read_text()
    # Run the actual bounded materialization block on disposable package
    # fixtures. No install, developer node_modules, credentials or services.
    sync = bootstrap.split("# Bun materializes", 1)[1].split("generation_target=", 1)[0]
    sync = sync[sync.index("for consumer "):]
    consumers = [("web", "agent-tool-contracts"), ("canvas-agent", "agent-tool-contracts"), ("canvas-agent", "agent-contracts")]
    for package in {package for _, package in consumers}:
        dist = tmp_path / "packages" / f"filmos-{package}" / "dist"
        dist.mkdir(parents=True)
        (dist / "index.js").write_text(f'export const identity = "{package}-current";\n')
        (dist / "index.d.ts").write_text("export declare const identity: string;\n")
    for consumer, package in consumers:
        target = tmp_path / consumer / "node_modules/@filmos" / package
        target.mkdir(parents=True)
        (target / "package.json").write_text(json.dumps({"type": "module", "exports": "./dist/index.js"}))
        if stale:
            (target / "dist").mkdir()
            (target / "dist/index.js").write_text('export const identity = "stale";\n')
    result = subprocess.run(["sh", "-eu", "-c", 'ROOT="$1"\n' + sync, "contract-fixture", str(tmp_path)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stdout + result.stderr
    for consumer, package in consumers:
        entry = tmp_path / consumer / "node_modules/@filmos" / package / "dist/index.js"
        assert entry.read_bytes() == (tmp_path / "packages" / f"filmos-{package}" / "dist/index.js").read_bytes()
        probe = subprocess.run(["node", "--input-type=module", "-e", f'import {{ identity }} from {json.dumps("@filmos/" + package)}; if (identity !== {json.dumps(package + "-current")}) process.exit(1);'], cwd=tmp_path / consumer, capture_output=True, text=True, timeout=10)
        assert probe.returncode == 0, probe.stdout + probe.stderr
    assert 'packages/filmos-agent-contracts" && npm run build' in bootstrap


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


@pytest.mark.parametrize("policy,expected", [(None, True), ("true", True), ("false", False), ("yes", None), ("", None)])
def test_source_generation_policy_is_explicit_and_shared(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, policy: str | None, expected: bool | None) -> None:
    source = tmp_path / "source fixture"
    resources = source / ".local/source-host/Resources"
    resources.mkdir(parents=True)
    fingerprint = source / "desktop/macos/scripts/source-fingerprint"
    fingerprint.parent.mkdir(parents=True)
    identity = {"git_commit_sha": "a" * 40, "git_tree_sha": "b" * 40, "source_fingerprint_sha256": "c" * 64, "source_clean": True}
    fingerprint.write_text("#!/usr/bin/env node\nprocess.stdout.write(" + json.dumps(json.dumps(identity)) + ");\n")
    fingerprint.chmod(0o755)
    runtime_file = resources / "InternalRuntime.json"
    before = {"application_support_directory_name": "fixture-data", "external_paid_submit_enabled": False}
    runtime_file.write_text(json.dumps(before))
    monkeypatch.delenv("FILMOS_SOURCE_EXTERNAL_PAID_SUBMIT_ENABLED", raising=False)
    if policy is not None:
        monkeypatch.setenv("FILMOS_SOURCE_EXTERNAL_PAID_SUBMIT_ENABLED", policy)
    result = subprocess.run(["node", str(ROOT / "scripts/source-runtime-metadata.mjs"), str(source), str(resources)], capture_output=True, text=True, timeout=10)
    if expected is None:
        assert result.returncode != 0
        assert "FILMOS_SOURCE_SUBMIT_POLICY_INVALID" in result.stderr
        assert json.loads(runtime_file.read_text()) == before
        assert not (resources / "SourceIdentity.json").exists()
        return
    assert result.returncode == 0, result.stderr
    runtime = json.loads(runtime_file.read_text())
    actual = json.loads((resources / "SourceIdentity.json").read_text())
    assert runtime["external_paid_submit_enabled"] is actual["external_paid_submit_enabled"] is expected
    assert runtime["release_channel"] == actual["release_channel"] == "development"
    assert runtime["source_commit"] == actual["git_commit_sha"] == identity["git_commit_sha"]
    assert runtime["application_support_directory_name"] == "fixture-data"
    assert json.loads(result.stdout)["external_paid_submit_enabled"] is expected
    assert not list(source.rglob("*.app"))


def test_source_web_uses_generated_policy_and_user_data_test_explicitly_disables_submit() -> None:
    helper = (ROOT / "scripts/filmos-source-helper").read_text()
    web = helper.split("    FilmOSWeb)", 1)[1].split("    FilmOSLocalRuntime)", 1)[0]
    assert 'export VITE_FILMOS_EXTERNAL_PAID_SUBMIT_ENABLED="$source_submit_policy"' in web
    assert "FILMOS_SOURCE_SUBMIT_POLICY_MISMATCH" in web
    assert 'external_paid_submit_enabled raw -o - "$identity"' in web
    assert 'external_paid_submit_enabled raw -o - "$runtime_root/Resources/InternalRuntime.json"' in web
    smoke = (ROOT / "scripts/test-filmos-source-host").read_text()
    assert 'FILMOS_SOURCE_EXTERNAL_PAID_SUBMIT_ENABLED=false "$launcher" prepare' in smoke
    assert 'FILMOS_SOURCE_EXTERNAL_PAID_SUBMIT_ENABLED=false "$launcher" start' in smoke
    assert 'FILMOS_SOURCE_EXTERNAL_PAID_SUBMIT_ENABLED="$restore_submit_policy" "$launcher" start' in smoke


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
