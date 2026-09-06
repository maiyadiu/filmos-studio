import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import sharp from "sharp";
import { SHOT_IMAGE_SCHEMA, summarizeShotImage, summarizeShotImageMcpResult, type ShotImageEvidence } from "@filmos/agent-contracts";
import { shotImageMcpContent } from "../src/shot-image-content.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpTools } from "../src/mcp-server.js";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const now = Date.parse("2026-09-06T08:00:00Z");
async function fixture(): Promise<ShotImageEvidence> {
    const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#336699" } }).png().toBuffer();
    return {
        schema: SHOT_IMAGE_SCHEMA,
        binding: { projectId: "p", canvasId: "c", nodeId: "n", rowId: "project-shot:s", shotId: "s", shotRevision: 2, sourceUnitId: "u", sourceRevision: 1,
            sourceHash: hash("保留对白。"), imageNodeId: "image-1", resourceId: "resource-1", resourceUpdatedAt: new Date(now).toISOString(), resourceETag: "fixture-etag", canvasContentHash: "a".repeat(64), dependencyHash: "b".repeat(64) },
        image: { mimeType: "image/png", sha256: hash(bytes), byteLength: bytes.length, width: 24, height: 16 },
        capturedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
        constraints: { scriptText: "保留对白。", project: { id: "p" }, shot: { id: "s", projectId: "p", unitId: "u", revision: 2, sourceRevision: 1, sourceHash: hash("保留对白。") }, direction: {}, assets: [] },
        bytesBase64: bytes.toString("base64"),
    };
}

test("verified bytes reach MCP image content with exact source identity, not base64 in text/history", async () => {
    const evidence = await fixture();
    const response = await shotImageMcpContent(evidence, now);
    assert.deepEqual(response.content[1], { type: "image", mimeType: "image/png", data: evidence.bytesBase64 });
    const text = response.content[0] as { text: string };
    const summary = JSON.parse(text.text);
    assert.deepEqual(summary.binding, evidence.binding);
    assert.equal(summary.bytesBase64, undefined);
    assert.equal(summary.visualJudgment, "NOT_YET_VERIFIED");
    assert.equal(text.text.includes(evidence.bytesBase64), false);
    assert.equal(JSON.stringify(summarizeShotImage(evidence)).includes(evidence.bytesBase64), false);
    assert.equal(JSON.stringify(summarizeShotImageMcpResult(response)).includes(evidence.bytesBase64), false);
});

test("valid header with truncated pixel stream cannot pass even with matching claimed hash", async () => {
    const evidence = await fixture(), bytes = Buffer.from(evidence.bytesBase64, "base64").subarray(0, 55);
    evidence.bytesBase64 = bytes.toString("base64"); evidence.image.byteLength = bytes.length; evidence.image.sha256 = hash(bytes);
    await assert.rejects(shotImageMcpContent(evidence, now), { code: "canvas_image_invalid" });
});

test("real MCP tool uses image blocks, preserves safe failures and rejects target substitution", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "shot-image-test", version: "1" });
    registerMcpTools(server, { url: "http://127.0.0.1:17371", token: "fixture", ownerId: "fixture", trustedWebOrigins: [], browserRegistrations: [] }, { surface: "workbench_operator", film: { gateway: { callTool: async () => ({ ok: true }) } as never } });
    const client = new Client({ name: "shot-image-client", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const original = globalThis.fetch;
    let evidence = await fixture();
    evidence.capturedAt = new Date().toISOString(); evidence.expiresAt = new Date(Date.now() + 60_000).toISOString();
    globalThis.fetch = async (_url, options) => {
        assert.equal(JSON.parse(String(options?.body)).name, "project_read_shot_image");
        return new Response(JSON.stringify({ ok: true, result: evidence }), { status: 200 });
    };
    try {
        const tool = (await client.listTools()).tools.find(tool => tool.name === "project_read_shot_image");
        assert.equal(tool?.annotations?.readOnlyHint, true);
        assert.equal(tool?.annotations?.openWorldHint, false);
        const args = { nodeId: "n", rowId: "project-shot:s" };
        const good = await client.callTool({ name: "project_read_shot_image", arguments: args });
        assert.notEqual(good.isError, true);
        assert.deepEqual((good.content as unknown[])[1], { type: "image", mimeType: "image/png", data: evidence.bytesBase64 });
        evidence.binding.nodeId = "different-node";
        const wrong = await client.callTool({ name: "project_read_shot_image", arguments: args });
        assert.equal(wrong.isError, true);
        assert.match(JSON.stringify(wrong.content), /canvas_image_scope_mismatch/);
        globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, code: "canvas_image_unavailable", message: "尚未取得有效像素" }), { status: 503 });
        const absent = await client.callTool({ name: "project_read_shot_image", arguments: args });
        assert.equal(absent.isError, true);
        assert.match(JSON.stringify(absent.content), /canvas_image_unavailable/);
        assert.equal((absent.content as Array<{type: string}>).some(block => block.type === "image"), false);
    } finally { globalThis.fetch = original; await client.close(); await server.close(); }
});

test("missing pixels, tampering, false dimensions, source drift and expired evidence fail closed", async () => {
    const original = await fixture();
    const cases: Array<(v: ShotImageEvidence) => void> = [
        v => { v.bytesBase64 = ""; }, v => { v.image.sha256 = "c".repeat(64); }, v => { v.image.width++; },
        v => { v.image.mimeType = "image/jpeg"; }, v => { v.constraints.scriptText = "被替换"; },
        v => { v.binding.rowId = "project-shot:other"; }, v => { v.constraints.project.id = "other"; },
        v => { v.expiresAt = new Date(now - 1).toISOString(); },
    ];
    for (const change of cases) {
        const evidence = structuredClone(original); change(evidence);
        await assert.rejects(shotImageMcpContent(evidence, now), { name: "ShotImageReadError" });
    }
    const corrupt = structuredClone(original), bytes = Buffer.from("not an image");
    corrupt.bytesBase64 = bytes.toString("base64"); corrupt.image.byteLength = bytes.length; corrupt.image.sha256 = hash(bytes);
    await assert.rejects(shotImageMcpContent(corrupt, now), { code: "canvas_image_invalid" });
});
