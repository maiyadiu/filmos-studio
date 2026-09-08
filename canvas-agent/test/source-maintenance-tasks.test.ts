import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SourceMaintenanceTasks } from "../src/brains/source-maintenance-tasks.js";
import { LocalRuntimeSessionError } from "../src/local-runtime-session.js";
import { JsonBrainSessionStore, MemoryBrainSessionStore } from "../src/brains/session-store.js";
import type { BrainSession } from "../src/brains/contracts.js";
import { sourceFixture } from "./fixtures/source-maintenance.js";

const account = "account_" + "a".repeat(64);
const file = "web/src/view.ts";
async function fixture(t: TestContext, persistent = false) {
    const source = sourceFixture(t);
    const sessionFile = path.join(source.root, ".local/sessions.json");
    const store = persistent ? new JsonBrainSessionStore(sessionFile) : new MemoryBrainSessionStore();
    const session: BrainSession = { id: "owned", conversationId: "conversation", accountScopeId: account, brainProfileId: "codex.subscription", connectionId: "codex.subscription", projectId: "project", canvasId: "canvas", providerThreadId: "original-thread", permissionGrantId: "original", status: "ready", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await store.saveSession(session);
    const tasks = new SourceMaintenanceTasks(() => source.workspace, () => store);
    const expectedHash = (await source.workspace.read({ path: file })).contentHash;
    const body = { requestId: "maintenance-1", purpose: "Correct fixture title", files: [{ path: file, expectedHash }] };
    const patch = { requestId: "patch-1", path: file, expectedHash, oldText: "'fixture'", newText: "'repaired'" };
    const current = async () => (await store.getSession(session.id))!;
    const bytes = () => readFileSync(path.join(source.root, file), "utf8");
    return { ...source, session, store, tasks, body, patch, current, bytes, sessionFile };
}

test("source task freezes selected hashes and retains ordinary session identity without opening other files", async t => {
    const f = await fixture(t);
    const record = await f.tasks.open(f.session, f.body, () => {});
    const current = await f.current(), grant = f.tasks.grant(current)!;
    assert.equal(current.providerThreadId, "original-thread");
    assert.equal(grant.sourceTaskId, record.id);
    assert.deepEqual(grant.allowedTools, ["workbench_get_context", "source_get_task", "source_read_file", "source_prepare_patch", "source_apply_patch"]);
    for (const [session, id, tool, input] of [
        [{ ...current, accountScopeId: "account_" + "b".repeat(64) }, record.id, "source_get_task", {}],
        [current, "forged", "source_get_task", {}],
        [current, record.id, "source_read_file", { path: "README.md" }],
        [current, record.id, "generation_submit", {}],
        [current, record.id, "source_prepare_patch", { ...f.patch, cwd: f.root }],
    ] as const) await assert.rejects(f.tasks.execute(session, id, tool, input), /源码任务/);
    assert.equal(f.tasks.view(current).live, true);
    await assert.rejects(f.tasks.open(current, f.body, () => {}), /源码任务/);
    await f.tasks.close(current, () => {});
    assert.equal(f.tasks.grant(await f.current()), undefined);
    assert.equal(f.tasks.view(await f.current()).record?.status, "closed");
    assert.match(f.bytes(), /'fixture'/);
});

test("patch intent persists before replacement and the original request replay does not rewrite the file", async t => {
    const f = await fixture(t, true);
    const record = await f.tasks.open(f.session, f.body, () => {});
    const execute = (tool: string, input: Record<string, unknown>) => f.tasks.execute(f.session, record.id, tool, input);
    await execute("source_prepare_patch", f.patch);
    const apply = f.workspace.applyPreparedPatch.bind(f.workspace);
    t.mock.method(f.workspace, "applyPreparedPatch", async (...args: Parameters<typeof apply>) => {
        const disk = new JsonBrainSessionStore(f.sessionFile);
        assert.equal((await disk.getSession(f.session.id))!.sourceMaintenance!.patches[0].status, "applying");
        return apply(...args);
    });
    const result = await execute("source_apply_patch", { requestId: f.patch.requestId });
    assert.equal("verified" in result && result.verified, true);
    const originalBytes = f.bytes();
    assert.match(originalBytes, /'repaired'/);
    assert.deepEqual(await execute("source_apply_patch", { requestId: f.patch.requestId }), { ...result, replayed: true });
    assert.equal(f.bytes(), originalBytes);
    assert.equal(f.git("rev-parse", "HEAD").trim(), record.sourceHead);
    assert.equal(f.git("diff", "--cached"), "");
    const restarted = new SourceMaintenanceTasks(() => f.workspace, () => new JsonBrainSessionStore(f.sessionFile));
    const saved = await f.current();
    assert.equal(restarted.view(saved).live, false);
    assert.equal(restarted.grant(saved), undefined);
    await assert.rejects(restarted.execute(saved, record.id, "source_apply_patch", { requestId: f.patch.requestId }), /源码任务/);
});

for (const phase of ["before", "after", "conflict"] as const) test(`interrupted ${phase} replacement is reconciled read-only, never blindly replayed`, async t => {
    const f = await fixture(t, true);
    const record = await f.tasks.open(f.session, f.body, () => {});
    await f.tasks.execute(f.session, record.id, "source_prepare_patch", f.patch);
    const apply = f.workspace.applyPreparedPatch.bind(f.workspace);
    t.mock.method(f.workspace, "applyPreparedPatch", async (...args: Parameters<typeof apply>) => {
        if (phase === "after") await apply(...args);
        if (phase === "conflict") f.write(file, "external editor changed content\n");
        throw new Error("SIMULATED_INTERRUPTION");
    });
    await assert.rejects(f.tasks.execute(f.session, record.id, "source_apply_patch", { requestId: f.patch.requestId }), /SIMULATED/);
    const diskStore = new JsonBrainSessionStore(f.sessionFile);
    const restarted = new SourceMaintenanceTasks(() => f.workspace, () => diskStore);
    const saved = (await diskStore.getSession(f.session.id))!;
    assert.equal(saved.sourceMaintenance!.patches[0].status, "applying");
    await assert.rejects(restarted.close(saved, () => {}), /源码任务/);
    const bytes = f.bytes();
    if (phase === "conflict") await assert.rejects(restarted.reconcile(saved, () => {}), /源码任务/);
    else {
        const result = await restarted.reconcile(saved, () => {});
        assert.equal(result.writeExecuted, false);
        assert.equal(result.record.patches[0].status, phase === "after" ? "applied" : "not_applied");
        assert.equal(restarted.view((await diskStore.getSession(f.session.id))!).live, false);
        await restarted.close((await diskStore.getSession(f.session.id))!, () => {});
    }
    assert.equal(f.bytes(), bytes);
});

test("expired or revoked authority blocks pending patch without replacing source", async t => {
    const f = await fixture(t); let valid = true;
    const record = await f.tasks.open(f.session, f.body, () => { if (!valid) throw new Error("REVOKED"); });
    await f.tasks.execute(f.session, record.id, "source_prepare_patch", f.patch);
    const update = f.store.updateSession.bind(f.store);
    t.mock.method(f.store, "updateSession", async (...args: Parameters<typeof update>) => {
        const result = await update(...args);
        if (args[1].sourceMaintenance?.patches.some(patch => patch.status === "applying")) valid = false;
        return result;
    });
    await assert.rejects(f.tasks.execute(f.session, record.id, "source_apply_patch", { requestId: f.patch.requestId }), /REVOKED/);
    assert.match(f.bytes(), /'fixture'/);
    valid = true;
    t.mock.method(Date, "now", () => Date.parse(record.expiresAt) + 1);
    await assert.rejects(f.tasks.execute(f.session, record.id, "source_get_task", {}), /源码任务/);
});

test("preflight rejects stale hashes, duplicate paths, async authorization and revoke during repository read", async t => {
    const f = await fixture(t);
    for (const body of [{ ...f.body, files: [...f.body.files, ...f.body.files] }, { ...f.body, files: [{ path: file, expectedHash: "0".repeat(64) }] }]) await assert.rejects(f.tasks.open(f.session, body, () => {}));
    await assert.rejects(f.tasks.open(f.session, f.body, async () => {}), /源码任务/);
    let valid = true; const inspect = f.workspace.inspect.bind(f.workspace);
    t.mock.method(f.workspace, "inspect", async () => { const value = await inspect(); valid = false; return value; });
    await assert.rejects(f.tasks.open(f.session, f.body, () => { if (!valid) throw new Error("REVOKED"); }), /REVOKED/);
    assert.equal((await f.current()).sourceMaintenance, undefined);
    assert.match(f.bytes(), /'fixture'/);
});

test("stopping the turn during source preflight prevents its prepared replacement", async t => {
    const f = await fixture(t), controller = new AbortController();
    const record = await f.tasks.open(f.session, f.body, () => {});
    await f.tasks.execute(f.session, record.id, "source_prepare_patch", f.patch);
    const apply = f.workspace.applyPreparedPatch.bind(f.workspace);
    t.mock.method(f.workspace, "applyPreparedPatch", async (...args: Parameters<typeof apply>) => {
        controller.abort(new Error("AGENT_TURN_CANCELLED"));
        return apply(...args);
    });
    await assert.rejects(f.tasks.execute(f.session, record.id, "source_apply_patch", { requestId: f.patch.requestId }, () => controller.signal.throwIfAborted()), error => error instanceof LocalRuntimeSessionError && error.code === "agent_turn_cancelled");
    assert.match(f.bytes(), /'fixture'/);
    assert.equal((await f.current()).sourceMaintenance!.patches[0].status, "applying");
    assert.equal((await f.tasks.reconcile(await f.current(), () => {})).record.patches[0].status, "not_applied");
});

test("recovery refuses later editor changes even when the stored receipt was successful", async t => {
    const f = await fixture(t);
    const record = await f.tasks.open(f.session, f.body, () => {});
    await f.tasks.execute(f.session, record.id, "source_prepare_patch", f.patch);
    await f.tasks.execute(f.session, record.id, "source_apply_patch", { requestId: f.patch.requestId });
    f.write(file, "external editor\n");
    await assert.rejects(f.tasks.reconcile(await f.current(), () => {}));
    assert.equal(f.bytes(), "external editor\n");
});
