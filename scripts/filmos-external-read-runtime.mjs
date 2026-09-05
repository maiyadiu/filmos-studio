#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SOURCE_ROOT = resolve(import.meta.dirname, "..");
export const RUNTIME_ROOT = resolve(SOURCE_ROOT, ".local/phase7-external-read-runtime");
const HOME = homedir();
export const FIXED_REVIEW_CONVERSATION_ID = "6a96a0f4-e1ac-83ea-979d-7d8c7a3bcc9e";

export const PHASE7 = Object.freeze({
  projectId: "ca40511be3ae12112101cc1de6059b95",
  contentUnitId: "ce98682e1b393b6b8a44e723af15a9a2",
  canvasId: "W6zs8YXqjVugG605nahMR",
  canvasStateHash: "4ba073b2877375a4738efcd9bfe33cae88b03418a89bdc3eac50c730b5f02e88",
  issueId: "FILMOS-ARCH-b3274782-30a0-44a1-a05e-01730678da8b",
  connectorAppId: "asdk_app_6a94061977d88191a953af5367cc42b5",
  connectorVersionId: "asdk_app_v_6a94061977e08191a9aadd6e474cefcd",
  tunnelId: "tunnel_6a924668e7048191a1e52bcf801a946e",
  connectionId: "chatgpt.subscription.host",
  hostProfileId: "chatgpt.subscription.host.pro_readonly",
  templatePath: resolve(SOURCE_ROOT, ".local/phase6-chatgpt-assessment/ChatGPT盲审包.md"),
  templateSha256: "bf635ba60056ead9b33dce766c2ff3502506d23dc64fcf8114b4190c99456c8f",
  legacySource: Object.freeze({
    commit: "7f64703b85cdb9a076ee40b9d5df2a004dc917d2",
    tree: "0b30e674bd50be4d5a370ead52617ffc21818d93",
    fingerprint: "06601b4a277fb7fc2fbfeda7f8750ee9d1a7902062b24ec8150c87faf98fca24",
    buildId: "development-7f64703b-06601b4a",
  }),
});

const REVIEW_BUS_PENDING_BOUNDARY = Object.freeze([
  Object.freeze({ issueId: "FILMOS-ARCH-b3274782-30a0-44a1-a05e-01730678da8b", state: "ARCHITECTURE_ASSESSMENTS_PENDING", entityVersion: 125, contentHash: "ba7b958f555d723bc0c4a679f3b5d104435015af4f5b53c0833aa1c180f04cae" }),
  Object.freeze({ issueId: "FILMOS-ISSUE-final-build-id-binding-v8-20260901", state: "DUAL_APPROVED", entityVersion: 152, contentHash: "5278980ffb26addeedb2edbb4e57b556ff52e26427a15b0cfb41754347f68e14" }),
  Object.freeze({ issueId: "FILMOS-ISSUE-final-candidate-intake-v7-20260901", state: "DUAL_APPROVED", entityVersion: 155, contentHash: "febda7810c50c617d707ac2cc2c9d389a4b2ffe13655737ed7ebb6e9245b98c1" }),
  Object.freeze({ issueId: "FILMOS-ISSUE-final-project-scope-v5-20260901", state: "EVIDENCE_FROZEN", entityVersion: 144, contentHash: "a3e5bba0f239209e2ed6755685a7797af886300ad4a1f74272de05fe9a93a4a8" }),
  Object.freeze({ issueId: "FILMOS-ISSUE-final-project-scope-v6-20260901", state: "TASK_PACKAGE_FROZEN", entityVersion: 1504, contentHash: "e48be830be33c0662a094a99b38903d0db793798ebd99b6ff5ebb13aa43d14b6" }),
]);
const REVIEW_BUS_PENDING_SUMMARY_SHA256 = "d6ac890757b44e57e93f093506a819f6ade90d1ee7f9af91057f8b58f7d29361";
const REVIEW_BUS_RECEIPT_KEYS_SHA256 = "46a037f9500d7fb637dac87050f5bb611b693ab9ca136e16362e47980d335efc";

const PATHS = Object.freeze({
  app: resolve(HOME, "Applications/FilmOS Studio.app"),
  sourceHost: resolve(SOURCE_ROOT, ".local/source-host"),
  appSupport: resolve(HOME, "Library/Application Support/FilmOS Studio"),
  preferences: resolve(HOME, "Library/Preferences/com.filmos.studio.localbeta.plist"),
  cloudflaredHome: resolve(HOME, ".cloudflared"),
  reviewBusDir: resolve(HOME, "Library/Application Support/FilmOS Studio/review-bus"),
  reviewBusDatabase: resolve(HOME, "Library/Application Support/FilmOS Studio/review-bus/review-bus.sqlite"),
  reviewBusToken: resolve(HOME, "Library/Application Support/FilmOS Studio/review-bus/review-bus.token"),
  filmCoreDatabase: resolve(HOME, "Library/Application Support/FilmOS Studio/ChatGPTConnection/FilmCore/film-core.sqlite"),
  tunnelArchive: resolve(SOURCE_ROOT, ".local/final-external-gates/bdec33ce/chatgpt-handoff-external/tunnel-client-download/tunnel-client-v0.0.13-darwin-arm64.zip"),
  acceptancePython: resolve(SOURCE_ROOT, ".local/acceptance-venv/bin/python"),
});

const EXECUTABLES = Object.freeze({
  node: { path: "/opt/homebrew/Cellar/node/26.3.0/bin/node", sha256: "56694c81b093cc8da273fa017cf91765b3653e5f64f16727976ffaa87b2b6b31" },
  python: { path: "/Library/Frameworks/Python.framework/Versions/3.14/bin/python3.14", sha256: "50298e5fa54e018a9950794d4625a82ba7f2b04a6ef272dc4d26f89a2176072b" },
  env: { path: "/usr/bin/env", sha256: "75690864f0e7397db05bcc0f4439915559ce24c2d834d530e4e619c14b938556" },
  git: { path: "/usr/bin/git", sha256: "b8763cf250e607a778bb4603cecb5b90338814d0a3dfcba0d57b1de242f610e9" },
  ditto: { path: "/usr/bin/ditto", sha256: "638df9b6d1454be2405dbc3c69c28ac75405bb5b21c9e878166be92f8b3a1c4d" },
  security: { path: "/usr/bin/security", sha256: "c69fd64c27c9de883cbb3e9cdcb218205626e471eacf8cf24ccb98a6cc710983" },
  plutil: { path: "/usr/bin/plutil", sha256: "3d4086a77e9bc2eb3eab7dc707ff844a8949b78c80daa2ffaa2e643e022c1c2f" },
  ps: { path: "/bin/ps", sha256: "3bbba882e30d91fc4ff6e6844ca7c59fef4351b9a3fea35dca55708d6d487d1c" },
  lsof: { path: "/usr/sbin/lsof", sha256: "b1b9151bbc56f4749890dbe4e533af9a4f8700240ad431a6c9ddf70fe137c165" },
});

const HELPERS = Object.freeze({
  profile: { path: resolve(SOURCE_ROOT, "scripts/agent_runtime_profile.py"), sha256: "08cdd1f2ce3cfb5b1338fde9c875ee44e834fe27dc81acb73c2da134c8517191" },
  metadata: { path: resolve(SOURCE_ROOT, "scripts/source-runtime-metadata.mjs"), sha256: "dd58959366905ec76d66dfadc1cbda8290b86e3f21ec7d77ef566b5c41d3eec3" },
  fingerprint: { path: resolve(SOURCE_ROOT, "desktop/macos/scripts/source-fingerprint"), sha256: "72ed0b6f9c1f8310c8117b4ea93fde094e278dea1ca139da1b782e7468c68adc" },
  tsc: { path: resolve(SOURCE_ROOT, "services/filmos-chatgpt-app/node_modules/typescript/lib/tsc.js"), sha256: "cbdfbf11c26ed00dfc073155e316a42d6d6d8a387be61006b82fa9aa93ac572e" },
  widget: { path: resolve(SOURCE_ROOT, "services/filmos-chatgpt-app/scripts/build-widget.mjs"), sha256: "a84788b08acd9f30887a5ba0fc1e0bbdf79346d384a1d7e98093d4374221d5d2" },
  widgetSource: { path: resolve(SOURCE_ROOT, "services/filmos-chatgpt-app/src/widget-runtime.ts"), sha256: "a7a8b0e6dcb2b676a9413e6767b5c5861306bf33ef3d6ad82f2b043271acb172" },
  esbuild: { path: resolve(SOURCE_ROOT, "services/filmos-chatgpt-app/node_modules/@esbuild/darwin-arm64/bin/esbuild"), sha256: "921b19d2a6e983de6aa861582476e4f983c8509cb40c462e572ce64ca1bcb5be" },
});

const PACKAGE_PINS = Object.freeze({
  "services/filmos-chatgpt-app/package-lock.json": "6b16648219df4aadfc0324d861ea2fe4c3486d559c4860a7c624fd6004df8c71",
  "packages/filmos-tool-contracts/package-lock.json": "cff181e459cfd35e943d84c038531656d0f07541344771461adbe9dec9d316ed",
  "services/filmos-chatgpt-app/package.json": "b8b07c9bf8fea01b3395fde7171a0eb25fda97d33f3b128f840cd6b23eede4ff",
  "packages/filmos-tool-contracts/package.json": "04f152de537c3df5c90b8d938a0a701917852a3c14aa28c834ac6913af2f3007",
  "services/filmos-chatgpt-app/tsconfig.json": "ac138850696ef43dc03f518479dcd36aa959afd682dcff7ec46e08c439cf1462",
  "packages/filmos-tool-contracts/tsconfig.json": "5dd25fbad00aea30442e2967bf01757c89c090b8169fd61174ae1989ae9a4751",
});

const GENERATED_WIDGET_SHA256 = "094be64d394c9ed3f6b200d0f1131268835f8385779537125c2fc2d2dd4db00b";
const TUNNEL_ARCHIVE_SHA256 = "15abf165f06050af642c948ba6bd6c905191dc5420a9422dadde2b49d892e2c6";
const TUNNEL_PAYLOADS = Object.freeze({
  "tunnel-client": { sha256: "814b5e7ad378e6dfeb7eeebf12df37ff879cfe58fd504769cabfc3e3b4cf99f6", executable: true },
  cloudflared: { sha256: "4cf6ca3f4dde4266cd5a61c55f3fe4d8e752914e9d6187a10bd0daf80d0440a1", executable: true },
  "cloudflared-manifest.json": { sha256: "80003d8a8f38d6a0bd74aabc096e9f99a6e8fad8ed4da699e26a8231fa453aa1", executable: false },
  LICENSE: { sha256: "f4c1d7ba32ef5bcf5cf03e2eefec5825ebafedf50fa330a36700a49c605c1ef4", executable: false },
  NOTICE: { sha256: "1364c020d86ecf948b78b7c655175032068203d13aece70fb0bfe112d7802dc2", executable: false },
  "tunnel-client-v0.0.13-darwin-arm64-licenses.txt": { sha256: "43fe622ebdd5fc5813415f5c7c8fb0ef0d7d551fa3383c66d04779aeb7906ef5", executable: false },
  "tunnel-client-v0.0.13-darwin-arm64.spdx.json": { sha256: "da101d06ef91c559dc3f8c586219bab9f05381a8f3daddcba7163a9208410f4e", executable: false },
});

const DATABASE_BASELINES = Object.freeze({
  reviewBus: {
    main: { device: 16777234, inode: 101926348, size: 12910592, sha256: "81f74d8692c03f688fa42683620ccdc70a4f9ad53644482690c9992dde2a65a2" },
    wal: { device: 16777234, inode: 101926350, size: 2212472, sha256: "e4a3ecf55b99ba5e354178e90d166fbf369a33bd3547109ba30fc7122721830a" },
    shm: { device: 16777234, inode: 101926351, size: 32768, sha256: "f42991894ef415450fc2eff57b432dd8d522aac4a6d609f71e9267de1030bd5d" },
  },
  filmCore: {
    main: { device: 16777234, inode: 98502137, size: 368640, sha256: "5756128081ed9e410ee58558cab2560d4dd235fa4b644dc8e9d3417ee983a47f" },
    wal: { device: 16777234, inode: 106184316, size: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    shm: { device: 16777234, inode: 106184317, size: 32768, sha256: "fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb" },
  },
});

const PORTS = [43100, 43101, 17371, 17650, 17840, 17920];
const KEYCHAIN = { service: "com.filmos.studio.openai-mcp-tunnel", account: "runtime-key" };
const MINIMAL_PATH_DIRECTORIES = Object.freeze([
  dirname(PATHS.acceptancePython),
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
]);
const PREFERENCE_KEYS = [
  "filmos.chatgpt.host.connection.v2",
  "filmos.chatgpt.host.project-session.v2",
  "filmos.chatgpt.host.workbench-context.v1",
];
export const EXTERNAL_TOOL_ORDER = Object.freeze([
  "issue_list_pending",
  "issue_get_codex_assessment_blind",
  "issue_get_evidence",
  "issue_get_constitution",
  "filmos_get_project_context",
  "filmos_get_live_workbench_context",
  "filmos_get_blockers",
]);
const AUDIT_ORDER = Object.freeze([
  "handoff.live_context.publish",
  "filmos_get_live_workbench_context",
  "filmos_get_blockers",
  "filmos_get_live_workbench_context",
  ...EXTERNAL_TOOL_ORDER,
]);
export const WIDGET_PREBUILD_LINK_NAMES = Object.freeze([
  "esbuild",
  "@modelcontextprotocol",
  "zod",
]);
export const RUNNER_DIRECT_TRANSIENT_ORDER = Object.freeze([
  "source-gate-before-branch",
  "source-gate-before-identity",
  "source-gate-before-status",
  "source-gate-before-ahead-behind",
  "lsof-pre-start",
  "agent-runtime-profile",
  "source-runtime-metadata",
  "widget-generated-input",
  "typescript-tool-contracts",
  "typescript-chatgpt-app",
  "tunnel-extraction",
  "preferences-before",
  "keychain-metadata-before",
  "keychain-secret-once",
  "tunnel-doctor",
  "lsof-ready",
  "ps-ready",
  "source-gate-after-branch",
  "source-gate-after-identity",
  "source-gate-after-status",
  "source-gate-after-ahead-behind",
  "source-fingerprint-after",
  "preferences-after",
  "keychain-metadata-after",
  "lsof-post-stop",
  "ps-post-stop",
]);
export const TRANSIENT_PROCESS_BUDGET = Object.freeze({
  runner_direct: 26,
  source_metadata_fingerprint: 1,
  source_fingerprint_nested_git: 10,
  widget_esbuild: 1,
  review_bus_startup_subtree: 14,
  tunnel_doctor_cloudflared_min: 0,
  tunnel_doctor_cloudflared_max: 1,
  total_min: 52,
  total_max: 53,
  source_fingerprint_total: 3,
  git_total: 31,
});
const SOURCE_NAMES = Object.freeze([
  "audit.ts", "canonical.ts", "chatgpt-auth.ts", "compatibility.ts", "data-source.ts", "doctor.ts",
  "generated-review-contract.ts", "grant-cli.ts", "grants.ts", "host-context.ts", "mcp.ts", "media.ts",
  "proposal-preview.ts", "proposal.ts", "review-mcp.ts", "review-source.ts", "security.ts", "server.ts",
  "tunnel.ts", "widget-model.ts", "widget-runtime.ts", "widgets.ts",
]);
let transientInvocationIndex = 0;

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolveRead, rejectRead) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectRead);
    stream.on("end", resolveRead);
  });
  return hash.digest("hex");
}

function isWithin(path, root) {
  const value = relative(root, path);
  return value === "" || (value !== ".." && !value.startsWith(".." + sep) && !isAbsolute(value));
}

export function assertSourceIndependentPath(path) {
  const absolute = resolve(path);
  invariant(!isWithin(absolute, PATHS.app), "APP_PATH_FORBIDDEN");
  invariant(!isWithin(absolute, PATHS.sourceHost), "SOURCE_HOST_PATH_FORBIDDEN");
  return absolute;
}

function runtimePath(path) {
  const absolute = resolve(path);
  invariant(absolute !== RUNTIME_ROOT && isWithin(absolute, RUNTIME_ROOT), "RUNTIME_PATH_ESCAPE");
  return absolute;
}

async function regularFile(path, expectedHash = null) {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), "REGULAR_FILE_REQUIRED:" + absolute);
  invariant(await realpath(absolute) === absolute, "CANONICAL_FILE_REQUIRED:" + absolute);
  const digest = await sha256File(absolute);
  if (expectedHash) invariant(digest === expectedHash, "FILE_HASH_MISMATCH:" + absolute);
  return { path: absolute, sha256: digest, size: metadata.size, mode: metadata.mode & 0o777 };
}

async function executable(spec) {
  const value = await regularFile(spec.path, spec.sha256);
  invariant((value.mode & 0o111) !== 0, "EXECUTABLE_REQUIRED:" + value.path);
  return value;
}

async function venvPython() {
  for (const name of ["python", "python3", "python3.14"]) {
    const path = resolve(dirname(PATHS.acceptancePython), name);
    const metadata = await lstat(path);
    invariant(metadata.isFile() || metadata.isSymbolicLink(), "ACCEPTANCE_PYTHON_REQUIRED:" + name);
    invariant(await realpath(path) === EXECUTABLES.python.path, "ACCEPTANCE_PYTHON_REALPATH_DRIFT:" + name);
  }
  await executable(EXECUTABLES.python);
  invariant(await resolveMinimalCommand("python3") === EXECUTABLES.python.path, "MINIMAL_PATH_PYTHON_DRIFT");
  invariant(await resolveMinimalCommand("git") === EXECUTABLES.git.path, "MINIMAL_PATH_GIT_DRIFT");
  return PATHS.acceptancePython;
}

async function resolveMinimalCommand(name) {
  for (const directory of MINIMAL_PATH_DIRECTORIES) {
    const path = resolve(directory, name);
    try {
      const metadata = await lstat(path);
      if ((metadata.isFile() || metadata.isSymbolicLink()) && (metadata.mode & 0o111) !== 0) return realpath(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("MINIMAL_PATH_COMMAND_MISSING:" + name);
}

async function atomicWrite(path, bytes, mode = 0o600) {
  const absolute = runtimePath(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = absolute + ".tmp-" + process.pid + "-" + randomUUID();
  await writeFile(temporary, bytes, { mode, flag: "wx" });
  await rename(temporary, absolute);
  await chmod(absolute, mode);
}

async function atomicJSON(path, value) {
  await atomicWrite(path, JSON.stringify(value, null, 2) + "\n");
}

function redactArg(value) {
  const text = String(value);
  if (/^(?:Bearer\s|fg_|proof_)/i.test(text)) return "[REDACTED]";
  return text;
}

function minimalEnvironment(extra = {}) {
  invariant(HOME === "/Users/apple", "UNEXPECTED_HOME");
  return {
    HOME,
    PATH: MINIMAL_PATH_DIRECTORIES.join(":"),
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TMPDIR: resolve(RUNTIME_ROOT, "tmp"),
    XDG_CACHE_HOME: resolve(RUNTIME_ROOT, "cache"),
    XDG_CONFIG_HOME: resolve(RUNTIME_ROOT, "config"),
    XDG_DATA_HOME: resolve(RUNTIME_ROOT, "data"),
    PYTHONPYCACHEPREFIX: resolve(RUNTIME_ROOT, "cache/python"),
    NO_PROXY: "127.0.0.1,localhost,::1",
    ...extra,
  };
}

async function appendTransient(value) {
  await appendFile(resolve(RUNTIME_ROOT, "transient-processes.jsonl"), JSON.stringify(value) + "\n", { mode: 0o600 });
}

async function runAudited(options) {
  const invocationIndex = ++transientInvocationIndex;
  const identity = options.expectedExecutable ? await executable(options.expectedExecutable) : await regularFile(options.executable);
  invariant(resolve(options.executable) === identity.path, "EXECUTABLE_PATH_MISMATCH:" + options.label);
  if (options.expectedScript) {
    assertSourceIndependentPath(options.expectedScript.path);
    await regularFile(options.expectedScript.path, options.expectedScript.sha256);
  }
  assertSourceIndependentPath(identity.path);
  assertSourceIndependentPath(resolve(options.cwd || SOURCE_ROOT));
  for (const arg of options.args || []) if (isAbsolute(String(arg))) assertSourceIndependentPath(String(arg));
  await appendTransient({
    schema_version: "filmos.phase7.transient-process.v1",
    phase: "start",
    invocation_index: invocationIndex,
    parent_pid: process.pid,
    label: options.label,
    started_at: new Date().toISOString(),
    executable: identity.path,
    executable_sha256: identity.sha256,
    argv: (options.args || []).map(redactArg),
    cwd: options.cwd || SOURCE_ROOT,
    sensitive_output: options.sensitiveOutput === true,
  });
  const child = spawn(identity.path, options.args || [], {
    cwd: options.cwd || SOURCE_ROOT,
    env: options.env || minimalEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  const capture = (target) => (chunk) => {
    bytes += chunk.byteLength;
    if (bytes > 32 * 1024 * 1024) child.kill("SIGKILL");
    target.push(Buffer.from(chunk));
  };
  child.stdout.on("data", capture(stdout));
  child.stderr.on("data", capture(stderr));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs || 120000);
  const result = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (status, signal) => resolveExit({ status, signal }));
  }).finally(() => clearTimeout(timer));
  const stdoutBytes = Buffer.concat(stdout);
  const stderrBytes = Buffer.concat(stderr);
  await appendTransient({
    schema_version: "filmos.phase7.transient-process.v1",
    phase: "exit",
    invocation_index: invocationIndex,
    parent_pid: process.pid,
    label: options.label,
    exited_at: new Date().toISOString(),
    pid: child.pid,
    status: result.status,
    signal: result.signal,
    timed_out: timedOut,
    stdout_bytes: options.sensitiveOutput ? "SUPPRESSED" : stdoutBytes.length,
    stderr_bytes: options.sensitiveOutput ? "SUPPRESSED" : stderrBytes.length,
    stdout_sha256: options.sensitiveOutput ? null : sha256(stdoutBytes),
    stderr_sha256: options.sensitiveOutput ? null : sha256(stderrBytes),
  });
  invariant(!timedOut && (options.allowStatuses || [0]).includes(result.status), "TRANSIENT_FAILED:" + options.label);
  return { stdout: stdoutBytes, stderr: stderrBytes, status: result.status, pid: child.pid };
}

function validIsoTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

export function transientExecutableSpec(label) {
  if (label.startsWith("source-gate-")) return EXECUTABLES.git;
  if (label.startsWith("lsof-")) return EXECUTABLES.lsof;
  if (label.startsWith("preferences-")) return EXECUTABLES.plutil;
  if (label.startsWith("keychain-")) return EXECUTABLES.security;
  if (label.startsWith("ps-")) return EXECUTABLES.ps;
  if (["agent-runtime-profile", "source-fingerprint-after"].includes(label)) return EXECUTABLES.python;
  if (["source-runtime-metadata", "widget-generated-input", "typescript-tool-contracts", "typescript-chatgpt-app"].includes(label)) return EXECUTABLES.node;
  if (label === "tunnel-extraction") return EXECUTABLES.ditto;
  if (label === "tunnel-doctor") {
    return { path: resolve(RUNTIME_ROOT, "Tunnel/tunnel-client"), sha256: TUNNEL_PAYLOADS["tunnel-client"].sha256 };
  }
  throw new Error("TRANSIENT_EXECUTABLE_SPEC_MISSING:" + label);
}

export function validateTransientRecords(records, parentPid = process.pid) {
  invariant(Array.isArray(records), "TRANSIENT_RECORDS_ARRAY_REQUIRED");
  invariant(records.length === RUNNER_DIRECT_TRANSIENT_ORDER.length * 2, "TRANSIENT_RECORD_COUNT_MISMATCH");
  invariant(Number.isSafeInteger(parentPid) && parentPid > 0, "TRANSIENT_PARENT_PID_INVALID");
  for (const [offset, label] of RUNNER_DIRECT_TRANSIENT_ORDER.entries()) {
    const invocationIndex = offset + 1;
    const start = records[offset * 2];
    const exit = records[offset * 2 + 1];
    invariant(start?.schema_version === "filmos.phase7.transient-process.v1" && exit?.schema_version === start.schema_version, "TRANSIENT_SCHEMA_MISMATCH:" + label);
    invariant(start.phase === "start" && exit.phase === "exit", "TRANSIENT_PHASE_PAIR_MISMATCH:" + label);
    invariant(start.label === label && exit.label === label, "TRANSIENT_LABEL_ORDER_MISMATCH:" + label);
    invariant(start.invocation_index === invocationIndex && exit.invocation_index === invocationIndex, "TRANSIENT_INVOCATION_INDEX_MISMATCH:" + label);
    invariant(start.parent_pid === parentPid && exit.parent_pid === parentPid, "TRANSIENT_PARENT_PID_MISMATCH:" + label);
    invariant(validIsoTimestamp(start.started_at) && validIsoTimestamp(exit.exited_at), "TRANSIENT_TIMESTAMP_INVALID:" + label);
    invariant(Date.parse(exit.exited_at) >= Date.parse(start.started_at), "TRANSIENT_TIME_ORDER_INVALID:" + label);
    invariant(typeof start.executable === "string" && isAbsolute(start.executable), "TRANSIENT_EXECUTABLE_INVALID:" + label);
    const expectedExecutable = transientExecutableSpec(label);
    invariant(start.executable === expectedExecutable.path, "TRANSIENT_EXECUTABLE_PATH_MISMATCH:" + label);
    invariant(start.executable_sha256 === expectedExecutable.sha256, "TRANSIENT_EXECUTABLE_HASH_MISMATCH:" + label);
    invariant(Array.isArray(start.argv) && typeof start.cwd === "string" && isAbsolute(start.cwd), "TRANSIENT_COMMAND_INVALID:" + label);
    invariant(Number.isSafeInteger(exit.pid) && exit.pid > 0, "TRANSIENT_PID_INVALID:" + label);
    invariant(exit.timed_out === false && exit.signal === null, "TRANSIENT_ABNORMAL_EXIT:" + label);
    const allowedStatuses = label.startsWith("lsof-") ? [0, 1] : [0];
    invariant(allowedStatuses.includes(exit.status), "TRANSIENT_STATUS_INVALID:" + label);
    const sensitive = label === "keychain-secret-once";
    invariant(start.sensitive_output === sensitive, "TRANSIENT_SENSITIVITY_MISMATCH:" + label);
    if (sensitive) {
      invariant(exit.stdout_bytes === "SUPPRESSED" && exit.stderr_bytes === "SUPPRESSED", "TRANSIENT_SECRET_BYTE_COUNT_EXPOSED");
      invariant(exit.stdout_sha256 === null && exit.stderr_sha256 === null, "TRANSIENT_SECRET_HASH_EXPOSED");
    } else {
      invariant(Number.isSafeInteger(exit.stdout_bytes) && exit.stdout_bytes >= 0, "TRANSIENT_STDOUT_SIZE_INVALID:" + label);
      invariant(Number.isSafeInteger(exit.stderr_bytes) && exit.stderr_bytes >= 0, "TRANSIENT_STDERR_SIZE_INVALID:" + label);
      invariant(/^[0-9a-f]{64}$/.test(String(exit.stdout_sha256 || "")), "TRANSIENT_STDOUT_HASH_INVALID:" + label);
      invariant(/^[0-9a-f]{64}$/.test(String(exit.stderr_sha256 || "")), "TRANSIENT_STDERR_HASH_INVALID:" + label);
    }
  }
  invariant(RUNNER_DIRECT_TRANSIENT_ORDER.length === TRANSIENT_PROCESS_BUDGET.runner_direct, "TRANSIENT_DIRECT_BUDGET_DRIFT");
  return {
    schema_version: "filmos.phase7.transient-process-summary.v1",
    evidence_standard: "PINNED_CODE_PLUS_READY_POST_ZERO_SURVIVORS_ACCEPTED",
    runner_direct_invocation_count: RUNNER_DIRECT_TRANSIENT_ORDER.length,
    runner_direct_record_count: records.length,
    runner_direct_order: [...RUNNER_DIRECT_TRANSIENT_ORDER],
    total_transient_process_invocations: `${TRANSIENT_PROCESS_BUDGET.total_min}..${TRANSIENT_PROCESS_BUDGET.total_max}`,
    total_source_fingerprint_invocations: TRANSIENT_PROCESS_BUDGET.source_fingerprint_total,
    total_git_invocations: TRANSIENT_PROCESS_BUDGET.git_total,
  };
}

function sourceSection(source, startMarker, endMarker, code) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  invariant(start >= 0 && end > start, code);
  return source.slice(start, end);
}

function matchCount(source, pattern) {
  return (source.match(pattern) || []).length;
}

export async function validateNestedProcessDerivation() {
  await venvPython();
  const serverPath = resolve(SOURCE_ROOT, "services/filmos-review-bus/src/server.mjs");
  const installedPath = resolve(SOURCE_ROOT, "services/filmos-review-bus/src/installed-source-identity.mjs");
  const files = {
    source_runtime_metadata: await regularFile(HELPERS.metadata.path, HELPERS.metadata.sha256),
    source_fingerprint: await regularFile(HELPERS.fingerprint.path, HELPERS.fingerprint.sha256),
    widget_builder: await regularFile(HELPERS.widget.path, HELPERS.widget.sha256),
    esbuild: await regularFile(HELPERS.esbuild.path, HELPERS.esbuild.sha256),
    nested_python: await executable(EXECUTABLES.python),
    nested_git: await executable(EXECUTABLES.git),
    shebang_env: await executable(EXECUTABLES.env),
    review_bus_server: await regularFile(serverPath),
    installed_source_identity: await regularFile(installedPath),
  };
  const [metadataSource, fingerprintSource, widgetSource, reviewBusSource, installedSource] = await Promise.all([
    readFile(files.source_runtime_metadata.path, "utf8"),
    readFile(files.source_fingerprint.path, "utf8"),
    readFile(files.widget_builder.path, "utf8"),
    readFile(files.review_bus_server.path, "utf8"),
    readFile(files.installed_source_identity.path, "utf8"),
  ]);

  invariant(matchCount(metadataSource, /\bexecFileSync\s*\(/g) === 1, "SOURCE_METADATA_FINGERPRINT_PROCESS_COUNT_DRIFT");
  invariant(metadataSource.includes('resolve(sourceRoot, "desktop/macos/scripts/source-fingerprint")'), "SOURCE_METADATA_FINGERPRINT_TARGET_DRIFT");
  invariant(matchCount(fingerprintSource, /\bsubprocess\.run\s*\(/g) === 2, "SOURCE_FINGERPRINT_SUBPROCESS_HELPER_DRIFT");
  const sourcePathsSection = sourceSection(fingerprintSource, "def source_paths()", "def fingerprint(", "SOURCE_FINGERPRINT_SOURCE_PATHS_SECTION_MISSING");
  const fingerprintMain = sourceSection(fingerprintSource, "def main()", 'if __name__ == "__main__"', "SOURCE_FINGERPRINT_MAIN_SECTION_MISSING");
  invariant(matchCount(sourcePathsSection, /\blisted_items\s*\(/g) === 1, "SOURCE_FINGERPRINT_TRACKED_LIST_COUNT_DRIFT");
  invariant(matchCount(fingerprintMain, /\bsource_paths\s*\(/g) === 1, "SOURCE_FINGERPRINT_SOURCE_PATH_CALL_COUNT_DRIFT");
  invariant(matchCount(fingerprintMain, /\blisted_items\s*\(/g) === 1, "SOURCE_FINGERPRINT_UNTRACKED_LIST_COUNT_DRIFT");
  invariant(matchCount(fingerprintMain, /\bgit\s*\(/g) === 3, "SOURCE_FINGERPRINT_GIT_CALL_COUNT_DRIFT");
  invariant(matchCount(widgetSource, /\bawait\s+build\s*\(/g) === 1, "WIDGET_ESBUILD_CALL_COUNT_DRIFT");

  const installedLoad = sourceSection(installedSource, "export function loadInstalledSourceIdentity", "function validateSource", "INSTALLED_SOURCE_IDENTITY_SECTION_MISSING");
  const installedGit = sourceSection(installedSource, "function git(", "}", "INSTALLED_SOURCE_IDENTITY_GIT_HELPER_MISSING");
  invariant(matchCount(installedLoad, /\bgit\s*\(/g) === 4, "INSTALLED_SOURCE_IDENTITY_GIT_COUNT_DRIFT");
  invariant(matchCount(installedGit, /\bspawnSync\s*\(/g) === 1, "INSTALLED_SOURCE_IDENTITY_GIT_SPAWN_DRIFT");

  const sealLoad = sourceSection(reviewBusSource, "export function loadSealSourceIdentity", "export function startFromEnvironment", "REVIEW_BUS_SEAL_IDENTITY_SECTION_MISSING");
  invariant(matchCount(sealLoad, /\bloadInstalledSourceIdentity\s*\(/g) === 1, "REVIEW_BUS_INSTALLED_IDENTITY_CALL_COUNT_DRIFT");
  invariant(matchCount(sealLoad, /\brunGit\s*\(/g) === 4, "REVIEW_BUS_DIRECT_GIT_COUNT_DRIFT");
  invariant(matchCount(sealLoad, /\bspawnSync\s*\(fingerprintExecutable/g) === 1, "REVIEW_BUS_FINGERPRINT_PROCESS_COUNT_DRIFT");

  const fingerprintGitPerInvocation = 5;
  const reviewBusGit = 4 + 4 + fingerprintGitPerInvocation;
  const reviewBusSubtree = reviewBusGit + 1;
  const sourceFingerprintTotal = 3;
  const totalGit = 8 + (2 * fingerprintGitPerInvocation) + reviewBusGit;
  const totalMin = RUNNER_DIRECT_TRANSIENT_ORDER.length + 1 + (2 * fingerprintGitPerInvocation) + 1 + reviewBusSubtree;
  const totalMax = totalMin + 1;
  invariant(reviewBusSubtree === TRANSIENT_PROCESS_BUDGET.review_bus_startup_subtree, "REVIEW_BUS_TRANSIENT_SUBTREE_BUDGET_DRIFT");
  invariant(sourceFingerprintTotal === TRANSIENT_PROCESS_BUDGET.source_fingerprint_total, "SOURCE_FINGERPRINT_TOTAL_BUDGET_DRIFT");
  invariant(totalGit === TRANSIENT_PROCESS_BUDGET.git_total, "TRANSIENT_GIT_TOTAL_BUDGET_DRIFT");
  invariant(totalMin === TRANSIENT_PROCESS_BUDGET.total_min && totalMax === TRANSIENT_PROCESS_BUDGET.total_max, "TRANSIENT_TOTAL_BUDGET_DRIFT");
  return {
    schema_version: "filmos.phase7.nested-process-derivation.v1",
    evidence_standard: "PINNED_CODE_PLUS_READY_POST_ZERO_SURVIVORS_ACCEPTED",
    minimal_path_resolution: {
      python3: await resolveMinimalCommand("python3"),
      git: await resolveMinimalCommand("git"),
    },
    files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, {
      path: value.path,
      sha256: value.sha256,
      size: value.size,
      mode: value.mode,
    }])),
    runner_direct_invocations: RUNNER_DIRECT_TRANSIENT_ORDER.length,
    source_metadata_fingerprint_invocations: 1,
    source_fingerprint_git_invocations: 2 * fingerprintGitPerInvocation,
    widget_esbuild_child_invocations: 1,
    review_bus: {
      load_installed_source_identity_git_invocations: 4,
      direct_git_invocations: 4,
      source_fingerprint_invocations: 1,
      source_fingerprint_git_invocations: fingerprintGitPerInvocation,
      total_git_invocations: reviewBusGit,
      total_transient_subtree_invocations: reviewBusSubtree,
    },
    tunnel_doctor_cloudflared_child_invocations: "0..1",
    total_transient_process_invocations: `${totalMin}..${totalMax}`,
    total_source_fingerprint_invocations: sourceFingerprintTotal,
    total_git_invocations: totalGit,
  };
}

async function prepareRoot() {
  invariant(await realpath(SOURCE_ROOT) === SOURCE_ROOT, "SOURCE_ROOT_NOT_CANONICAL");
  const localRoot = resolve(SOURCE_ROOT, ".local");
  invariant((await lstat(localRoot)).isDirectory() && await realpath(localRoot) === localRoot, "LOCAL_ROOT_NOT_CANONICAL");
  try {
    await mkdir(RUNTIME_ROOT, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("PHASE7_RUNTIME_ROOT_ALREADY_EXISTS");
    throw error;
  }
  for (const name of ["Resources", "Build", "MCP", "tmp", "cache", "config", "data"]) {
    await mkdir(resolve(RUNTIME_ROOT, name), { mode: 0o700 });
  }
  await atomicWrite(resolve(RUNTIME_ROOT, "runner.pid"), String(process.pid) + "\n");
}

async function sourceGate(stage) {
  const common = { executable: EXECUTABLES.git.path, expectedExecutable: EXECUTABLES.git, cwd: SOURCE_ROOT };
  const branch = (await runAudited({ ...common, label: "source-gate-" + stage + "-branch", args: ["symbolic-ref", "--short", "HEAD"] })).stdout.toString().trim();
  const identity = (await runAudited({ ...common, label: "source-gate-" + stage + "-identity", args: ["rev-parse", "HEAD", "HEAD^{tree}", "refs/remotes/origin/integration"] })).stdout.toString().trim().split(/\r?\n/);
  const tracked = (await runAudited({ ...common, label: "source-gate-" + stage + "-status", args: ["status", "--porcelain=v1", "--untracked-files=no"] })).stdout.toString().trim();
  const counts = (await runAudited({ ...common, label: "source-gate-" + stage + "-ahead-behind", args: ["rev-list", "--left-right", "--count", "HEAD...refs/remotes/origin/integration"] })).stdout.toString().trim().split(/\s+/).map(Number);
  const value = { branch, head: identity[0], tree: identity[1], origin_integration: identity[2], tracked_status: tracked, ahead: counts[0], behind: counts[1] };
  invariant(branch === "integration", "SOURCE_BRANCH_DRIFT");
  invariant(value.head === value.origin_integration && value.ahead === 0 && value.behind === 0, "SOURCE_REMOTE_DRIFT");
  invariant(tracked === "", "TRACKED_SOURCE_DIRTY");
  return value;
}

async function physicalFile(path) {
  try {
    const metadata = await lstat(path);
    invariant(metadata.isFile() && !metadata.isSymbolicLink(), "PHYSICAL_FILE_REQUIRED:" + path);
    invariant(await realpath(path) === resolve(path), "PHYSICAL_FILE_NOT_CANONICAL:" + path);
    return {
      present: true,
      path: resolve(path),
      device: Number(metadata.dev),
      inode: Number(metadata.ino),
      size: metadata.size,
      mode: metadata.mode & 0o777,
      sha256: await sha256File(path),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, path: resolve(path) };
    throw error;
  }
}

function assertPhysical(actual, expected, label) {
  invariant(actual.present, label + "_MISSING");
  for (const key of ["device", "inode", "size", "sha256"]) {
    invariant(actual[key] === expected[key], label + "_" + key.toUpperCase() + "_DRIFT");
  }
}

async function snapshotTree(root, options = {}) {
  const absolute = resolve(root);
  const aggregate = createHash("sha256");
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;
  async function visit(path) {
    const rel = relative(absolute, path) || ".";
    if (rel !== "." && options.exclude?.(path, rel)) return;
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT" && rel === ".") return;
      throw error;
    }
    entryCount += 1;
    aggregate.update([rel, metadata.mode & 0o7777, Number(metadata.dev), Number(metadata.ino), metadata.size, metadata.mtimeMs].join("\0") + "\0");
    if (metadata.isSymbolicLink()) {
      aggregate.update("link\0" + await readlink(path) + "\0");
      return;
    }
    if (metadata.isFile()) {
      fileCount += 1;
      totalBytes += metadata.size;
      aggregate.update("file\0");
      if (options.hashContents !== false) aggregate.update(await sha256File(path));
      aggregate.update("\0");
      return;
    }
    invariant(metadata.isDirectory(), "UNSUPPORTED_SNAPSHOT_ENTRY:" + path);
    aggregate.update("dir\0");
    for (const name of (await readdir(path)).sort()) await visit(resolve(path, name));
  }
  await visit(absolute);
  return {
    path: absolute,
    present: entryCount > 0,
    entry_count: entryCount,
    file_count: fileCount,
    total_bytes: totalBytes,
    content_hashed: options.hashContents !== false,
    digest: aggregate.digest("hex"),
  };
}

async function productionSnapshot() {
  const connection = resolve(PATHS.appSupport, "ChatGPTConnection");
  const reviewDatabaseNames = new Set(["review-bus.sqlite", "review-bus.sqlite-wal", "review-bus.sqlite-shm"]);
  const filmCoreDatabaseFiles = new Set([
    PATHS.filmCoreDatabase,
    PATHS.filmCoreDatabase + "-wal",
    PATHS.filmCoreDatabase + "-shm",
  ].map((path) => resolve(path)));
  return {
    app_bundle_metadata: await snapshotTree(PATHS.app),
    source_host_metadata: await snapshotTree(PATHS.sourceHost),
    workbench_data: await snapshotTree(resolve(PATHS.appSupport, "WorkbenchData")),
    local_runtime: await snapshotTree(resolve(PATHS.appSupport, "LocalRuntime")),
    runtime: await snapshotTree(resolve(PATHS.appSupport, "Runtime")),
    development: await snapshotTree(resolve(PATHS.appSupport, "development")),
    developer_repository_metadata: await snapshotTree(resolve(PATHS.appSupport, "DeveloperRepository")),
    app_backups_metadata: await snapshotTree(resolve(PATHS.appSupport, "AppBackups")),
    user_backups_metadata: await snapshotTree(resolve(PATHS.appSupport, "UserDataBackups")),
    chatgpt_connection_other: await snapshotTree(connection, {
      exclude: (path) => filmCoreDatabaseFiles.has(resolve(path)),
    }),
    review_bus_other: await snapshotTree(PATHS.reviewBusDir, {
      exclude: (_path, rel) => reviewDatabaseNames.has(rel),
    }),
    cloudflared_home: await snapshotTree(PATHS.cloudflaredHome),
    preferences_file: await physicalFile(PATHS.preferences),
    review_bus: {
      main: await physicalFile(PATHS.reviewBusDatabase),
      wal: await physicalFile(PATHS.reviewBusDatabase + "-wal"),
      shm: await physicalFile(PATHS.reviewBusDatabase + "-shm"),
    },
    film_core: {
      main: await physicalFile(PATHS.filmCoreDatabase),
      wal: await physicalFile(PATHS.filmCoreDatabase + "-wal"),
      shm: await physicalFile(PATHS.filmCoreDatabase + "-shm"),
    },
  };
}

function normalizedSqliteValue(value) {
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (value instanceof Uint8Array) return { blob_sha256: sha256(value), size: value.byteLength };
  return value;
}

function normalizedSqliteRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizedSqliteValue(value)]));
}

function receiptKey(row) {
  return `${row.issue_id}|${row.consumer}|${row.tool_name}`;
}

function receiptKeySha256(rows) {
  const lines = [...rows].sort((left, right) => receiptKey(left).localeCompare(receiptKey(right)))
    .map(receiptKey).join("\n");
  return sha256(lines + (rows.length ? "\n" : ""));
}

function logicalTableSnapshot(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'review_read_receipts'
    ORDER BY name`).all().map((row) => row.name);
  const tableRows = {};
  const tableDigests = {};
  for (const table of tables) {
    invariant(/^[A-Za-z_][A-Za-z0-9_]*$/.test(table), "REVIEW_BUS_TABLE_NAME_INVALID");
    const rows = db.prepare(`SELECT * FROM "${table}"`).all()
      .map(normalizedSqliteRow)
      .map(canonicalJSON)
      .sort();
    tableRows[table] = rows.length;
    tableDigests[table] = sha256(rows.join("\n") + (rows.length ? "\n" : ""));
  }
  return {
    table_row_counts: tableRows,
    table_digests: tableDigests,
    sha256: sha256(canonicalJSON({ table_row_counts: tableRows, table_digests: tableDigests })),
  };
}

export function reviewBusFailureBoundarySnapshot(databasePath = PATHS.reviewBusDatabase) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    const projectionRows = db.prepare(`SELECT issue_id,project_id,state,lane,entity_version,document_json,content_hash,updated_at
      FROM review_projections WHERE project_id = ? ORDER BY issue_id`).all(PHASE7.projectId);
    const projectionSummaries = projectionRows.map((row) => {
      let document;
      try { document = JSON.parse(row.document_json); }
      catch { throw new Error("REVIEW_BUS_PROJECTION_DOCUMENT_INVALID:" + row.issue_id); }
      return {
        issue_id: row.issue_id,
        project_id: row.project_id,
        state: row.state,
        lane: row.lane,
        entity_version: Number(row.entity_version),
        content_hash: row.content_hash,
        document_sha256: sha256(row.document_json),
        document_content_hash: document.content_hash,
        evidence_manifest_hash: document.evidence?.manifest?.contentHash ?? document.evidence?.manifest?.content_hash ?? null,
        codex_slot: document.assessment_slots?.codex?.status ?? null,
        chatgpt_slot: document.assessment_slots?.chatgpt?.status ?? null,
      };
    });
    const eventRows = db.prepare(`SELECT event.sequence,event.event_id,event.issue_id,event.event_type,event.actor,
        event.payload_json,event.previous_hash,event.event_hash,event.created_at
      FROM review_events AS event
      INNER JOIN review_projections AS projection ON projection.issue_id = event.issue_id
      WHERE projection.project_id = ? ORDER BY event.sequence`).all(PHASE7.projectId);
    const eventSummaryByIssue = new Map(projectionSummaries.map((item) => [item.issue_id, {
      issue_id: item.issue_id,
      event_count: 0,
      last_event_sequence: null,
      last_event_hash: null,
    }]));
    for (const row of eventRows) {
      const summary = eventSummaryByIssue.get(row.issue_id);
      invariant(summary, "REVIEW_BUS_EVENT_OUTSIDE_PROJECT_BOUNDARY");
      summary.event_count += 1;
      summary.last_event_sequence = Number(row.sequence);
      summary.last_event_hash = row.event_hash;
    }
    const receiptRows = db.prepare(`SELECT issue_id,project_id,consumer,tool_name,projection_content_hash,evidence_manifest_hash,read_at
      FROM review_read_receipts ORDER BY issue_id,consumer,tool_name`).all().map(normalizedSqliteRow);
    const logical = logicalTableSnapshot(db);
    return {
      schema_version: "filmos.phase7.review-bus-failure-boundary.v1",
      project_id: PHASE7.projectId,
      non_receipt_tables_sha256: logical.sha256,
      non_receipt_table_row_counts: logical.table_row_counts,
      projection_rows_sha256: sha256(projectionRows.map(normalizedSqliteRow).map(canonicalJSON).join("\n") + (projectionRows.length ? "\n" : "")),
      event_rows_sha256: sha256(eventRows.map(normalizedSqliteRow).map(canonicalJSON).join("\n") + (eventRows.length ? "\n" : "")),
      project_projection_count: projectionRows.length,
      project_event_count: eventRows.length,
      projection_summaries: projectionSummaries,
      event_summaries: [...eventSummaryByIssue.values()],
      read_receipt_row_count: receiptRows.length,
      read_receipt_keys_sha256: receiptKeySha256(receiptRows),
      read_receipt_rows: receiptRows,
    };
  } finally {
    db.close();
  }
}

function assertFrozenReviewBusBoundary(snapshot) {
  invariant(snapshot?.schema_version === "filmos.phase7.review-bus-failure-boundary.v1", "REVIEW_BUS_FAILURE_BOUNDARY_SCHEMA_MISMATCH");
  invariant(snapshot.project_id === PHASE7.projectId, "REVIEW_BUS_FAILURE_PROJECT_MISMATCH");
  invariant(snapshot.project_projection_count === REVIEW_BUS_PENDING_BOUNDARY.length, "REVIEW_BUS_FAILURE_PROJECTION_COUNT_DRIFT");
  invariant(snapshot.projection_summaries?.length === REVIEW_BUS_PENDING_BOUNDARY.length, "REVIEW_BUS_FAILURE_PROJECTION_SUMMARY_DRIFT");
  const projections = [...snapshot.projection_summaries].sort((left, right) => left.issue_id.localeCompare(right.issue_id));
  const pendingLines = projections.map((projection, index) => {
    const expected = REVIEW_BUS_PENDING_BOUNDARY[index];
    invariant(
      projection.issue_id === expected.issueId
        && projection.project_id === PHASE7.projectId
        && projection.state === expected.state
        && projection.entity_version === expected.entityVersion
        && projection.content_hash === expected.contentHash
        && projection.document_content_hash === expected.contentHash,
      "REVIEW_BUS_FAILURE_PROJECTION_VERSION_DRIFT:" + String(projection.issue_id),
    );
    return `${projection.issue_id}|${projection.state}|${projection.entity_version}|${projection.content_hash}`;
  });
  invariant(sha256(pendingLines.join("\n") + "\n") === REVIEW_BUS_PENDING_SUMMARY_SHA256, "REVIEW_BUS_FAILURE_PENDING_SET_DRIFT");
  const targetProjection = projections.find((item) => item.issue_id === PHASE7.issueId);
  invariant(targetProjection?.codex_slot === "SEALED" && targetProjection?.chatgpt_slot === "EMPTY", "REVIEW_BUS_FAILURE_TARGET_SLOT_DRIFT");
  const events = new Map(snapshot.event_summaries?.map((item) => [item.issue_id, item]));
  invariant(events.size === REVIEW_BUS_PENDING_BOUNDARY.length, "REVIEW_BUS_FAILURE_EVENT_SUMMARY_DRIFT");
  for (const expected of REVIEW_BUS_PENDING_BOUNDARY) {
    const event = events.get(expected.issueId);
    invariant(event && event.event_count === expected.entityVersion, "REVIEW_BUS_FAILURE_EVENT_COUNT_DRIFT:" + expected.issueId);
  }
  const targetEvent = events.get(PHASE7.issueId);
  invariant(
    targetEvent.last_event_sequence === 12988
      && targetEvent.last_event_hash === "8650686aced0251fa8452164ed0cd5e649a17549a7cb2f73f13bdfda27aa47e7",
    "REVIEW_BUS_FAILURE_TARGET_EVENT_DRIFT",
  );
  invariant(snapshot.project_event_count === [...events.values()].reduce((sum, item) => sum + item.event_count, 0), "REVIEW_BUS_FAILURE_EVENT_TOTAL_DRIFT");
  invariant(snapshot.read_receipt_row_count === 6 && snapshot.read_receipt_rows?.length === 6, "REVIEW_BUS_FAILURE_RECEIPT_ROW_COUNT_DRIFT");
  invariant(snapshot.read_receipt_keys_sha256 === REVIEW_BUS_RECEIPT_KEYS_SHA256, "REVIEW_BUS_FAILURE_RECEIPT_KEY_SET_DRIFT");
  const allowedKeys = new Set([
    ...REVIEW_BUS_PENDING_BOUNDARY.map((item) => `${item.issueId}|chatgpt-mcp|issue_list_pending`),
    `${PHASE7.issueId}|chatgpt-mcp|issue_get_evidence`,
  ]);
  for (const row of snapshot.read_receipt_rows) {
    invariant(
      allowedKeys.has(receiptKey(row))
        && row.project_id === PHASE7.projectId
        && validIsoTimestamp(row.read_at),
      "REVIEW_BUS_FAILURE_RECEIPT_BOUNDARY_DRIFT",
    );
  }
  return { projections, events };
}

export function assertReviewBusFailurePreserved(before, after) {
  const beforeValidated = assertFrozenReviewBusBoundary(before);
  const afterValidated = assertFrozenReviewBusBoundary(after);
  invariant(before.non_receipt_tables_sha256 === after.non_receipt_tables_sha256, "REVIEW_BUS_FAILURE_NON_RECEIPT_TABLE_DRIFT");
  invariant(canonicalJSON(before.non_receipt_table_row_counts) === canonicalJSON(after.non_receipt_table_row_counts), "REVIEW_BUS_FAILURE_NON_RECEIPT_ROW_COUNT_DRIFT");
  invariant(before.projection_rows_sha256 === after.projection_rows_sha256, "REVIEW_BUS_FAILURE_PROJECTION_BYTES_DRIFT");
  invariant(before.event_rows_sha256 === after.event_rows_sha256, "REVIEW_BUS_FAILURE_EVENT_BYTES_DRIFT");
  invariant(canonicalJSON(before.event_summaries) === canonicalJSON(after.event_summaries), "REVIEW_BUS_FAILURE_EVENT_VERSION_DRIFT");
  const beforeReceipts = new Map(before.read_receipt_rows.map((row) => [receiptKey(row), row]));
  const projectionByIssue = new Map(afterValidated.projections.map((item) => [item.issue_id, item]));
  let changedReceiptRows = 0;
  for (const row of after.read_receipt_rows) {
    const prior = beforeReceipts.get(receiptKey(row));
    invariant(prior, "REVIEW_BUS_FAILURE_RECEIPT_KEY_SET_DRIFT");
    if (canonicalJSON(prior) === canonicalJSON(row)) continue;
    changedReceiptRows += 1;
    const projection = projectionByIssue.get(row.issue_id);
    invariant(
      projection
        && row.projection_content_hash === projection.content_hash
        && row.evidence_manifest_hash === projection.evidence_manifest_hash
        && Date.parse(row.read_at) >= Date.parse(prior.read_at),
      "REVIEW_BUS_FAILURE_RECEIPT_VALUE_DRIFT:" + receiptKey(row),
    );
  }
  invariant(changedReceiptRows <= 6, "REVIEW_BUS_FAILURE_RECEIPT_BUDGET_EXCEEDED");
  return {
    schema_version: "filmos.phase7.review-bus-failure-preservation.v1",
    target_projection_preserved: true,
    pending_projection_set_preserved: true,
    project_event_history_preserved: true,
    non_receipt_tables_preserved: true,
    read_receipt_row_count: after.read_receipt_row_count,
    read_receipt_keys_sha256: after.read_receipt_keys_sha256,
    changed_read_receipt_row_count: changedReceiptRows,
    permitted_read_receipt_row_change_limit: 6,
    before_sha256: sha256(canonicalJSON(before)),
    after_sha256: sha256(canonicalJSON(after)),
    event_summary_count: afterValidated.events.size,
  };
}

function immutableDigests(snapshot) {
  const keys = [
    "app_bundle_metadata", "source_host_metadata", "workbench_data", "local_runtime", "runtime", "development",
    "developer_repository_metadata", "app_backups_metadata", "user_backups_metadata", "chatgpt_connection_other",
    "review_bus_other", "cloudflared_home", "preferences_file",
  ];
  return Object.fromEntries(keys.map((key) => [key, snapshot[key]?.digest || snapshot[key]?.sha256 || null]));
}

export function assertProductionPreserved(before, after) {
  invariant(canonicalJSON(immutableDigests(before)) === canonicalJSON(immutableDigests(after)), "IMMUTABLE_PRODUCTION_SNAPSHOT_DRIFT");
  for (const key of ["device", "inode", "size", "sha256"]) {
    invariant(before.film_core.main[key] === after.film_core.main[key], "FILM_CORE_MAIN_" + key.toUpperCase() + "_DRIFT");
    invariant(before.film_core.wal[key] === after.film_core.wal[key], "FILM_CORE_WAL_" + key.toUpperCase() + "_DRIFT");
  }
  for (const key of ["present", "path", "device", "inode", "size"]) {
    invariant(before.film_core.shm[key] === after.film_core.shm[key], "FILM_CORE_SHM_" + key.toUpperCase() + "_DRIFT");
  }
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}

export function parsePreferencePlistXML(xml) {
  const values = {};
  for (const key of PREFERENCE_KEYS) {
    const pattern = "<key>" + escapeRegex(key) + "</key>\\s*<data>([\\s\\S]*?)</data>";
    const match = new RegExp(pattern).exec(xml);
    invariant(match, "PREFERENCE_KEY_MISSING:" + key);
    const decoded = JSON.parse(Buffer.from(match[1].replace(/\s/g, ""), "base64").toString("utf8"));
    if (key.endsWith("workbench-context.v1")) {
      invariant(typeof decoded.context === "string", "WORKBENCH_CONTEXT_ENCODING_INVALID");
      decoded.context = JSON.parse(Buffer.from(decoded.context, "base64").toString("utf8"));
    }
    values[key] = decoded;
  }
  return values;
}

export function validatePreferenceSnapshot(values) {
  const connection = values[PREFERENCE_KEYS[0]];
  const session = values[PREFERENCE_KEYS[1]];
  const saved = values[PREFERENCE_KEYS[2]];
  const context = saved?.context;
  invariant(connection?.autoConnect === true && connection?.tunnelID === PHASE7.tunnelId && connection?.connectionID === PHASE7.connectionId, "SAVED_CONNECTION_DRIFT");
  invariant(session?.projectID === PHASE7.projectId && session?.canvasID === PHASE7.canvasId, "SAVED_PROJECT_SESSION_DRIFT");
  invariant(saved?.projectID === PHASE7.projectId, "SAVED_WORKBENCH_PROJECT_DRIFT");
  invariant(context?.project_id === PHASE7.projectId, "SAVED_CONTEXT_PROJECT_DRIFT");
  invariant(context?.content_unit_id === PHASE7.contentUnitId, "SAVED_CONTENT_UNIT_DRIFT");
  invariant(context?.canvas_id === PHASE7.canvasId, "SAVED_CANVAS_DRIFT");
  invariant(context?.canvas_state_hash === PHASE7.canvasStateHash, "SAVED_CANVAS_HASH_DRIFT");
  return { connection, session, context };
}

async function preferenceSnapshot(stage) {
  const result = await runAudited({
    label: "preferences-" + stage,
    executable: EXECUTABLES.plutil.path,
    expectedExecutable: EXECUTABLES.plutil,
    args: ["-convert", "xml1", "-o", "-", PATHS.preferences],
  });
  const values = parsePreferencePlistXML(result.stdout.toString("utf8"));
  return {
    sha256: sha256(result.stdout),
    relevant_values_sha256: sha256(canonicalJSON(values)),
    values,
    validated: validatePreferenceSnapshot(values),
  };
}

async function keychainMetadata(stage) {
  const result = await runAudited({
    label: "keychain-metadata-" + stage,
    executable: EXECUTABLES.security.path,
    expectedExecutable: EXECUTABLES.security,
    args: ["find-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account],
  });
  const bytes = Buffer.concat([result.stdout, result.stderr]);
  invariant(bytes.length > 0, "KEYCHAIN_METADATA_EMPTY");
  return { sha256: sha256(bytes), size: bytes.length };
}

async function readRuntimeKeyOnce() {
  const result = await runAudited({
    label: "keychain-secret-once",
    executable: EXECUTABLES.security.path,
    expectedExecutable: EXECUTABLES.security,
    args: ["find-generic-password", "-s", KEYCHAIN.service, "-a", KEYCHAIN.account, "-w"],
    sensitiveOutput: true,
  });
  const value = result.stdout.toString("utf8").trim();
  invariant(value.length >= 24 && !/[\r\n]/.test(value), "TUNNEL_RUNTIME_KEY_INVALID");
  return value;
}

async function lsofAudit(stage, allowOutput) {
  const args = ["-nP", "+D", RUNTIME_ROOT, ...PORTS.map((port) => "-iTCP:" + port), "-sTCP:LISTEN"];
  const result = await runAudited({
    label: "lsof-" + stage,
    executable: EXECUTABLES.lsof.path,
    expectedExecutable: EXECUTABLES.lsof,
    args,
    allowStatuses: [0, 1],
    timeoutMs: 180000,
  });
  const output = result.stdout.toString("utf8").trim();
  if (!allowOutput) invariant(output === "", "STARTUP_PORT_OR_RUNTIME_ROOT_OCCUPIED");
  return output;
}

async function psAudit(stage) {
  const result = await runAudited({
    label: "ps-" + stage,
    executable: EXECUTABLES.ps.path,
    expectedExecutable: EXECUTABLES.ps,
    args: ["-axo", "pid=,ppid=,command="],
  });
  return result.stdout.toString().split(/\r?\n/).filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}

async function generateSourceIdentity(source) {
  const resources = resolve(RUNTIME_ROOT, "Resources");
  await venvPython();
  await executable(EXECUTABLES.python);
  await executable(EXECUTABLES.env);
  await executable(EXECUTABLES.git);
  await regularFile(HELPERS.fingerprint.path, HELPERS.fingerprint.sha256);
  await runAudited({
    label: "agent-runtime-profile",
    executable: EXECUTABLES.python.path,
    expectedExecutable: EXECUTABLES.python,
    expectedScript: HELPERS.profile,
    args: [
      HELPERS.profile.path, "runtime", "--profile", "filmos-candidate",
      "--output", resolve(resources, "InternalRuntime.json"),
      "--start-url", "http://127.0.0.1:43100/create",
      "--web-health-url", "http://127.0.0.1:43100/",
      "--backend-health-url", "http://127.0.0.1:43101/api/health",
      "--application-support-directory-name", "FilmOS Studio",
      "--backend-data-directory-name", "WorkbenchData",
    ],
  });
  await chmod(resolve(resources, "InternalRuntime.json"), 0o600);
  await runAudited({
    label: "source-runtime-metadata",
    executable: EXECUTABLES.node.path,
    expectedExecutable: EXECUTABLES.node,
    expectedScript: HELPERS.metadata,
    args: [HELPERS.metadata.path, SOURCE_ROOT, resources],
  });
  const identity = JSON.parse(await readFile(resolve(resources, "SourceIdentity.json"), "utf8"));
  invariant(identity.git_commit_sha === source.head && identity.git_tree_sha === source.tree, "GENERATED_SOURCE_IDENTITY_DRIFT");
  invariant(identity.source_clean === true && identity.release_channel === "development", "GENERATED_SOURCE_NOT_CLEAN");
  const expectedBuild = "development-" + source.head.slice(0, 8) + "-" + identity.source_fingerprint_sha256.slice(0, 8);
  invariant(identity.build_id === expectedBuild, "GENERATED_BUILD_ID_INVALID");
  return identity;
}

async function copyTracked(relativePath, destinationRoot, expectedHash = null) {
  const source = assertSourceIndependentPath(resolve(SOURCE_ROOT, relativePath));
  const identity = await regularFile(source, expectedHash);
  const destination = runtimePath(resolve(destinationRoot, relativePath));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, identity.mode);
  invariant(await sha256File(destination) === identity.sha256, "BUILD_INPUT_COPY_MISMATCH:" + relativePath);
  return { relative_path: relativePath, sha256: identity.sha256, size: identity.size, mode: identity.mode };
}

async function createExactLink(linkPath, targetPath) {
  const link = runtimePath(linkPath);
  const target = resolve(targetPath);
  assertSourceIndependentPath(target);
  const metadata = await lstat(target);
  invariant(!metadata.isSymbolicLink() && (metadata.isDirectory() || metadata.isFile()), "LINK_TARGET_INVALID:" + target);
  invariant(await realpath(target) === target, "LINK_TARGET_NOT_CANONICAL:" + target);
  await mkdir(dirname(link), { recursive: true, mode: 0o700 });
  await symlink(target, link, metadata.isDirectory() ? "dir" : "file");
  invariant(await realpath(link) === target, "LINK_REALPATH_MISMATCH:" + link);
  const snapshot = metadata.isDirectory() ? await snapshotTree(target) : await physicalFile(target);
  return { link: relative(RUNTIME_ROOT, link), target, target_digest: snapshot.digest || snapshot.sha256 };
}

async function buildFiles(root) {
  const values = [];
  async function visit(path) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return;
    if (metadata.isFile()) {
      values.push({ path: relative(RUNTIME_ROOT, path), sha256: await sha256File(path), size: metadata.size, mode: metadata.mode & 0o777 });
      return;
    }
    invariant(metadata.isDirectory(), "BUILD_OUTPUT_ENTRY_INVALID:" + path);
    for (const name of (await readdir(path)).sort()) await visit(resolve(path, name));
  }
  await visit(root);
  return values;
}


async function buildIsolatedMcp() {
  const sourceBuild = resolve(RUNTIME_ROOT, "Build/source");
  const chatSource = resolve(sourceBuild, "chatgpt-app");
  const contractSource = resolve(sourceBuild, "tool-contracts");
  const chatOutput = resolve(RUNTIME_ROOT, "Build/chatgpt-app");
  const contractOutput = resolve(RUNTIME_ROOT, "Build/tool-contracts");
  const inputs = [];
  for (const [path, digest] of Object.entries(PACKAGE_PINS)) inputs.push(await copyTracked(path, sourceBuild, digest));
  for (const name of SOURCE_NAMES) {
    const expected = name === "widget-runtime.ts" ? HELPERS.widgetSource.sha256 : null;
    inputs.push(await copyTracked("services/filmos-chatgpt-app/src/" + name, sourceBuild, expected));
  }
  inputs.push(await copyTracked("services/filmos-chatgpt-app/scripts/build-widget.mjs", sourceBuild, HELPERS.widget.sha256));
  inputs.push(await copyTracked("packages/filmos-tool-contracts/src/generated.ts", sourceBuild));

  async function moveInput(fromRelative, destination) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(resolve(sourceBuild, fromRelative), destination);
  }
  await moveInput("services/filmos-chatgpt-app/src", resolve(chatSource, "src"));
  await moveInput("services/filmos-chatgpt-app/scripts", resolve(chatSource, "scripts"));
  for (const name of ["package.json", "package-lock.json", "tsconfig.json"]) {
    await moveInput("services/filmos-chatgpt-app/" + name, resolve(chatSource, name));
  }
  await moveInput("packages/filmos-tool-contracts/src", resolve(contractSource, "src"));
  for (const name of ["package.json", "package-lock.json", "tsconfig.json"]) {
    await moveInput("packages/filmos-tool-contracts/" + name, resolve(contractSource, name));
  }
  await rm(resolve(sourceBuild, "services"), { recursive: true });
  await rm(resolve(sourceBuild, "packages"), { recursive: true });

  await regularFile(HELPERS.esbuild.path, HELPERS.esbuild.sha256);
  const sourceNodeModules = resolve(SOURCE_ROOT, "services/filmos-chatgpt-app/node_modules");
  const compileLinks = [];
  for (const name of WIDGET_PREBUILD_LINK_NAMES) {
    compileLinks.push(await createExactLink(
      resolve(chatSource, "node_modules", name),
      resolve(sourceNodeModules, name),
    ));
  }
  await runAudited({
    label: "widget-generated-input",
    executable: EXECUTABLES.node.path,
    expectedExecutable: EXECUTABLES.node,
    args: [resolve(chatSource, "scripts/build-widget.mjs")],
    cwd: chatSource,
  });
  const generated = resolve(chatSource, "generated/widget-runtime.ts");
  await regularFile(generated, GENERATED_WIDGET_SHA256);
  await regularFile(resolve(SOURCE_ROOT, "services/filmos-chatgpt-app/generated/widget-runtime.ts"), GENERATED_WIDGET_SHA256);

  await mkdir(contractOutput, { recursive: true, mode: 0o700 });
  await runAudited({
    label: "typescript-tool-contracts",
    executable: EXECUTABLES.node.path,
    expectedExecutable: EXECUTABLES.node,
    expectedScript: HELPERS.tsc,
    args: [HELPERS.tsc.path, "-p", resolve(contractSource, "tsconfig.json"), "--outDir", resolve(contractOutput, "dist")],
    cwd: contractSource,
  });
  await copyFile(resolve(contractSource, "package.json"), resolve(contractOutput, "package.json"));
  await chmod(resolve(contractOutput, "package.json"), 0o644);
  await regularFile(resolve(contractOutput, "dist/generated.js"));

  const sourceLinks = [
    ["@filmos/tool-contracts", contractOutput],
    ["express", resolve(sourceNodeModules, "express")],
    ["@types", resolve(sourceNodeModules, "@types")],
  ];
  for (const [name, target] of sourceLinks) {
    compileLinks.push(await createExactLink(resolve(chatSource, "node_modules", name), target));
  }
  invariant(compileLinks.length === 6, "COMPILE_LINK_COUNT_MISMATCH");

  await mkdir(chatOutput, { recursive: true, mode: 0o700 });
  await runAudited({
    label: "typescript-chatgpt-app",
    executable: EXECUTABLES.node.path,
    expectedExecutable: EXECUTABLES.node,
    expectedScript: HELPERS.tsc,
    args: [HELPERS.tsc.path, "-p", resolve(chatSource, "tsconfig.json"), "--outDir", chatOutput],
    cwd: chatSource,
  });
  await copyFile(resolve(chatSource, "package.json"), resolve(chatOutput, "package.json"));
  await chmod(resolve(chatOutput, "package.json"), 0o644);

  const runtimeLinks = [];
  for (const [name, target] of [
    ["@filmos/tool-contracts", contractOutput],
    ["@modelcontextprotocol", resolve(SOURCE_ROOT, "services/filmos-chatgpt-app/node_modules/@modelcontextprotocol")],
    ["express", resolve(SOURCE_ROOT, "services/filmos-chatgpt-app/node_modules/express")],
    ["zod", resolve(SOURCE_ROOT, "services/filmos-chatgpt-app/node_modules/zod")],
  ]) {
    runtimeLinks.push(await createExactLink(resolve(chatOutput, "node_modules", name), target));
  }
  invariant(runtimeLinks.length === 4, "RUNTIME_LINK_COUNT_MISMATCH");
  invariant(
    (await readdir(resolve(chatOutput, "node_modules"))).sort().join("\n")
      === ["@filmos", "@modelcontextprotocol", "express", "zod"].sort().join("\n"),
    "RUNTIME_LINK_MAP_MISMATCH",
  );
  await regularFile(resolve(chatOutput, "src/server.js"));

  const manifest = {
    schema_version: "filmos.phase7.isolated-build.v1",
    created_at: new Date().toISOString(),
    source_root: SOURCE_ROOT,
    inputs,
    compiler: await regularFile(HELPERS.tsc.path, HELPERS.tsc.sha256),
    widget_builder: await regularFile(HELPERS.widget.path, HELPERS.widget.sha256),
    generated_widget_sha256: GENERATED_WIDGET_SHA256,
    compile_links: compileLinks,
    runtime_links: runtimeLinks,
    outputs: [...await buildFiles(contractOutput), ...await buildFiles(chatOutput)],
  };
  await atomicJSON(resolve(RUNTIME_ROOT, "Build/manifest.json"), manifest);
  return { chatOutput, contractOutput, manifest };
}

async function validateBuildLinkTargets(manifest) {
  const proofs = [];
  const seen = new Map();
  for (const link of [...manifest.compile_links, ...manifest.runtime_links]) {
    const linkPath = resolve(RUNTIME_ROOT, link.link);
    const metadata = await lstat(linkPath);
    invariant(metadata.isSymbolicLink() && await realpath(linkPath) === link.target, "BUILD_LINK_TARGET_DRIFT:" + link.link);
    let snapshot = seen.get(link.target);
    if (!snapshot) {
      const targetMetadata = await lstat(link.target);
      snapshot = targetMetadata.isDirectory() ? await snapshotTree(link.target) : await physicalFile(link.target);
      seen.set(link.target, snapshot);
    }
    invariant((snapshot.digest || snapshot.sha256) === link.target_digest, "BUILD_LINK_DIGEST_DRIFT:" + link.link);
    proofs.push({ link: link.link, target: link.target, target_digest: link.target_digest });
  }
  return {
    verified_link_count: proofs.length,
    unique_target_count: seen.size,
    links: proofs,
  };
}

export async function verifyTunnelPayloadDirectory(directory, payloads = TUNNEL_PAYLOADS) {
  const names = (await readdir(directory)).sort();
  const expected = Object.keys(payloads).sort();
  invariant(names.join("\n") === expected.join("\n"), "TUNNEL_PAYLOAD_SET_MISMATCH");
  const result = [];
  for (const name of names) {
    const value = await regularFile(resolve(directory, name), payloads[name].sha256);
    if (payloads[name].executable) invariant((value.mode & 0o111) !== 0, "TUNNEL_PAYLOAD_NOT_EXECUTABLE:" + name);
    result.push({ name, sha256: value.sha256, size: value.size, mode: value.mode });
  }
  return result;
}

async function extractTunnel() {
  await regularFile(PATHS.tunnelArchive, TUNNEL_ARCHIVE_SHA256);
  const temporary = await mkdtemp(resolve(RUNTIME_ROOT, ".tunnel-client."));
  const archive = resolve(temporary, basename(PATHS.tunnelArchive));
  const unpacked = resolve(temporary, "unpacked");
  try {
    await copyFile(PATHS.tunnelArchive, archive);
    invariant(await sha256File(archive) === TUNNEL_ARCHIVE_SHA256, "TUNNEL_ARCHIVE_COPY_MISMATCH");
    await mkdir(unpacked, { mode: 0o700 });
    await runAudited({
      label: "tunnel-extraction",
      executable: EXECUTABLES.ditto.path,
      expectedExecutable: EXECUTABLES.ditto,
      args: ["-x", "-k", archive, unpacked],
    });
    const payloads = await verifyTunnelPayloadDirectory(unpacked);
    await rename(unpacked, resolve(RUNTIME_ROOT, "Tunnel"));
    return payloads;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function spawnLongLived(options) {
  let identity;
  if (options.canonicalExecutable) {
    identity = await executable(options.canonicalExecutable);
    invariant(await realpath(options.executable) === identity.path, "LONG_LIVED_EXECUTABLE_REALPATH_MISMATCH:" + options.label);
  } else if (options.expectedExecutable) {
    identity = await executable(options.expectedExecutable);
    invariant(resolve(options.executable) === identity.path, "LONG_LIVED_EXECUTABLE_MISMATCH:" + options.label);
  } else {
    identity = await regularFile(options.executable, options.expectedHash);
    invariant((identity.mode & 0o111) !== 0, "LONG_LIVED_EXECUTABLE_REQUIRED:" + options.label);
  }
  assertSourceIndependentPath(resolve(options.executable));
  assertSourceIndependentPath(resolve(options.cwd));
  for (const arg of options.args) if (isAbsolute(String(arg))) assertSourceIndependentPath(String(arg));
  const handle = await open(runtimePath(options.logPath), "wx", 0o600);
  const child = spawn(options.executable, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", handle.fd, handle.fd],
  });
  await handle.close();
  const state = {
    label: options.label,
    child,
    pid: child.pid,
    executable: resolve(options.executable),
    executableRealpath: identity.path,
    executableSha256: identity.sha256,
    args: options.args.map(redactArg),
    expectedCommand: [resolve(options.executable), ...options.args].join(" "),
    cwd: options.cwd,
    logPath: options.logPath,
    exited: false,
    status: null,
    signal: null,
  };
  child.once("exit", (status, signal) => {
    state.exited = true;
    state.status = status;
    state.signal = signal;
  });
  child.once("error", () => {
    state.exited = true;
    state.status = -1;
  });
  return state;
}

async function waitForHealth(url, child, validate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    invariant(!child.exited, "SERVICE_EXITED_BEFORE_READY:" + child.label);
    try {
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      if (response.ok) {
        validate(body);
        return body;
      }
      last = String(response.status);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("SERVICE_NOT_READY:" + child.label + ":" + last.slice(0, 120));
}

async function writePid(name, pid) {
  await atomicWrite(resolve(RUNTIME_ROOT, name), String(pid) + "\n");
}

async function issueGrant(build, state) {
  const modulePath = resolve(build.chatOutput, "src/grants.js");
  const loaded = await import(pathToFileURL(modulePath).href + "?phase7=" + Date.now());
  const grantsPath = resolve(RUNTIME_ROOT, "MCP/grants.json");
  const store = await loaded.JsonProjectGrantStore.open(grantsPath);
  return issueGrantWithStore({
    store,
    state,
    grantsPath,
    headerPath: resolve(RUNTIME_ROOT, "mcp-authorization.header"),
  });
}

export async function issueGrantWithStore({
  store,
  state,
  grantsPath,
  headerPath,
  readRecords = async () => JSON.parse(await readFile(grantsPath, "utf8")),
  writeAuthorizationHeader = async (path, token) => atomicWrite(path, "Bearer " + token + "\n"),
  hooks = {},
}) {
  const issued = await store.issue(PHASE7.projectId, "phase7-external-read-runtime", 60 * 60 * 1000);
  const grant = { store, issued, grantsPath, headerPath, revoked: false, headerCreated: false };
  state.grant = grant;
  state.secrets.grantToken = issued.token;
  await hooks.afterIssue?.(grant);
  const records = await readRecords();
  invariant(
    records.length === 1
      && records[0].grant_id === issued.grant.grant_id
      && records[0].token_hash === sha256(issued.token)
      && records[0].revoked_at === null,
    "ISOLATED_GRANT_STORE_MISMATCH",
  );
  await hooks.afterValidation?.(grant);
  await writeAuthorizationHeader(headerPath, issued.token);
  grant.headerCreated = true;
  await hooks.afterHeader?.(grant);
  return grant;
}

async function revokeGrant(grant) {
  if (!grant || grant.revoked) return;
  await grant.store.revoke(grant.issued.grant.grant_id);
  const records = JSON.parse(await readFile(grant.grantsPath ?? resolve(RUNTIME_ROOT, "MCP/grants.json"), "utf8"));
  invariant(records.length === 1 && records[0].grant_id === grant.issued.grant.grant_id && typeof records[0].revoked_at === "string", "ISOLATED_GRANT_REVOKE_MISMATCH");
  grant.revoked = true;
}

async function startServices(source, identity, build, secrets, children) {
  const resources = resolve(RUNTIME_ROOT, "Resources");
  const reviewBus = await spawnLongLived({
    label: "review-bus",
    executable: EXECUTABLES.node.path,
    expectedExecutable: EXECUTABLES.node,
    args: [resolve(SOURCE_ROOT, "services/filmos-review-bus/src/server.mjs")],
    cwd: resolve(SOURCE_ROOT, "services/filmos-review-bus"),
    env: minimalEnvironment({
      FILMOS_REVIEW_BUS_RUNTIME_MODE: "external-read",
      FILMOS_REVIEW_BUS_LOCAL_DIR: PATHS.reviewBusDir,
      FILMOS_REVIEW_BUS_HOST: "127.0.0.1",
      FILMOS_REVIEW_BUS_PORT: "17920",
      FILMOS_REVIEW_SEAL_SOURCE_ROOT: SOURCE_ROOT,
      FILMOS_REVIEW_SEAL_SOURCE_COMMIT: source.head,
      FILMOS_REVIEW_SEAL_SOURCE_TREE: source.tree,
      FILMOS_REVIEW_SEAL_SOURCE_FINGERPRINT_SHA256: identity.source_fingerprint_sha256,
      FILMOS_INSTALLED_SOURCE_IDENTITY_PATH: resolve(resources, "SourceIdentity.json"),
      FILMOS_INSTALLED_INTERNAL_RUNTIME_PATH: resolve(resources, "InternalRuntime.json"),
      FILMOS_REVIEW_DEVELOPER_REPOSITORY_LOCATOR: resolve(resources, "DeveloperRepository.json"),
    }),
    logPath: resolve(RUNTIME_ROOT, "review-bus.log"),
  });
  children.push(reviewBus);
  await writePid("review-bus.pid", reviewBus.pid);
  const reviewHealth = await waitForHealth("http://127.0.0.1:17920/healthz", reviewBus, (body) => {
    assertReviewBusHealth(body, source, identity, 0);
  });

  await venvPython();
  const filmCore = await spawnLongLived({
    label: "film-core",
    executable: PATHS.acceptancePython,
    canonicalExecutable: EXECUTABLES.python,
    args: [resolve(SOURCE_ROOT, "desktop/macos/runtime/film-core-launcher.py")],
    cwd: SOURCE_ROOT,
    env: minimalEnvironment({
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: resolve(SOURCE_ROOT, "film-core/src"),
      FILMOS_CORE_RUNTIME_MODE: "external-read",
      FILMOS_CORE_DB_PATH: PATHS.filmCoreDatabase,
      FILMOS_CORE_HOST: "127.0.0.1",
      FILMOS_CORE_PORT: "17650",
    }),
    logPath: resolve(RUNTIME_ROOT, "film-core.log"),
  });
  children.push(filmCore);
  await writePid("film-core.pid", filmCore.pid);
  const filmHealth = await waitForHealth("http://127.0.0.1:17650/health", filmCore, (body) => {
    invariant(body.ok === true && body.runtime_mode === "external-read" && body.project_id === PHASE7.projectId && body.schema_version === 7, "FILM_CORE_HEALTH_MISMATCH");
  });

  const mcp = await spawnLongLived({
    label: "chatgpt-mcp",
    executable: EXECUTABLES.node.path,
    expectedExecutable: EXECUTABLES.node,
    args: [resolve(build.chatOutput, "src/server.js")],
    cwd: build.chatOutput,
    env: minimalEnvironment({
      FILMOS_CHATGPT_RUNTIME_MODE: "external-read",
      FILMOS_EXTERNAL_READ_RUNTIME_ROOT: RUNTIME_ROOT,
      FILMOS_CHATGPT_APP_ENABLED: "true",
      FILMOS_CHATGPT_READ_TOOLS_ENABLED: "true",
      FILMOS_CHATGPT_WIDGETS_ENABLED: "false",
      FILMOS_CHATGPT_PROPOSAL_HANDOFF_ENABLED: "false",
      FILMOS_CHATGPT_HOST_PROFILE: PHASE7.hostProfileId,
      FILMOS_CHATGPT_HOST: "127.0.0.1",
      FILMOS_CHATGPT_PORT: "17840",
      FILMOS_CHATGPT_LOCAL_DIR: resolve(RUNTIME_ROOT, "MCP"),
      FILMOS_CHATGPT_PID_FILE: resolve(RUNTIME_ROOT, "chatgpt-mcp.pid"),
      FILMOS_REVIEW_BUS_READ_ENABLED: "true",
      FILMOS_REVIEW_BUS_AUTH_FILE: PATHS.reviewBusToken,
      FILMOS_REVIEW_BUS_BASE_URL: "http://127.0.0.1:17920",
      FILMOS_CORE_BASE_URL: "http://127.0.0.1:17650/film",
      FILMOS_SECURE_TUNNEL_PROOF: secrets.proof,
      FILMOS_CHATGPT_CONNECTION_ID: PHASE7.connectionId,
      FILMOS_CHATGPT_OBSERVATION_TTL_MS: "300000",
    }),
    logPath: resolve(RUNTIME_ROOT, "chatgpt-mcp.log"),
  });
  children.push(mcp);
  const mcpHealth = await waitForHealth("http://127.0.0.1:17840/health", mcp, (body) => {
    invariant(body.runtime_mode === "external-read", "MCP_RUNTIME_MODE_MISMATCH");
    invariant(JSON.stringify(body.mcp_tool_names) === JSON.stringify(EXTERNAL_TOOL_ORDER), "MCP_TOOL_ORDER_MISMATCH");
    invariant(body.mcp_read_tool_count === 7 && body.mcp_write_tool_count === 0 && body.mcp_paid_tool_count === 0 && body.mcp_destructive_tool_count === 0, "MCP_RISK_SURFACE_MISMATCH");
  });
  invariant((await readFile(resolve(RUNTIME_ROOT, "chatgpt-mcp.pid"), "utf8")).trim() === String(mcp.pid), "MCP_PID_RECEIPT_MISMATCH");
  return { reviewHealth, filmHealth, mcpHealth };
}

function tunnelArguments(mode, headerPath) {
  return [
    mode,
    ...(mode === "doctor" ? ["--json", "--explain"] : []),
    "--control-plane.tunnel-id", PHASE7.tunnelId,
    "--control-plane.api-key", "env:OPENAI_MCP_TUNNEL_RUNTIME_KEY",
    "--mcp.server-url", "url=http://127.0.0.1:17840/mcp,channel=main",
    "--mcp.extra-headers", "Authorization: file:" + headerPath,
    "--mcp.extra-headers", "X-FilmOS-Transport: secure-mcp-tunnel",
    "--mcp.extra-headers", "X-FilmOS-Transport-Proof: env:FILMOS_SECURE_TUNNEL_PROOF",
    "--mcp.extra-headers", "X-FilmOS-Live-Gate-Challenge: env:FILMOS_LIVE_GATE_CHALLENGE",
    "--mcp.discovery-extra-headers", "Authorization: file:" + headerPath,
    "--mcp.discovery-extra-headers", "X-FilmOS-Transport: secure-mcp-tunnel",
    "--mcp.discovery-extra-headers", "X-FilmOS-Transport-Proof: env:FILMOS_SECURE_TUNNEL_PROOF",
    "--mcp.discovery-extra-headers", "X-FilmOS-Live-Gate-Challenge: env:FILMOS_LIVE_GATE_CHALLENGE",
    "--health.listen-addr", "127.0.0.1:0",
    "--health.url-file", resolve(RUNTIME_ROOT, "tunnel-health.url"),
    "--pid.file", resolve(RUNTIME_ROOT, "tunnel-client.pid"),
  ];
}

async function startTunnel(grant, secrets, children) {
  const tunnel = resolve(RUNTIME_ROOT, "Tunnel/tunnel-client");
  const spec = { path: tunnel, sha256: TUNNEL_PAYLOADS["tunnel-client"].sha256 };
  const env = minimalEnvironment({
    OPENAI_MCP_TUNNEL_RUNTIME_KEY: secrets.runtimeKey,
    FILMOS_SECURE_TUNNEL_PROOF: secrets.proof,
    FILMOS_LIVE_GATE_CHALLENGE: secrets.challenge,
  });
  const doctor = await runAudited({
    label: "tunnel-doctor",
    executable: tunnel,
    expectedExecutable: spec,
    args: tunnelArguments("doctor", grant.headerPath),
    cwd: RUNTIME_ROOT,
    env,
    timeoutMs: 120000,
  });
  await atomicWrite(resolve(RUNTIME_ROOT, "tunnel-doctor.json"), doctor.stdout.length ? doctor.stdout : Buffer.from("{}\n"));
  const running = await spawnLongLived({
    label: "tunnel-client",
    executable: tunnel,
    expectedHash: TUNNEL_PAYLOADS["tunnel-client"].sha256,
    args: tunnelArguments("run", grant.headerPath),
    cwd: RUNTIME_ROOT,
    env,
    logPath: resolve(RUNTIME_ROOT, "tunnel-runtime.log"),
  });
  children.push(running);
  const healthPath = resolve(RUNTIME_ROOT, "tunnel-health.url");
  const deadline = Date.now() + 30000;
  let healthURL = "";
  while (Date.now() < deadline) {
    invariant(!running.exited, "TUNNEL_EXITED_BEFORE_READY");
    try {
      healthURL = (await readFile(healthPath, "utf8")).trim();
    } catch {}
    if (/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(healthURL)) {
      try {
        const response = await fetch(healthURL, { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch {}
    }
    healthURL = "";
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  invariant(healthURL !== "", "TUNNEL_HEALTH_NOT_READY");
  invariant((await readFile(resolve(RUNTIME_ROOT, "tunnel-client.pid"), "utf8")).trim() === String(running.pid), "TUNNEL_PID_RECEIPT_MISMATCH");
  return { running, healthURL };
}

export function liveContextReceipt(raw) {
  const value = structuredClone(raw);
  delete value.context_receipt_id;
  delete value.content_unit_kind;
  return "filmos-live:" + sha256(canonicalJSON(value));
}

export function bindLiveContext(savedContext, sourceIdentity, filmContext) {
  const value = structuredClone(savedContext);
  const ref = filmContext?.film_project?.ref;
  invariant(ref && Number.isSafeInteger(ref.version) && ref.version > 0 && /^[0-9a-f]{64}$/.test(ref.content_hash), "FILM_CORE_REF_INVALID");
  invariant(
    value.project_id === PHASE7.projectId
      && value.content_unit_id === PHASE7.contentUnitId
      && value.canvas_id === PHASE7.canvasId
      && value.canvas_state_hash === PHASE7.canvasStateHash,
    "LIVE_CONTEXT_SAVED_BINDING_DRIFT",
  );
  value.film_expected_version = ref.version;
  value.film_content_hash = ref.content_hash;
  value.source_identity = structuredClone(sourceIdentity);
  value.context_receipt_id = liveContextReceipt(value);
  delete value.content_unit_kind;
  return value;
}

async function currentFilmProjectContext() {
  const url = "http://127.0.0.1:17650/film/projects/" + PHASE7.projectId + "/context";
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  invariant(response.ok, "FILM_CORE_PROJECT_CONTEXT_UNAVAILABLE");
  const context = await response.json();
  const ref = context?.film_project?.ref;
  invariant(
    ref?.film_entity_id === "a7b9d814-ea33-4d99-afde-6ccfcd93421c"
      && ref?.version === 1
      && ref?.content_hash === "3bdf5e830e542def63117b976c7026109834a7e5806a4fe46f0e43aff186f977",
    "FILM_CORE_PROJECT_MAPPING_DRIFT",
  );
  invariant(Array.isArray(context.content_units) && context.content_units.length === 1 && Array.isArray(context.shots) && context.shots.length === 0, "FILM_CORE_PROJECT_COUNTS_DRIFT");
  return context;
}

async function publishLiveContext(grant, secrets, context) {
  const response = await fetch("http://127.0.0.1:17840/handoff/live-context", {
    method: "PUT",
    headers: { authorization: "Bearer " + grant.issued.token, "content-type": "application/json" },
    body: JSON.stringify({ challenge_id: secrets.challenge, context }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  invariant(response.ok && body.accepted === true && body.project_id === PHASE7.projectId && body.context_receipt_id === context.context_receipt_id, "LIVE_CONTEXT_PUBLISH_FAILED");
  return body;
}

export function parseRpcBody(body) {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLines = trimmed.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  invariant(dataLines.length > 0, "RPC_BODY_UNRECOGNIZED");
  const values = dataLines
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .map((line) => JSON.parse(line));
  return values.at(-1) || null;
}

async function localProbe(grant, secrets, identity) {
  const endpoint = "http://127.0.0.1:17840/mcp";
  const headers = {
    accept: "application/json, text/event-stream",
    authorization: "Bearer " + grant.issued.token,
    "content-type": "application/json",
    "x-filmos-transport": "secure-mcp-tunnel",
    "x-filmos-transport-proof": secrets.proof,
    "x-filmos-live-gate-challenge": secrets.challenge,
  };
  let sessionId = "";
  const captures = [];
  async function exchange(label, request) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" } : {}) },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10000),
    });
    const raw = await response.text();
    sessionId = sessionId || response.headers.get("mcp-session-id") || "";
    invariant(response.ok, "LOCAL_MCP_EXCHANGE_FAILED:" + label);
    const rpc = parseRpcBody(raw);
    captures.push({ label, http_status: response.status, response_sha256: sha256(raw), rpc });
    return rpc;
  }
  await exchange("initialize", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "filmos-phase7-local-probe", version: "1.0.0" } },
  });
  await exchange("initialized", { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const l1 = (await exchange("live-l1", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "filmos_get_live_workbench_context", arguments: {} } }))?.result?.structuredContent;
  const blockers = (await exchange("blockers", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "filmos_get_blockers", arguments: {} } }))?.result?.structuredContent;
  const l2 = (await exchange("live-l2", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "filmos_get_live_workbench_context", arguments: {} } }))?.result?.structuredContent;
  invariant(sessionId !== "", "LOCAL_MCP_SESSION_MISSING");
  for (const live of [l1, l2]) {
    invariant(live?.project_id === PHASE7.projectId && live?.project_grant_id === grant.issued.grant.grant_id && live?.challenge_id === secrets.challenge, "LOCAL_LIVE_BINDING_MISMATCH");
    invariant(live?.canvas_id === PHASE7.canvasId && live?.canvas_state_hash === PHASE7.canvasStateHash, "LOCAL_LIVE_CANVAS_MISMATCH");
    invariant(live?.context_receipt_id === live?.binding?.context_receipt_id, "LOCAL_LIVE_RECEIPT_MISMATCH");
    const expectedSource = {
      build_id: identity.build_id,
      git_commit_sha: identity.git_commit_sha,
      git_tree_sha: identity.git_tree_sha,
      source_fingerprint_sha256: identity.source_fingerprint_sha256,
      release_channel: "development",
      source_clean: true,
    };
    for (const [key, expected] of Object.entries(expectedSource)) {
      invariant(live?.source_identity?.[key] === expected, "LOCAL_LIVE_SOURCE_IDENTITY_MISMATCH:" + key);
    }
  }
  const blockerData = blockers?.data;
  invariant(
    blockerData?.evaluation?.status === "CLEAR"
      && blockerData?.evaluation?.blocker_count === 0
      && Array.isArray(blockerData?.items)
      && blockerData.items.length === 0,
    "LOCAL_BLOCKERS_NOT_CLEAR",
  );
  invariant(blockerData?.evidence?.live_context_receipt_id === l1.context_receipt_id && l1.context_receipt_id === l2.context_receipt_id, "LOCAL_BLOCKER_RECEIPT_MISMATCH");
  const output = {
    schema_version: "filmos.phase7.local-probe.v1",
    captured_at: new Date().toISOString(),
    session_id_sha256: sha256(sessionId),
    session_left_open: true,
    tool_order: ["filmos_get_live_workbench_context", "filmos_get_blockers", "filmos_get_live_workbench_context"],
    captures: captures.map(({ rpc, ...capture }) => ({
      ...capture,
      rpc_sha256: sha256(canonicalJSON(rpc)),
      rpc_error_code: rpc?.error?.code ?? null,
    })),
    binding: {
      project_id: l1.project_id,
      project_grant_id: l1.project_grant_id,
      challenge_id_sha256: sha256(l1.challenge_id),
      context_receipt_id: l1.context_receipt_id,
      expires_at: l1.expires_at,
      content_unit_id: l1.content_unit_id,
      canvas_id: l1.canvas_id,
      canvas_state_hash: l1.canvas_state_hash,
      blockers_status: blockerData.evaluation.status,
      blocker_count: blockerData.evaluation.blocker_count,
    },
  };
  await atomicJSON(resolve(RUNTIME_ROOT, "local-probe.json"), output);
  return output;
}

export function bindPhase6Package(template, binding, sourceIdentity) {
  const placeholderValues = {
    JIT_EXISTING_CONNECTOR_APP_ID: PHASE7.connectorAppId,
    JIT_EXISTING_CONNECTOR_VERSION_ID: PHASE7.connectorVersionId,
    JIT_PROJECT_GRANT_ID: binding.project_grant_id,
    JIT_PROJECT_GRANT_ISSUED_AT: binding.project_grant_issued_at,
    JIT_PROJECT_GRANT_EXPIRES_AT: binding.project_grant_expires_at,
    JIT_EXISTING_TUNNEL_ID: PHASE7.tunnelId,
    JIT_TUNNEL_CHALLENGE_ID: binding.challenge_id,
    JIT_LIVE_CONTEXT_RECEIPT_ID: binding.context_receipt_id,
    JIT_LIVE_CONTEXT_EXPIRES_AT: binding.live_context_expires_at,
    JIT_CONTENT_UNIT_ID: binding.content_unit_id,
    JIT_CANVAS_ID: binding.canvas_id,
    JIT_CANVAS_STATE_HASH: binding.canvas_state_hash,
  };
  let output = template;
  for (const [name, value] of Object.entries(placeholderValues)) {
    const token = "<" + name + ">";
    invariant(output.split(token).length - 1 === 1, "PHASE6_PLACEHOLDER_COUNT_MISMATCH:" + name);
    output = output.split(token).join(String(value));
  }
  const replacements = [
    [PHASE7.legacySource.commit, sourceIdentity.git_commit_sha],
    [PHASE7.legacySource.tree, sourceIdentity.git_tree_sha],
    [PHASE7.legacySource.fingerprint, sourceIdentity.source_fingerprint_sha256],
    [PHASE7.legacySource.buildId, sourceIdentity.build_id],
  ];
  const sourceReplacements = [];
  for (const [oldValue, newValue] of replacements) {
    const occurrenceCount = output.split(oldValue).length - 1;
    invariant(occurrenceCount >= 1, "PHASE6_LEGACY_SOURCE_VALUE_MISSING");
    output = output.split(oldValue).join(newValue);
    sourceReplacements.push({ from: oldValue, to: newValue, occurrence_count: occurrenceCount });
  }
  invariant(!/<JIT_[A-Z0-9_]+>/.test(output), "PHASE6_PLACEHOLDER_REMAINS");
  invariant(!output.includes(PHASE7.legacySource.commit) || sourceIdentity.git_commit_sha === PHASE7.legacySource.commit, "LEGACY_SOURCE_COMMIT_REMAINS");
  return {
    output,
    placeholderValues,
    sourceReplacements,
  };
}

async function createBoundPackage(grant, secrets, published, local, identity) {
  const template = await readFile(PHASE7.templatePath, "utf8");
  invariant(sha256(template) === PHASE7.templateSha256, "PHASE6_TEMPLATE_HASH_DRIFT");
  const binding = {
    project_id: PHASE7.projectId,
    project_grant_id: grant.issued.grant.grant_id,
    project_grant_issued_at: grant.issued.grant.issued_at,
    project_grant_expires_at: grant.issued.grant.expires_at,
    challenge_id: secrets.challenge,
    context_receipt_id: local.binding.context_receipt_id,
    live_context_expires_at: published.expires_at,
    content_unit_id: local.binding.content_unit_id,
    canvas_id: local.binding.canvas_id,
    canvas_state_hash: local.binding.canvas_state_hash,
    source_identity: {
      build_id: identity.build_id,
      commit: identity.git_commit_sha,
      tree: identity.git_tree_sha,
      source_fingerprint_sha256: identity.source_fingerprint_sha256,
      source_clean: identity.source_clean,
    },
  };
  const bound = bindPhase6Package(template, binding, identity);
  const packagePath = resolve(RUNTIME_ROOT, "bound-package.md");
  await atomicWrite(packagePath, bound.output);
  const receipt = {
    schema_version: "filmos.phase7.jit-binding.v1",
    created_at: new Date().toISOString(),
    template_path: PHASE7.templatePath,
    template_sha256: PHASE7.templateSha256,
    bound_package_path: packagePath,
    bound_package_sha256: sha256(bound.output),
    placeholder_count: Object.keys(bound.placeholderValues).length,
    remaining_placeholder_count: 0,
    source_identity_replacement_count: bound.sourceReplacements.length,
    binding,
  };
  await atomicJSON(resolve(RUNTIME_ROOT, "binding.json"), receipt);
  return receipt;
}

function parseLsofPids(text) {
  return [...new Set(
    text.split(/\r?\n/).slice(1)
      .map((line) => Number(line.trim().split(/\s+/)[1]))
      .filter(Number.isSafeInteger),
  )];
}

export function verifyPostCleanupProcessBoundary(state, {
  lsofText = "",
  psRows = [],
  runtimeRoot = RUNTIME_ROOT,
  runnerPid = process.pid,
} = {}) {
  invariant(Array.isArray(psRows), "POST_CLEANUP_PS_ROWS_INVALID");
  const trackedPids = new Set([
    ...(state.children || []).map((child) => child.pid),
    ...(state.processInventory?.processes || [])
      .filter((item) => item.label !== "runner")
      .map((item) => item.pid),
  ].filter((pid) => Number.isSafeInteger(pid) && pid > 0));
  const lsofPids = new Set(parseLsofPids(lsofText).filter((pid) => pid !== runnerPid));
  const psPids = new Set(psRows.map((row) => row.pid));
  const trackedSurvivors = [...trackedPids].filter((pid) => psPids.has(pid) || lsofPids.has(pid)).sort((left, right) => left - right);
  const runtimeRootReferences = psRows
    .filter((row) => row.pid !== runnerPid && typeof row.command === "string" && row.command.includes(runtimeRoot))
    .map((row) => row.pid)
    .sort((left, right) => left - right);
  const cloudflaredPath = resolve(runtimeRoot, "Tunnel/cloudflared");
  const inventoryVendorPids = new Set((state.processInventory?.processes || [])
    .filter((item) => item.label === "cloudflared")
    .map((item) => item.pid));
  const conditionalCloudflaredSurvivors = psRows
    .filter((row) => row.pid !== runnerPid && (
      inventoryVendorPids.has(row.pid)
      || row.command === cloudflaredPath
      || row.command?.startsWith(cloudflaredPath + " ")
    ))
    .map((row) => row.pid)
    .sort((left, right) => left - right);
  const survivors = [...new Set([
    ...trackedSurvivors,
    ...runtimeRootReferences,
    ...conditionalCloudflaredSurvivors,
    ...lsofPids,
  ])].sort((left, right) => left - right);
  return {
    schema_version: "filmos.phase7.post-cleanup-process-boundary.v1",
    audit_complete: true,
    boundary_verified: survivors.length === 0,
    tracked_pid_count: trackedPids.size,
    tracked_pid_survivors: trackedSurvivors,
    conditional_cloudflared_survivor_pids: conditionalCloudflaredSurvivors,
    runtime_root_reference_pids: runtimeRootReferences,
    runtime_root_or_reserved_port_open_pids: [...lsofPids].sort((left, right) => left - right),
    survivor_pids: survivors,
  };
}

async function auditPostCleanupProcesses(state, attempt) {
  const lsofText = await lsofAudit(`failure-post-cleanup-${attempt}`, true);
  const psRows = await psAudit(`failure-post-cleanup-${attempt}`);
  return verifyPostCleanupProcessBoundary(state, { lsofText, psRows });
}

async function validateReadyProcesses(children, lsofText, psRows) {
  const expectedChildLabels = ["review-bus", "film-core", "chatgpt-mcp", "tunnel-client"];
  invariant(
    children.length === expectedChildLabels.length
      && children.map((child) => child.label).join("\n") === expectedChildLabels.join("\n")
      && new Set(children.map((child) => child.pid)).size === expectedChildLabels.length,
    "READY_PRIMARY_PROCESS_SET_MISMATCH",
  );
  const runnerRow = psRows.find((item) => item.pid === process.pid);
  invariant(runnerRow, "READY_RUNNER_PROCESS_MISSING");
  invariant(await realpath(process.execPath) === EXECUTABLES.node.path, "READY_RUNNER_EXECUTABLE_REALPATH_MISMATCH");
  await executable(EXECUTABLES.node);
  const expected = new Map([[process.pid, "runner"], ...children.map((child) => [child.pid, child.label])]);
  for (const child of children) {
    invariant(!child.exited, "READY_PROCESS_EXITED:" + child.label);
    const row = psRows.find((item) => item.pid === child.pid);
    invariant(row && row.ppid === process.pid, "READY_PROCESS_PARENT_MISMATCH:" + child.label);
    invariant(row.command === child.expectedCommand, "READY_PROCESS_COMMAND_MISMATCH:" + child.label);
    invariant(await realpath(child.executable) === child.executableRealpath, "READY_PROCESS_EXECUTABLE_REALPATH_MISMATCH:" + child.label);
    await regularFile(child.executableRealpath, child.executableSha256);
    invariant(await realpath(child.cwd) === child.cwd, "READY_PROCESS_CWD_DRIFT:" + child.label);
  }
  const tunnelPid = children.find((item) => item.label === "tunnel-client")?.pid;
  const cloudflaredPath = resolve(RUNTIME_ROOT, "Tunnel/cloudflared");
  const vendor = psRows.filter((item) => item.ppid === tunnelPid
    && (item.command === cloudflaredPath || item.command.startsWith(cloudflaredPath + " ")));
  invariant(vendor.length <= 1, "CLOUDFLARED_CHILD_COUNT_EXCEEDED");
  if (vendor.length === 1) {
    await regularFile(cloudflaredPath, TUNNEL_PAYLOADS.cloudflared.sha256);
    expected.set(vendor[0].pid, "cloudflared");
    await writePid("cloudflared.pid", vendor[0].pid);
  }
  for (const row of psRows) {
    if (row.command.includes(RUNTIME_ROOT)) invariant(expected.has(row.pid), "UNLISTED_RUNTIME_PROCESS:" + row.pid);
  }
  for (const pid of parseLsofPids(lsofText)) invariant(expected.has(pid), "UNLISTED_RUNTIME_OPEN_FILE_OR_PORT:" + pid);
  return {
    schema_version: "filmos.phase7.process-inventory.v1",
    captured_at: new Date().toISOString(),
    primary_process_count: 5,
    conditional_vendor_child_count: vendor.length,
    total_observed_long_lived_process_count: 5 + vendor.length,
    processes: [...expected].map(([pid, label]) => {
      const row = psRows.find((item) => item.pid === pid);
      const command = row
        ? row.command.split(/\s+/).map(redactArg).join(" ")
        : label === "runner" ? process.argv.map(redactArg).join(" ") : null;
      const owned = children.find((child) => child.pid === pid);
      return {
        pid,
        label,
        ppid: row?.ppid || null,
        command,
        executable_realpath: owned?.executableRealpath ?? (label === "runner" ? EXECUTABLES.node.path : cloudflaredPath),
        executable_sha256: owned?.executableSha256 ?? (label === "runner" ? EXECUTABLES.node.sha256 : TUNNEL_PAYLOADS.cloudflared.sha256),
        cwd: owned?.cwd ?? (label === "runner" ? SOURCE_ROOT : RUNTIME_ROOT),
      };
    }),
    lsof_sha256: sha256(lsofText),
  };
}

async function waitForExternalCommand() {
  process.stdout.write(JSON.stringify({
    status: "READY_FOR_EXTERNAL_CHATGPT",
    bound_package: resolve(RUNTIME_ROOT, "bound-package.md"),
    completion_protocol: "one JSON line on stdin",
  }) + "\n");
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const line = await new Promise((resolveLine, rejectLine) => {
    input.once("line", resolveLine);
    input.once("close", () => rejectLine(new Error("EXTERNAL_COMPLETION_INPUT_CLOSED")));
  });
  input.close();
  invariant(Buffer.byteLength(line) <= 4 * 1024 * 1024, "EXTERNAL_COMPLETION_INPUT_TOO_LARGE");
  const command = JSON.parse(line);
  invariant(command && typeof command === "object" && !Array.isArray(command), "EXTERNAL_COMPLETION_INPUT_INVALID");
  if (command.action === "abort") throw new Error("EXTERNAL_EXECUTION_ABORTED:" + String(command.reason || "unspecified").slice(0, 120));
  invariant(command.action === "complete", "EXTERNAL_COMPLETION_ACTION_INVALID");
  invariant(exactKeys(command, ["action", "external_conversation_id", "external_message_count", "platform_schema_discovery_call_count", "external_response"]), "EXTERNAL_COMPLETION_SCHEMA_MISMATCH");
  invariant(
    Number.isInteger(command.platform_schema_discovery_call_count)
      && command.platform_schema_discovery_call_count >= 0
      && command.platform_schema_discovery_call_count <= 2,
    "PLATFORM_SCHEMA_DISCOVERY_COUNT_INVALID",
  );
  validateExternalConversationBinding(command);
  return command;
}

export function validateExternalConversationBinding(command) {
  invariant(
    typeof command?.external_conversation_id === "string"
      && /^[A-Za-z0-9._:-]{1,256}$/.test(command.external_conversation_id)
      && command.external_conversation_id !== FIXED_REVIEW_CONVERSATION_ID
      && command.external_message_count === 1,
    command?.external_conversation_id === FIXED_REVIEW_CONVERSATION_ID
      ? "EXTERNAL_CONVERSATION_MUST_DIFFER_FROM_FIXED_REVIEW"
      : "EXTERNAL_CONVERSATION_OR_MESSAGE_COUNT_INVALID",
  );
  return command.external_conversation_id;
}

const SUCCESS_KEYS = Object.freeze([
  "product_goal_fit", "root_cause", "root_cause_explains_symptom", "authority_risk", "resolution_layer", "workflow_impact",
  "acceptance_gates", "scope_drift", "problem_statement", "existing_authorities", "current_architecture_map", "host_capability_matrix",
  "architecture_options", "recommended_option", "recommended_first_vertical_canary", "security_and_compliance", "state_machine",
  "idempotency_and_recovery", "result_return_contract", "candidate_and_qc_contract", "source_impact_map", "new_service_count",
  "new_storage_count", "new_authority_count", "reuse_and_deletion_plan", "evidence_gaps", "open_questions", "explicit_non_goals",
]);
const BLOCKED_KEYS = Object.freeze([
  "assessment_status", "blocker_code", "failed_or_unobservable_call", "completed_filmos_call_count",
  "platform_schema_discovery_call_count", "blindness_preserved", "assessment_generated",
]);

function exactKeys(value, expected) {
  return Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

function nonEmptyString(value, code) {
  invariant(typeof value === "string" && value.trim().length > 0, code);
  return value;
}

function stringList(value, code, { allowEmpty = false } = {}) {
  invariant(Array.isArray(value) && (allowEmpty || value.length > 0), code);
  for (const item of value) nonEmptyString(item, code);
  return value;
}

function validateHostCapabilityMatrix(value) {
  const hosts = [
    "chatgpt_subscription_image_host",
    "google_ai_studio_subscription_image_host",
    "gemini_subscription_image_host",
  ];
  const keys = [
    "host", "model_catalog", "text_to_image", "reference_image_or_edit", "result_return",
    "maximum_supported_silence_level", "security_and_compliance_risks",
  ];
  invariant(Array.isArray(value) && value.length === hosts.length, "HOST_CAPABILITY_MATRIX_MISMATCH");
  for (const [index, row] of value.entries()) {
    invariant(row && typeof row === "object" && !Array.isArray(row) && exactKeys(row, keys), "HOST_CAPABILITY_ROW_SCHEMA_MISMATCH");
    invariant(row.host === hosts[index], "HOST_CAPABILITY_ORDER_MISMATCH");
    for (const name of ["model_catalog", "text_to_image", "reference_image_or_edit", "result_return"]) {
      nonEmptyString(row[name], "HOST_CAPABILITY_VALUE_INVALID:" + name);
    }
    invariant(["L1", "L2", "L3", "REQUIRES_CONTROLLED_CANARY"].includes(row.maximum_supported_silence_level), "HOST_SILENCE_LEVEL_INVALID");
    stringList(row.security_and_compliance_risks, "HOST_SECURITY_RISKS_INVALID", { allowEmpty: true });
  }
  return hosts;
}

function validateArchitectureOptions(value) {
  const keys = [
    "option", "summary", "reused_authorities", "minimal_new_components", "source_layers",
    "new_service_count", "new_storage_count", "new_authority_count", "security_and_compliance_risks",
    "idempotency_and_recovery", "test_method", "replaced_or_deleted_duplicate_logic",
    "single_production_chain_preserved",
  ];
  invariant(Array.isArray(value) && value.length >= 2, "ARCHITECTURE_OPTIONS_INCOMPLETE");
  const names = new Set();
  for (const option of value) {
    invariant(option && typeof option === "object" && !Array.isArray(option) && exactKeys(option, keys), "ARCHITECTURE_OPTION_SCHEMA_MISMATCH");
    const name = nonEmptyString(option.option, "ARCHITECTURE_OPTION_NAME_INVALID");
    invariant(!names.has(name), "ARCHITECTURE_OPTION_NAME_DUPLICATE");
    names.add(name);
    nonEmptyString(option.summary, "ARCHITECTURE_OPTION_SUMMARY_INVALID");
    for (const field of [
      "reused_authorities", "minimal_new_components", "source_layers", "security_and_compliance_risks",
      "idempotency_and_recovery", "test_method", "replaced_or_deleted_duplicate_logic",
    ]) stringList(option[field], "ARCHITECTURE_OPTION_LIST_INVALID:" + field);
    for (const field of ["new_service_count", "new_storage_count", "new_authority_count"]) {
      invariant(Number.isSafeInteger(option[field]) && option[field] >= 0, "ARCHITECTURE_OPTION_COUNT_INVALID:" + field);
    }
    invariant(typeof option.single_production_chain_preserved === "boolean", "ARCHITECTURE_OPTION_CHAIN_FLAG_INVALID");
  }
  return names;
}

export function validateExternalResponse(input) {
  let value = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    invariant(trimmed.startsWith("{") && trimmed.endsWith("}") && !trimmed.includes(String.fromCharCode(96).repeat(3)), "EXTERNAL_RESPONSE_NOT_STRICT_JSON");
    value = JSON.parse(trimmed);
  }
  invariant(value && typeof value === "object" && !Array.isArray(value), "EXTERNAL_RESPONSE_OBJECT_REQUIRED");
  if (value.assessment_status === "BLOCKED") {
    invariant(exactKeys(value, BLOCKED_KEYS), "BLOCKED_RESPONSE_SCHEMA_MISMATCH");
    invariant(value.assessment_generated === false && value.blindness_preserved === true, "BLOCKED_RESPONSE_BOUNDARY_MISMATCH");
    invariant(/^[A-Z][A-Z0-9_]{2,127}$/.test(String(value.blocker_code || "")), "BLOCKED_RESPONSE_CODE_INVALID");
    nonEmptyString(value.failed_or_unobservable_call, "BLOCKED_RESPONSE_CALL_INVALID");
    invariant(Number.isSafeInteger(value.completed_filmos_call_count) && value.completed_filmos_call_count >= 0 && value.completed_filmos_call_count <= 7, "BLOCKED_FILMOS_CALL_COUNT_INVALID");
    invariant(Number.isSafeInteger(value.platform_schema_discovery_call_count) && value.platform_schema_discovery_call_count >= 0 && value.platform_schema_discovery_call_count <= 2, "BLOCKED_SCHEMA_DISCOVERY_COUNT_INVALID");
    return { kind: "BLOCKED", value };
  }
  invariant(exactKeys(value, SUCCESS_KEYS), "SUCCESS_RESPONSE_SCHEMA_MISMATCH");
  for (const field of ["product_goal_fit", "root_cause_explains_symptom", "authority_risk", "scope_drift"]) {
    invariant(typeof value[field] === "boolean", "ASSESSMENT_BOOLEAN_INVALID:" + field);
  }
  for (const field of ["root_cause", "resolution_layer", "workflow_impact", "problem_statement"]) {
    nonEmptyString(value[field], "ASSESSMENT_STRING_INVALID:" + field);
  }
  for (const field of [
    "acceptance_gates", "existing_authorities", "current_architecture_map", "security_and_compliance",
    "state_machine", "idempotency_and_recovery", "result_return_contract", "candidate_and_qc_contract",
    "source_impact_map", "reuse_and_deletion_plan", "explicit_non_goals",
  ]) stringList(value[field], "ASSESSMENT_LIST_INVALID:" + field);
  for (const field of ["evidence_gaps", "open_questions"]) stringList(value[field], "ASSESSMENT_LIST_INVALID:" + field, { allowEmpty: true });
  const hosts = validateHostCapabilityMatrix(value.host_capability_matrix);
  const optionNames = validateArchitectureOptions(value.architecture_options);
  invariant(optionNames.has(value.recommended_option), "RECOMMENDED_OPTION_NOT_DECLARED");
  const recommended = value.architecture_options.find((option) => option.option === value.recommended_option);
  const canary = value.recommended_first_vertical_canary;
  invariant(canary && typeof canary === "object" && !Array.isArray(canary) && exactKeys(canary, ["host", "scope", "requires_future_user_generation_authorization", "reason"]), "VERTICAL_CANARY_SCHEMA_MISMATCH");
  invariant(hosts.includes(canary.host), "VERTICAL_CANARY_HOST_INVALID");
  invariant(canary.requires_future_user_generation_authorization === true, "VERTICAL_CANARY_AUTHORIZATION_BOUNDARY_INVALID");
  invariant(canonicalJSON(canary.scope) === canonicalJSON([
    "1 Project", "1 ContentUnit", "1 Canvas", "1 Image Node", "1 Subscription Host", "1 explicit model",
    "1 generation request", "1 candidate result set", "Asset Version", "Formal Candidate", "QC Pending", "Canvas refresh",
  ]), "VERTICAL_CANARY_SCOPE_MISMATCH");
  nonEmptyString(canary.reason, "VERTICAL_CANARY_REASON_INVALID");
  for (const name of ["new_service_count", "new_storage_count", "new_authority_count"]) {
    invariant(Number.isSafeInteger(value[name]) && value[name] >= 0, "ASSESSMENT_COUNT_INVALID:" + name);
    invariant(recommended[name] === value[name], "ASSESSMENT_RECOMMENDED_COUNT_MISMATCH:" + name);
  }
  invariant(
    !/(?:EVIDENCE_DERIVED_STRING|NON_EMPTY_STRING|OBSERVED_OR_|A_OR_B_OR_|ONE_OF_THE_THREE_HOSTS|L1_OR_L2_OR_L3_OR_REQUIRES_CONTROLLED_CANARY|"STRING")/.test(JSON.stringify(value)),
    "ASSESSMENT_TEMPLATE_TOKEN_REMAINS",
  );
  return { kind: "SUCCESS", value };
}

function parseAudit(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export function validateAuditRecords(records, binding) {
  invariant(records.length === AUDIT_ORDER.length, "MCP_AUDIT_ROW_COUNT_MISMATCH");
  invariant(records.map((record) => record.action).join("\n") === AUDIT_ORDER.join("\n"), "MCP_AUDIT_ACTION_ORDER_MISMATCH");
  const grantIssuedAt = Date.parse(binding.project_grant_issued_at);
  const grantExpiresAt = Date.parse(binding.project_grant_expires_at);
  const liveContextExpiresAt = Date.parse(binding.live_context_expires_at);
  invariant(Number.isFinite(grantIssuedAt) && grantIssuedAt < liveContextExpiresAt && liveContextExpiresAt <= grantExpiresAt, "MCP_AUDIT_EXPIRY_BINDING_INVALID");
  const eventIds = new Set();
  const correlationIds = new Set();
  let previousRecordedAt = grantIssuedAt;
  for (const record of records) {
    invariant(record.outcome === "ALLOW" && record.project_id === PHASE7.projectId && record.grant_id === binding.project_grant_id, "MCP_AUDIT_BINDING_MISMATCH:" + record.action);
    invariant(!record.code, "MCP_AUDIT_ERROR:" + record.action);
    invariant(record.challenge_id === binding.challenge_id, "MCP_AUDIT_CHALLENGE_MISMATCH:" + record.action);
    invariant(typeof record.event_id === "string" && record.event_id.length > 0 && validIsoTimestamp(record.recorded_at), "MCP_AUDIT_IDENTITY_INVALID:" + record.action);
    invariant(Number.isSafeInteger(record.result_size) && record.result_size >= 0, "MCP_AUDIT_RESULT_SIZE_INVALID:" + record.action);
    invariant(!eventIds.has(record.event_id) && !correlationIds.has(record.correlation_id), "MCP_AUDIT_DUPLICATE_ID:" + record.action);
    eventIds.add(record.event_id);
    correlationIds.add(record.correlation_id);
    const recordedAt = Date.parse(record.recorded_at);
    invariant(recordedAt >= previousRecordedAt && recordedAt <= grantExpiresAt, "MCP_AUDIT_RECORDED_TIME_INVALID:" + record.action);
    previousRecordedAt = recordedAt;
  }
  invariant(records[0].context_receipt_id === binding.context_receipt_id, "MCP_PUBLISH_RECEIPT_MISMATCH");
  invariant(records[0].output_hash === PHASE7.canvasStateHash, "MCP_PUBLISH_OUTPUT_HASH_MISMATCH");
  const publishedAt = Date.parse(records[0].recorded_at);
  invariant(publishedAt <= liveContextExpiresAt, "MCP_PUBLISH_OUTSIDE_JIT_WINDOW");
  for (const record of records.slice(1)) {
    invariant(record.request_id === record.correlation_id, "MCP_AUDIT_REQUEST_ID_MISMATCH:" + record.action);
    invariant(record.tool_name === record.action, "MCP_AUDIT_TOOL_NAME_MISMATCH:" + record.action);
    invariant(validIsoTimestamp(record.timestamp), "MCP_AUDIT_TOOL_TIMESTAMP_INVALID:" + record.action);
    const toolTimestamp = Date.parse(record.timestamp);
    invariant(toolTimestamp >= publishedAt && toolTimestamp <= liveContextExpiresAt, "MCP_AUDIT_TOOL_OUTSIDE_JIT_WINDOW:" + record.action);
    invariant(/^[0-9a-f]{64}$/.test(String(record.output_hash || "")), "MCP_AUDIT_OUTPUT_HASH_INVALID:" + record.action);
    invariant(record.result_hash === record.output_hash, "MCP_AUDIT_RESULT_HASH_MISMATCH:" + record.action);
  }
  return {
    row_count: records.length,
    action_order: records.map((record) => record.action),
    local_probe_action_count: 3,
    independent_action_count: 7,
    live_context_publish_count: 1,
  };
}

export function assertReviewBusHealth(body, source, identity, expectedOperationCount) {
  const installedIdentity = {
    schema_version: "filmos.installed-source-identity.v1",
    source_identity_schema: identity.schema_version,
    internal_runtime_schema: 4,
    build_id: identity.build_id,
    release_channel: identity.release_channel,
    repository: identity.repository,
    commit: identity.git_commit_sha,
    tree: identity.git_tree_sha,
    source_fingerprint_sha256: identity.source_fingerprint_sha256,
    source_file_count: identity.source_file_count,
    source_clean: identity.source_clean,
    external_paid_submit_enabled: identity.external_paid_submit_enabled,
  };
  invariant(body.runtime_mode === "external-read", "REVIEW_BUS_RUNTIME_MODE_MISMATCH");
  invariant(
    body.source_identity?.status === "VERIFIED"
      && body.source_identity?.source_root === SOURCE_ROOT
      && body.source_identity?.branch === source.branch
      && body.source_identity?.commit === source.head
      && body.source_identity?.tree === source.tree
      && body.source_identity?.source_fingerprint_sha256 === identity.source_fingerprint_sha256
      && body.source_identity?.content_hash === sha256(canonicalJSON(installedIdentity)),
    "REVIEW_BUS_HEALTH_IDENTITY_MISMATCH",
  );
  invariant(
    body.constitution_version === "1.1.0"
      && body.constitution_content_hash === "a61228c66e931cb977928f4d2864ab6556f3fcd163479e31ccebbc6fccf39d41",
    "REVIEW_BUS_CONSTITUTION_DRIFT",
  );
  invariant(
    body.target?.project_id === PHASE7.projectId
      && body.target?.issue_id === PHASE7.issueId
      && body.target?.state === "ARCHITECTURE_ASSESSMENTS_PENDING"
      && body.target?.entity_version === 125
      && body.target?.projection_content_hash === "ba7b958f555d723bc0c4a679f3b5d104435015af4f5b53c0833aa1c180f04cae"
      && body.target?.issue_event_count === 125
      && body.target?.last_event_sequence === 12988
      && body.target?.last_event_hash === "8650686aced0251fa8452164ed0cd5e649a17549a7cb2f73f13bdfda27aa47e7"
      && body.target?.codex_slot === "SEALED"
      && body.target?.chatgpt_slot === "EMPTY",
    "REVIEW_BUS_TARGET_DRIFT",
  );
  invariant(
    body.pending_issue_count === 5
      && body.pending_summary_sha256 === "d6ac890757b44e57e93f093506a819f6ade90d1ee7f9af91057f8b58f7d29361"
      && body.read_receipt_operation_count === expectedOperationCount
      && body.read_receipt_operation_limit === 6
      && body.read_receipt_row_count === 6
      && body.read_receipt_keys_sha256 === "46a037f9500d7fb637dac87050f5bb611b693ab9ca136e16362e47980d335efc"
      && body.current_seal_state === "CODEX_SEALED_SUCCESSOR",
    "REVIEW_BUS_RECEIPT_OR_SEAL_DRIFT",
  );
  return body;
}

async function reviewBusFinalHealth(source, identity) {
  const response = await fetch("http://127.0.0.1:17920/healthz", { signal: AbortSignal.timeout(5000) });
  invariant(response.ok, "REVIEW_BUS_FINAL_HEALTH_UNAVAILABLE");
  const body = await response.json();
  return assertReviewBusHealth(body, source, identity, 6);
}

async function scanForSecrets(paths, secrets) {
  const forbidden = [secrets.runtimeKey, secrets.proof, secrets.grantToken].filter(Boolean);
  for (const path of paths) {
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const secret of forbidden) invariant(!text.includes(secret), "SECRET_LEAK:" + basename(path));
  }
}

export async function scanRuntimeSecrets(root, secrets, { purge = false, removeFile = unlink } = {}) {
  const absoluteRoot = resolve(root);
  const forbidden = [secrets.runtimeKey, secrets.proof, secrets.grantToken].filter(Boolean).map((value) => Buffer.from(value));
  const matches = [];
  const errors = [];
  async function visit(path) {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(resolve(path, name));
      return;
    }
    if (!metadata.isFile()) return;
    const bytes = await readFile(path);
    if (!forbidden.some((secret) => bytes.includes(secret))) return;
    const name = relative(absoluteRoot, path);
    matches.push(name);
    if (purge) {
      try { await removeFile(path); }
      catch (error) { errors.push({ path: name, code: safeCleanupErrorCode(error) }); }
    }
  }
  await visit(absoluteRoot);
  return { matches, errors };
}

function safeCleanupErrorCode(error) {
  const value = String(error?.code || error?.message || error || "CLEANUP_ERROR").split(":")[0];
  return /^[A-Z0-9_-]{2,160}$/.test(value) ? value : "CLEANUP_ERROR";
}

async function waitChildExit(state, timeoutMs) {
  if (state.exited) return true;
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.child.removeListener("exit", onExit);
      resolveExit(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(state.exited), timeoutMs);
    state.child.once("exit", onExit);
    if (state.exited) finish(true);
  });
}

async function stopChild(state) {
  if (!state || state.exited) return;
  const pid = state.pid;
  invariant(state.child.pid === pid, "OWNED_PID_MISMATCH:" + state.label);
  state.child.kill("SIGTERM");
  const exited = await waitChildExit(state, 5000);
  if (!exited && !state.exited) {
    state.child.kill("SIGKILL");
    invariant(await waitChildExit(state, 5000), "OWNED_PROCESS_KILL_TIMEOUT:" + state.label);
  }
}

async function removeExact(path) {
  const absolute = runtimePath(path);
  try {
    await unlink(absolute);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function pathAbsent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function grantIsRevoked(grant) {
  if (!grant) return true;
  const records = JSON.parse(await readFile(grant.grantsPath ?? resolve(RUNTIME_ROOT, "MCP/grants.json"), "utf8"));
  const record = records.find((value) => value.grant_id === grant.issued.grant.grant_id);
  return Boolean(record && typeof record.revoked_at === "string" && record.revoked_at.length > 0);
}

export async function cleanupOwned(state, { strict = false, deferSecretClearing = false, operations = {} } = {}) {
  if (state.cleanupPromise) return state.cleanupPromise;
  state.cleanupStarted = true;
  state.cleanupPromise = (async () => {
    const errors = [];
    const secrets = {
      runtimeKey: state.secrets.runtimeKey,
      proof: state.secrets.proof,
      grantToken: state.secrets.grantToken || state.grant?.issued?.token || "",
    };
    const attempt = async (operation) => {
      try { await operation(); }
      catch (error) { errors.push(safeCleanupErrorCode(error)); }
    };
    const stop = operations.stopChild ?? stopChild;
    const revoke = operations.revokeGrant ?? revokeGrant;
    const remove = operations.removeExact ?? removeExact;
    const removeTree = operations.removeTree ?? ((path) => rm(runtimePath(path), { recursive: true, force: true }));
    const scan = operations.scanRuntimeSecrets ?? ((secretValues, options) => scanRuntimeSecrets(RUNTIME_ROOT, secretValues, options));
    const headerAbsent = operations.headerAbsent ?? (() => pathAbsent(resolve(RUNTIME_ROOT, "mcp-authorization.header")));
    const revoked = operations.grantIsRevoked ?? (() => grantIsRevoked(state.grant));
    for (const child of [...state.children].reverse()) await attempt(() => stop(child));
    await attempt(() => revoke(state.grant));
    await attempt(() => remove(resolve(RUNTIME_ROOT, "mcp-authorization.header")));
    for (const name of ["cloudflared.pid", "tunnel-client.pid", "chatgpt-mcp.pid", "film-core.pid", "review-bus.pid", "runner.pid"]) {
      await attempt(() => remove(resolve(RUNTIME_ROOT, name)));
    }
    for (const name of ["tmp", "cache", "config", "data"]) {
      await attempt(() => removeTree(resolve(RUNTIME_ROOT, name)));
    }
    let purged = { matches: [], errors: [] };
    await attempt(async () => { purged = await scan(secrets, { purge: true }); });
    errors.push(...purged.errors.map((error) => error.code));
    let residual = { matches: [], errors: [] };
    await attempt(async () => { residual = await scan(secrets, { purge: false }); });
    errors.push(...residual.errors.map((error) => error.code));
    let authorizationHeaderAbsent = false;
    let grantRevoked = false;
    await attempt(async () => { authorizationHeaderAbsent = await headerAbsent(); });
    await attempt(async () => { grantRevoked = await revoked(); });
    const survivorPids = state.children.filter((child) => !child.exited).map((child) => child.pid);
    const boundaryVerified = authorizationHeaderAbsent
      && grantRevoked
      && survivorPids.length === 0
      && residual.matches.length === 0;
    const result = {
      attempt: (state.cleanupHistory?.length ?? 0) + 1,
      boundary_verified: boundaryVerified,
      error_codes: [...new Set(errors)],
      authorization_header_absent: authorizationHeaderAbsent,
      grant_revoked: grantRevoked,
      survivor_pids: survivorPids,
      purged_secret_paths: purged.matches,
      residual_secret_paths: residual.matches,
    };
    state.cleanupHistory ??= [];
    state.cleanupHistory.push(result);
    if (boundaryVerified && !deferSecretClearing) {
      state.secrets.runtimeKey = "";
      state.secrets.proof = "";
      state.secrets.grantToken = "";
      if (state.grant?.issued) state.grant.issued.token = "";
    }
    if (strict && (!boundaryVerified || errors.length)) throw new Error(errors[0] ?? "CLEANUP_BOUNDARY_NOT_VERIFIED");
    return result;
  })();
  try {
    return await state.cleanupPromise;
  } finally {
    state.cleanupPromise = null;
  }
}

function assertPostShutdown(psRows, childPids) {
  for (const row of psRows) invariant(!childPids.has(row.pid), "OWNED_PROCESS_SURVIVED:" + row.pid);
  for (const row of psRows) {
    if (row.command.includes(RUNTIME_ROOT)) invariant(row.pid === process.pid, "RUNTIME_PROCESS_SURVIVED:" + row.pid);
  }
}

async function validateRuntimeBudgets() {
  const limits = {
    tmp: { entries: 128, bytes: 268_435_456 },
    cache: { entries: 128, bytes: 67_108_864 },
    config: { entries: 64, bytes: 16_777_216 },
    data: { entries: 64, bytes: 16_777_216 },
    Build: { entries: 256, bytes: 67_108_864 },
  };
  const snapshots = {};
  for (const [name, limit] of Object.entries(limits)) {
    const snapshot = await snapshotTree(resolve(RUNTIME_ROOT, name));
    const contentEntryCount = snapshot.entry_count - 1;
    const minimum = name === "Build" ? 1 : 0;
    invariant(contentEntryCount >= minimum && contentEntryCount <= limit.entries, "RUNTIME_ENTRY_BUDGET_EXCEEDED:" + name);
    invariant(snapshot.total_bytes <= limit.bytes, "RUNTIME_BYTE_BUDGET_EXCEEDED:" + name);
    snapshots[name] = { ...snapshot, content_entry_count: contentEntryCount };
  }
  invariant(!(await readdir(RUNTIME_ROOT)).some((name) => name.startsWith(".tunnel-client.")), "TUNNEL_EXTRACTION_TEMP_SURVIVED");
  return snapshots;
}

async function validateRetainedRuntimeArtifacts(finalAdditions = []) {
  const directories = ["Build", "MCP", "Resources", "Tunnel"];
  const baseFiles = [
    "binding.json", "bound-package.md", "chatgpt-mcp.log", "external-call-audit.json", "external-response.json",
    "film-core.log", "local-probe.json", "process-inventory.json", "readiness.json", "review-bus.log",
    "transient-processes.jsonl", "tunnel-doctor.json", "tunnel-health.url", "tunnel-runtime.log",
  ];
  const expected = [...directories, ...baseFiles, ...finalAdditions].sort();
  const actual = (await readdir(RUNTIME_ROOT)).sort();
  invariant(actual.join("\n") === expected.join("\n"), "RUNTIME_RETAINED_ARTIFACT_SET_MISMATCH");
  for (const name of directories) {
    const metadata = await lstat(resolve(RUNTIME_ROOT, name));
    invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "RUNTIME_RETAINED_DIRECTORY_INVALID:" + name);
  }
  for (const name of [...baseFiles, ...finalAdditions]) await regularFile(resolve(RUNTIME_ROOT, name));
  const nestedSets = {
    MCP: ["audit.jsonl", "grants.json"],
    Resources: ["DeveloperRepository.json", "InternalRuntime.json", "SourceIdentity.json"],
    Tunnel: Object.keys(TUNNEL_PAYLOADS),
  };
  for (const [directory, names] of Object.entries(nestedSets)) {
    const entries = (await readdir(resolve(RUNTIME_ROOT, directory))).sort();
    invariant(entries.join("\n") === [...names].sort().join("\n"), "RUNTIME_RETAINED_SUBTREE_SET_MISMATCH:" + directory);
  }
  const buildSnapshot = await snapshotTree(resolve(RUNTIME_ROOT, "Build"));
  const buildContentEntryCount = buildSnapshot.entry_count - 1;
  invariant(buildContentEntryCount >= 1 && buildContentEntryCount <= 256 && buildSnapshot.total_bytes <= 67_108_864, "RUNTIME_BUILD_BUDGET_EXCEEDED");
  const grants = JSON.parse(await readFile(resolve(RUNTIME_ROOT, "MCP/grants.json"), "utf8"));
  invariant(grants.length === 1 && typeof grants[0].token_hash === "string" && typeof grants[0].revoked_at === "string" && !("token" in grants[0]), "RUNTIME_RETAINED_GRANT_INVALID");
  return {
    root_entry_count: actual.length,
    root_entries: actual,
    mcp_entries: [...nestedSets.MCP],
    resource_entries: [...nestedSets.Resources],
    tunnel_entries: [...nestedSets.Tunnel].sort(),
    build_snapshot: { ...buildSnapshot, content_entry_count: buildContentEntryCount },
    unexpected_entry_count: 0,
  };
}

export async function persistBlockedEvidence(command, response, {
  writeJSON = atomicJSON,
  root = RUNTIME_ROOT,
  now = () => new Date(),
  readPartialAudit = async () => {
    try { return parseAudit(await readFile(resolve(RUNTIME_ROOT, "MCP/audit.jsonl"), "utf8")); }
    catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  },
} = {}) {
  invariant(response?.kind === "BLOCKED", "BLOCKED_RESPONSE_REQUIRED");
  validateExternalConversationBinding(command);
  invariant(
    response.value.platform_schema_discovery_call_count === command.platform_schema_discovery_call_count,
    "BLOCKED_SCHEMA_DISCOVERY_COUNT_MISMATCH",
  );
  const auditRecords = await readPartialAudit();
  const evidence = {
    schema_version: "filmos.phase7.blocked-evidence.v1",
    captured_at: now().toISOString(),
    status: "BLOCKED",
    external_conversation_id: command.external_conversation_id,
    external_message_count: 1,
    blocker_code: response.value.blocker_code,
    failed_or_unobservable_call: response.value.failed_or_unobservable_call,
    completed_filmos_call_count: response.value.completed_filmos_call_count,
    platform_schema_discovery_call_count: response.value.platform_schema_discovery_call_count,
    blindness_preserved: true,
    assessment_generated: false,
    review_bus_assessment_submission_count: 0,
    observed_audit_row_count: auditRecords.length,
    observed_audit_actions: auditRecords.map((record) => record.action),
    observed_audit_sha256: sha256(auditRecords.map((record) => canonicalJSON(record)).join("\n") + (auditRecords.length ? "\n" : "")),
  };
  await writeJSON(resolve(root, "external-response.json"), response.value);
  await writeJSON(resolve(root, "blocked-evidence.json"), evidence);
  return evidence;
}

export async function prepareExternalResponse(command, blockedEvidenceOptions = undefined) {
  const response = validateExternalResponse(command.external_response);
  if (response.kind === "BLOCKED") {
    await persistBlockedEvidence(command, response, blockedEvidenceOptions);
    throw new Error("EXTERNAL_ASSESSMENT_BLOCKED:" + response.value.blocker_code);
  }
  return response;
}

async function completeLifecycle(state, command) {
  const response = await prepareExternalResponse(command);
  const secretScanValues = {
    runtimeKey: state.secrets.runtimeKey,
    proof: state.secrets.proof,
    grantToken: state.grant.issued.token,
  };
  const auditPath = resolve(RUNTIME_ROOT, "MCP/audit.jsonl");
  const auditText = await readFile(auditPath, "utf8");
  const auditRecords = parseAudit(auditText);
  const auditSummary = validateAuditRecords(auditRecords, state.binding.binding);
  const reviewHealth = await reviewBusFinalHealth(state.source, state.identity);
  await scanForSecrets([
    auditPath,
    resolve(RUNTIME_ROOT, "review-bus.log"),
    resolve(RUNTIME_ROOT, "film-core.log"),
    resolve(RUNTIME_ROOT, "chatgpt-mcp.log"),
    resolve(RUNTIME_ROOT, "tunnel-runtime.log"),
    resolve(RUNTIME_ROOT, "tunnel-doctor.json"),
    resolve(RUNTIME_ROOT, "transient-processes.jsonl"),
  ], secretScanValues);
  await atomicJSON(resolve(RUNTIME_ROOT, "external-response.json"), response.value);
  await atomicJSON(resolve(RUNTIME_ROOT, "external-call-audit.json"), {
    schema_version: "filmos.phase7.external-call-audit.v1",
    captured_at: new Date().toISOString(),
    external_conversation_id: command.external_conversation_id,
    external_message_count: 1,
    platform_schema_discovery_call_count: command.platform_schema_discovery_call_count,
    filmos_tool_order: EXTERNAL_TOOL_ORDER,
    audit_summary: auditSummary,
    external_rows: auditRecords.slice(4).map((record) => ({
      event_id: record.event_id,
      recorded_at: record.recorded_at,
      correlation_id: record.correlation_id,
      action: record.action,
      grant_id: record.grant_id,
      project_id: record.project_id,
      outcome: record.outcome,
      output_hash: record.output_hash,
      challenge_id: record.challenge_id,
      request_id: record.request_id,
      tool_name: record.tool_name,
      timestamp: record.timestamp,
      result_hash: record.result_hash,
    })),
  });

  const afterSource = await sourceGate("after");
  invariant(canonicalJSON(afterSource) === canonicalJSON(state.source), "SOURCE_GATE_CHANGED_DURING_CAPTURE");
  const fingerprintResult = await runAudited({
    label: "source-fingerprint-after",
    executable: EXECUTABLES.python.path,
    expectedExecutable: EXECUTABLES.python,
    expectedScript: HELPERS.fingerprint,
    args: [HELPERS.fingerprint.path, "--json"],
    cwd: SOURCE_ROOT,
  });
  const fingerprint = JSON.parse(fingerprintResult.stdout.toString("utf8"));
  invariant(
    fingerprint.source_clean === true
      && fingerprint.git_commit_sha === state.source.head
      && fingerprint.git_tree_sha === state.source.tree
      && fingerprint.source_fingerprint_sha256 === state.identity.source_fingerprint_sha256,
    "SOURCE_FINGERPRINT_CHANGED_DURING_CAPTURE",
  );

  const childPids = new Set(state.children.map((child) => child.pid));
  await cleanupOwned(state, { strict: true });
  const preferencesAfter = await preferenceSnapshot("after");
  invariant(
    preferencesAfter.sha256 === state.preferencesBefore.sha256
      && preferencesAfter.relevant_values_sha256 === state.preferencesBefore.relevant_values_sha256,
    "PREFERENCES_CHANGED",
  );
  const keychainAfter = await keychainMetadata("after");
  invariant(canonicalJSON(keychainAfter) === canonicalJSON(state.keychainBefore), "KEYCHAIN_METADATA_CHANGED");
  const productionAfter = await productionSnapshot();
  assertProductionPreserved(state.productionBefore, productionAfter);
  const lsofAfter = await lsofAudit("post-stop", true);
  for (const pid of parseLsofPids(lsofAfter)) invariant(!childPids.has(pid), "OWNED_OPEN_FILE_OR_PORT_SURVIVED:" + pid);
  const psAfter = await psAudit("post-stop");
  assertPostShutdown(psAfter, childPids);
  const buildSnapshotAfter = await snapshotTree(resolve(RUNTIME_ROOT, "Build"));
  invariant(canonicalJSON(buildSnapshotAfter) === canonicalJSON(state.buildSnapshotBefore), "ISOLATED_BUILD_CHANGED_DURING_CAPTURE");
  const buildLinkProof = await validateBuildLinkTargets(state.build.manifest);
  const transientRecords = parseAudit(await readFile(resolve(RUNTIME_ROOT, "transient-processes.jsonl"), "utf8"));
  const transientSummary = validateTransientRecords(transientRecords, process.pid);
  const nestedDerivationSha256 = sha256(canonicalJSON(state.nestedDerivation));
  const retainedArtifacts = await validateRetainedRuntimeArtifacts();

  const beforeAfter = {
    schema_version: "filmos.phase7.before-after.v1",
    captured_at: new Date().toISOString(),
    immutable_before: immutableDigests(state.productionBefore),
    immutable_after: immutableDigests(productionAfter),
    film_core_before: state.productionBefore.film_core,
    film_core_after: productionAfter.film_core,
    review_bus_before: state.productionBefore.review_bus,
    review_bus_after: productionAfter.review_bus,
    review_bus_permitted_read_receipt_upsert_operations: reviewHealth.read_receipt_operation_count,
    preferences_before_sha256: state.preferencesBefore.sha256,
    preferences_after_sha256: preferencesAfter.sha256,
    keychain_metadata_before: state.keychainBefore,
    keychain_metadata_after: keychainAfter,
    source_before: state.source,
    source_after: afterSource,
    isolated_build_before: state.buildSnapshotBefore,
    isolated_build_after: buildSnapshotAfter,
    build_link_target_proof: buildLinkProof,
    transient_process_summary: transientSummary,
    nested_process_derivation_sha256: nestedDerivationSha256,
    retained_runtime_artifact_allowlist: retainedArtifacts,
    isolated_build_preserved: true,
    user_data_preserved: true,
    app_build_install_relaunch_count: [0, 0, 0],
  };
  await atomicJSON(resolve(RUNTIME_ROOT, "before-after.json"), beforeAfter);

  const evidenceNames = [
    "Build/manifest.json", "tunnel-doctor.json", "readiness.json", "local-probe.json", "binding.json",
    "bound-package.md", "process-inventory.json", "transient-processes.jsonl", "before-after.json",
    "external-call-audit.json", "external-response.json", "MCP/grants.json", "MCP/audit.jsonl",
    "review-bus.log", "film-core.log", "chatgpt-mcp.log", "tunnel-runtime.log",
  ];
  const evidence = {};
  for (const name of evidenceNames) evidence[name] = await sha256File(resolve(RUNTIME_ROOT, name));
  const lifecycle = {
    schema_version: "filmos.phase7.lifecycle-receipt.v1",
    completed_at: new Date().toISOString(),
    status: "PASS",
    source: state.source,
    source_fingerprint_sha256: state.identity.source_fingerprint_sha256,
    project_id: PHASE7.projectId,
    connector_app_id: PHASE7.connectorAppId,
    connector_version_id: PHASE7.connectorVersionId,
    tunnel_id: PHASE7.tunnelId,
    bound_package_sha256: state.binding.bound_package_sha256,
    external_response_sha256: evidence["external-response.json"],
    review_bus_read_receipt_upsert_operations: 6,
    ephemeral_mcp_audit_rows: 11,
    local_probe_tool_calls: 3,
    independent_tool_calls: 7,
    app_build_install_relaunch_count: [0, 0, 0],
    model_api_paid_provider_generation_upload_counts: [0, 0, 0, 0],
    new_connector_tunnel_counts: [0, 0],
    grant_issue_count: 1,
    grant_revoke_count: 1,
    authorization_header_create_count: 1,
    authorization_header_delete_count: 1,
    keychain_secret_read_count: 1,
    keychain_metadata_read_count: 2,
    preferences_read_count: 2,
    source_gate_git_invocation_count: 8,
    runner_direct_transient_invocation_count: 26,
    review_bus_extra_transient_subtree_count: 14,
    total_transient_process_invocations: "52..53",
    total_source_fingerprint_invocation_count: 3,
    total_git_invocation_count: 31,
    nested_process_evidence_standard: "PINNED_CODE_PLUS_READY_POST_ZERO_SURVIVORS_ACCEPTED",
    nested_process_derivation_sha256: nestedDerivationSha256,
    transient_process_summary: transientSummary,
    retained_runtime_artifact_allowlist: retainedArtifacts,
    production_user_data_preserved: true,
    evidence,
  };
  await atomicJSON(resolve(RUNTIME_ROOT, "lifecycle-receipt.json"), lifecycle);
  const lifecycleSha = await sha256File(resolve(RUNTIME_ROOT, "lifecycle-receipt.json"));
  await validateRetainedRuntimeArtifacts(["before-after.json", "lifecycle-receipt.json"]);
  const completion = [
    "CODEX_PHASE7_EXTERNAL_READ_RUNTIME: PASS",
    "SOURCE_HEAD: " + state.source.head,
    "SOURCE_TREE: " + state.source.tree,
    "SOURCE_FINGERPRINT_SHA256: " + state.identity.source_fingerprint_sha256,
    "BOUND_PACKAGE_SHA256: " + state.binding.bound_package_sha256,
    "EXTERNAL_RESPONSE_SHA256: " + evidence["external-response.json"],
    "LIFECYCLE_RECEIPT_SHA256: " + lifecycleSha,
    "TRANSIENT_PROCESS_INVOCATIONS: 52..53",
    "SOURCE_FINGERPRINT_INVOCATIONS: 3",
    "GIT_INVOCATIONS: 31",
    "APP_BUILD_INSTALL_RELAUNCH: 0/0/0",
    "PRODUCTION_WRITES: REVIEW_READ_RECEIPT_UPSERTS_ONLY_6",
    "FORMAL_CHATGPT_ASSESSMENT_SUBMITTED: NO",
  ].join("\n") + "\n";
  await atomicWrite(resolve(RUNTIME_ROOT, "completion-receipt.txt"), completion);
  await validateRetainedRuntimeArtifacts(["before-after.json", "completion-receipt.txt", "lifecycle-receipt.json"]);
  await scanForSecrets([
    resolve(RUNTIME_ROOT, "MCP/grants.json"),
    resolve(RUNTIME_ROOT, "MCP/audit.jsonl"),
    resolve(RUNTIME_ROOT, "binding.json"),
    resolve(RUNTIME_ROOT, "bound-package.md"),
    resolve(RUNTIME_ROOT, "before-after.json"),
    resolve(RUNTIME_ROOT, "chatgpt-mcp.log"),
    resolve(RUNTIME_ROOT, "completion-receipt.txt"),
    resolve(RUNTIME_ROOT, "external-call-audit.json"),
    resolve(RUNTIME_ROOT, "external-response.json"),
    resolve(RUNTIME_ROOT, "film-core.log"),
    resolve(RUNTIME_ROOT, "lifecycle-receipt.json"),
    resolve(RUNTIME_ROOT, "local-probe.json"),
    resolve(RUNTIME_ROOT, "process-inventory.json"),
    resolve(RUNTIME_ROOT, "readiness.json"),
    resolve(RUNTIME_ROOT, "review-bus.log"),
    resolve(RUNTIME_ROOT, "transient-processes.jsonl"),
    resolve(RUNTIME_ROOT, "tunnel-doctor.json"),
    resolve(RUNTIME_ROOT, "tunnel-health.url"),
    resolve(RUNTIME_ROOT, "tunnel-runtime.log"),
  ], secretScanValues);
  secretScanValues.runtimeKey = "";
  secretScanValues.proof = "";
  secretScanValues.grantToken = "";
  return { lifecycle, lifecycleSha };
}

export async function failureReceipt(state, error, { root = RUNTIME_ROOT, operations = {} } = {}) {
  if (!state.rootReady) return;
  const secretScanValues = {
    runtimeKey: state.secrets.runtimeKey,
    proof: state.secrets.proof,
    grantToken: state.secrets.grantToken || state.grant?.issued?.token || "",
  };
  const cleanup = operations.cleanupOwned ?? ((targetState) => cleanupOwned(targetState, { deferSecretClearing: true }));
  const processAudit = operations.auditPostCleanupProcesses ?? auditPostCleanupProcesses;
  const remove = operations.removeExact ?? removeExact;
  const snapshotProduction = operations.productionSnapshot ?? productionSnapshot;
  const assertProduction = operations.assertProductionPreserved ?? assertProductionPreserved;
  const snapshotReviewBus = operations.reviewBusFailureBoundarySnapshot ?? reviewBusFailureBoundarySnapshot;
  const assertReviewBus = operations.assertReviewBusFailurePreserved ?? assertReviewBusFailurePreserved;
  const scanRuntime = operations.scanRuntimeSecrets ?? scanRuntimeSecrets;
  const writeJSON = operations.writeJSON ?? atomicJSON;
  const scanReceipt = operations.scanForSecrets ?? scanForSecrets;
  const cleanupResults = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let cleanupResult;
    try {
      cleanupResult = await cleanup(state, attempt + 1);
    } catch (cleanupError) {
      cleanupResult = {
        attempt: attempt + 1,
        boundary_verified: false,
        error_codes: [safeCleanupErrorCode(cleanupError)],
        authorization_header_absent: false,
        grant_revoked: false,
        survivor_pids: state.children.filter((child) => !child.exited).map((child) => child.pid),
        purged_secret_paths: [],
        residual_secret_paths: [],
      };
    }
    let osProcessBoundary;
    try {
      osProcessBoundary = await processAudit(state, attempt + 1);
    } catch (processError) {
      osProcessBoundary = {
        schema_version: "filmos.phase7.post-cleanup-process-boundary.v1",
        audit_complete: false,
        boundary_verified: false,
        tracked_pid_count: state.children.length,
        tracked_pid_survivors: [],
        conditional_cloudflared_survivor_pids: [],
        runtime_root_reference_pids: [],
        runtime_root_or_reserved_port_open_pids: [],
        survivor_pids: [],
        error_code: safeCleanupErrorCode(processError),
      };
    }
    const localBoundaryVerified = cleanupResult.boundary_verified === true;
    const result = {
      ...cleanupResult,
      attempt: attempt + 1,
      local_boundary_verified: localBoundaryVerified,
      os_process_boundary: osProcessBoundary,
      boundary_verified: localBoundaryVerified && osProcessBoundary.boundary_verified === true,
      error_codes: [...new Set([
        ...(cleanupResult.error_codes ?? []),
        ...(osProcessBoundary.error_code ? [osProcessBoundary.error_code] : []),
      ])],
    };
    cleanupResults.push(result);
    if (result.boundary_verified) break;
  }
  const receiptErrors = [];
  try { await remove(resolve(root, "completion-receipt.txt")); }
  catch (cleanupError) { receiptErrors.push(safeCleanupErrorCode(cleanupError)); }
  const productionPreservationApplicable = Boolean(state.productionBefore || state.reviewBusBoundaryBefore);
  let immutableAndFilmCorePreservationVerified = false;
  if (state.productionBefore) {
    try {
      assertProduction(state.productionBefore, await snapshotProduction());
      immutableAndFilmCorePreservationVerified = true;
    } catch (preservationError) {
      receiptErrors.push(safeCleanupErrorCode(preservationError));
    }
  }
  let reviewBusPreservationVerified = false;
  let reviewBusPreservation = null;
  if (state.reviewBusBoundaryBefore) {
    try {
      reviewBusPreservation = assertReviewBus(state.reviewBusBoundaryBefore, await snapshotReviewBus());
      reviewBusPreservationVerified = true;
    } catch (preservationError) {
      receiptErrors.push(safeCleanupErrorCode(preservationError));
    }
  } else if (state.productionBefore) {
    receiptErrors.push("REVIEW_BUS_FAILURE_BASELINE_MISSING");
  }
  const productionPreservationVerified = Boolean(
    state.productionBefore
      && state.reviewBusBoundaryBefore
      && immutableAndFilmCorePreservationVerified
      && reviewBusPreservationVerified,
  );
  let finalSecretScan = { matches: [], errors: [] };
  try {
    const purgeResult = await scanRuntime(root, secretScanValues, { purge: true });
    receiptErrors.push(...purgeResult.errors.map((item) => item.code));
    finalSecretScan = await scanRuntime(root, secretScanValues);
    receiptErrors.push(...finalSecretScan.errors.map((item) => item.code));
  } catch (scanError) {
    receiptErrors.push(safeCleanupErrorCode(scanError));
    finalSecretScan = { matches: ["SECRET_SCAN_INCOMPLETE"], errors: [] };
  }
  const finalCleanup = cleanupResults.at(-1) ?? null;
  const finalProcessBoundary = finalCleanup?.os_process_boundary ?? {
    audit_complete: false,
    boundary_verified: false,
    tracked_pid_survivors: [],
    conditional_cloudflared_survivor_pids: [],
    runtime_root_reference_pids: [],
    runtime_root_or_reserved_port_open_pids: [],
    survivor_pids: [],
  };
  const cleanupBoundaryVerified = finalCleanup?.boundary_verified === true
    && finalSecretScan.matches.length === 0
    && finalSecretScan.errors.length === 0;
  if (cleanupBoundaryVerified) {
    state.secrets.runtimeKey = "";
    state.secrets.proof = "";
    state.secrets.grantToken = "";
    if (state.grant?.issued) state.grant.issued.token = "";
  }
  const value = {
    schema_version: "filmos.phase7.lifecycle-receipt.v1",
    completed_at: new Date().toISOString(),
    status: "FAIL_CLOSED",
    error_code: String(error?.message || error).split(":")[0].slice(0, 160),
    blocker_code: String(error?.message || error).startsWith("EXTERNAL_ASSESSMENT_BLOCKED:")
      ? String(error.message).split(":")[1]?.slice(0, 160) ?? null
      : null,
    source: state.source || null,
    assessment_generated: false,
    review_bus_assessment_submission_count: 0,
    cleanup_attempt_count: cleanupResults.length,
    cleanup_boundary_verified: cleanupBoundaryVerified,
    cleanup_results: cleanupResults,
    cleanup_error_codes: [...new Set([
      ...cleanupResults.flatMap((result) => result.error_codes ?? []),
      ...receiptErrors,
    ])],
    final_residual_secret_paths: finalSecretScan.matches,
    final_process_audit_complete: finalProcessBoundary.audit_complete === true,
    final_process_boundary_verified: finalProcessBoundary.boundary_verified === true,
    final_owned_process_survivor_pids: finalProcessBoundary.survivor_pids,
    final_tracked_process_survivor_pids: finalProcessBoundary.tracked_pid_survivors,
    final_conditional_cloudflared_survivor_pids: finalProcessBoundary.conditional_cloudflared_survivor_pids,
    final_runtime_root_reference_pids: finalProcessBoundary.runtime_root_reference_pids,
    final_runtime_root_or_reserved_port_open_pids: finalProcessBoundary.runtime_root_or_reserved_port_open_pids,
    authorization_header_absent: finalCleanup?.authorization_header_absent ?? false,
    grant_revoked: finalCleanup?.grant_revoked ?? (state.grant === null),
    production_preservation_applicable: productionPreservationApplicable,
    immutable_and_film_core_preservation_verified: immutableAndFilmCorePreservationVerified,
    review_bus_preservation_applicable: Boolean(state.reviewBusBoundaryBefore),
    review_bus_preservation_verified: reviewBusPreservationVerified,
    review_bus_preservation: reviewBusPreservation,
    production_preservation_verified: productionPreservationVerified,
    app_build_install_relaunch_count: [0, 0, 0],
    model_api_paid_provider_generation_upload_counts: [0, 0, 0, 0],
    new_connector_tunnel_counts: [0, 0],
    automatic_retry_count: Math.max(0, cleanupResults.length - 1),
  };
  try {
    await writeJSON(resolve(root, "lifecycle-receipt.json"), value);
    await scanReceipt([resolve(root, "lifecycle-receipt.json")], secretScanValues);
  } catch (receiptError) {
    await remove(resolve(root, "lifecycle-receipt.json")).catch(() => undefined);
    process.stderr.write("FILMOS_PHASE7_FAILURE_RECEIPT_ERROR " + safeCleanupErrorCode(receiptError) + "\n");
  }
  return value;
}

export async function main() {
  invariant(
    process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "start"),
    "USAGE:filmos-external-read-runtime [start]",
  );
  const state = {
    rootReady: false,
    cleanupStarted: false,
    children: [],
    grant: null,
    secrets: { runtimeKey: "", proof: "", challenge: "", grantToken: "" },
    source: null,
    identity: null,
  };
  const signalHandler = async () => {
    await failureReceipt(state, new Error("INTERRUPTED"));
    process.exit(130);
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  try {
    await prepareRoot();
    state.rootReady = true;
    state.source = await sourceGate("before");
    state.nestedDerivation = {
      ...await validateNestedProcessDerivation(),
      captured_at: new Date().toISOString(),
    };
    state.productionBefore = await productionSnapshot();
    state.reviewBusBoundaryBefore = reviewBusFailureBoundarySnapshot();
    assertReviewBusFailurePreserved(state.reviewBusBoundaryBefore, state.reviewBusBoundaryBefore);
    assertPhysical(state.productionBefore.review_bus.main, DATABASE_BASELINES.reviewBus.main, "REVIEW_BUS_MAIN");
    assertPhysical(state.productionBefore.review_bus.wal, DATABASE_BASELINES.reviewBus.wal, "REVIEW_BUS_WAL");
    assertPhysical(state.productionBefore.review_bus.shm, DATABASE_BASELINES.reviewBus.shm, "REVIEW_BUS_SHM");
    assertPhysical(state.productionBefore.film_core.main, DATABASE_BASELINES.filmCore.main, "FILM_CORE_MAIN");
    assertPhysical(state.productionBefore.film_core.wal, DATABASE_BASELINES.filmCore.wal, "FILM_CORE_WAL");
    assertPhysical(state.productionBefore.film_core.shm, DATABASE_BASELINES.filmCore.shm, "FILM_CORE_SHM");
    await lsofAudit("pre-start", false);
    state.identity = await generateSourceIdentity(state.source);
    const build = await buildIsolatedMcp();
    state.build = build;
    state.buildSnapshotBefore = await snapshotTree(resolve(RUNTIME_ROOT, "Build"));
    await extractTunnel();
    state.preferencesBefore = await preferenceSnapshot("before");
    state.keychainBefore = await keychainMetadata("before");
    state.secrets.runtimeKey = await readRuntimeKeyOnce();
    state.secrets.proof = "proof_" + randomBytes(32).toString("base64url");
    state.secrets.challenge = "live_" + randomBytes(24).toString("base64url");
    state.grant = await issueGrant(build, state);
    const services = await startServices(state.source, state.identity, build, state.secrets, state.children);
    const tunnel = await startTunnel(state.grant, state.secrets, state.children);
    const filmContext = await currentFilmProjectContext();
    const liveContext = bindLiveContext(state.preferencesBefore.validated.context, state.identity, filmContext);
    const published = await publishLiveContext(state.grant, state.secrets, liveContext);
    const local = await localProbe(state.grant, state.secrets, state.identity);
    state.binding = await createBoundPackage(state.grant, state.secrets, published, local, state.identity);
    const readyLsof = await lsofAudit("ready", true);
    const readyPs = await psAudit("ready");
    const inventory = await validateReadyProcesses(state.children, readyLsof, readyPs);
    state.processInventory = inventory;
    const nestedDerivationSha256 = sha256(canonicalJSON(state.nestedDerivation));
    const runtimeBudgets = await validateRuntimeBudgets();
    await atomicJSON(resolve(RUNTIME_ROOT, "process-inventory.json"), {
      ...inventory,
      nested_process_derivation_sha256: nestedDerivationSha256,
      nested_process_derivation: state.nestedDerivation,
      runtime_budget_snapshots: runtimeBudgets,
    });
    await atomicJSON(resolve(RUNTIME_ROOT, "readiness.json"), {
      schema_version: "filmos.phase7.readiness.v1",
      ready_at: new Date().toISOString(),
      status: "READY_FOR_ONE_EXTERNAL_MESSAGE",
      source: state.source,
      source_fingerprint_sha256: state.identity.source_fingerprint_sha256,
      connector_app_id: PHASE7.connectorAppId,
      connector_version_id: PHASE7.connectorVersionId,
      tunnel_id: PHASE7.tunnelId,
      tunnel_health_url: tunnel.healthURL,
      project_id: PHASE7.projectId,
      grant_id: state.grant.issued.grant.grant_id,
      grant_expires_at: state.grant.issued.grant.expires_at,
      live_context_receipt_id: state.binding.binding.context_receipt_id,
      live_context_expires_at: state.binding.binding.live_context_expires_at,
      bound_package_path: state.binding.bound_package_path,
      bound_package_sha256: state.binding.bound_package_sha256,
      process_inventory_sha256: await sha256File(resolve(RUNTIME_ROOT, "process-inventory.json")),
      nested_process_derivation_sha256: nestedDerivationSha256,
      total_transient_process_invocations_on_success: "52..53",
      runtime_budget_snapshot_sha256: sha256(canonicalJSON(runtimeBudgets)),
      review_bus_health_sha256: sha256(canonicalJSON(services.reviewHealth)),
      film_core_health_sha256: sha256(canonicalJSON(services.filmHealth)),
      mcp_health_sha256: sha256(canonicalJSON(services.mcpHealth)),
    });
    const command = await waitForExternalCommand();
    const completed = await completeLifecycle(state, command);
    process.stdout.write(JSON.stringify({
      status: "PASS",
      lifecycle_receipt: resolve(RUNTIME_ROOT, "lifecycle-receipt.json"),
      lifecycle_receipt_sha256: completed.lifecycleSha,
    }) + "\n");
  } catch (error) {
    await failureReceipt(state, error);
    process.stderr.write("FILMOS_PHASE7_FAIL_CLOSED " + String(error?.message || error).slice(0, 240) + "\n");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
  }
}

export function isExecutedAsMain(moduleUrl, argvPath) {
  return Boolean(argvPath) && fileURLToPath(moduleUrl) === resolve(argvPath);
}

if (isExecutedAsMain(import.meta.url, process.argv[1])) await main();
