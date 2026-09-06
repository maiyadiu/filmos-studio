import { expect, test } from "bun:test";
import { ApiError } from "../src/services/api/request";
import { CanvasPromptSaveError } from "../src/services/api/canvas-prompts";
import { canvasToolFailure } from "../src/lib/canvas/canvas-tool-failure";
import { CanvasPromptConflictError } from "../../packages/filmos-agent-contracts/src/index";

test("backend failure status survives the canvas bridge without sensitive messages", () => {
    for (const status of [400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503, 504]) {
        const failure = canvasToolFailure(new ApiError("private cookie and database path", { status, code: status }));
        expect(failure.backendStatus).toBe(status);
        expect(failure.error).not.toContain("private");
    }
    expect(canvasToolFailure(new ApiError("business envelope failure", { status: 200, code: 409 })).backendStatus).toBe(409);
    expect(canvasToolFailure(new ApiError("conflicting envelope", { status: 403, code: 404 })).backendStatus).toBe(403);
    expect(canvasToolFailure(new ApiError("network lost"))).not.toHaveProperty("backendStatus");
    expect(canvasToolFailure(Object.assign(new Error("unknown"), { status: 404 }))).not.toHaveProperty("backendStatus");
    expect(canvasToolFailure(new CanvasPromptSaveError("private rejection details", "rejected", { cause: new ApiError("private conflict", { status: 409 }) }))).toMatchObject({ backendStatus: 409 });
    expect(canvasToolFailure(new Error("unclassified wrapper", { cause: new ApiError("private", { status: 404 }) }))).not.toHaveProperty("backendStatus");
});

test("local prompt conflicts are not mislabeled as backend responses", () => {
    const local = new CanvasPromptConflictError();
    for (const error of [local, new CanvasPromptSaveError("private detail", "rejected", { cause: local })]) {
        const result = canvasToolFailure(error);
        expect(result.localConflict).toBe("canvas_local_prompt_conflict");
        expect(result).not.toHaveProperty("backendStatus");
        expect(result.error).toContain("尚未提交保存");
        expect(result.error).not.toContain("private");
    }
    expect(canvasToolFailure(Object.assign(new Error("forged"), { code: local.code }))).not.toHaveProperty("localConflict");
});
