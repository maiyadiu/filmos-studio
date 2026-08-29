import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { MemoryAuditSink } from "../src/audit.js";
import { MemoryFilmOSReadDataSource } from "../src/data-source.js";
import { MemoryProjectGrantStore } from "../src/grants.js";
import { createFilmOSChatGPTApp } from "../src/server.js";

const projectId = "filmos-acceptance-project-v1";
const grants = new MemoryProjectGrantStore();
const issued = await grants.issue(projectId, "acceptance-mcp-manifest");
const instance = createFilmOSChatGPTApp({
    enabled: true,
    readToolsEnabled: true,
    widgetsEnabled: true,
    proposalHandoffEnabled: true,
    proposalSigningSecret: "acceptance-signing-secret-not-a-credential",
    grants,
    dataSource: new MemoryFilmOSReadDataSource({ [projectId]: { project_id: projectId } }),
    audit: new MemoryAuditSink(),
    secureTunnelProof: "acceptance-transport-proof",
});
const server = instance.app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));

try {
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await (await fetch(`${baseUrl}/health`)).json() as Record<string, unknown>;
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
    });
    const client = new Client({ name: "filmos-acceptance-manifest", version: "1.0.0" });
    await client.connect(transport);
    try {
        const tools = (await client.listTools()).tools;
        const names = tools.map((tool) => tool.name).sort();
        const healthNames = [...(health.mcp_tool_names as string[])].sort();
        assert.deepEqual(names, healthNames);
        assert.equal(health.mcp_tool_count, tools.length);
        const calculated = {
            read: tools.filter((tool) => tool.annotations?.readOnlyHint === true).length,
            write: tools.filter((tool) => tool.annotations?.readOnlyHint !== true && tool.annotations?.destructiveHint !== true).length,
            destructive: tools.filter((tool) => tool.annotations?.destructiveHint === true).length,
            paid: tools.filter((tool) => (tool._meta as Record<string, unknown> | undefined)?.["filmos/risk"] === "paid").length,
        };
        assert.equal(health.mcp_read_tool_count, calculated.read);
        assert.equal(health.mcp_write_tool_count, calculated.write);
        assert.equal(health.mcp_destructive_tool_count, calculated.destructive);
        assert.equal(health.mcp_paid_tool_count, calculated.paid);
        process.stdout.write(`${JSON.stringify({
            schema_version: "1.0.0",
            gate_id: "MCP-ACTUAL-TOOL-COUNT-001",
            status: "PASSED",
            source: "REAL_STREAMABLE_HTTP_MCP_LIST_TOOLS",
            profile_id: health.profile_id,
            billing_mode: health.billing_mode,
            tool_names: names,
            actual_tool_count: tools.length,
            calculated_risk_counts: calculated,
            desktop_health_risk_counts: {
                read: health.mcp_read_tool_count,
                write: health.mcp_write_tool_count,
                destructive: health.mcp_destructive_tool_count,
                paid: health.mcp_paid_tool_count,
            },
            exact_match: true,
        }, null, 2)}\n`);
    } finally {
        await client.close();
    }
} finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
}
