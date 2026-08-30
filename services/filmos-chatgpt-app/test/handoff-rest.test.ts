import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { MemoryAuditSink } from "../src/audit.js";
import { MemoryFilmOSReadDataSource } from "../src/data-source.js";
import { MemoryProjectGrantStore } from "../src/grants.js";
import type { ProposalPreviewAdapter } from "../src/proposal-preview.js";
import { createFilmOSChatGPTApp } from "../src/server.js";
import { projectA, projectB, projects } from "./fixture.js";

async function withServer(
  options: Parameters<typeof createFilmOSChatGPTApp>[0],
  run: (baseUrl: string) => Promise<void>,
) {
  const instance = createFilmOSChatGPTApp(options);
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("handoff status is flat, project scoped, audited, and reveals no token or local path", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "desktop-test");
  const audit = new MemoryAuditSink();
  await withServer({ enabled: true, proposalHandoffEnabled: false, grants, dataSource: new MemoryFilmOSReadDataSource(projects), audit }, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json() as any;
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.external_account_connected, false);
    assert.equal(healthBody.observation_scope, "authenticated_handoff_status_only");
    assert.equal(healthBody.mcp_tool_count, healthBody.mcp_tool_names.length);
    assert.equal(healthBody.mcp_write_tool_count, 0);
    const response = await fetch(`${baseUrl}/handoff/status?project_id=${projectA}`, { headers: { authorization: `Bearer ${issued.token}` } });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(Object.keys(body).sort(), ["authorized_project", "billing_mode", "challenge_id", "connection", "connection_id", "external_account_connected", "fallback_enabled", "handoff_id", "last_chatgpt_mcp_request_at", "last_context_snapshot", "last_read_at", "local_mcp_ready", "mcp_destructive_tool_count", "mcp_manifest", "mcp_paid_tool_count", "mcp_read_tool_count", "mcp_session_id", "mcp_tool_count", "mcp_tool_names", "mcp_write_tool_count", "model_api_adapter_available", "observation_expires_at", "profile_id", "project_scope", "proposal_handoff_enabled", "request_id", "result_hash", "status_code", "tool_name"]);
    assert.deepEqual(body.authorized_project, { project_id: projectA, grant_id: issued.grant.grant_id, expires_at: issued.grant.expires_at });
    assert.equal(body.connection, "disconnected");
    assert.equal(body.local_mcp_ready, true);
    assert.equal(body.external_account_connected, false);
    assert.equal(body.status_code, "WAITING_FOR_CHATGPT");
    assert.equal(body.profile_id, "chatgpt.subscription.host.pro_readonly");
    assert.equal(body.billing_mode, "subscription_host_no_extra_model_api");
    assert.equal(body.model_api_adapter_available, false);
    assert.equal(body.fallback_enabled, false);
    assert.equal(body.mcp_tool_count, body.mcp_manifest.length);
    assert.equal(body.mcp_write_tool_count, 0);
    assert.equal(body.handoff_id, null);
    assert.equal(JSON.stringify(body).includes(issued.token), false);
    assert.equal(JSON.stringify(body).includes("/Users/"), false);

    const denied = await fetch(`${baseUrl}/handoff/status?project_id=${projectB}`, { headers: { authorization: `Bearer ${issued.token}` } });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as any).code, "PROJECT_SCOPE_DENIED");
    const ambiguous = await fetch(`${baseUrl}/handoff/status?project_id=${projectA}&project_id=${projectB}`, { headers: { authorization: `Bearer ${issued.token}` } });
    assert.equal(ambiguous.status, 403);
  });
  assert.ok(audit.records.every((record) => record.event_id && record.recorded_at && record.result_size >= 0));
  assert.ok(audit.records.some((record) => record.action === "handoff.status" && record.outcome === "DENY"));
});

test("proposal tools require both the service flag and an eligible Host profile", async () => {
  const grants = new MemoryProjectGrantStore();
  const options = {
    enabled: true,
    proposalHandoffEnabled: true,
    grants,
    dataSource: new MemoryFilmOSReadDataSource(projects),
    audit: new MemoryAuditSink(),
  };
  await withServer({ ...options, hostProfileId: "unsupported.profile" }, async (baseUrl) => {
    const health = await (await fetch(`${baseUrl}/health`)).json() as any;
    assert.equal(health.proposal_handoff_enabled, false);
    assert.equal(health.mcp_tool_names.includes("filmos_prepare_proposal_export"), false);
    assert.equal(health.mcp_write_tool_count, 0);
    assert.equal(health.mcp_paid_tool_count, 0);
    assert.equal(health.mcp_destructive_tool_count, 0);
  });
  await withServer({ ...options, hostProfileId: "chatgpt.subscription.host.pro_readonly" }, async (baseUrl) => {
    const health = await (await fetch(`${baseUrl}/health`)).json() as any;
    assert.equal(health.proposal_handoff_enabled, true);
    assert.equal(health.mcp_tool_names.includes("filmos_prepare_proposal_export"), true);
    assert.equal(health.mcp_tool_count, health.mcp_manifest.length);
    assert.equal(health.mcp_write_tool_count, 0);
    assert.equal(health.mcp_paid_tool_count, 0);
    assert.equal(health.mcp_destructive_tool_count, 0);
    assert.equal(health.mcp_manifest.every((tool: any) => tool.risk === "read"), true);
  });
});

test("grant revoke only revokes the bearer grant and returns the stable receipt", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "desktop-test");
  const other = await grants.issue(projectB, "desktop-test");
  const audit = new MemoryAuditSink();
  await withServer({ enabled: true, proposalHandoffEnabled: false, grants, dataSource: new MemoryFilmOSReadDataSource(projects), audit }, async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/handoff/grants/revoke`, {
      method: "POST", headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" }, body: JSON.stringify({ grant_id: other.grant.grant_id }),
    });
    assert.equal(denied.status, 403);
    await grants.authorize(other.token);

    const response = await fetch(`${baseUrl}/handoff/grants/revoke`, {
      method: "POST", headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" }, body: JSON.stringify({ grant_id: issued.grant.grant_id }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(Object.keys(body).sort(), ["grant_id", "revoked", "revoked_at"]);
    assert.equal(body.revoked, true);
    assert.equal(body.grant_id, issued.grant.grant_id);
    await assert.rejects(() => grants.authorize(issued.token), (error: any) => error.code === "GRANT_REVOKED");
    await grants.authorize(other.token);
  });
  assert.equal(audit.records.filter((record) => record.action === "handoff.grant.revoke").length, 2);
});

test("proposal preview accepts exactly {package}, preserves the Core wrapper, and never applies", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "desktop-test");
  const audit = new MemoryAuditSink();
  const adapter: ProposalPreviewAdapter = {
    async preview(value, grant) {
      assert.equal(grant.project_id, projectA);
      assert.equal(value.host_project_id, projectA);
      return { ok: true, kind: "FILMOS_PROPOSAL_IMPORT_PREVIEW", preview: { status: "PREVIEW_REQUIRES_HUMAN_APPROVAL", formal_write_executed: false } };
    },
  };
  await withServer({ enabled: true, proposalHandoffEnabled: true, grants, dataSource: new MemoryFilmOSReadDataSource(projects), audit, proposalPreview: adapter }, async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/handoff/proposals/preview`, {
      method: "POST", headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" }, body: JSON.stringify({ package: {}, project_id: projectB }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as any).code, "INVALID_PROPOSAL_PACKAGE");

    const response = await fetch(`${baseUrl}/handoff/proposals/preview`, {
      method: "POST", headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" }, body: JSON.stringify({ package: { host_project_id: projectA } }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, kind: "FILMOS_PROPOSAL_IMPORT_PREVIEW", preview: { status: "PREVIEW_REQUIRES_HUMAN_APPROVAL", formal_write_executed: false } });
  });
  assert.ok(audit.records.some((record) => record.action === "handoff.proposal.preview" && record.outcome === "ALLOW"));
  assert.ok(audit.records.some((record) => record.action === "handoff.proposal.preview" && record.outcome === "DENY"));
});

test("proposal preview fails closed when the Core importer is not configured", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "desktop-test");
  const audit = new MemoryAuditSink();
  await withServer({ enabled: true, proposalHandoffEnabled: true, grants, dataSource: new MemoryFilmOSReadDataSource(projects), audit }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/handoff/proposals/preview`, {
      method: "POST", headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" }, body: JSON.stringify({ package: {} }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: "PROPOSAL_IMPORT_NOT_CONFIGURED", status: "BLOCKED_LOCAL_CONFIG" });
  });
  assert.equal(audit.records.at(-1)?.code, "PROPOSAL_IMPORT_NOT_CONFIGURED");
});

test("handoff JSON body limit is 1 MiB and errors never return an Express stack", async () => {
  const grants = new MemoryProjectGrantStore();
  const issued = await grants.issue(projectA, "desktop-test");
  await withServer({ enabled: true, proposalHandoffEnabled: true, grants, dataSource: new MemoryFilmOSReadDataSource(projects), audit: new MemoryAuditSink() }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/handoff/proposals/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
      body: JSON.stringify({ package: { padding: "x".repeat(1024 * 1024) } }),
    });
    assert.equal(response.status, 413);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { code: "REQUEST_TOO_LARGE" });
    assert.equal(text.includes("/Users/"), false);
    assert.equal(text.includes("node_modules"), false);
  });
});
