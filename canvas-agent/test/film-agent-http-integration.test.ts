import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MemoryFilmAgentAuditSink } from "../src/film/audit.js";
import type { FilmCommand } from "../src/film/contracts.js";
import {
  FilmAgentGateway,
  FilmAgentGatewayError,
  type FilmCanvasObservationSource,
} from "../src/film/gateway.js";
import { HttpFilmCoreTransport } from "../src/film/http.js";

const canvasAgentRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(canvasAgentRoot, "..");
const coreSource = path.resolve(repositoryRoot, "film-core/src");
const sidecarScript = path.resolve(
  canvasAgentRoot,
  "test/fixtures/film-core-http-sidecar.py",
);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const initialStates = {
  creative_stage: "draft",
  execution_state: "not_started",
  review_state: "not_reviewed",
  lock_state: "unlocked",
  delivery_state: "not_ready",
  stale_state: "fresh",
};

class MutableCanvas implements FilmCanvasObservationSource {
  observation = { revision: 7, stateHash: "c".repeat(16) };

  async current() {
    return { ...this.observation };
  }
}

test("real HTTP Film Core Sidecar completes MCP Read -> Preview -> Apply", async (context) => {
  const sidecar = await startSidecar();
  context.after(() => sidecar.stop());
  const canvas = new MutableCanvas();
  const audit = new MemoryFilmAgentAuditSink();
  const gateway = createGateway(sidecar.transport, canvas, audit);
  const hostProjectId = "host-project-http-golden";

  const projectRead = readObservation(
    await gateway.callTool("film_project_get_context", {
      host_project_id: hostProjectId,
    }),
  );
  assert.equal(projectRead.expected_version, null);
  assert.match(projectRead.expected_content_hash, HASH_PATTERN);
  const createCommand: FilmCommand = {
    command_type: "entity.create",
    target_id: null,
    expected_version: 0,
    payload: {
      entity_type: "film_project_extension",
      host: { host_project_id: hostProjectId },
      states: initialStates,
    },
  };
  const createGuards = guardsFrom(projectRead);
  const createPreview = previewReceipt(
    await gateway.callTool("film_command_preview", {
      command: createCommand,
      guards: createGuards,
    }),
  );
  const created = appliedEntity(
    await gateway.callTool("film_command_apply", {
      command: createCommand,
      guards: createGuards,
      preview_receipt: createPreview,
    }),
  );
  assert.match(created.ref.film_entity_id, UUID4_PATTERN);
  assert.equal(created.ref.version, 1);
  assert.match(created.ref.content_hash, HASH_PATTERN);

  const entityRead = readObservation(
    await gateway.callTool("film_entity_get", {
      film_entity_id: created.ref.film_entity_id,
    }),
  );
  const updateCommand: FilmCommand = {
    command_type: "entity.set_states",
    target_id: created.ref.film_entity_id,
    expected_version: entityRead.expected_version as number,
    payload: {
      states: { ...initialStates, creative_stage: "authored" },
    },
  };
  const updateGuards = guardsFrom(entityRead);
  const updatePreview = previewReceipt(
    await gateway.callTool("film_command_preview", {
      command: updateCommand,
      guards: updateGuards,
    }),
  );
  const updated = appliedEntity(
    await gateway.callTool("film_command_apply", {
      command: updateCommand,
      guards: updateGuards,
      preview_receipt: updatePreview,
    }),
  );
  assert.equal(updated.ref.film_entity_id, created.ref.film_entity_id);
  assert.equal(updated.ref.version, 2);
  assert.notEqual(updated.ref.content_hash, created.ref.content_hash);
  assert.equal(updated.states.creative_stage, "authored");

  const auditResult = asRecord(
    await gateway.callTool("film_audit_events_get", {
      target_id: created.ref.film_entity_id,
      limit: 10,
    }),
  );
  assert.equal(Array.isArray(auditResult.data), true);
  assert.equal((auditResult.data as unknown[]).length, 2);
  assert.deepEqual(
    audit.records.map((record) => record.outcome),
    [
      "read",
      "previewed",
      "dispatched",
      "applied",
      "read",
      "previewed",
      "dispatched",
      "applied",
      "read",
    ],
  );
  assert.equal(fs.existsSync(sidecar.databasePath), true);
});

test("real HTTP boundary fails closed on stale Film/Canvas guards and Agent approval", async (context) => {
  const sidecar = await startSidecar();
  context.after(() => sidecar.stop());
  const canvas = new MutableCanvas();
  const audit = new MemoryFilmAgentAuditSink();
  const gateway = createGateway(sidecar.transport, canvas, audit);
  const createCommand: FilmCommand = {
    command_type: "entity.create",
    target_id: null,
    expected_version: 0,
    actor_kind: "codex",
    payload: {
      entity_type: "film_project_extension",
      host: { host_project_id: "host-project-http-conflict" },
      states: initialStates,
    },
  };
  const created = appliedEntity(
    await sidecar.transport.applyCommand(createCommand),
  );
  const entityId = created.ref.film_entity_id;
  const read = readObservation(
    await gateway.callTool("film_entity_get", { film_entity_id: entityId }),
  );
  const guards = guardsFrom(read);
  const updateCommand: FilmCommand = {
    command_type: "entity.set_states",
    target_id: entityId,
    expected_version: 1,
    payload: {
      states: { ...initialStates, creative_stage: "authored" },
    },
  };

  await assertGatewayError(
    () =>
      gateway.callTool("film_command_preview", {
        command: { ...updateCommand, expected_version: 2 },
        guards,
      }),
    "version_guard_mismatch",
  );
  await assertGatewayError(
    () =>
      gateway.callTool("film_command_preview", {
        command: updateCommand,
        guards: { ...guards, expected_content_hash: "f".repeat(64) },
      }),
    "content_hash_mismatch",
  );

  const preview = previewReceipt(
    await gateway.callTool("film_command_preview", {
      command: updateCommand,
      guards,
    }),
  );
  await sidecar.transport.applyCommand({
    ...updateCommand,
    actor_kind: "codex",
  });
  await assertGatewayError(
    () =>
      gateway.callTool("film_command_apply", {
        command: updateCommand,
        guards,
        preview_receipt: preview,
      }),
    "film_state_changed",
  );
  await assertGatewayError(
    () => sidecar.transport.applyCommand(updateCommand),
    "version_conflict",
  );

  const currentRead = readObservation(
    await gateway.callTool("film_entity_get", { film_entity_id: entityId }),
  );
  const currentGuards = guardsFrom(currentRead);
  const nextCommand: FilmCommand = {
    ...updateCommand,
    expected_version: 2,
    payload: {
      states: { ...initialStates, creative_stage: "reviewed" },
    },
  };
  const nextPreview = previewReceipt(
    await gateway.callTool("film_command_preview", {
      command: nextCommand,
      guards: currentGuards,
    }),
  );
  canvas.observation = { revision: 8, stateHash: currentGuards.expected_canvas_state_hash };
  await assertGatewayError(
    () =>
      gateway.callTool("film_command_apply", {
        command: nextCommand,
        guards: currentGuards,
        preview_receipt: nextPreview,
      }),
    "canvas_revision_conflict",
  );
  canvas.observation = {
    revision: currentGuards.expected_canvas_revision,
    stateHash: "d".repeat(16),
  };
  await assertGatewayError(
    () =>
      gateway.callTool("film_command_apply", {
        command: nextCommand,
        guards: currentGuards,
        preview_receipt: nextPreview,
      }),
    "canvas_hash_conflict",
  );

  const forbidden: FilmCommand = {
    ...nextCommand,
    payload: {
      states: {
        ...initialStates,
        creative_stage: "locked",
        review_state: "approved",
        lock_state: "locked",
      },
    },
  };
  await assertGatewayError(
    () =>
      gateway.callTool("film_command_preview", {
        command: forbidden,
        guards: currentGuards,
      }),
    "human_authority_required",
  );
  const coreAudit = (await sidecar.transport.getAuditEvents({
    targetId: entityId,
    limit: 10,
  })) as unknown[];
  assert.equal(coreAudit.length, 2, "denied Agent writes never reach Core audit");
  assert.equal(audit.records.at(-1)?.outcome, "denied");
  assert.equal(audit.records.at(-1)?.error_code, "human_authority_required");
});

function createGateway(
  transport: HttpFilmCoreTransport,
  canvas: MutableCanvas,
  audit: MemoryFilmAgentAuditSink,
) {
  return new FilmAgentGateway({
    identity: { actorKind: "codex", actorId: "codex-http-integration" },
    transport,
    canvas,
    audit,
  });
}

type ReadObservation = {
  read_receipt: string;
  expected_version: number | null;
  expected_content_hash: string;
  expected_canvas_revision: number;
  expected_canvas_state_hash: string;
};

function readObservation(value: unknown): ReadObservation {
  return asRecord(asRecord(value).observation) as ReadObservation;
}

function guardsFrom(read: ReadObservation) {
  return {
    read_receipt: read.read_receipt,
    expected_content_hash: read.expected_content_hash,
    expected_canvas_revision: read.expected_canvas_revision,
    expected_canvas_state_hash: read.expected_canvas_state_hash,
  };
}

function previewReceipt(value: unknown) {
  const receipt = asRecord(value).preview_receipt;
  assert.equal(typeof receipt, "string");
  assert.match(receipt as string, UUID4_PATTERN);
  return receipt as string;
}

type CoreEntity = {
  ref: { film_entity_id: string; version: number; content_hash: string };
  states: Record<string, string>;
};

function appliedEntity(value: unknown): CoreEntity {
  const source = asRecord(value);
  const data = source.data ? asRecord(source.data) : source;
  return asRecord(data.entity) as CoreEntity;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function assertGatewayError(
  operation: () => Promise<unknown>,
  code: string,
) {
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof FilmAgentGatewayError && error.code === code,
  );
}

type RunningSidecar = {
  transport: HttpFilmCoreTransport;
  databasePath: string;
  stop(): Promise<void>;
};

async function startSidecar(): Promise<RunningSidecar> {
  const python = resolvePython();
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "filmos-agent-http-"),
  );
  const databasePath = path.join(temporaryRoot, "film-core.sqlite");
  const port = await unusedLoopbackPort();
  const child = spawn(
    python,
    [sidecarScript, "--database", databasePath, "--port", String(port)],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PYTHONPATH: [coreSource, process.env.PYTHONPATH]
          .filter(Boolean)
          .join(path.delimiter),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stdout?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  const baseUrl = `http://127.0.0.1:${port}/film`;
  try {
    await waitForHealth(baseUrl, child, () => logs);
  } catch (error) {
    await stopChild(child);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    transport: new HttpFilmCoreTransport(baseUrl),
    databasePath,
    async stop() {
      await stopChild(child);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
}

function resolvePython() {
  const candidates = [
    process.env.FILMOS_CORE_PYTHON,
    path.resolve(repositoryRoot, "film-core/.venv/bin/python"),
    "python3",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate,
      [
        "-c",
        "import fastapi, pydantic, uvicorn; print(fastapi.__version__, pydantic.__version__, uvicorn.__version__)",
      ],
      { encoding: "utf8" },
    );
    if (probe.status === 0) return candidate;
  }
  throw new Error(
    "Film Core HTTP integration requires the film-core Python dependencies; set FILMOS_CORE_PYTHON or install film-core[test]",
  );
}

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcess,
  logs: () => string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Film Core test Sidecar exited early: ${logs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The loopback listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Film Core test Sidecar did not become ready: ${logs()}`);
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    deadline.unref();
    child.once("exit", () => {
      clearTimeout(deadline);
      resolve();
    });
  });
}
