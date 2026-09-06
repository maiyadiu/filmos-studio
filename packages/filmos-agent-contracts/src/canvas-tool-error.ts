// Only bounded HTTP failure semantics cross the browser/runtime boundary.
// Backend messages, URLs, response bodies and credentials must not cross it.
export class CanvasToolApiError extends Error {
    readonly code: string;
    constructor(readonly statusCode: number) {
        if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) throw new Error("INVALID_CANVAS_BACKEND_STATUS");
        const message = statusCode === 404 ? "未找到目标或原请求回执；请核对目标并回读当前版本，不代表请求已保存"
            : statusCode === 409 ? "业务版本或依赖发生冲突；回读当前内容与原请求回执后再决定，不盲目重复写入"
            : statusCode === 401 ? "业务登录已失效；恢复登录后回读实际结果"
            : statusCode === 403 ? "当前账号无权操作该业务对象，已拒绝执行"
            : statusCode === 429 ? "业务请求受限；稍后先回读实际结果，不自动重试写入"
            : statusCode === 408 || statusCode >= 500 ? "业务服务暂不可用或响应超时；保存结果可能不确定，恢复后先回读原请求"
            : "业务请求未通过校验；请核对参数和目标，不重复盲写";
        super(message);
        this.name = "CanvasToolApiError";
        this.code = `canvas_backend_http_${statusCode}`;
    }
}

export function canvasToolApiError(status: unknown): CanvasToolApiError | undefined {
    return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
        ? new CanvasToolApiError(status) : undefined;
}

// A browser preflight refusal is not an observed backend HTTP response.
export class CanvasPromptConflictError extends Error {
    readonly code = "canvas_local_prompt_conflict";
    constructor() {
        super("本地提示词版本或请求已变化，本次尚未提交保存；请回读目标与原请求，不覆盖本地草稿");
        this.name = "CanvasPromptConflictError";
    }
}
