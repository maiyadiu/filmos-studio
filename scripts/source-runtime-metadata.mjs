#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [sourceRootInput, resourcesInput] = process.argv.slice(2);
if (!sourceRootInput || !resourcesInput) {
  throw new Error("usage: source-runtime-metadata <source-root> <resources-directory>");
}
const sourceRoot = resolve(sourceRootInput);
const resources = resolve(resourcesInput);
const runtimePath = resolve(resources, "InternalRuntime.json");
const identityPath = resolve(resources, "SourceIdentity.json");
const sourceIdentity = JSON.parse(execFileSync(
  resolve(sourceRoot, "desktop/macos/scripts/source-fingerprint"),
  ["--json"],
  { cwd: sourceRoot, encoding: "utf8" },
));
const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
const buildID = `development-${sourceIdentity.git_commit_sha.slice(0, 8)}-${sourceIdentity.source_fingerprint_sha256.slice(0, 8)}`;

Object.assign(runtime, {
  schema_version: 4,
  release_channel: "development",
  build_id: buildID,
  external_paid_submit_enabled: false,
  source_commit: sourceIdentity.git_commit_sha,
  source_tree: sourceIdentity.git_tree_sha,
  source_fingerprint_sha256: sourceIdentity.source_fingerprint_sha256,
  source_repository: "maiyadiu/filmos-studio",
  review_bus_health_url: "http://127.0.0.1:17920/healthz",
  review_bus_issue_url: "http://127.0.0.1:17920/v1/issues",
});
Object.assign(sourceIdentity, {
  build_id: buildID,
  release_channel: "development",
  external_paid_submit_enabled: false,
  repository: "maiyadiu/filmos-studio",
});

atomicJSON(runtimePath, runtime);
atomicJSON(identityPath, sourceIdentity);
process.stdout.write(`${JSON.stringify({
  mode: "source-host",
  build_id: buildID,
  commit: sourceIdentity.git_commit_sha,
  tree: sourceIdentity.git_tree_sha,
  source_clean: sourceIdentity.source_clean,
})}\n`);

function atomicJSON(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}
