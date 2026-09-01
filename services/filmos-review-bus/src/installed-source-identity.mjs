import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { problem, sha256 } from "./canonical.mjs";

export const INSTALLED_SOURCE_IDENTITY_SCHEMA = "filmos.installed-source-identity.v1";
const BUNDLE_SOURCE_SCHEMA = "1.0.0";
const INTERNAL_RUNTIME_SCHEMA = 4;
const OFFICIAL_REPOSITORY = "maiyadiu/filmos-studio";
const OFFICIAL_REMOTES = new Set([
  "https://github.com/maiyadiu/filmos-studio.git",
  "git@github.com:maiyadiu/filmos-studio.git",
]);

export function loadInstalledSourceIdentity({
  sourceIdentityPath,
  internalRuntimePath,
  repositoryLocatorPath,
  gitExecutable = "/usr/bin/git",
}) {
  const paths = [sourceIdentityPath, internalRuntimePath, repositoryLocatorPath];
  if (paths.some((value) => typeof value !== "string" || !isAbsolute(value) || !existsSync(value))) {
    throw problem("INSTALLED_SOURCE_IDENTITY_UNAVAILABLE", "INSTALLED_SOURCE_IDENTITY_UNAVAILABLE", 503);
  }
  if (basename(sourceIdentityPath) !== "SourceIdentity.json"
    || basename(internalRuntimePath) !== "InternalRuntime.json"
    || dirname(realpathSync(sourceIdentityPath)) !== dirname(realpathSync(internalRuntimePath))) {
    throw problem("INSTALLED_SOURCE_IDENTITY_MISMATCH", "INSTALLED_SOURCE_IDENTITY_MISMATCH", 503);
  }

  const source = readJson(sourceIdentityPath, "INSTALLED_SOURCE_IDENTITY_MISMATCH");
  const runtime = readJson(internalRuntimePath, "APP_RUNTIME_IDENTITY_MISMATCH");
  const locator = readJson(repositoryLocatorPath, "INSTALLED_SOURCE_IDENTITY_MISMATCH");
  validateSource(source);
  validateRuntime(runtime);
  validateLocator(locator);

  if (source.build_id !== runtime.build_id
    || source.git_commit_sha !== runtime.source_commit
    || source.git_tree_sha !== runtime.source_tree
    || source.source_fingerprint_sha256 !== runtime.source_fingerprint_sha256
    || source.repository !== runtime.source_repository
    || source.release_channel !== runtime.release_channel
    || source.external_paid_submit_enabled !== runtime.external_paid_submit_enabled) {
    throw problem("APP_RUNTIME_IDENTITY_MISMATCH", "APP_RUNTIME_IDENTITY_MISMATCH", 503);
  }
  if (source.repository !== locator.repository
    || source.git_commit_sha !== locator.source_commit
    || source.git_tree_sha !== locator.source_tree) {
    throw problem("INSTALLED_SOURCE_IDENTITY_MISMATCH", "INSTALLED_SOURCE_IDENTITY_MISMATCH", 503);
  }

  const repositoryPath = realpathSync(locator.source_repository);
  if (repositoryPath === "/" || resolve(repositoryPath) !== repositoryPath) {
    throw problem("INSTALLED_SOURCE_IDENTITY_MISMATCH", "INSTALLED_SOURCE_IDENTITY_MISMATCH", 503);
  }
  git(gitExecutable, repositoryPath, ["cat-file", "-e", `${source.git_commit_sha}^{commit}`], "SOURCE_COMMIT_NOT_FOUND");
  const actualTree = git(gitExecutable, repositoryPath, ["rev-parse", `${source.git_commit_sha}^{tree}`], "SOURCE_COMMIT_NOT_FOUND");
  if (actualTree !== source.git_tree_sha) throw problem("SOURCE_TREE_MISMATCH", "SOURCE_TREE_MISMATCH", 503);
  const fetchRemote = git(gitExecutable, repositoryPath, ["remote", "get-url", "origin"], "INSTALLED_SOURCE_IDENTITY_MISMATCH");
  const pushRemote = git(gitExecutable, repositoryPath, ["remote", "get-url", "--push", "origin"], "INSTALLED_SOURCE_IDENTITY_MISMATCH");
  if (!OFFICIAL_REMOTES.has(fetchRemote) || !OFFICIAL_REMOTES.has(pushRemote)) {
    throw problem("INSTALLED_SOURCE_IDENTITY_MISMATCH", "INSTALLED_SOURCE_IDENTITY_MISMATCH", 503);
  }

  const identity = {
    schema_version: INSTALLED_SOURCE_IDENTITY_SCHEMA,
    source_identity_schema: source.schema_version,
    internal_runtime_schema: runtime.schema_version,
    build_id: source.build_id,
    release_channel: source.release_channel,
    repository: source.repository,
    commit: source.git_commit_sha,
    tree: source.git_tree_sha,
    source_fingerprint_sha256: source.source_fingerprint_sha256,
    source_file_count: source.source_file_count,
    source_clean: source.source_clean,
    external_paid_submit_enabled: source.external_paid_submit_enabled,
  };
  return Object.freeze({ ...identity, content_hash: sha256(identity) });
}

function validateSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema_version !== BUNDLE_SOURCE_SCHEMA
    || value.repository !== OFFICIAL_REPOSITORY
    || !/^[a-f0-9]{40,64}$/.test(String(value.git_commit_sha ?? ""))
    || !/^[a-f0-9]{40,64}$/.test(String(value.git_tree_sha ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(value.source_fingerprint_sha256 ?? ""))
    || !Number.isInteger(value.source_file_count) || value.source_file_count < 1
    || !Array.isArray(value.source_scopes) || value.source_scopes.length < 1 || value.source_scopes.some((item) => typeof item !== "string" || !item)
    || value.source_clean !== true
    || !/^[A-Za-z0-9._-]{1,160}$/.test(String(value.build_id ?? ""))
    || !["development", "candidate", "pilot", "stable"].includes(value.release_channel)
    || typeof value.external_paid_submit_enabled !== "boolean") {
    throw problem("INSTALLED_SOURCE_IDENTITY_MISMATCH", "INSTALLED_SOURCE_IDENTITY_MISMATCH", 503);
  }
}

function validateRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema_version !== INTERNAL_RUNTIME_SCHEMA
    || value.source_repository !== OFFICIAL_REPOSITORY
    || !/^[a-f0-9]{40,64}$/.test(String(value.source_commit ?? ""))
    || !/^[a-f0-9]{40,64}$/.test(String(value.source_tree ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(value.source_fingerprint_sha256 ?? ""))
    || !/^[A-Za-z0-9._-]{1,160}$/.test(String(value.build_id ?? ""))) {
    throw problem("APP_RUNTIME_IDENTITY_MISMATCH", "APP_RUNTIME_IDENTITY_MISMATCH", 503);
  }
}

function validateLocator(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema_version !== "1.0.0"
    || value.repository !== OFFICIAL_REPOSITORY
    || typeof value.source_repository !== "string" || !isAbsolute(value.source_repository)
    || !existsSync(value.source_repository)
    || !/^[a-f0-9]{40,64}$/.test(String(value.source_commit ?? ""))
    || !/^[a-f0-9]{40,64}$/.test(String(value.source_tree ?? ""))) {
    throw problem("INSTALLED_SOURCE_IDENTITY_MISMATCH", "INSTALLED_SOURCE_IDENTITY_MISMATCH", 503);
  }
}

function readJson(path, code) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw problem(code, code, 503);
  }
}

function git(executable, repository, args, errorCode) {
  const result = spawnSync(executable, ["-C", repository, ...args], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw problem(errorCode, errorCode, 503);
  return result.stdout.trim();
}
