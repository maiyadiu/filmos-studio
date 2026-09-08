import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { parseCodexModelSelection, reportedCodexModel } from "@filmos/agent-contracts";
import { CodexAppServerClient } from "../src/brains/adapters/codex-app-server-client.js";
import { publicAgentRuntimeFailure } from "../src/local-runtime-security.js";

const option = (model = "fixture-model") => ({ model, displayName: model, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "fixture high" }, { reasoningEffort: "future-effort", description: "future effort" }] });
const choice = { model: "fixture-model", effort: "future-effort" };
const policy = { approvalPolicy: "on-request", sandbox: "read-only" } as const;

async function fixture(t: TestContext, respond: (method: string, params: any) => unknown) {
    const stdout = new PassThrough();
    const requests: Array<{ id: number; method: string; params: any }> = [];
    const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), exitCode: 0,
        stdin: new Writable({ write(chunk, _encoding, callback) {
            const request = JSON.parse(String(chunk)); requests.push(request);
            const result = request.method === "turn/start" ? { turn: { id: "provider-turn" } } : respond(request.method, request.params);
            if (request.id && result !== undefined) queueMicrotask(() => {
                stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
                if (request.method === "turn/start") stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "thread", turn: { id: "provider-turn", status: "completed" } } }) + "\n");
            });
            callback();
        } }),
    });
    const client = await CodexAppServerClient.start({ command: "unused", args: [], version: "fixture", emit: () => undefined, spawnProcess: (() => child) as never });
    t.after(() => client.dispose());
    return { client, requests, stdout };
}

test("catalog pages preserve provider efforts, filter hidden models and reject loops or ambiguity", async t => {
    let loop = false, duplicate = false;
    const { client, requests } = await fixture(t, (method, params) => method === "model/list" ? {
        data: params.cursor ? [option(duplicate ? "fixture-model" : "second-model")] : [option(), { ...option("hidden"), hidden: true }],
        nextCursor: params.cursor && !loop ? null : "next",
    } : {});
    assert.deepEqual(await client.listModels(), [option(), option("second-model")]);
    assert.deepEqual(requests.find(r => r.method === "model/list")?.params, { limit: 100, includeHidden: false });
    loop = true; await assert.rejects(client.listModels(), /CATALOG_UNAVAILABLE/);
    loop = false; duplicate = true; await assert.rejects(client.listModels(), /CATALOG_UNAVAILABLE/);
});

test("selected turn transmits exact model and effort; actual metadata may differ, fast completion is retained", async t => {
    const { client, requests } = await fixture(t, method => method === "model/list" ? { data: [option()], nextCursor: null }
        : method === "thread/read" ? { thread: { id: "thread", model: "reported-model", reasoningEffort: "high" } } : {});
    let receipt: unknown;
    await client.startTurn("thread", "prompt", ["fixture.png"], [], undefined, undefined, policy, { model: choice, onModelReceipt: value => { receipt = value; } });
    const turn = requests.find(r => r.method === "turn/start")!;
    assert.equal(turn.params.model, choice.model); assert.equal(turn.params.effort, choice.effort);
    assert.equal(turn.params.approvalPolicy, "on-request");
    assert.equal(turn.params.input[1].type, "localImage");
    assert.deepEqual(receipt, { providerTurnId: "provider-turn", requested: choice, source: "thread/read", reported: { model: "reported-model", effort: "high" } });
    assert.deepEqual(requests.find(r => r.method === "thread/read")?.params, { threadId: "thread", includeTurns: false });
    assert.equal(requests.some(r => r.method.includes("config")), false);
});

test("invalid model/effort or cancelled preflight never starts a turn", async t => {
    const controller = new AbortController();
    const { client, requests } = await fixture(t, method => {
        if (method !== "model/list") return {};
        controller.abort(); return { data: [option()], nextCursor: null };
    });
    await assert.rejects(client.startTurn("thread", "prompt", [], [], undefined, undefined, policy, { model: { ...choice, effort: "unsupported" } }), /SELECTION_UNAVAILABLE/);
    await assert.rejects(client.startTurn("thread", "prompt", [], [], undefined, undefined, policy, { model: choice, signal: controller.signal }), /abort/i);
    assert.equal(requests.filter(r => r.method === "turn/start").length, 0);
    for (const value of [null, {}, { model: "x" }, { ...choice, config: {} }, { model: "../bad model", effort: "high" }]) assert.throws(() => parseCodexModelSelection(value), /SELECTION_INVALID/);
    assert.equal(publicAgentRuntimeFailure(new Error("CODEX_MODEL_SELECTION_UNAVAILABLE"))?.statusCode, 409);
});

test("no explicit override preserves legacy defaults and missing/wrong-thread metadata remains unknown", async t => {
    const { client, requests } = await fixture(t, () => ({}));
    let receipt: any;
    await client.startTurn("thread", "prompt", [], [], undefined, undefined, policy, { onModelReceipt: value => { receipt = value; } });
    const turn = requests.find(r => r.method === "turn/start")!;
    assert.equal("model" in turn.params, false); assert.equal("effort" in turn.params, false);
    assert.equal(requests.some(r => r.method === "model/list"), false);
    assert.equal(receipt.requested, null); assert.equal(receipt.source, "not_reported");
    assert.deepEqual(receipt.reported, { model: null, effort: null });
    assert.deepEqual(reportedCodexModel({ thread: { id: "other", model: "wrong", reasoningEffort: "high" } }, "thread").reported, receipt.reported);
});

test("unanswered metadata read is bounded and its late response cannot revise the receipt or resend", async t => {
    const { client, requests, stdout } = await fixture(t, method => method === "thread/read" ? undefined : {});
    const receipts: unknown[] = [];
    await client.startTurn("thread", "prompt", [], [], undefined, undefined, policy, { onModelReceipt: value => { receipts.push(value); } });
    const read = requests.find(r => r.method === "thread/read")!;
    stdout.write(JSON.stringify({ id: read.id, result: { thread: { id: "thread", model: "late", reasoningEffort: "high" } } }) + "\n");
    assert.equal(receipts.length, 1); assert.equal((receipts[0] as any).source, "not_reported");
    assert.equal(requests.filter(r => r.method === "turn/start").length, 1);
});
