import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { MemoryAuditSink } from "../src/audit.js";
import { MemoryFilmOSReadDataSource } from "../src/data-source.js";
import { MemoryProjectGrantStore } from "../src/grants.js";
import { createFilmOSChatGPTApp, EXTERNAL_READ_TOOL_ALLOWLIST, FILMOS_CHATGPT_RUNTIME_MODE_EXTERNAL_READ, isExecutedAsMain, startFromEnvironment } from "../src/server.js";
import { projectA, projects } from "./fixture.js";

test("server entrypoint recognizes decoded paths containing spaces and Unicode", () => {
  const rawPath = "/tmp/短剧/FilmOS Studio/dist/server.js";
  assert.equal(isExecutedAsMain(pathToFileURL(rawPath).href, rawPath), true);
  assert.equal(isExecutedAsMain(pathToFileURL(rawPath).href, "/tmp/other/server.js"), false);
  assert.equal(isExecutedAsMain(pathToFileURL(rawPath).href, undefined), false);
});

test("server PID receipt is written only after listen and removed on close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "filmos-chatgpt-pid-"));
  const pidFile = join(directory, "chatgpt-mcp.pid");
  try {
    const started = await startFromEnvironment({
      FILMOS_CHATGPT_APP_ENABLED: "true",
      FILMOS_CHATGPT_HOST: "127.0.0.1",
      FILMOS_CHATGPT_PORT: "0",
      FILMOS_CHATGPT_LOCAL_DIR: directory,
      FILMOS_CHATGPT_PID_FILE: pidFile,
    });
    assert.equal((await readFile(pidFile, "utf8")).trim(), String(process.pid));
    await new Promise<void>((resolveClose, rejectClose) => started.httpServer.close((error) => error ? rejectClose(error) : resolveClose()));
    await assert.rejects(stat(pidFile), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("external-read entrypoint rejects an alternate runtime root before creating state", async () => {
  await assert.rejects(
    () => startFromEnvironment({
      FILMOS_CHATGPT_RUNTIME_MODE: FILMOS_CHATGPT_RUNTIME_MODE_EXTERNAL_READ,
      FILMOS_EXTERNAL_READ_RUNTIME_ROOT: "/tmp/alternate-filmos-runtime",
    }),
    /EXTERNAL_READ_RUNTIME_ROOT_REQUIRED/,
  );
});

test("external-read HTTP profile denies unlisted routes before parsing and accepts live context exactly once", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "external-read-http", 60 * 60_000);
  const audit = new MemoryAuditSink();
  const instance = createFilmOSChatGPTApp({
    enabled: true,
    runtimeMode: FILMOS_CHATGPT_RUNTIME_MODE_EXTERNAL_READ,
    readToolsEnabled: true,
    widgetsEnabled: false,
    proposalHandoffEnabled: false,
    grants,
    dataSource: new MemoryFilmOSReadDataSource(projects),
    audit,
    secureTunnelProof: "external-read-proof",
    reviewRead: { async read(tool, input, project) { return { tool, input, project_id: project }; } },
    toolAllowlist: EXTERNAL_READ_TOOL_ALLOWLIST,
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseURL = `http://127.0.0.1:${address.port}`;
  const authorization = `Bearer ${issued.token}`;
  const context = {
    project_id: projectA,
    content_unit_id: "unit-a",
    scene_id: null,
    director_unit_id: null,
    shot_id: null,
    canvas_id: "canvas-a",
    selected_node_ids: [],
    visible_node_summaries: [],
    asset_version_ids: [],
    canvas_revision: 1,
    canvas_state_hash: "a".repeat(64),
    film_expected_version: 1,
    film_content_hash: "b".repeat(64),
    context_receipt_id: `filmos-live:${"c".repeat(64)}`,
    source_identity: {
      schema_version: "1.0.0",
      build_id: "external-read-test",
      repository: "maiyadiu/filmos-studio",
      git_commit_sha: "d".repeat(40),
      git_tree_sha: "e".repeat(40),
      source_fingerprint_sha256: "f".repeat(64),
      release_channel: "development",
      source_clean: true,
    },
  };
  try {
    const health = await (await fetch(`${baseURL}/health`)).json() as any;
    assert.equal(health.runtime_mode, FILMOS_CHATGPT_RUNTIME_MODE_EXTERNAL_READ);
    assert.deepEqual(health.mcp_tool_names, [...EXTERNAL_READ_TOOL_ALLOWLIST]);
    assert.deepEqual(
      [health.mcp_read_tool_count, health.mcp_write_tool_count, health.mcp_paid_tool_count, health.mcp_destructive_tool_count],
      [7, 0, 0, 0],
    );
    const denied = await fetch(`${baseURL}/handoff/grants/revoke`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: "{",
    });
    assert.equal(denied.status, 404);
    assert.equal((await denied.json() as any).code, "EXTERNAL_READ_RUNTIME_ROUTE_DENIED");
    assert.equal(audit.records.length, 0);
    const queryDenied = await fetch(`${baseURL}/mcp?unexpected=1`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: "{",
    });
    assert.equal(queryDenied.status, 404);
    assert.equal((await queryDenied.json() as any).code, "EXTERNAL_READ_RUNTIME_ROUTE_DENIED");
    assert.equal(audit.records.length, 0);

    const publish = () => fetch(`${baseURL}/handoff/live-context`, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ challenge_id: "live_external_12345678", context }),
    });
    assert.equal((await publish()).status, 200);
    const duplicate = await publish();
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json() as any).code, "EXTERNAL_READ_LIVE_CONTEXT_ALREADY_PUBLISHED");
    assert.equal(instance.getLiveContextPublishCount(), 1);
    assert.equal(audit.records.filter((record) => record.action === "handoff.live_context.publish").length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
