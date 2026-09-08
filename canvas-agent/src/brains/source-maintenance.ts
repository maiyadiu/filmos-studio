import { execFile } from "node:child_process";
import { constants, lstatSync, openSync, closeSync, fstatSync, readSync, realpathSync, writeSync, fchmodSync, fsyncSync, renameSync, unlinkSync, type Stats } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { LocalRuntimeSessionError } from "../local-runtime-session.js";
import { sourceReadInputSchema as readSchema, sourcePatchInputSchema as patchSchema } from "./source-maintenance-schemas.js";

const exec = promisify(execFile);
const sourceRoots = ["web/", "canvas-agent/", "backend/", "packages/", "desktop/macos/", "scripts/", "docs/"];
const textExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".go", ".swift", ".md", ".mdx", ".sh"]);
const listSchema = z.object({ prefix: z.string().max(300).default(""), offset: z.number().int().min(0).max(100_000).default(0), limit: z.number().int().min(1).max(100).default(60) }).strict();
const maxFileBytes = 256 * 1024;
export type SourcePatchReceipt = {
    requestId: string; path: string; beforeHash: string; afterHash: string; sourceHead: string;
    status: "applied"; verified: true; committed: false; runtimeUpdated: false;
};
type PreparedPatch = { inputHash: string; before: Buffer; after: Buffer; receipt: SourcePatchReceipt; expiresAt: number; mode: number };
// Serializes this Runtime's writers across workspace instances. This is not an
// OS-wide editor lock; external changes still require exact hash/inode checks.
const writers = new Set<string>();

// Source authority comes from the launched executable's repository, never an
// HTTP cwd or a model path. Writes additionally require a scoped session task.
export class SourceMaintenanceWorkspace {
    private readonly patches = new Map<string, PreparedPatch>();
    private readonly receipts = new Map<string, SourcePatchReceipt>();
    constructor(private readonly root: string) {}

    static fromEnvironment(environment: NodeJS.ProcessEnv = process.env, moduleRoot = fileURLToPath(new URL("../../../", import.meta.url))) {
        const source = environment.FILMOS_DESKTOP_SOURCE_ROOT;
        if (!source) return undefined;
        try {
            if (!path.isAbsolute(source) || path.resolve(source) !== realpathSync(source)
                || realpathSync(source) !== realpathSync(moduleRoot)
                || environment.FILMOS_DESKTOP_SOURCE_RUNTIME_ROOT !== path.join(source, ".local/source-host")) throw unavailable();
            return new SourceMaintenanceWorkspace(source);
        } catch { throw unavailable(); }
    }

    async inspect() {
        await this.assertRepository();
        // status may invoke a configured clean/process filter while refreshing
        // tracked files. Refuse that configuration instead of running source code.
        await this.assertNoFilters();
        const [head, tree, status, files] = await Promise.all([
            this.git("rev-parse", "HEAD"), this.git("rev-parse", "HEAD^{tree}"),
            this.git("status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=all"), this.files(),
        ]);
        return { available: true, mode: "source-read-only" as const, branch: "integration", head: head.trim(), tree: tree.trim(), trackedClean: status.length === 0, sourceFileCount: files.length,
            capabilities: { read: true, edit: false, runChecks: false, reload: false } };
    }

    async list(input: unknown) {
        const parsed = listSchema.safeParse(input);
        if (!parsed.success) throw invalid();
        const { prefix, offset, limit } = parsed.data;
        if (prefix && !safeRelative(prefix.replace(/\/$/, ""))) throw denied();
        await this.assertRepository();
        const files = (await this.files()).filter(file => file.startsWith(prefix));
        return { paths: files.slice(offset, offset + limit), total: files.length, nextOffset: offset + limit < files.length ? offset + limit : null };
    }

    async read(input: unknown) {
        const parsed = readSchema.safeParse(input);
        if (!parsed.success) throw invalid();
        const { path: relative, startLine, lineCount, expectedHash } = parsed.data;
        await this.assertTracked(relative);
        const absolute = path.join(this.root, relative);
        const body = this.readFile(relative, absolute);
        const contentHash = createHash("sha256").update(body).digest("hex");
        if (expectedHash && expectedHash !== contentHash) throw changed();
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { throw denied(); }
        if (text.includes("\0")) throw denied();
        const lines = text.split("\n");
        if (startLine > lines.length) throw invalid();
        return { path: relative, contentHash, bytes: body.length, startLine, endLine: Math.min(startLine + lineCount - 1, lines.length), totalLines: lines.length,
            content: lines.slice(startLine - 1, startLine - 1 + lineCount).join("\n"), truncated: startLine > 1 || startLine + lineCount - 1 < lines.length };
    }

    // The primitive is not permission: the session task binds owner/file scope
    // and revalidates it immediately before the synchronous replacement.
    async preparePatch(input: unknown) {
        const parsed = patchSchema.safeParse(input);
        if (!parsed.success) throw patchInvalid();
        const value = parsed.data;
        if (value.oldText === value.newText || [value.oldText, value.newText].some(text => text.includes("\0") || Buffer.from(text).toString("utf8") !== text)) throw patchInvalid();
        const inputHash = hash(Buffer.from(JSON.stringify(value)));
        const existing = this.patches.get(value.requestId);
        if (existing) {
            if (existing.inputHash !== inputHash) throw patchConflict();
            return { ...patchView(existing), ...(this.receipts.has(value.requestId) ? { status: "applied" as const, written: true } : {}) };
        }
        if (this.patches.size >= 32) throw new LocalRuntimeSessionError("agent_source_patch_limit", "本次维护补丁数量已达上限，请先核对已有回执", 409);
        await this.assertTracked(value.path);
        const head = (await this.git("rev-parse", "HEAD")).trim();
        const absolute = path.join(this.root, value.path);
        const before = this.readFile(value.path, absolute);
        if (hash(before) !== value.expectedHash) throw changed();
        try { new TextDecoder("utf-8", { fatal: true }).decode(before); } catch { throw denied(); }
        // Buffer.toString preserves a UTF-8 BOM and CRLF; decoding a document
        // for display must not silently normalize bytes in the patch path.
        const text = before.toString("utf8");
        if (text.includes("\0")) throw denied();
        const at = text.indexOf(value.oldText);
        if (at < 0 || text.indexOf(value.oldText, at + 1) !== -1) throw patchConflict();
        const after = Buffer.from(text.slice(0, at) + value.newText + text.slice(at + value.oldText.length));
        if (after.length > maxFileBytes || after.equals(before)) throw patchInvalid();
        const patch: PreparedPatch = { inputHash, before, after, expiresAt: Date.now() + 5 * 60_000, mode: lstatSync(absolute).mode,
            receipt: { requestId: value.requestId, path: value.path, beforeHash: value.expectedHash, afterHash: hash(after), sourceHead: head, status: "applied", verified: true, committed: false, runtimeUpdated: false } };
        // Preparation yields to Git; simultaneous requests cannot replace an
        // already frozen request ID with a different patch.
        if (this.patches.has(value.requestId) || this.patches.size >= 32) throw patchConflict();
        this.patches.set(value.requestId, patch);
        return patchView(patch);
    }

    async applyPreparedPatch(requestId: string, authorize: (scope: { path: string; requestId: string; beforeHash: string; afterHash: string }) => void) {
        const patch = this.patches.get(requestId);
        if (!patch || typeof authorize !== "function") throw patchInvalid();
        if (writers.has(this.root)) throw new LocalRuntimeSessionError("agent_source_writer_busy", "另一源码补丁正在执行，未排队或重发", 409);
        writers.add(this.root);
        let temporary: string | undefined, fd: number | undefined, replaced = false;
        try {
            const { path: relative, beforeHash, afterHash, sourceHead } = patch.receipt;
            const scope = { path: relative, requestId, beforeHash, afterHash };
            const assertAuthorized = () => {
                const result: unknown = authorize(scope);
                if (result !== undefined) {
                    if (result instanceof Promise) void result.catch(() => {});
                    throw new LocalRuntimeSessionError("agent_source_authorization_invalid", "源码写入需要已验证的同步任务授权；未等待隐式授权", 403);
                }
            };
            assertAuthorized();
            await this.assertTracked(relative);
            if ((await this.git("rev-parse", "HEAD")).trim() !== sourceHead) throw changed();
            const absolute = path.join(this.root, relative);
            const current = this.readFile(relative, absolute);
            const receipt = this.receipts.get(requestId);
            if (receipt) {
                if (hash(current) !== afterHash) throw changed();
                assertAuthorized();
                return { ...receipt, replayed: true };
            }
            if (Date.now() >= patch.expiresAt) throw new LocalRuntimeSessionError("agent_source_patch_expired", "补丁预览已过期；未执行或自动重发", 409);
            if (!current.equals(patch.before)) throw changed();
            const before = lstatSync(absolute);
            if (before.mode !== patch.mode || before.uid !== process.getuid?.()) throw denied();
            temporary = path.join(path.dirname(absolute), `.filmos-patch-${randomUUID()}`);
            fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
            let offset = 0;
            while (offset < patch.after.length) {
                const written = writeSync(fd, patch.after, offset, patch.after.length - offset);
                if (!written) throw new Error("short write");
                offset += written;
            }
            fchmodSync(fd, before.mode & 0o777);
            fsyncSync(fd);
            closeSync(fd); fd = undefined;
            assertAuthorized();
            if (Date.now() >= patch.expiresAt) throw new LocalRuntimeSessionError("agent_source_patch_expired", "补丁预览已过期；未执行或自动重发", 409);
            if (!this.readFile(relative, absolute).equals(patch.before) || !sameFile(before, lstatSync(absolute))) throw changed();
            // No await between the final scope/hash checks and replacement.
            renameSync(temporary, absolute); temporary = undefined; replaced = true;
            if (hash(this.readFile(relative, absolute)) !== afterHash) throw new Error("readback mismatch");
            this.receipts.set(requestId, { ...patch.receipt });
            return { ...patch.receipt, replayed: false };
        } catch (error) {
            if (replaced) throw new LocalRuntimeSessionError("agent_source_patch_uncertain", "文件已替换但回读未确认；请读取当前文件和原请求，不回滚或重发", 409);
            if (error instanceof LocalRuntimeSessionError) throw error;
            throw new LocalRuntimeSessionError("agent_source_patch_failed", "补丁未替换原文件；请检查权限或磁盘状态，不自动重试", 409);
        } finally {
            if (fd !== undefined) closeSync(fd);
            if (temporary) { try { unlinkSync(temporary); } catch { /* Only our exclusive temporary file; never delete the source. */ } }
            writers.delete(this.root);
        }
    }

    private async assertTracked(relative: string) {
        if (!readablePath(relative)) throw denied();
        await this.assertRepository();
        const entry = await this.git("ls-files", "--stage", "-z", "--", relative);
        if (!/^100(?:644|755) [0-9a-f]{40,64} 0\t/.test(entry) || entry.split("\0").filter(Boolean).length !== 1 || entry.split("\t")[1] !== `${relative}\0`) throw denied();
    }

    private readFile(relative: string, absolute: string) {
        let fd: number | undefined;
        try {
            this.assertNoSymlinks(relative);
            fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const before = fstatSync(fd);
            if (!before.isFile() || before.nlink !== 1 || before.size > maxFileBytes) throw denied();
            const buffer = Buffer.alloc(maxFileBytes + 1);
            let length = 0;
            while (length < buffer.length) {
                const count = readSync(fd, buffer, length, buffer.length - length, length);
                if (!count) break;
                length += count;
            }
            const after = fstatSync(fd);
            this.assertNoSymlinks(relative);
            const current = lstatSync(absolute);
            if (length > maxFileBytes || length !== before.size || !sameFile(before, after) || !sameFile(after, current)) throw changed();
            return buffer.subarray(0, length);
        } catch (error) {
            if (error instanceof LocalRuntimeSessionError) throw error;
            throw denied();
        } finally { if (fd !== undefined) closeSync(fd); }
    }

    private async assertRepository() {
        try {
            if (!path.isAbsolute(this.root) || this.root === path.parse(this.root).root || realpathSync(this.root) !== path.resolve(this.root)
                || !lstatSync(path.join(this.root, ".git")).isDirectory()) throw unavailable();
            const [top, branch, common] = await Promise.all([this.git("rev-parse", "--show-toplevel"), this.git("branch", "--show-current"), this.git("rev-parse", "--path-format=absolute", "--git-common-dir")]);
            if (realpathSync(top.trim()) !== this.root || branch.trim() !== "integration" || realpathSync(common.trim()) !== path.join(this.root, ".git")) throw unavailable();
        } catch { throw unavailable(); }
    }

    private async files() {
        const files = (await this.git("ls-files", "--stage", "-z")).split("\0").filter(Boolean).flatMap(entry => {
            const match = /^100(?:644|755) [0-9a-f]{40,64} 0\t(.+)$/.exec(entry);
            return match && readablePath(match[1]) ? [match[1]] : [];
        });
        return [...new Set(files)].sort();
    }

    private async assertNoFilters() {
        try {
            await this.git("config", "--local", "--includes", "--name-only", "--get-regexp", "^filter\\.");
        } catch (error) {
            if ((error as { code?: number }).code === 1) return;
            throw unavailable();
        }
        throw unavailable();
    }

    private assertNoSymlinks(relative: string) {
        let current = this.root;
        for (const part of relative.split("/")) {
            current = path.join(current, part);
            if (lstatSync(current).isSymbolicLink()) throw denied();
        }
        if (realpathSync(current) !== path.join(this.root, relative)) throw denied();
    }

    private async git(...args: string[]) {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
        const { stdout } = await exec("git", ["--no-optional-locks", "--literal-pathspecs", "-C", this.root, "-c", "core.fsmonitor=false", ...args],
            { encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
        return stdout;
    }
}

function sameFile(a: Stats, b: Stats) {
    return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function hash(body: Buffer) { return createHash("sha256").update(body).digest("hex"); }
function patchView(patch: PreparedPatch) {
    const { requestId, path, beforeHash, afterHash, sourceHead } = patch.receipt;
    return { requestId, path, beforeHash, afterHash, sourceHead, expiresAt: new Date(patch.expiresAt).toISOString(), beforeBytes: patch.before.length, afterBytes: patch.after.length, status: "prepared" as const, written: false };
}
function patchInvalid() { return new LocalRuntimeSessionError("agent_source_patch_invalid", "补丁必须指定唯一文件、原哈希及精确替换片段，且不得超限", 400); }
function patchConflict() { return new LocalRuntimeSessionError("agent_source_patch_conflict", "原片段不唯一、请求ID重复或补丁身份变化；未执行修改", 409); }

function safeRelative(value: string) {
    return !path.isAbsolute(value) && !/[\\\x00-\x1f\x7f]/.test(value) && value.split("/").every(part => part && part !== "." && part !== ".." && !part.startsWith("."));
}
function readablePath(value: string) {
    if (!safeRelative(value) || /(?:^|\/)(?:node_modules|data|uploads|generated|dist|vendor)(?:\/|$)/.test(value)) return false;
    if (["AGENTS.md", "README.md", "源码启动.command"].includes(value)) return true;
    if (!sourceRoots.some(root => value.startsWith(root))) return false;
    return textExtensions.has(path.extname(value)) || /(?:^|\/)(?:package|tsconfig(?:\.[a-z-]+)?)\.json$/.test(value);
}
function unavailable() { return new LocalRuntimeSessionError("agent_source_unavailable", "当前不是唯一 integration 源码运行环境，未开放源码维护", 409); }
function invalid() { return new LocalRuntimeSessionError("agent_source_request_invalid", "源码读取参数无效或超限", 400); }
function denied() { return new LocalRuntimeSessionError("agent_source_path_denied", "只能读取当前源码中受支持的 tracked 普通文本文件；不读取用户材料、密钥、数据或链接", 403); }
function changed() { return new LocalRuntimeSessionError("agent_source_changed", "读取期间源码已改变，请重新核对文件版本；没有执行修改", 409); }
