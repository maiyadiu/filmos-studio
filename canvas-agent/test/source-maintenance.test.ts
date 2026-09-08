import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { SourceMaintenanceWorkspace } from "../src/brains/source-maintenance.js";
import { LocalRuntimeSessionError } from "../src/local-runtime-session.js";
import { sourceFixture } from "./fixtures/source-maintenance.js";

const failure = (code: string) => (error: unknown) => error instanceof LocalRuntimeSessionError && error.code === code;
const denied = failure("agent_source_path_denied");

test("source read lists tracked code only and returns exact hash/range without changing git or user materials", async t => {
    const f = sourceFixture(t);
    f.write("任务包/用户.md", "private user material"); f.write(".local/data.md", "private data"); f.write("web/src/untracked.ts", "uncommitted addition");
    const index = readFileSync(path.join(f.root, ".git/index")), head = f.git("rev-parse", "HEAD").trim();
    const status = await f.workspace.inspect();
    assert.equal(status.head, head); assert.equal(status.tree, f.git("rev-parse", "HEAD^{tree}").trim());
    assert.equal(status.trackedClean, true); assert.equal(status.sourceFileCount, 3);
    assert.deepEqual(status.capabilities, { read: true, edit: false, runChecks: false, reload: false });
    assert.deepEqual(await f.workspace.list({ prefix: "web/", limit: 1 }), { paths: ["web/package.json"], total: 2, nextOffset: 1 });
    assert.deepEqual(await f.workspace.list({ prefix: "web/", offset: 1 }), { paths: ["web/src/view.ts"], total: 2, nextOffset: null });
    const body = readFileSync(path.join(f.root, "web/src/view.ts"));
    const result = await f.workspace.read({ path: "web/src/view.ts", startLine: 2, lineCount: 1 });
    assert.equal(result.content, "// line two"); assert.equal(result.totalLines, 3); assert.equal(result.endLine, 2); assert.equal(result.truncated, true);
    assert.equal(result.contentHash, createHash("sha256").update(body).digest("hex"));
    assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index);
    assert.equal(readFileSync(path.join(f.root, "任务包/用户.md"), "utf8"), "private user material");
    assert.equal(f.git("rev-parse", "HEAD").trim(), head);
});

test("dirty source is read honestly and stale hashes cannot be reused", async t => {
    const f = sourceFixture(t), old = await f.workspace.read({ path: "web/src/view.ts" });
    f.write("web/src/view.ts", "export const changed = true;");
    assert.equal((await f.workspace.inspect()).trackedClean, false);
    await assert.rejects(f.workspace.read({ path: "web/src/view.ts", expectedHash: old.contentHash }), failure("agent_source_changed"));
    const current = await f.workspace.read({ path: "web/src/view.ts" });
    assert.equal(current.content, "export const changed = true;");
    assert.equal((await f.workspace.read({ path: "web/src/view.ts", expectedHash: current.contentHash })).contentHash, current.contentHash);
});

test("invalid requests and hidden/data/untracked paths fail closed", async t => {
    const f = sourceFixture(t);
    for (const relative of ["web/.env", "web/.private/key.ts", "backend/data/file.ts", "web/uploads/file.ts", "web/src/untracked.ts", "web/dist/file.js", "web/node_modules/file.js", "任务包/用户.md"]) f.write(relative, "private");
    f.git("add", "-f", "web/.env", "web/.private/key.ts", "backend/data/file.ts", "web/uploads/file.ts", "web/dist/file.js", "web/node_modules/file.js");
    for (const relative of ["../README.md", "/etc/passwd", "web/../README.md", "web\\src\\view.ts", ".git/config", "web/.env", "web/.private/key.ts", "backend/data/file.ts", "web/uploads/file.ts", "web/src/untracked.ts", "web/dist/file.js", "web/node_modules/file.js", "任务包/用户.md", "web/src/*.ts", "web/src/view.ts\0"]) {
        await assert.rejects(f.workspace.read({ path: relative }), denied);
    }
    assert.equal((await f.workspace.list({})).total, 3);
    for (const input of [{}, { path: "README.md", cwd: f.root }, { path: "README.md", startLine: 0 }, { path: "README.md", lineCount: 241 }, { path: "README.md", startLine: 3 }, { path: "README.md", expectedHash: "wrong" }]) await assert.rejects(f.workspace.read(input), failure("agent_source_request_invalid"));
    await assert.rejects(f.workspace.list({ prefix: "../" }), denied);
    await assert.rejects(f.workspace.list({ limit: 101 }), failure("agent_source_request_invalid"));
});

test("tracked symlinks and a regular tracked path replaced by a symlink are rejected", async t => {
    const f = sourceFixture(t), target = f.write(".local/private.ts", "private secret fixture");
    symlinkSync(target, path.join(f.root, "web/src/link.ts")); f.git("add", "web/src/link.ts");
    await assert.rejects(f.workspace.read({ path: "web/src/link.ts" }), denied);
    assert.ok(!(await f.workspace.list({})).paths.includes("web/src/link.ts"));
    rmSync(path.join(f.root, "web/src/view.ts")); symlinkSync(target, path.join(f.root, "web/src/view.ts"));
    await assert.rejects(f.workspace.read({ path: "web/src/view.ts" }), denied);
});

test("linked parent directories, hardlinks and missing files return safe errors", async t => {
    const f = sourceFixture(t);
    renameSync(path.join(f.root, "web/src"), path.join(f.root, ".local-src"));
    symlinkSync(path.join(f.root, ".local-src"), path.join(f.root, "web/src"));
    await assert.rejects(f.workspace.read({ path: "web/src/view.ts" }), denied);
    rmSync(path.join(f.root, "web/src")); renameSync(path.join(f.root, ".local-src"), path.join(f.root, "web/src"));
    linkSync(path.join(f.root, "web/src/view.ts"), path.join(f.root, "duplicate"));
    await assert.rejects(f.workspace.read({ path: "web/src/view.ts" }), denied);
    rmSync(path.join(f.root, "web/src/view.ts"));
    await assert.rejects(f.workspace.read({ path: "web/src/view.ts" }), error => denied(error) && !(error as Error).message.includes(f.root));
});

test("source reads reject directories, binary, invalid UTF-8 and oversized content", async t => {
    const f = sourceFixture(t);
    for (const body of [Buffer.from([0x61, 0, 0x62]), Buffer.from([0xff]), Buffer.alloc(256 * 1024 + 1, 0x61)]) {
        f.write("web/src/view.ts", body); await assert.rejects(f.workspace.read({ path: "web/src/view.ts" }), denied);
    }
    rmSync(path.join(f.root, "web/src/view.ts")); mkdirSync(path.join(f.root, "web/src/view.ts"));
    await assert.rejects(f.workspace.read({ path: "web/src/view.ts" }), denied);
});

test("source authority refuses another branch, detached HEAD and gitfile workspaces", async t => {
    const f = sourceFixture(t);
    f.git("checkout", "-b", "fixture-other"); await assert.rejects(f.workspace.inspect(), failure("agent_source_unavailable"));
    f.git("checkout", "--detach"); await assert.rejects(f.workspace.list({}), failure("agent_source_unavailable"));
    f.git("checkout", "integration");
    renameSync(path.join(f.root, ".git"), path.join(f.root, "git-fixture")); f.write(".git", "gitdir: git-fixture");
    await assert.rejects(f.workspace.read({ path: "README.md" }), failure("agent_source_unavailable"));
});

test("runtime source authority binds launcher environment to the executing module root", t => {
    const f = sourceFixture(t);
    const environment = { FILMOS_DESKTOP_SOURCE_ROOT: f.root, FILMOS_DESKTOP_SOURCE_RUNTIME_ROOT: path.join(f.root, ".local/source-host") };
    assert.equal(SourceMaintenanceWorkspace.fromEnvironment({}), undefined);
    assert.ok(SourceMaintenanceWorkspace.fromEnvironment(environment, f.root));
    for (const env of [{ ...environment, FILMOS_DESKTOP_SOURCE_ROOT: "relative" }, { ...environment, FILMOS_DESKTOP_SOURCE_RUNTIME_ROOT: f.root }]) assert.throws(() => SourceMaintenanceWorkspace.fromEnvironment(env, f.root), failure("agent_source_unavailable"));
    assert.throws(() => SourceMaintenanceWorkspace.fromEnvironment(environment, path.dirname(f.root)), failure("agent_source_unavailable"));
    symlinkSync(f.root, path.join(f.root, "alias"));
    assert.throws(() => SourceMaintenanceWorkspace.fromEnvironment({ ...environment, FILMOS_DESKTOP_SOURCE_ROOT: path.join(f.root, "alias") }, f.root), failure("agent_source_unavailable"));
});

test("Git reads ignore inherited repository overrides and never execute fsmonitor/filter commands", async t => {
    const f = sourceFixture(t), marker = path.join(f.root, "executed");
    const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
    process.env.GIT_DIR = "/not-a-repo"; process.env.GIT_WORK_TREE = "/not-a-repo";
    f.git("config", "core.fsmonitor", `touch '${marker}'`);
    assert.equal((await f.workspace.inspect()).trackedClean, true); assert.equal(existsSync(marker), false);
    f.git("config", "filter.fixture.clean", `touch '${marker}'`);
    await assert.rejects(f.workspace.inspect(), failure("agent_source_unavailable"));
    assert.equal(existsSync(marker), false);
});

const sha = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");
const patchInput = (body: string | Buffer, overrides: Record<string, unknown> = {}) => ({ requestId: "patch-one", path: "web/src/view.ts", expectedHash: sha(body), oldText: "fixture", newText: "updated", ...overrides });
const targetText = (f: ReturnType<typeof sourceFixture>) => readFileSync(path.join(f.root, "web/src/view.ts"), "utf8");

test("internal patch freezes a one-file exact replacement, preserves dirty work/index/HEAD and reads back once", async t => {
    const f = sourceFixture(t);
    const body = "\ufeffexport const title = 'fixture';\r\n// 用户的未提交修改\r\n";
    const target = f.write("web/src/view.ts", body);
    chmodSync(target, 0o755);
    f.write("任务包/用户.md", "keep private materials"); f.write("README.md", "unrelated dirty edit");
    const index = readFileSync(path.join(f.root, ".git/index")), head = f.git("rev-parse", "HEAD");
    const plan = await f.workspace.preparePatch(patchInput(body));
    assert.equal(plan.written, false); assert.equal(targetText(f), body);
    const scopes: unknown[] = [];
    const receipt = await f.workspace.applyPreparedPatch(plan.requestId, scope => { scopes.push(scope); });
    assert.equal(receipt.status, "applied"); assert.equal(receipt.verified, true); assert.equal(receipt.runtimeUpdated, false);
    assert.equal(receipt.committed, false); assert.equal(receipt.replayed, false);
    assert.equal(targetText(f), body.replace("fixture", "updated"));
    assert.equal(receipt.afterHash, sha(targetText(f)));
    assert.equal(lstatSync(target).mode & 0o777, 0o755);
    assert.equal(scopes.length, 2); assert.deepEqual(scopes[0], scopes[1]);
    assert.deepEqual(readFileSync(path.join(f.root, ".git/index")), index); assert.equal(f.git("rev-parse", "HEAD"), head);
    assert.equal(readFileSync(path.join(f.root, "README.md"), "utf8"), "unrelated dirty edit");
    assert.equal(readFileSync(path.join(f.root, "任务包/用户.md"), "utf8"), "keep private materials");
    assert.equal(readdirSync(path.dirname(target)).some(name => name.startsWith(".filmos-patch-")), false);
    const inode = lstatSync(target).ino;
    assert.equal((await f.workspace.applyPreparedPatch(plan.requestId, () => {})).replayed, true);
    assert.equal(lstatSync(target).ino, inode);
    assert.equal((await f.workspace.preparePatch(patchInput(body))).written, true);
});

test("patch rejects unknown scope, changed request IDs, stale hashes, missing/ambiguous snippets and invalid text", async t => {
    const f = sourceFixture(t), body = targetText(f);
    for (const fields of [{ oldText: "" }, { newText: "fixture" }, { newText: "\0" }, { newText: "\ud800" }, { newText: "x".repeat(32_769) }, { expectedHash: "not-a-hash" }, { cwd: f.root }]) await assert.rejects(f.workspace.preparePatch(patchInput(body, fields)), failure("agent_source_patch_invalid"));
    await assert.rejects(f.workspace.preparePatch(patchInput(body, { oldText: "missing" })), failure("agent_source_patch_conflict"));
    await assert.rejects(f.workspace.preparePatch(patchInput(body, { oldText: "//" })), failure("agent_source_patch_conflict"));
    await assert.rejects(f.workspace.preparePatch(patchInput(body, { expectedHash: "0".repeat(64) })), failure("agent_source_changed"));
    await assert.rejects(f.workspace.preparePatch(patchInput(body, { path: ".git/config" })), denied);
    await assert.rejects(f.workspace.applyPreparedPatch("unknown", () => {}), failure("agent_source_patch_invalid"));
    await f.workspace.preparePatch(patchInput(body));
    await assert.rejects(f.workspace.preparePatch(patchInput(body, { newText: "different" })), failure("agent_source_patch_conflict"));
    assert.equal(targetText(f), body);
});

test("changed file or HEAD invalidates frozen patches; user edits are never rolled back", async t => {
    const f = sourceFixture(t), body = targetText(f);
    await f.workspace.preparePatch(patchInput(body));
    f.write("web/src/view.ts", "new user edit");
    await assert.rejects(f.workspace.applyPreparedPatch("patch-one", () => {}), failure("agent_source_changed"));
    assert.equal(targetText(f), "new user edit");
    f.write("web/src/view.ts", body); f.git("commit", "--allow-empty", "-m", "other source change");
    await assert.rejects(f.workspace.applyPreparedPatch("patch-one", () => {}), failure("agent_source_changed"));
    assert.equal(targetText(f), body);
});

test("source authorization is required before work and rechecked immediately before replacement", async t => {
    const f = sourceFixture(t), body = targetText(f);
    await f.workspace.preparePatch(patchInput(body));
    const revoked = () => { throw new LocalRuntimeSessionError("agent_account_binding_required", "revoked", 401); };
    await assert.rejects(f.workspace.applyPreparedPatch("patch-one", revoked), failure("agent_account_binding_required"));
    let checks = 0;
    await assert.rejects(f.workspace.applyPreparedPatch("patch-one", () => { if (++checks === 2) revoked(); }), failure("agent_account_binding_required"));
    assert.equal(checks, 2); assert.equal(targetText(f), body);
    await assert.rejects(f.workspace.applyPreparedPatch("patch-one", async () => {}), failure("agent_source_authorization_invalid"));
    assert.deepEqual(readdirSync(path.join(f.root, "web/src")), ["view.ts"]);
    assert.equal((await f.workspace.applyPreparedPatch("patch-one", () => {})).verified, true);
});

test("final synchronous scope check cannot hide a concurrent target edit or a replaced inode", async t => {
    const f = sourceFixture(t), body = targetText(f);
    await f.workspace.preparePatch(patchInput(body));
    let checks = 0;
    await assert.rejects(f.workspace.applyPreparedPatch("patch-one", () => { if (++checks === 2) f.write("web/src/view.ts", "concurrent edit"); }), failure("agent_source_changed"));
    assert.equal(targetText(f), "concurrent edit");
    f.write("web/src/view.ts", body); checks = 0;
    await assert.rejects(f.workspace.applyPreparedPatch("patch-one", () => {
        if (++checks === 2) { const replacement = f.write("web/src/replacement.ts", body); renameSync(replacement, path.join(f.root, "web/src/view.ts")); }
    }), failure("agent_source_changed"));
    assert.equal(targetText(f), body);
});

test("prepared patches reject symlinks, hardlinks, changed modes and binary/oversized results", async t => {
    const f = sourceFixture(t), body = targetText(f), target = path.join(f.root, "web/src/view.ts");
    await f.workspace.preparePatch(patchInput(body));
    const secret = f.write(".local/private.ts", "private data");
    rmSync(target); symlinkSync(secret, target);
    await assert.rejects(f.workspace.applyPreparedPatch("patch-one", () => {}), denied);
    assert.equal(readFileSync(secret, "utf8"), "private data");
    rmSync(target); f.write("web/src/view.ts", body); linkSync(target, path.join(f.root, "hardlink"));
    await assert.rejects(f.workspace.applyPreparedPatch("patch-one", () => {}), denied);
    rmSync(path.join(f.root, "hardlink")); chmodSync(target, 0o755);
    await assert.rejects(f.workspace.applyPreparedPatch("patch-one", () => {}), denied);
    f.write("web/src/view.ts", Buffer.from([0xff]));
    await assert.rejects(f.workspace.preparePatch(patchInput(Buffer.from([0xff]), { requestId: "binary" })), denied);
    const big = "fixture" + "a".repeat(256 * 1024 - 7); f.write("web/src/view.ts", big);
    await assert.rejects(f.workspace.preparePatch(patchInput(big, { requestId: "large", newText: "longer fixture" })), failure("agent_source_patch_invalid"));
});

test("Runtime single-writer gate rejects concurrent replacement across workspace instances without queuing", async t => {
    const f = sourceFixture(t), body = targetText(f), other = new SourceMaintenanceWorkspace(f.root);
    await f.workspace.preparePatch(patchInput(body)); await other.preparePatch(patchInput(body, { requestId: "second" }));
    const first = f.workspace.applyPreparedPatch("patch-one", () => {});
    await assert.rejects(other.applyPreparedPatch("second", () => {}), failure("agent_source_writer_busy"));
    await first;
    await assert.rejects(other.applyPreparedPatch("second", () => {}), failure("agent_source_changed"));
});

test("post-restart lost receipt cannot be replaced by guessed success or a repeated write", async t => {
    const f = sourceFixture(t), body = targetText(f);
    await f.workspace.preparePatch(patchInput(body)); await f.workspace.applyPreparedPatch("patch-one", () => {});
    const fresh = new SourceMaintenanceWorkspace(f.root);
    await assert.rejects(fresh.applyPreparedPatch("patch-one", () => {}), failure("agent_source_patch_invalid"));
    await assert.rejects(fresh.preparePatch(patchInput(body)), failure("agent_source_changed"));
    f.write("web/src/view.ts", "later edit");
    await assert.rejects(f.workspace.applyPreparedPatch("patch-one", () => {}), failure("agent_source_changed"));
    assert.equal(targetText(f), "later edit");
});

test("expired preparation is not applied; old receipts remain readback-only", async t => {
    const f = sourceFixture(t), body = targetText(f);
    const pending = await f.workspace.preparePatch(patchInput(body));
    t.mock.method(Date, "now", () => Date.parse(pending.expiresAt) + 1);
    await assert.rejects(f.workspace.applyPreparedPatch("patch-one", () => {}), failure("agent_source_patch_expired"));
    assert.equal(targetText(f), body);
    t.mock.restoreAll();
    const second = await f.workspace.preparePatch(patchInput(body, { requestId: "applied" }));
    await f.workspace.applyPreparedPatch("applied", () => {});
    t.mock.method(Date, "now", () => Date.parse(second.expiresAt) + 1);
    assert.equal((await f.workspace.applyPreparedPatch("applied", () => {})).replayed, true);
});

test("patch can never change branches or create/delete untracked user files", async t => {
    const f = sourceFixture(t), body = targetText(f);
    f.write("web/src/untracked.ts", body);
    await assert.rejects(f.workspace.preparePatch(patchInput(body, { path: "web/src/untracked.ts" })), denied);
    await f.workspace.preparePatch(patchInput(body)); f.git("checkout", "-b", "fixture-other");
    await assert.rejects(f.workspace.applyPreparedPatch("patch-one", () => {}), failure("agent_source_unavailable"));
    assert.equal(targetText(f), body); assert.equal(f.git("branch", "--show-current").trim(), "fixture-other");
    assert.equal(readFileSync(path.join(f.root, "web/src/untracked.ts"), "utf8"), body);
});
