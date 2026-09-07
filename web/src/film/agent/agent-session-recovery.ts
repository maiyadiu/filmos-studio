import { AgentRuntimeRequestError, type AgentSessionClient, type BrainSessionView } from "./agent-client";

type RecoveryScope = Pick<BrainSessionView, "id" | "brainProfileId" | "projectId" | "canvasId" | "domainProjectId" | "contentUnitId">;
type RecoveryClient = Pick<AgentSessionClient, "getSession" | "resumeSession">;

// Recovery rotates the local grant and reads history; it must never send a turn
// or replay a business request. The Runtime remains the authority on live turns.
export async function recoverAgentSession(client: RecoveryClient, scope: RecoveryScope, isCurrent: () => boolean, syncContext: () => Promise<boolean>) {
    const assertCurrent = () => { if (!isCurrent()) throw new Error("工作台或会话已切换，未将旧恢复结果应用到当前对话。"); };
    const assertScope = (session: BrainSessionView) => {
        if (Object.entries(scope).some(([key, value]) => session[key as keyof RecoveryScope] !== value)) throw new Error("会话与当前作品身份不一致，已停止恢复。");
        if (session.status === "closed") throw new Error("该会话已关闭，不能恢复。");
    };
    const assertIdle = (session: BrainSessionView) => {
        if (!session.execution) throw new Error("本轮执行状态尚未确认，暂不恢复。");
        if (session.execution.activeTurnId || session.execution.resuming || session.execution.pendingConfirmations.length) throw new Error("会话仍在执行或等待确认，请先处理当前轮次。");
    };
    assertCurrent();
    const { session: before } = await client.getSession(scope.id);
    assertCurrent(); assertScope(before); assertIdle(before);
    if (scope.brainProfileId === "codex.subscription" && !before.providerThreadId) throw new Error("原 Codex 会话身份缺失，不能以新对话冒充恢复。");
    if (!await syncContext()) throw new Error("当前工作台上下文同步失败，未恢复会话；请检查本地连接。");
    assertCurrent();
    const result = await client.resumeSession(scope.id);
    assertCurrent(); assertScope(result.session);
    if (result.session.providerThreadId !== before.providerThreadId) throw new Error("恢复返回了不同的原生会话身份，已停止接续。");
    const { session: after } = await client.getSession(scope.id);
    assertCurrent(); assertScope(after); assertIdle(after);
    if (after.providerThreadId !== before.providerThreadId) throw new Error("回读会话身份已变化，已停止接续。");
    return result;
}

export function agentFailureGuidance(code: string): string {
    switch (code) {
        case "agent_grant_refresh_required":
            return "这是 FilmOS 本地工具授权到期，不是 Codex 订阅掉线。轮次结束后可点“恢复当前会话”；恢复不会重发任务，继续前先回读原请求及当前版本。";
        case "agent_context_refresh_required": case "agent_context_stale":
            return "工作台上下文已变化或到期。先重新读取工作台及目标当前版本；不要重复提交旧参数。";
        case "canvas_backend_http_401":
            return "这是工作台登录态失效，不是订阅额度或工具授权。恢复工作台登录后先回读原请求及当前版本。";
        case "canvas_backend_http_400":
            return "这是业务参数校验失败，恢复授权不能修正参数。请核对错误字段、来源及目标，再决定是否修正请求。";
        case "canvas_backend_http_404":
            return "目标或原回执未找到，不代表保存一定没发生。先核对项目、章节、原 requestId 和当前内容；不要换 ID 重复创建。";
        case "canvas_backend_http_409": case "agent_confirmation_unavailable":
            return "版本或确认状态已失效。先回读当前结果，不重复批准旧请求或覆盖新版本。";
        default: return "";
    }
}

export function agentFailureText(error: unknown) {
    const text = error instanceof Error ? error.message : "请求失败";
    // Only classify a server error code, never the assistant's narrative.
    const guidance = error instanceof AgentRuntimeRequestError ? agentFailureGuidance(error.code) : "";
    return guidance ? `${text}\n\n${guidance}` : text;
}
