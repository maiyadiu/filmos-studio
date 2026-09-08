import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SOURCE_MAINTENANCE_TOOLS, type BrainSession, type SourceMaintenanceRecord } from "@filmos/agent-contracts";
import type { BrainSessionStore } from "./session-store.js";
import { SourceMaintenanceWorkspace, sourceReadInputSchema, sourcePatchInputSchema } from "./source-maintenance.js";
import { LocalRuntimeSessionError } from "../local-runtime-session.js";

const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const openSchema = z.object({ requestId, purpose: z.string().trim().min(1).max(1000), files: z.array(z.object({ path: z.string().min(1).max(300), expectedHash: hash }).strict()).min(1).max(5) }).strict();
export const sourceToolSchemas = {
    source_get_task: z.object({}).strict(),
    source_read_file: sourceReadInputSchema,
    source_prepare_patch: sourcePatchInputSchema,
    source_apply_patch: z.object({ requestId }).strict(),
} as const;
type SourceTool = keyof typeof sourceToolSchemas;
type SourceAuthorization = () => void;
type ActiveTask = { sessionId: string; accountScopeId: string; workspace: SourceMaintenanceWorkspace; record: SourceMaintenanceRecord; authorize: SourceAuthorization; busy: boolean };

// Authority exists only in this Runtime. Stored records are recovery evidence,
// never grants. Reopening a provider thread cannot resurrect source privileges.
export class SourceMaintenanceTasks {
    private active?: ActiveTask;
    private opening = false;
    constructor(private readonly workspace: () => SourceMaintenanceWorkspace | undefined, private readonly store: () => BrainSessionStore) {}

    async open(session: BrainSession, input: unknown, authorize: SourceAuthorization) {
        assertAuthorized(authorize);
        const parsed = openSchema.safeParse(input);
        if (!parsed.success || !session.accountScopeId || session.brainProfileId !== "codex.subscription" || session.executionProfile === "review_coordinator") throw failure("agent_source_task_invalid", 400);
        const body = parsed.data;
        if (new Set(body.files.map(file => file.path)).size !== body.files.length) throw failure("agent_source_task_invalid", 400);
        if (this.opening || this.active || session.sourceMaintenance?.status === "active") throw failure("agent_source_task_busy", 409);
        this.opening = true;
        try {
            const workspace = this.workspace();
            if (!workspace) throw failure("agent_source_unavailable", 409);
            const source = await workspace.inspect();
            const files = [];
            for (const file of body.files) {
                const current = await workspace.read({ path: file.path, expectedHash: file.expectedHash, lineCount: 1 });
                files.push({ path: file.path, initialHash: current.contentHash, currentHash: current.contentHash });
            }
            assertAuthorized(authorize);
            if ((await workspace.inspect()).head !== source.head) throw failure("agent_source_changed", 409);
            assertAuthorized(authorize);
            const record: SourceMaintenanceRecord = { id: randomUUID(), requestId: body.requestId, purpose: body.purpose, sourceHead: source.head, status: "active", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), files, patches: [] };
            await this.store().updateSession(session.id, { sourceMaintenance: structuredClone(record) });
            // A late revoke leaves an inert saved record, not working authority.
            assertAuthorized(authorize);
            this.active = { sessionId: session.id, accountScopeId: session.accountScopeId, workspace, record, authorize, busy: false };
            return structuredClone(record);
        } finally { this.opening = false; }
    }

    grant(session: BrainSession) {
        if (!this.active || this.active.sessionId !== session.id) return undefined;
        const task = this.require(session);
        return { sourceTaskId: task.record.id, allowedTools: ["workbench_get_context", ...SOURCE_MAINTENANCE_TOOLS] };
    }

    view(session: BrainSession) {
        const record = session.sourceMaintenance;
        let live = false;
        try { live = this.require(session).record.id === record?.id; } catch { /* History remains readable without working authority. */ }
        return { record: record ? structuredClone(record) : null, live,
            note: "历史记录不授予权限；源码修改不代表运行态已更新。" };
    }

    async close(session: BrainSession, authorize: SourceAuthorization) {
        assertAuthorized(authorize);
        const task = this.active?.sessionId === session.id ? this.active : undefined;
        if (task?.accountScopeId !== undefined && task.accountScopeId !== session.accountScopeId) throw failure("agent_source_task_denied", 403);
        if (task?.busy || session.sourceMaintenance?.patches.some(patch => patch.status === "applying")) throw failure("agent_source_task_review_required", 409);
        const record = task?.record ?? session.sourceMaintenance;
        if (!record) throw failure("agent_source_task_missing", 404);
        if (task) this.active = undefined;
        await this.store().updateSession(session.id, { sourceMaintenance: { ...structuredClone(record), status: "closed" } });
        assertAuthorized(authorize);
    }

    async reconcile(session: BrainSession, authorize: SourceAuthorization) {
        assertAuthorized(authorize);
        const task = this.active?.sessionId === session.id ? this.active : undefined;
        if (task?.busy) throw failure("agent_source_writer_busy", 409);
        if (task && task.accountScopeId !== session.accountScopeId) throw failure("agent_source_task_denied", 403);
        const record = structuredClone(task?.record ?? session.sourceMaintenance);
        const workspace = task?.workspace ?? this.workspace();
        if (!record || !workspace) throw failure("agent_source_task_missing", 404);
        if (task) task.busy = true;
        try {
            if ((await workspace.inspect()).head !== record.sourceHead) throw failure("agent_source_changed", 409);
            for (const patch of record.patches.filter(patch => patch.status === "applying")) {
                const current = await workspace.read({ path: patch.path, lineCount: 1 });
                assertAuthorized(authorize);
                if (current.contentHash !== patch.beforeHash && current.contentHash !== patch.afterHash) throw failure("agent_source_changed", 409);
                patch.status = current.contentHash === patch.afterHash ? "applied" : "not_applied";
                patch.verifiedAt = new Date().toISOString();
                const file = record.files.find(file => file.path === patch.path);
                if (!file) throw failure("agent_source_task_denied", 403);
                file.currentHash = current.contentHash;
            }
            // Even a saved successful receipt is history: verify the latest
            // expected bytes before presenting recovery as reconciled.
            for (const file of record.files) await workspace.read({ path: file.path, expectedHash: file.currentHash, lineCount: 1 });
            if ((await workspace.inspect()).head !== record.sourceHead) throw failure("agent_source_changed", 409);
            assertAuthorized(authorize);
            await this.store().updateSession(session.id, { sourceMaintenance: record });
            if (task) task.record = record;
            assertAuthorized(authorize);
            return { record, writeExecuted: false, note: "仅核对磁盘前后哈希；不会重新应用补丁，历史记录不会重新授予权限。" };
        } finally { if (task) task.busy = false; }
    }

    async execute(session: BrainSession, sourceTaskId: string | undefined, tool: string, input: Record<string, unknown>, authorizeTurn: SourceAuthorization = () => {}) {
        const check = () => {
            try { assertAuthorized(authorizeTurn); }
            catch (error) {
                if (error instanceof Error && error.message === "AGENT_TURN_CANCELLED") throw new LocalRuntimeSessionError("agent_turn_cancelled", "本轮已停止；源码补丁结果须回读，不自动重发", 409);
                throw error;
            }
            return this.require(session);
        };
        const task = check();
        if (sourceTaskId !== task.record.id || !Object.hasOwn(sourceToolSchemas, tool)) throw failure("agent_source_task_denied", 403);
        const schema = sourceToolSchemas[tool as SourceTool];
        if (!schema.safeParse(input).success) throw failure("agent_source_task_invalid", 400);
        if (task.busy) throw failure("agent_source_writer_busy", 409);
        task.busy = true;
        try {
            if (tool === "source_get_task") return { task: structuredClone(task.record), runtimeUpdated: false };
            if (tool === "source_read_file") {
                this.file(task, String(input.path));
                const result = await task.workspace.read(input);
                check();
                return result;
            }
            if (tool === "source_prepare_patch") {
                const file = this.file(task, String(input.path));
                if (file.currentHash !== input.expectedHash || task.record.patches.some(patch => patch.status === "applying")) throw failure("agent_source_changed", 409);
                const plan = await task.workspace.preparePatch(input);
                check();
                if (plan.sourceHead !== task.record.sourceHead) throw failure("agent_source_changed", 409);
                if (!task.record.patches.some(patch => patch.requestId === plan.requestId)) {
                    task.record.patches.push({ requestId: plan.requestId, path: plan.path, beforeHash: plan.beforeHash, afterHash: plan.afterHash, status: "prepared" });
                    await this.persist(task);
                }
                check();
                return plan;
            }
            const patch = task.record.patches.find(patch => patch.requestId === input.requestId);
            if (!patch) throw failure("agent_source_task_denied", 403);
            const file = this.file(task, patch.path);
            if (patch.status === "applying") throw failure("agent_source_task_review_required", 409);
            if (patch.status === "not_applied") throw failure("agent_source_task_review_required", 409);
            if (file.currentHash !== (patch.status === "applied" ? patch.afterHash : patch.beforeHash)) throw failure("agent_source_changed", 409);
            const previousStatus = patch.status;
            // Intent survives process exit before any filesystem write. A lost
            // response cannot be turned into a second speculative replacement.
            patch.status = "applying";
            try { await this.persist(task); } catch (error) { patch.status = previousStatus; throw error; }
            check();
            const result = await task.workspace.applyPreparedPatch(patch.requestId, scope => {
                check();
                if (scope.path !== patch.path || scope.beforeHash !== patch.beforeHash || scope.afterHash !== patch.afterHash) throw failure("agent_source_task_denied", 403);
            });
            file.currentHash = result.afterHash;
            patch.status = "applied";
            patch.verifiedAt = new Date().toISOString();
            await this.persist(task);
            check();
            return result;
        } finally { task.busy = false; }
    }

    private require(session: BrainSession) {
        const task = this.active;
        if (!task || task.sessionId !== session.id || task.accountScopeId !== session.accountScopeId || session.brainProfileId !== "codex.subscription" || session.executionProfile === "review_coordinator" || task.record.status !== "active") throw failure("agent_source_task_denied", 403);
        assertAuthorized(task.authorize);
        if (Date.now() >= Date.parse(task.record.expiresAt)) throw failure("agent_source_task_expired", 409);
        return task;
    }
    private file(task: ActiveTask, path: string) {
        const file = task.record.files.find(file => file.path === path);
        if (!file) throw failure("agent_source_task_denied", 403);
        return file;
    }
    private async persist(task: ActiveTask) { await this.store().updateSession(task.sessionId, { sourceMaintenance: structuredClone(task.record) }); }
}

function failure(code: string, status: number) {
    return new LocalRuntimeSessionError(code, "源码任务范围、授权或结果需核对；不会扩大文件范围、自动重发补丁或重启工作台", status);
}
function assertAuthorized(authorize: SourceAuthorization) {
    const result: unknown = authorize();
    if (result !== undefined) {
        if (result instanceof Promise) void result.catch(() => {});
        throw failure("agent_source_authorization_invalid", 403);
    }
}
