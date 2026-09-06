import { canvasToolApiError, CanvasPromptConflictError, ShotImageReadError } from "../../../../packages/filmos-agent-contracts/src/index";
import { ApiError } from "../../services/api/request";
import { CanvasPromptSaveError } from "../../services/api/canvas-prompts";

export function canvasToolFailure(error: unknown): { error: string; backendStatus?: number; localConflict?: string; visualError?: string } {
    if (error instanceof ShotImageReadError) return { error: error.message, visualError: error.code };
    const apiError = error instanceof CanvasPromptSaveError && (error.cause instanceof ApiError || error.cause instanceof CanvasPromptConflictError) ? error.cause : error;
    if (apiError instanceof CanvasPromptConflictError) return { error: apiError.message, localConflict: apiError.code };
    if (apiError instanceof ApiError) {
        const failure = canvasToolApiError(apiError.status) ?? canvasToolApiError(apiError.code);
        if (failure) return { error: failure.message, backendStatus: failure.statusCode };
    }
    // Unknown errors are still masked by the runtime's public error boundary.
    return { error: error instanceof Error ? error.message : "画布操作失败" };
}
