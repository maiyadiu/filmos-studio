import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

import { problem } from "./canonical.mjs";

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export class GitHubEvidenceVerifier {
  constructor({ repository = "maiyadiu/filmos-studio", token = "", fetchImpl = fetch, now = () => new Date() } = {}) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("INVALID_GITHUB_REPOSITORY");
    this.repository = repository;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async verify(candidate) {
    if (!this.token) throw problem("GITHUB_EVIDENCE_TOKEN_REQUIRED");
    const commitPath = `/repos/${this.repository}/git/commits/${candidate.candidate_commit}`;
    const branchPath = `/repos/${this.repository}/commits/${encodeURIComponent(candidate.branch)}`;
    const runPath = `/repos/${this.repository}/actions/runs/${encodeURIComponent(String(candidate.github_run.id))}`;
    const artifactPath = `/repos/${this.repository}/actions/artifacts/${encodeURIComponent(String(candidate.artifact_id))}`;
    const [commit, branch, run, artifact] = await Promise.all([
      this.#json(commitPath), this.#json(branchPath), this.#json(runPath), this.#json(artifactPath),
    ]);

    assertEqual(commit.sha, candidate.candidate_commit, "GIT_COMMIT_MISMATCH");
    assertEqual(commit.tree?.sha, candidate.tree, "GIT_TREE_MISMATCH");
    assertEqual(branch.sha, candidate.candidate_commit, "GIT_BRANCH_HEAD_MISMATCH");
    assertEqual(branch.commit?.tree?.sha, candidate.tree, "GIT_BRANCH_TREE_MISMATCH");
    assertEqual(String(run.id), String(candidate.github_run.id), "GITHUB_RUN_ID_MISMATCH");
    assertEqual(run.head_sha, candidate.candidate_commit, "GITHUB_RUN_COMMIT_MISMATCH");
    assertEqual(run.head_branch, candidate.branch, "GITHUB_RUN_BRANCH_MISMATCH");
    if (run.status !== "completed" || run.conclusion !== "success") throw problem("GITHUB_RUN_NOT_SUCCESSFUL");
    assertEqual(String(artifact.id), String(candidate.artifact_id), "ARTIFACT_ID_MISMATCH");
    if (artifact.expired === true) throw problem("ARTIFACT_EXPIRED");
    assertEqual(artifact.digest, candidate.artifact_digest, "ARTIFACT_DIGEST_MISMATCH");
    if (artifact.workflow_run?.id != null) assertEqual(String(artifact.workflow_run.id), String(run.id), "ARTIFACT_RUN_MISMATCH");
    if (artifact.workflow_run?.head_sha) assertEqual(artifact.workflow_run.head_sha, candidate.candidate_commit, "ARTIFACT_COMMIT_MISMATCH");

    const archiveResponse = await this.#request(artifact.archive_download_url);
    const archive = await readResponseBytes(archiveResponse, MAX_ARTIFACT_BYTES);
    assertEqual(`sha256:${digest(archive)}`, candidate.artifact_digest, "ARTIFACT_DOWNLOAD_DIGEST_MISMATCH");
    const releaseManifestBytes = extractUniqueZipEntry(archive, "RELEASE_MANIFEST.json", MAX_MANIFEST_BYTES);
    let releaseManifest;
    try { releaseManifest = JSON.parse(releaseManifestBytes.toString("utf8")); }
    catch { throw problem("RELEASE_MANIFEST_INVALID"); }
    assertEqual(releaseManifest.repository, this.repository, "RELEASE_REPOSITORY_MISMATCH");
    assertEqual(releaseManifest.git_commit_sha, candidate.candidate_commit, "RELEASE_COMMIT_MISMATCH");
    assertEqual(releaseManifest.git_tree_sha, candidate.tree, "RELEASE_TREE_MISMATCH");
    assertEqual(releaseManifest.evidence_index_hash, candidate.evidence_index_hash, "EVIDENCE_INDEX_HASH_MISMATCH");

    return {
      verified: true,
      repository: this.repository,
      candidate_commit: candidate.candidate_commit,
      tree: candidate.tree,
      branch: candidate.branch,
      github_run_id: String(run.id),
      github_run_conclusion: run.conclusion,
      artifact_id: String(artifact.id),
      artifact_digest: artifact.digest,
      artifact_commit: releaseManifest.git_commit_sha,
      evidence_index_hash: releaseManifest.evidence_index_hash,
      release_manifest_sha256: digest(releaseManifestBytes),
      checked_at: this.now().toISOString(),
    };
  }

  async #json(path) {
    const response = await this.#request(`https://api.github.com${path}`);
    try { return await response.json(); }
    catch { throw problem("GITHUB_EVIDENCE_INVALID_JSON"); }
  }

  async #request(url) {
    let response;
    try {
      response = await this.fetchImpl(url, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${this.token}`, "x-github-api-version": "2022-11-28" }, redirect: "follow" });
    } catch { throw problem("GITHUB_EVIDENCE_UNAVAILABLE"); }
    if (!response.ok) throw problem(`GITHUB_EVIDENCE_HTTP_${response.status}`);
    return response;
  }
}

function assertEqual(actual, expected, code) {
  if (actual !== expected) throw problem(code);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readResponseBytes(response, maximum) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximum) throw problem("ARTIFACT_TOO_LARGE");
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) throw problem("ARTIFACT_TOO_LARGE");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function extractUniqueZipEntry(archive, expectedName, maximum) {
  const entries = zipEntries(archive).filter((entry) => entry.name === expectedName || entry.name.endsWith(`/${expectedName}`));
  if (entries.length !== 1) throw problem("RELEASE_MANIFEST_NOT_UNIQUE");
  const entry = entries[0];
  if (entry.uncompressedSize > maximum) throw problem("RELEASE_MANIFEST_TOO_LARGE");
  if (archive.readUInt32LE(entry.localOffset) !== 0x04034b50) throw problem("ARTIFACT_ZIP_INVALID");
  const nameLength = archive.readUInt16LE(entry.localOffset + 26);
  const extraLength = archive.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = archive.subarray(start, start + entry.compressedSize);
  const bytes = entry.compression === 0 ? compressed : entry.compression === 8 ? inflateRawSync(compressed) : null;
  if (!bytes || bytes.length !== entry.uncompressedSize || bytes.length > maximum) throw problem("ARTIFACT_ZIP_INVALID");
  return Buffer.from(bytes);
}

function zipEntries(archive) {
  const minimum = Math.max(0, archive.length - 65_557);
  let end = -1;
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw problem("ARTIFACT_ZIP_INVALID");
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw problem("ARTIFACT_ZIP_INVALID");
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    entries.push({
      name,
      compression: archive.readUInt16LE(offset + 10),
      compressedSize: archive.readUInt32LE(offset + 20),
      uncompressedSize: archive.readUInt32LE(offset + 24),
      localOffset: archive.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
