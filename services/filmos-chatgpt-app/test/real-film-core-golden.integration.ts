import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { MemoryAuditSink } from "../src/audit.js";
import { FilmCoreReadClient } from "../src/data-source.js";
import { MemoryProjectGrantStore } from "../src/grants.js";
import { createFilmOSChatGPTApp } from "../src/server.js";
import { buildWidgetModel } from "../src/widget-model.js";

const execFileAsync = promisify(execFile);
const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(SERVICE_ROOT, "../..");
const SIGNING_SECRET = "track14-real-golden-signing-secret-123456";

test("Golden ChatGPT A/B use real Film Core SQLite/HTTP and the Python Preview importer", async () => {
  const python = process.env.FILMOS_TEST_PYTHON;
  assert.ok(python, "FILMOS_TEST_PYTHON must point to the Film Core test virtualenv Python");
  const temporary = await mkdtemp(resolve(tmpdir(), "filmos-chatgpt-real-golden-"));
  const databasePath = resolve(temporary, "film-core.sqlite");
  const seeder = resolve(SERVICE_ROOT, "test/fixtures/seed_real_film_core.py");
  const seeded = await execFileAsync(python, [seeder, databasePath], { cwd: REPOSITORY_ROOT, maxBuffer: 1024 * 1024 });
  const fixture = JSON.parse(seeded.stdout.trim().split("\n").at(-1)!) as Record<string, string>;
  const corePort = await reservePort();
  const core = spawn(python, ["-m", "uvicorn", "film_production_core.api:create_app", "--factory", "--host", "127.0.0.1", "--port", String(corePort), "--log-level", "warning"], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, PYTHONPATH: resolve(REPOSITORY_ROOT, "film-core/src"), FILMOS_CORE_DB_PATH: databasePath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let coreLogs = "";
  core.stdout?.on("data", (chunk) => { coreLogs += String(chunk); });
  core.stderr?.on("data", (chunk) => { coreLogs += String(chunk); });

  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(fixture.project_id, "track14-real-golden");
  const audit = new MemoryAuditSink();
  const instance = createFilmOSChatGPTApp({
    enabled: true,
    readToolsEnabled: true,
    widgetsEnabled: true,
    proposalHandoffEnabled: true,
    proposalSigningSecret: SIGNING_SECRET,
    grants,
    dataSource: new FilmCoreReadClient(`http://127.0.0.1:${corePort}`),
    audit,
  });
  const mcpHttpServer = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((done) => mcpHttpServer.once("listening", done));
  const mcpPort = (mcpHttpServer.address() as { port: number }).port;
  const client = new Client({ name: "track14-real-golden", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } });

  try {
    await waitForHealth(`http://127.0.0.1:${corePort}/health`, core, () => coreLogs);
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "filmos_approval_create"), false);
    assert.equal(tools.tools.find((tool) => tool.name === "filmos_get_project_context")?._meta?.ui, undefined);
    assert.equal((tools.tools.find((tool) => tool.name === "filmos_render_project_overview")?._meta?.ui as any).resourceUri, "ui://filmos/project-overview-v1.html");

    const search = await call(client, "search", { query: fixture.unit_id });
    const searchResult = JSON.parse(search.content[0].text).results[0];
    assert.ok(searchResult.id.startsWith(`filmos://project/${fixture.project_id}/`));
    const fetched = await call(client, "fetch", { id: searchResult.id });
    assert.equal(JSON.parse(fetched.content[0].text).id, searchResult.id);

    const project = await call(client, "filmos_get_project_context", {});
    const unit = await call(client, "filmos_get_content_unit_context", { host_unit_id: fixture.unit_id });
    const shot = await call(client, "filmos_get_shot_context", { host_shot_id: fixture.shot_id });
    const asset = await call(client, "filmos_get_asset_version", { film_entity_id: fixture.asset_id });
    const scene = await call(client, "filmos_get_scene_twin_summary", { film_entity_id: fixture.scene_twin_id });
    const attempts = await call(client, "filmos_get_generation_attempts", {});
    const review = await call(client, "filmos_get_review_queue", {});
    const blockers = await call(client, "filmos_get_blockers", {});
    const changes = await call(client, "filmos_get_recent_changes", { limit: 20 });
    assert.equal(project.structuredContent.data.film_project.host.host_project_id, fixture.project_id);
    assert.equal(unit.structuredContent.data.host.host_unit_id, fixture.unit_id);
    assert.equal(shot.structuredContent.data.host.host_shot_id, fixture.shot_id);
    assert.equal(asset.structuredContent.data.ref.film_entity_id, fixture.asset_id);
    assert.equal(scene.structuredContent.data.ref.film_entity_id, fixture.scene_twin_id);
    assert.ok(attempts.structuredContent.data.items.some((item: any) => item.ref?.entity_type === "candidate"));
    assert.ok(review.structuredContent.data.items.some((item: any) => item.kind === "Candidate"));
    assert.ok(Array.isArray(blockers.structuredContent.data.items));
    assert.ok(Array.isArray(changes.structuredContent.data.items));

    const render = await call(client, "filmos_render_project_overview", {});
    const widget = buildWidgetModel("project", render.structuredContent);
    assert.equal(widget.headline, `Project ${fixture.project_id}`);
    assert.ok(widget.stats.some((stat) => stat.label === "Shots" && stat.value === "1"));

    const proposalResponse = await call(client, "filmos_prepare_proposal_export", {
      proposal_type: "Candidate",
      summary: "Tighten the real Candidate reaction framing",
      items_json: JSON.stringify([{ item_id: "real-golden-item", kind: "Candidate", target_uri: `filmos://project/${fixture.project_id}/shot/${fixture.shot_id}`, summary: "Tighten reaction framing", payload: { framing: "close-up" } }]),
      base_state_hash: project.structuredContent.state_hash,
    });
    const packagePath = resolve(temporary, "real-export.filmosproposal");
    await writeFile(packagePath, `${JSON.stringify(proposalResponse.structuredContent.package)}\n`, { mode: 0o600 });
    const receiptPath = resolve(temporary, "import-receipt.json");
    const cliArguments = ["-m", "external_brains.chatgpt.cli", "preview", packagePath, "--project-id", fixture.project_id, "--state-hash", project.structuredContent.state_hash, "--versions-json", JSON.stringify({ [project.structuredContent.uri]: project.structuredContent.version }), "--receipt-file", receiptPath];
    const cliOptions = { cwd: resolve(REPOSITORY_ROOT, "film-core/app"), env: { ...process.env, PYTHONPATH: resolve(REPOSITORY_ROOT, "film-core/app"), FILMOS_CHATGPT_PROPOSAL_SIGNING_SECRET: SIGNING_SECRET }, maxBuffer: 1024 * 1024 };
    const firstPreview = JSON.parse((await execFileAsync(python, cliArguments, cliOptions)).stdout);
    const replayPreview = JSON.parse((await execFileAsync(python, cliArguments, cliOptions)).stdout);
    assert.equal(firstPreview.kind, "FILMOS_PROPOSAL_IMPORT_PREVIEW");
    assert.equal(firstPreview.preview.status, "PREVIEW_REQUIRES_HUMAN_APPROVAL");
    assert.equal(firstPreview.preview.formal_write_executed, false);
    assert.equal(firstPreview.preview.provider_task_created, false);
    assert.equal(replayPreview.preview.idempotent_replay, true);
    assert.equal((await readFile(receiptPath, "utf8")).includes("PREVIEW_REQUIRES_HUMAN_APPROVAL"), true);

    process.stdout.write(`${JSON.stringify({
      kind: "TRACK14_REAL_GOLDEN_RECEIPT",
      golden_a: { real_film_core_sqlite: true, real_film_core_http: true, candidate_id: fixture.candidate_id, asset_id: fixture.asset_id, scene_twin_id: fixture.scene_twin_id, review_id: fixture.review_id, mcp_tools_exercised: ["search", "fetch", "project", "content_unit", "shot", "asset", "scene_twin", "generation_attempts", "review_queue", "blockers", "recent_changes", "render_project"], fallback_mock_used: false, external_calls: 0 },
      golden_b: { real_export_file: true, python_importer_cli: true, preview_status: firstPreview.preview.status, idempotent_replay: replayPreview.preview.idempotent_replay, formal_write_executed: false, external_calls: 0 },
    })}\n`);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((done) => mcpHttpServer.close(() => done()));
    await stopProcess(core);
    await rm(temporary, { recursive: true, force: true });
  }
});

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const response = await client.callTool({ name, arguments: args }) as any;
  assert.notEqual(response.isError, true, `${name} failed: ${JSON.stringify(response.content)}`);
  return response;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

async function waitForHealth(url: string, process: ChildProcess, logs: () => string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Film Core exited before health check: ${logs()}`);
    try { if ((await fetch(url)).ok) return; } catch { /* retry bounded local startup */ }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Film Core health timed out: ${logs()}`);
}

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((done) => process.once("exit", () => done())),
    new Promise<void>((done) => setTimeout(done, 2000)),
  ]);
  if (process.exitCode === null) process.kill("SIGKILL");
}
