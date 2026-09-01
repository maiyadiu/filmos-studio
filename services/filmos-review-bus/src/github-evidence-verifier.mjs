import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createWriteStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "./canonical.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_REPOSITORY = "maiyadiu/filmos-studio";
const HANDOFF_ARCHIVE_PATTERN = /^FilmOS_V1_1_Dual_Expert_Operational_Closure_Handoff_[0-9a-f]{8,64}\.zip$/;
const defaultReadArtifactEvidenceIndex = (...args) => readArtifactEvidenceIndex(...args);

export class GitHubEvidenceVerifier {
  constructor({
    repository = process.env.FILMOS_REVIEW_GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY,
    apiJson = defaultApiJson,
    downloadArtifact = defaultDownloadArtifact,
    readArtifactEvidenceIndex = defaultReadArtifactEvidenceIndex,
    now = () => new Date(),
  } = {}) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw evidenceProblem("INVALID_GITHUB_REPOSITORY");
    this.repository = repository;
    this.apiJson = apiJson;
    this.downloadArtifact = downloadArtifact;
    this.readArtifactEvidenceIndex = readArtifactEvidenceIndex;
    this.now = now;
  }

  async verify(candidate) {
    validateCandidateRequest(candidate);
    const repository = this.repository;
    let archive;
    try {
      const [commit, branch, run, artifact] = await Promise.all([
        this.apiJson(`/repos/${repository}/git/commits/${candidate.candidate_commit}`),
        this.apiJson(`/repos/${repository}/branches/${encodeURIComponent(candidate.branch)}`),
        this.apiJson(`/repos/${repository}/actions/runs/${candidate.github_run.id}`),
        this.apiJson(`/repos/${repository}/actions/artifacts/${candidate.artifact_id}`),
      ]);
      archive = await this.downloadArtifact(repository, candidate.artifact_id);
      const evidenceBytes = await this.readArtifactEvidenceIndex(archive);
      const evidenceIndexHash = createHash("sha256").update(evidenceBytes).digest("hex");
      const checks = {
        commit_exists: commit?.sha === candidate.candidate_commit,
        tree_matches: commit?.tree?.sha === candidate.tree,
        branch_exists: typeof branch?.commit?.sha === "string",
        run_exists: String(run?.id) === String(candidate.github_run.id),
        run_head_matches: run?.head_sha === candidate.candidate_commit,
        run_success: run?.conclusion === "success",
        artifact_exists: String(artifact?.id) === String(candidate.artifact_id) && artifact?.expired !== true,
        artifact_run_matches: !artifact?.workflow_run?.head_sha || artifact.workflow_run.head_sha === candidate.candidate_commit,
        artifact_digest_matches: artifact?.digest === candidate.artifact_digest,
        evidence_index_present: evidenceBytes.length > 0,
        evidence_index_hash_matches: evidenceIndexHash === candidate.evidence_index_hash,
      };
      const failed = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
      if (failed.length) throw evidenceProblem("GITHUB_REMOTE_EVIDENCE_MISMATCH", failed.join(","));
      const receipt = {
        schema_version: "filmos.github-evidence-verification.v1",
        status: "VERIFIED",
        repository,
        candidate_commit: candidate.candidate_commit,
        candidate_tree: candidate.tree,
        branch: candidate.branch,
        github_run_id: String(candidate.github_run.id),
        artifact_id: String(candidate.artifact_id),
        artifact_digest: candidate.artifact_digest,
        evidence_index_hash: evidenceIndexHash,
        checks,
        verified_at: this.now().toISOString(),
      };
      return { ...receipt, content_hash: sha256(receipt) };
    } catch (error) {
      if (error?.code === "GITHUB_REMOTE_EVIDENCE_MISMATCH") throw error;
      throw evidenceProblem("GITHUB_EVIDENCE_REQUIRED", String(error?.message ?? error));
    } finally {
      archive?.cleanup?.();
    }
  }
}

function validateCandidateRequest(candidate) {
  if (!candidate || !/^[0-9a-f]{40,64}$/.test(candidate.candidate_commit ?? "") || !/^[0-9a-f]{40,64}$/.test(candidate.tree ?? "")) throw evidenceProblem("INVALID_CANDIDATE_GIT_BINDING");
  if (!candidate.branch || !candidate.github_run?.id || !candidate.artifact_id || !/^sha256:[0-9a-f]{64}$/.test(candidate.artifact_digest ?? "") || !/^[0-9a-f]{64}$/.test(candidate.evidence_index_hash ?? "")) throw evidenceProblem("GITHUB_EVIDENCE_REQUIRED");
}

async function defaultApiJson(endpoint) {
  const { stdout } = await execFileAsync(resolveGitHubCLI(), ["api", endpoint], { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function defaultDownloadArtifact(repository, artifactId) {
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-github-artifact-"));
  const path = resolve(directory, "artifact.zip");
  try {
    await spawnToFile(resolveGitHubCLI(), ["api", "-H", "Accept: application/vnd.github+json", `/repos/${repository}/actions/artifacts/${artifactId}/zip`], path);
    return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function resolveGitHubCLI(environment = process.env) {
  const candidates = [
    environment.FILMOS_GH_EXECUTABLE,
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the explicit, bounded install locations.
    }
  }
  return "gh";
}

export async function readHandoffEvidenceIndex(archive) {
  if (!archive?.path) throw evidenceProblem("ARTIFACT_ARCHIVE_REQUIRED");
  const outerEntries = await zipEntries(archive.path);
  const handoffEntries = outerEntries.filter((entry) => HANDOFF_ARCHIVE_PATTERN.test(entry));
  if (handoffEntries.length === 0) throw evidenceProblem("ARTIFACT_HANDOFF_MISSING");
  if (handoffEntries.length !== 1) throw evidenceProblem("ARTIFACT_HANDOFF_AMBIGUOUS");

  const handoffEntry = handoffEntries[0];
  const handoffStem = handoffEntry.slice(0, -4);
  const directory = mkdtempSync(resolve(tmpdir(), "filmos-handoff-artifact-"));
  const handoffPath = resolve(directory, "handoff.zip");
  try {
    await spawnToFile("unzip", ["-p", archive.path, handoffEntry], handoffPath);
    const nestedEntries = await zipEntries(handoffPath);
    const evidenceEntries = nestedEntries.filter((entry) => entry === "EVIDENCE_INDEX.json" || entry.endsWith("/EVIDENCE_INDEX.json"));
    if (evidenceEntries.length === 0) throw evidenceProblem("ARTIFACT_EVIDENCE_INDEX_MISSING");
    if (evidenceEntries.length !== 1) throw evidenceProblem("ARTIFACT_EVIDENCE_INDEX_AMBIGUOUS");
    const evidenceEntry = evidenceEntries[0];
    if (evidenceEntry !== `${handoffStem}/EVIDENCE_INDEX.json`) throw evidenceProblem("ARTIFACT_EVIDENCE_INDEX_INVALID_NESTING");
    const { stdout: bytes } = await execFileAsync("unzip", ["-p", handoffPath, evidenceEntry], { encoding: null, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    if (!bytes.length) throw evidenceProblem("ARTIFACT_EVIDENCE_INDEX_MISSING");
    return Buffer.from(bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function readArtifactEvidenceIndex(archive) {
  if (!archive?.path) throw evidenceProblem("ARTIFACT_ARCHIVE_REQUIRED");
  const outerEntries = await zipEntries(archive.path);
  const handoffEntries = outerEntries.filter((entry) => HANDOFF_ARCHIVE_PATTERN.test(entry));
  if (handoffEntries.length > 1) throw evidenceProblem("ARTIFACT_HANDOFF_AMBIGUOUS");
  if (handoffEntries.length === 1) return readHandoffEvidenceIndex(archive);

  const evidenceEntries = outerEntries.filter((entry) => entry === "EVIDENCE_INDEX.json" || entry.endsWith("/EVIDENCE_INDEX.json"));
  if (evidenceEntries.length === 0) throw evidenceProblem("ARTIFACT_EVIDENCE_INDEX_MISSING");
  if (evidenceEntries.length !== 1) throw evidenceProblem("ARTIFACT_EVIDENCE_INDEX_AMBIGUOUS");
  if (evidenceEntries[0] !== "EVIDENCE_INDEX.json") throw evidenceProblem("ARTIFACT_EVIDENCE_INDEX_INVALID_NESTING");
  const { stdout: bytes } = await execFileAsync("unzip", ["-p", archive.path, "EVIDENCE_INDEX.json"], { encoding: null, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  if (!bytes.length) throw evidenceProblem("ARTIFACT_EVIDENCE_INDEX_MISSING");
  return Buffer.from(bytes);
}

async function zipEntries(path) {
  const { stdout } = await execFileAsync("unzip", ["-Z1", path], { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split(/\r?\n/).filter(Boolean);
}

function spawnToFile(command, args, outputPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const output = createWriteStream(outputPath, { mode: 0o600 });
    const errors = [];
    let childClosed = false;
    let outputFinished = false;
    let exitCode = null;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const complete = () => {
      if (settled || !childClosed || !outputFinished) return;
      if (exitCode === 0) {
        settled = true;
        resolvePromise();
      } else {
        fail(new Error(`gh artifact download failed (${exitCode}): ${Buffer.concat(errors).toString("utf8").slice(0, 1000)}`));
      }
    };
    child.stderr.on("data", (chunk) => { if (errors.reduce((sum, item) => sum + item.length, 0) < 16_384) errors.push(chunk); });
    child.stdout.pipe(output);
    child.once("error", fail);
    output.once("error", fail);
    output.once("finish", () => { outputFinished = true; complete(); });
    child.once("close", (code) => {
      exitCode = code;
      childClosed = true;
      complete();
    });
  });
}

function evidenceProblem(code, detail = code) {
  return Object.assign(new Error(detail), { code, status: code === "GITHUB_EVIDENCE_REQUIRED" ? 503 : 409 });
}
