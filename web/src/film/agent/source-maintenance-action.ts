import type { AgentSessionClient, BrainSessionView, SourceTaskInput } from "./agent-client";

export type SourceSessionScope = Pick<BrainSessionView, "id" | "brainProfileId" | "projectId" | "workspaceId" | "canvasId" | "domainProjectId" | "contentUnitId">;
export type SourceScopeOperation = { kind: "open"; input: SourceTaskInput } | { kind: "close" } | { kind: "reconcile" };
type Client = Pick<AgentSessionClient, "getSession" | "getSourceTask" | "openSourceTask" | "closeSourceTask" | "reconcileSourceTask" | "resumeSession">;

export function assertSourceSession(session: BrainSessionView, scope: SourceSessionScope, idle = false) {
    if (scope.brainProfileId !== "codex.subscription" || Object.entries(scope).some(([key, value]) => session[key as keyof SourceSessionScope] !== value) || !session.providerThreadId || session.status === "closed") {
        throw new Error("维护会话身份不匹配；不会创建替代对话。");
    }
    if (idle && (!session.execution || session.execution.activeTurnId || session.execution.resuming || session.execution.pendingConfirmations.length || ["creating", "running", "awaiting_confirmation"].includes(session.status))) {
        throw new Error("原会话尚未确认空闲，请先处理当前轮次。");
    }
}

// The one mutation is followed by readback, never by an automatic retry/resume.
// It rotates the original thread's scope, not its model, draft, or conversation.
export async function changeSourceScope(client: Client, scope: SourceSessionScope, operation: SourceScopeOperation, isCurrent: () => boolean, syncContext: () => Promise<boolean>) {
    const check = () => { if (!isCurrent()) throw new Error("工作台或会话已切换；旧维护结果未应用到当前对话。"); };
    check();
    const { session: before } = await client.getSession(scope.id);
    check(); assertSourceSession(before, scope, true);
    if (!await syncContext()) throw new Error("当前页面上下文同步失败，未改变维护范围。");
    check();
    if (operation.kind === "open") {
        const result = await client.openSourceTask(scope.id, operation.input);
        check(); assertSourceSession(result.session, scope);
        if (result.session.providerThreadId !== before.providerThreadId) throw new Error("维护返回的原生对话身份变化，请核对原会话。");
    } else if (operation.kind === "close") {
        // An unsuccessful open can leave no source record. Explicit recovery
        // still uses the original thread; reading alone never renews authority.
        const result = before.sourceMaintenance ? await client.closeSourceTask(scope.id) : await client.resumeSession(scope.id);
        check(); assertSourceSession(result.session, scope);
        if (result.session.providerThreadId !== before.providerThreadId) throw new Error("结束维护返回的原生对话身份变化，请核对原会话。");
    } else await client.reconcileSourceTask(scope.id);
    check();
    const { session } = await client.getSession(scope.id);
    check(); assertSourceSession(session, scope, true);
    if (session.providerThreadId !== before.providerThreadId) throw new Error("回读原生对话身份变化，未接续任务。");
    const { source } = await client.getSourceTask(scope.id);
    check();
    if (operation.kind === "open" && (!source.live || source.record?.requestId !== operation.input.requestId || source.record.status !== "active")) throw new Error("维护开启结果未核实，先核对原请求，不重复开启。");
    if (operation.kind === "close" && (source.record?.status === "active" || (before.sourceMaintenance && !source.record))) throw new Error("维护结束结果未核实，请核对原请求。");
    return { session, source };
}
