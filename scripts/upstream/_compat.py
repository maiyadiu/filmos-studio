#!/usr/bin/env python3
"""Read-only upstream compatibility analysis for FilmOS Studio Track 00."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable


A = "A_AUTO_COMPATIBLE"
B = "B_ADAPTER_CHANGE"
C = "C_MIGRATION_REQUIRED"
D = "D_BLOCKED"
RANK = {A: 0, B: 1, C: 2, D: 3}
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = SCRIPT_DIR / "baseline.json"


class CompatError(RuntimeError):
    pass


def run_process(
    command: list[str],
    *,
    cwd: Path | None = None,
    check: bool = True,
    timeout: int | None = None,
) -> subprocess.CompletedProcess[str]:
    process = subprocess.run(
        command,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    if check and process.returncode != 0:
        detail = process.stderr.strip() or process.stdout.strip() or f"exit {process.returncode}"
        raise CompatError(f"{' '.join(command)}: {detail}")
    return process


def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run_process(["git", "-C", str(repo), *args], check=check)


def repo_root(value: str | None) -> Path:
    start = Path(value).expanduser().resolve() if value else Path.cwd()
    process = run_process(["git", "-C", str(start), "rev-parse", "--show-toplevel"])
    return Path(process.stdout.strip()).resolve()


def load_config(path: str | None) -> tuple[Path, dict[str, Any]]:
    config_path = Path(path).expanduser().resolve() if path else DEFAULT_CONFIG
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CompatError(f"cannot read baseline config {config_path}: {exc}") from exc
    required = ("repository", "release_api", "stable", "candidate_ref", "dev_ref")
    missing = [key for key in required if key not in payload]
    if missing:
        raise CompatError(f"baseline config missing keys: {', '.join(missing)}")
    stable = payload["stable"]
    for key in ("tag", "commit", "tree"):
        if key not in stable:
            raise CompatError(f"baseline config stable missing key: {key}")
    return config_path, payload


def normalize_remote_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    return normalized[:-4] if normalized.endswith(".git") else normalized


def resolve_commit(repo: Path, ref: str) -> str | None:
    process = git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}", check=False)
    return process.stdout.strip() if process.returncode == 0 else None


def resolve_tree(repo: Path, ref: str) -> str | None:
    process = git(repo, "rev-parse", "--verify", f"{ref}^{{tree}}", check=False)
    return process.stdout.strip() if process.returncode == 0 else None


def is_ancestor(repo: Path, ancestor: str, descendant: str) -> bool:
    return git(repo, "merge-base", "--is-ancestor", ancestor, descendant, check=False).returncode == 0


@dataclass
class StateContext:
    repo: Path
    config_path: Path
    config: dict[str, Any]
    stable_ref: str
    stable_commit: str | None
    stable_tree: str | None
    candidate_ref: str
    candidate_commit: str | None
    dev_ref: str
    dev_commit: str | None
    references: dict[str, str | None]
    problems: list[str]
    warnings: list[str]

    def public(self) -> dict[str, Any]:
        return {
            "stable": {
                "ref": self.stable_ref,
                "commit": self.stable_commit,
                "tree": self.stable_tree,
                "expected_commit": self.config["stable"]["commit"],
                "expected_tree": self.config["stable"]["tree"],
            },
            "candidate": {"ref": self.candidate_ref, "commit": self.candidate_commit},
            "dev": {"ref": self.dev_ref, "commit": self.dev_commit},
            "references": self.references,
            "problems": self.problems,
            "warnings": self.warnings,
        }


def resolve_context(args: argparse.Namespace) -> StateContext:
    repo = repo_root(args.repo)
    config_path, config = load_config(args.config)
    stable_ref = str(config["stable"]["tag"])
    stable_commit = resolve_commit(repo, stable_ref)
    stable_tree = resolve_tree(repo, stable_ref)
    candidate_ref = args.candidate or str(config["candidate_ref"])
    dev_ref = args.dev or str(config["dev_ref"])
    candidate_commit = resolve_commit(repo, candidate_ref)
    dev_commit = resolve_commit(repo, dev_ref)
    problems: list[str] = []
    warnings: list[str] = []

    expected_commit = str(config["stable"]["commit"])
    expected_tree = str(config["stable"]["tree"])
    if stable_commit is None:
        problems.append(f"stable tag {stable_ref} cannot be resolved")
    elif stable_commit != expected_commit:
        problems.append(f"stable tag drift: expected {expected_commit}, got {stable_commit}")
    if stable_tree is None:
        problems.append(f"stable tree {stable_ref} cannot be resolved")
    elif stable_tree != expected_tree:
        problems.append(f"stable tree drift: expected {expected_tree}, got {stable_tree}")

    alias_tag = config["stable"].get("alias_tag")
    if alias_tag:
        alias_commit = resolve_commit(repo, str(alias_tag))
        if alias_commit is None:
            warnings.append(f"optional stable alias {alias_tag} is absent")
        elif stable_commit and alias_commit != stable_commit:
            problems.append(f"stable alias {alias_tag} resolves to {alias_commit}, expected {stable_commit}")

    read_only = tuple(str(item) for item in config.get("read_only_reference_remotes", []))
    if any(candidate_ref == name or candidate_ref.startswith(f"{name}/") for name in read_only):
        problems.append(f"reference remote cannot be used as Candidate: {candidate_ref}")
    if candidate_commit is None:
        problems.append(f"Candidate ref cannot be resolved: {candidate_ref}")
    if dev_commit is None:
        problems.append(f"Dev ref cannot be resolved: {dev_ref}")
    if stable_commit and candidate_commit and not is_ancestor(repo, stable_commit, candidate_commit):
        problems.append("Candidate is not a descendant of the fixed Stable baseline")
    if stable_commit and dev_commit and not is_ancestor(repo, stable_commit, dev_commit):
        problems.append("Dev is not a descendant of the fixed Stable baseline")

    configured_remotes = config.get("remotes", {})
    actual_remotes: dict[str, str] = {}
    remote_lines = git(repo, "remote", "-v").stdout.splitlines()
    for line in remote_lines:
        parts = line.split()
        if len(parts) >= 3 and parts[2] == "(fetch)":
            actual_remotes[parts[0]] = parts[1]
    for name, expected_url in configured_remotes.items():
        actual_url = actual_remotes.get(str(name))
        if actual_url is None:
            problems.append(f"required remote is absent: {name}")
        elif normalize_remote_url(actual_url) != normalize_remote_url(str(expected_url)):
            problems.append(f"remote URL mismatch for {name}: {actual_url}")

    references: dict[str, str | None] = {}
    for name in read_only:
        ref = f"{name}/main"
        commit = resolve_commit(repo, ref)
        references[ref] = commit
        if commit is None and name in configured_remotes:
            warnings.append(f"read-only tracking ref is absent: {ref}")

    return StateContext(
        repo=repo,
        config_path=config_path,
        config=config,
        stable_ref=stable_ref,
        stable_commit=stable_commit,
        stable_tree=stable_tree,
        candidate_ref=candidate_ref,
        candidate_commit=candidate_commit,
        dev_ref=dev_ref,
        dev_commit=dev_commit,
        references=references,
        problems=problems,
        warnings=warnings,
    )


def list_files(repo: Path, rev: str, roots: Iterable[str]) -> list[str]:
    command = ["ls-tree", "-r", "--name-only", rev, "--", *roots]
    output = git(repo, *command).stdout
    return [line for line in output.splitlines() if line]


def read_blob(repo: Path, rev: str, path: str) -> str:
    return git(repo, "show", f"{rev}:{path}").stdout


def changed_files(repo: Path, before: str, after: str, roots: Iterable[str]) -> list[dict[str, str]]:
    process = git(repo, "diff", "--name-status", "--no-renames", before, after, "--", *roots)
    changes: list[dict[str, str]] = []
    for line in process.stdout.splitlines():
        if not line:
            continue
        status, path = line.split("\t", 1)
        changes.append({"status": status, "path": path})
    return changes


def canonical(source: str) -> str:
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    source = re.sub(r"//[^\n]*", "", source)
    return re.sub(r"\s+", " ", source).strip()


def brace_block(source: str, start: int, opening: str = "{", closing: str = "}") -> str:
    depth = 0
    quote: str | None = None
    escaped = False
    for index in range(start, len(source)):
        char = source[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in ('"', "'", "`"):
            quote = char
            continue
        if char == opening:
            depth += 1
        elif char == closing:
            depth -= 1
            if depth == 0:
                return source[start : index + 1]
    return source[start:]


def extract_go_structs(source: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for match in re.finditer(r"(?m)^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\s*\{", source):
        body = brace_block(source, source.find("{", match.start()))
        result[match.group(1)] = canonical(body)
    return result


def extract_ts_exports(source: str) -> dict[str, str]:
    result: dict[str, str] = {}
    pattern = re.compile(r"(?m)^export\s+(?:declare\s+)?(type|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)")
    for match in pattern.finditer(source):
        kind, name = match.groups()
        if kind in ("interface", "enum"):
            open_index = source.find("{", match.end())
            value = brace_block(source, open_index) if open_index >= 0 else source[match.start() : match.end()]
        else:
            end = source.find(";", match.end())
            value = source[match.start() : end + 1 if end >= 0 else len(source)]
        result[name] = canonical(value)
    return result


def extract_api_inventory(ctx: StateContext, rev: str) -> dict[str, str]:
    inventory: dict[str, str] = {}
    go_roots = ("backend/cmd/server", "backend/internal/handler")
    group_pattern = re.compile(r"(?m)^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([A-Za-z_][A-Za-z0-9_]*)\.Group\(\s*([\"`])([^\"`]+)\3")
    route_pattern = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*([\"`])([^\"`]+)\3")
    for path in list_files(ctx.repo, rev, go_roots):
        if not path.endswith(".go") or path.endswith("_test.go"):
            continue
        source = read_blob(ctx.repo, rev, path)
        group_prefixes: dict[str, str] = {"r": ""}
        unresolved = list(group_pattern.findall(source))
        while unresolved:
            remaining: list[tuple[str, str, str, str]] = []
            progressed = False
            for child, parent, quote, prefix in unresolved:
                if parent in group_prefixes:
                    group_prefixes[child] = group_prefixes[parent].rstrip("/") + "/" + prefix.lstrip("/")
                    progressed = True
                else:
                    remaining.append((child, parent, quote, prefix))
            unresolved = remaining
            if not progressed:
                break
        for receiver, method, _, route in route_pattern.findall(source):
            prefix = group_prefixes.get(receiver, "")
            full_route = prefix.rstrip("/") + "/" + route.lstrip("/")
            inventory[f"{method} {full_route}"] = path
    client_roots = ("web/src/services/api",)
    endpoint_pattern = re.compile(r"(?:[\"'`])(/(?:admin|ai|announcements|assets|auth|canvas|channels|diagnostics|features|models|plugins|projects|resources|sessions|settings|skills|tasks|wallet)[^\"'`\s]*)(?:[\"'`])")
    for path in list_files(ctx.repo, rev, client_roots):
        if not path.endswith((".ts", ".tsx")) or path.endswith(".test.ts"):
            continue
        for route in endpoint_pattern.findall(read_blob(ctx.repo, rev, path)):
            inventory[f"CLIENT {route}"] = path
    return inventory


def extract_model_inventory(ctx: StateContext, rev: str) -> dict[str, str]:
    inventory: dict[str, str] = {}
    for path in list_files(ctx.repo, rev, ("backend/internal/model",)):
        if not path.endswith(".go") or path.endswith("_test.go"):
            continue
        for name, body in extract_go_structs(read_blob(ctx.repo, rev, path)).items():
            inventory[name] = body
    return inventory


def migration_files(ctx: StateContext, rev: str) -> list[str]:
    paths = list_files(ctx.repo, rev, ("backend",))
    return [
        path
        for path in paths
        if path.endswith(".go")
        and not path.endswith("_test.go")
        and (
            path.startswith("backend/internal/database/")
            or path.startswith("backend/cmd/migrate")
            or any(token in Path(path).name.lower() for token in ("migrate", "migration", "schema"))
        )
    ]


def extract_canvas_inventory(ctx: StateContext, rev: str) -> dict[str, str]:
    roots = ("web/src/lib/canvas", "web/src/stores/canvas", "web/src/types/director.ts")
    inventory: dict[str, str] = {}
    for path in list_files(ctx.repo, rev, roots):
        if not path.endswith((".ts", ".tsx")) or path.endswith(".test.ts"):
            continue
        for name, body in extract_ts_exports(read_blob(ctx.repo, rev, path)).items():
            inventory[f"{path}:{name}"] = body
    return inventory


def extract_mcp_inventory(ctx: StateContext, rev: str) -> dict[str, str]:
    roots = ("canvas-agent/src", "plugins/yingce/.mcp.json", "plugins/yingce/.codex-plugin/plugin.json")
    inventory: dict[str, str] = {}
    for path in list_files(ctx.repo, rev, roots):
        if path.endswith(".ts") and (path.endswith("schemas.ts") or "mcp" in Path(path).name):
            source = read_blob(ctx.repo, rev, path)
            names_match = re.search(r"export\s+const\s+toolNames\s*=\s*\[(.*?)\]\s*as\s+const", source, re.S)
            if names_match:
                for name in re.findall(r"[\"']([A-Za-z0-9_-]+)[\"']", names_match.group(1)):
                    schema_match = re.search(rf"(?m)^\s*{re.escape(name)}\s*:\s*(.+)$", source)
                    inventory[name] = canonical(schema_match.group(1)) if schema_match else "declared"
            for name in re.findall(r"registerTool\(\s*[\"']([A-Za-z0-9_-]+)[\"']", source):
                call_start = source.find("registerTool", source.find(name) - 30)
                inventory[name] = canonical(source[call_start : call_start + 600])
        elif path.endswith(".json"):
            source = read_blob(ctx.repo, rev, path)
            try:
                value = json.dumps(json.loads(source), sort_keys=True, separators=(",", ":"))
            except json.JSONDecodeError:
                value = canonical(source)
            inventory[f"manifest:{path}"] = value
    return inventory


def inventory_delta(before: dict[str, str], after: dict[str, str]) -> tuple[list[str], list[str], list[str]]:
    before_keys = set(before)
    after_keys = set(after)
    added = sorted(after_keys - before_keys)
    removed = sorted(before_keys - after_keys)
    changed = sorted(key for key in before_keys & after_keys if before[key] != after[key])
    return added, removed, changed


def base_result(ctx: StateContext, check: str, target_name: str) -> dict[str, Any]:
    target_ref = ctx.candidate_ref if target_name == "candidate" else ctx.dev_ref
    target_commit = ctx.candidate_commit if target_name == "candidate" else ctx.dev_commit
    return {
        "track": "00-upstream",
        "check": check,
        "classification": D if ctx.problems else A,
        "comparison": target_name,
        "baseline_ref": ctx.stable_ref,
        "baseline_commit": ctx.stable_commit,
        "target_ref": target_ref,
        "target_commit": target_commit,
        "states": ctx.public(),
        "summary": "baseline validation failed" if ctx.problems else "no relevant differences",
        "added": [],
        "removed": [],
        "changed": [],
        "files": [],
    }


def analyze_inventory(
    ctx: StateContext,
    target_name: str,
    check: str,
    roots: tuple[str, ...],
    extractor: Callable[[StateContext, str], dict[str, str]],
    changed_level: str,
) -> dict[str, Any]:
    result = base_result(ctx, check, target_name)
    if ctx.problems:
        return result
    before = ctx.stable_commit
    after = ctx.candidate_commit if target_name == "candidate" else ctx.dev_commit
    assert before and after
    old_inventory = extractor(ctx, before)
    new_inventory = extractor(ctx, after)
    added, removed, changed = inventory_delta(old_inventory, new_inventory)
    files = [
        item
        for item in changed_files(ctx.repo, before, after, roots)
        if not item["path"].endswith(("_test.go", ".test.ts", ".test.tsx")) and "/test/" not in item["path"]
    ]
    if removed:
        classification = D
    elif added or changed or files:
        classification = changed_level
    else:
        classification = A
    result.update(
        classification=classification,
        summary=f"{len(added)} added, {len(removed)} removed, {len(changed)} changed; {len(files)} files touched",
        added=added,
        removed=removed,
        changed=changed,
        files=files,
    )
    return result


def analyze_api(ctx: StateContext, target_name: str) -> dict[str, Any]:
    return analyze_inventory(
        ctx,
        target_name,
        "api",
        ("backend/cmd/server", "backend/internal/handler", "web/src/services/api"),
        extract_api_inventory,
        B,
    )


def analyze_models(ctx: StateContext, target_name: str) -> dict[str, Any]:
    return analyze_inventory(ctx, target_name, "models", ("backend/internal/model",), extract_model_inventory, C)


def analyze_migrations(ctx: StateContext, target_name: str) -> dict[str, Any]:
    result = base_result(ctx, "migrations", target_name)
    if ctx.problems:
        return result
    before = ctx.stable_commit
    after = ctx.candidate_commit if target_name == "candidate" else ctx.dev_commit
    assert before and after
    old_files = set(migration_files(ctx, before))
    new_files = set(migration_files(ctx, after))
    relevant_roots = tuple(sorted(old_files | new_files))
    files = changed_files(ctx.repo, before, after, relevant_roots) if relevant_roots else []
    added = sorted(new_files - old_files)
    removed = sorted(old_files - new_files)
    modified = sorted(item["path"] for item in files if item["status"] == "M")
    classification = D if removed else C if files else A
    result.update(
        classification=classification,
        summary=f"{len(added)} migration files added, {len(removed)} removed, {len(modified)} modified",
        added=added,
        removed=removed,
        changed=modified,
        files=files,
    )
    return result


def analyze_canvas(ctx: StateContext, target_name: str) -> dict[str, Any]:
    return analyze_inventory(
        ctx,
        target_name,
        "canvas-schema",
        ("web/src/lib/canvas", "web/src/stores/canvas", "web/src/types/director.ts"),
        extract_canvas_inventory,
        B,
    )


def analyze_mcp(ctx: StateContext, target_name: str) -> dict[str, Any]:
    return analyze_inventory(
        ctx,
        target_name,
        "mcp",
        ("canvas-agent/src", "plugins/yingce/.mcp.json", "plugins/yingce/.codex-plugin/plugin.json"),
        extract_mcp_inventory,
        B,
    )


ANALYZERS: dict[str, Callable[[StateContext, str], dict[str, Any]]] = {
    "api": analyze_api,
    "models": analyze_models,
    "migrations": analyze_migrations,
    "canvas-schema": analyze_canvas,
    "mcp": analyze_mcp,
}


def check_release(ctx: StateContext, *, offline: bool, timeout: int, api_url: str | None) -> dict[str, Any]:
    result = base_result(ctx, "release", "candidate")
    result.update(
        release_api=api_url or ctx.config["release_api"],
        network_status="OFFLINE" if offline else "PENDING",
        latest_release=None,
    )
    if ctx.problems:
        return result
    if offline:
        result.update(classification=B, summary="network disabled; local fixed baseline validated")
        return result
    request = urllib.request.Request(
        str(result["release_api"]),
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "FilmOS-Studio-upstream-compat",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    payload: dict[str, Any] | None = None
    network_errors: list[str] = []
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.load(response)
    except (OSError, ValueError, urllib.error.URLError) as exc:
        network_errors.append(f"urllib: {exc}")
    if payload is None and shutil.which("curl"):
        curl = run_process(
            [
                "curl",
                "-fsSL",
                "--connect-timeout",
                str(min(timeout, 10)),
                "--max-time",
                str(timeout),
                "-H",
                "Accept: application/vnd.github+json",
                "-H",
                "X-GitHub-Api-Version: 2022-11-28",
                "-H",
                "User-Agent: FilmOS-Studio-upstream-compat",
                str(result["release_api"]),
            ],
            check=False,
            timeout=timeout + 2,
        )
        if curl.returncode == 0:
            try:
                payload = json.loads(curl.stdout)
            except json.JSONDecodeError as exc:
                network_errors.append(f"curl JSON: {exc}")
        else:
            network_errors.append(f"curl: {curl.stderr.strip() or f'exit {curl.returncode}'}")
    if payload is not None:
        latest = {
            "tag": payload.get("tag_name"),
            "name": payload.get("name"),
            "draft": bool(payload.get("draft")),
            "prerelease": bool(payload.get("prerelease")),
            "published_at": payload.get("published_at"),
            "html_url": payload.get("html_url"),
        }
        expected_tag = ctx.config["stable"]["tag"]
        classification = A if latest["tag"] == expected_tag and not latest["draft"] and not latest["prerelease"] else B
        summary = "latest stable release matches fixed baseline" if classification == A else "new or non-stable release requires compatibility review"
        result.update(classification=classification, summary=summary, network_status="OK", latest_release=latest)
    else:
        result.update(
            classification=B,
            summary="release API unavailable; local fixed baseline validated",
            network_status="UNAVAILABLE",
            network_error="; ".join(network_errors) or "no HTTP client available",
        )
    return result


def blob_id(repo: Path, rev: str, path: str) -> str:
    process = git(repo, "rev-parse", "--verify", f"{rev}:{path}", check=False)
    return process.stdout.strip() if process.returncode == 0 else "-"


def manifest_rows(ctx: StateContext, before: str, after: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for item in changed_files(ctx.repo, before, after, (".",)):
        path = item["path"]
        rows.append(
            {
                "status": item["status"],
                "path": path,
                "stable_blob": blob_id(ctx.repo, before, path),
                "target_blob": blob_id(ctx.repo, after, path),
            }
        )
    return rows


def write_tsv(path: Path, rows: list[dict[str, str]]) -> None:
    headers = ("status", "path", "stable_blob", "target_blob")
    lines = ["\t".join(headers)]
    lines.extend("\t".join(row[key] for key in headers) for row in rows)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_candidate(ctx: StateContext, output: Path, timeout: int) -> dict[str, Any]:
    if ctx.problems or not ctx.candidate_commit:
        return {"status": "BLOCKED", "classification": D, "summary": "state validation failed"}
    temp_root = Path(tempfile.mkdtemp(prefix="filmos-candidate-"))
    worktree = temp_root / "source"
    log_path = output / "candidate-build.log"
    commands = [
        ("backend", ["go", "test", "./..."]),
        ("canvas-agent", ["bun", "install", "--frozen-lockfile"]),
        # Canvas Agent has cross-runtime tests that import Web source modules.
        # Install both dependency graphs before executing either native gate.
        ("web", ["bun", "install", "--frozen-lockfile"]),
        ("canvas-agent", ["bun", "run", "test"]),
        ("canvas-agent", ["bun", "run", "build"]),
        ("web", ["bun", "run", "build"]),
    ]
    logs: list[str] = []
    added = False
    try:
        git(ctx.repo, "worktree", "add", "--detach", str(worktree), ctx.candidate_commit)
        added = True
        for relative_cwd, command in commands:
            logs.append(f"$ (cd {relative_cwd} && {' '.join(command)})")
            process = run_process(command, cwd=worktree / relative_cwd, check=False, timeout=timeout)
            logs.append(process.stdout)
            logs.append(process.stderr)
            if process.returncode != 0:
                log_path.write_text("\n".join(logs), encoding="utf-8")
                return {
                    "status": "FAILED",
                    "classification": D,
                    "summary": f"candidate verification failed: {' '.join(command)}",
                    "log": str(log_path),
                }
        log_path.write_text("\n".join(logs), encoding="utf-8")
        return {"status": "PASSED", "classification": A, "summary": "candidate native tests and builds passed", "log": str(log_path)}
    except (CompatError, OSError, subprocess.TimeoutExpired) as exc:
        logs.append(str(exc))
        log_path.write_text("\n".join(logs), encoding="utf-8")
        return {"status": "FAILED", "classification": D, "summary": str(exc), "log": str(log_path)}
    finally:
        if added:
            git(ctx.repo, "worktree", "remove", "--force", str(worktree), check=False)
        shutil.rmtree(temp_root, ignore_errors=True)


def worst_classification(results: Iterable[dict[str, Any]]) -> str:
    return max((str(result["classification"]) for result in results), key=lambda item: RANK[item], default=A)


def summary_markdown(
    ctx: StateContext,
    checks: list[dict[str, Any]],
    overall: str,
    build: dict[str, Any],
    generated_at: str,
) -> str:
    lines = [
        "# FilmOS 上游兼容报告",
        "",
        f"- 生成时间：`{generated_at}`",
        f"- Stable：`{ctx.stable_ref}` → `{ctx.stable_commit}`",
        f"- Candidate：`{ctx.candidate_ref}` → `{ctx.candidate_commit}`",
        f"- Dev：`{ctx.dev_ref}` → `{ctx.dev_commit}`",
        f"- 总体判定：`{overall}`",
        f"- Candidate 原生验证：`{build['status']}`",
        "",
        "| 检查 | 分类 | 摘要 |",
        "| --- | --- | --- |",
    ]
    for item in checks:
        lines.append(f"| {item['check']} | `{item['classification']}` | {item['summary']} |")
    lines.extend(
        [
            "",
            "## 边界",
            "",
            "本报告仅做只读 Release/ref/diff/隔离 worktree 验证，不执行 merge、rebase、cherry-pick、push 或 release。",
            "`reference-tigerowo` 与 `reference-basket` 只列出 ref，不进入 Candidate 合并流程。",
            "",
            "## 回滚锚点",
            "",
            f"先运行 `scripts/upstream/rollback --dry-run`；确认工作树干净后，可显式切到固定提交 `{ctx.stable_commit}`。",
        ]
    )
    return "\n".join(lines) + "\n"


def run_compat(ctx: StateContext, args: argparse.Namespace) -> dict[str, Any]:
    output = Path(args.output).expanduser()
    if not output.is_absolute():
        output = ctx.repo / output
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    release = check_release(ctx, offline=args.offline, timeout=args.timeout, api_url=args.api_url)
    checks = [release] + [ANALYZERS[name](ctx, "candidate") for name in ("api", "models", "migrations", "canvas-schema", "mcp")]
    build = build_candidate(ctx, output, args.build_timeout) if args.build_candidate else {
        "status": "NOT_RUN",
        "classification": A,
        "summary": "pass --build-candidate to run isolated native verification",
    }
    overall = worst_classification([*checks, build])
    generated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    thin_patch = manifest_rows(ctx, ctx.stable_commit, ctx.dev_commit) if not ctx.problems and ctx.stable_commit and ctx.dev_commit else []
    upstream_changes = manifest_rows(ctx, ctx.stable_commit, ctx.candidate_commit) if not ctx.problems and ctx.stable_commit and ctx.candidate_commit else []
    payload = {
        "track": "00-upstream",
        "generated_at": generated_at,
        "classification": overall,
        "states": ctx.public(),
        "checks": checks,
        "candidate_build": build,
        "thin_patch_count": len(thin_patch),
        "upstream_change_count": len(upstream_changes),
        "output": str(output),
    }
    for item in checks:
        (output / f"{item['check']}.json").write_text(json.dumps(item, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    write_tsv(output / "thin-patch-manifest.tsv", thin_patch)
    write_tsv(output / "upstream-changes.tsv", upstream_changes)
    (output / "summary.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (output / "summary.md").write_text(summary_markdown(ctx, checks, overall, build, generated_at), encoding="utf-8")
    return payload


def text_result(result: dict[str, Any]) -> str:
    lines = [
        f"CHECK={result.get('check', 'run-compat')}",
        f"CLASSIFICATION={result['classification']}",
    ]
    states = result.get("states", {})
    for key in ("stable", "candidate", "dev"):
        state = states.get(key, {})
        if state:
            lines.append(f"{key.upper()}={state.get('ref')}@{state.get('commit')}")
    lines.append(f"SUMMARY={result.get('summary', result.get('output', ''))}")
    if result.get("output"):
        lines.append(f"REPORT_DIR={result['output']}")
    if result.get("added"):
        lines.append("ADDED=" + ",".join(result["added"]))
    if result.get("removed"):
        lines.append("REMOVED=" + ",".join(result["removed"]))
    if result.get("changed"):
        lines.append("CHANGED=" + ",".join(result["changed"]))
    return "\n".join(lines)


def emit(result: dict[str, Any], json_mode: bool) -> None:
    if json_mode:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(text_result(result))


def rollback(ctx: StateContext, args: argparse.Namespace) -> dict[str, Any]:
    result = base_result(ctx, "rollback", "candidate")
    dirty = bool(git(ctx.repo, "status", "--porcelain").stdout.strip())
    stable_problems = [item for item in ctx.problems if item.startswith("stable")]
    result.update(
        target=ctx.stable_commit,
        mode="branch" if args.branch else "detached",
        branch=args.branch,
        dirty_worktree=dirty,
        dry_run=args.dry_run,
    )
    if stable_problems:
        result["summary"] = "; ".join(stable_problems)
        return result
    if args.dry_run:
        result.update(
            classification=A,
            summary=(
                "dry-run only; execution would refuse a dirty worktree"
                if dirty
                else "dry-run passed; fixed Stable target is ready"
            ),
        )
        return result
    if dirty:
        result.update(classification=D, summary="rollback refused: worktree is not clean")
        return result
    assert ctx.stable_commit
    if args.branch:
        existing = git(ctx.repo, "show-ref", "--verify", f"refs/heads/{args.branch}", check=False)
        if existing.returncode == 0:
            result.update(classification=D, summary=f"rollback branch already exists: {args.branch}")
            return result
        git(ctx.repo, "switch", "-c", args.branch, ctx.stable_commit)
    else:
        git(ctx.repo, "switch", "--detach", ctx.stable_commit)
    result.update(classification=A, summary="switched to fixed Stable without moving an existing branch")
    return result


def add_common(parser: argparse.ArgumentParser, *, target: bool = False) -> None:
    parser.add_argument("--repo", help="repository path; defaults to the current Git worktree")
    parser.add_argument("--config", help=f"baseline config; defaults to {DEFAULT_CONFIG}")
    parser.add_argument("--candidate", help="Candidate ref; defaults to upstream-yingce/main")
    parser.add_argument("--dev", help="Dev ref; defaults to HEAD")
    parser.add_argument("--json", action="store_true", help="emit JSON")
    if target:
        parser.add_argument("--target", choices=("candidate", "dev"), default="candidate")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    subparsers = root.add_subparsers(dest="command", required=True)
    release = subparsers.add_parser("check-release", help="validate v1.2.1 and inspect the latest GitHub Release")
    add_common(release)
    release.add_argument("--offline", action="store_true", help="skip the Release API and validate local refs only")
    release.add_argument("--timeout", type=int, default=10)
    release.add_argument("--api-url", help="Release API override, primarily for deterministic tests")
    for command in ("diff-api", "diff-models", "diff-migrations", "diff-canvas-schema", "diff-mcp"):
        subparser = subparsers.add_parser(command)
        add_common(subparser, target=True)
    compat = subparsers.add_parser("run-compat", help="run all checks and write a compatibility report")
    add_common(compat)
    compat.add_argument("--offline", action="store_true")
    compat.add_argument("--timeout", type=int, default=10)
    compat.add_argument("--api-url")
    compat.add_argument("--output", default=".local/upstream-compat")
    compat.add_argument("--build-candidate", action="store_true", help="run native tests/builds in an isolated detached worktree")
    compat.add_argument("--build-timeout", type=int, default=1800, help="timeout in seconds for each candidate build command")
    compat.add_argument("--fail-on", choices=("never", A, B, C, D), default=D)
    rollback_parser = subparsers.add_parser("rollback", help="safely switch a clean worktree to the fixed Stable commit")
    add_common(rollback_parser)
    rollback_parser.add_argument("--dry-run", action="store_true")
    rollback_parser.add_argument("--branch", help="create this new branch at Stable instead of using detached HEAD")
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        ctx = resolve_context(args)
        if args.command == "check-release":
            result = check_release(ctx, offline=args.offline, timeout=args.timeout, api_url=args.api_url)
        elif args.command.startswith("diff-"):
            name = args.command.removeprefix("diff-")
            result = ANALYZERS[name](ctx, args.target)
        elif args.command == "run-compat":
            result = run_compat(ctx, args)
        elif args.command == "rollback":
            result = rollback(ctx, args)
        else:
            raise CompatError(f"unknown command: {args.command}")
        emit(result, args.json)
        if args.command == "run-compat":
            if args.fail_on == "never":
                return 0
            return 2 if RANK[result["classification"]] >= RANK[args.fail_on] else 0
        return 2 if result["classification"] == D else 0
    except (CompatError, OSError, subprocess.TimeoutExpired) as exc:
        print(f"upstream-compat: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
