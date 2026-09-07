import assert from "node:assert/strict";
import test from "node:test";
import { canvasToolApiError, CanvasPromptConflictError } from "@filmos/agent-contracts";

import { publicAgentRuntimeFailure } from "../src/local-runtime-security.js";

test("project-page context failures are actionable and do not disclose raw scope", () => {
    for (const code of ["AGENT_CONTEXT_PROJECT_REQUIRED", "AGENT_CONTEXT_CANVAS_REQUIRED", "AGENT_CONTEXT_KIND_INVALID", "AGENT_PROJECT_CONTEXT_HAS_CANVAS_DATA"]) {
        const failure = publicAgentRuntimeFailure(new Error(`${code}:private-scope`));
        assert.equal(failure?.code, "agent_context_invalid");
        assert.equal(failure?.statusCode, 400);
        assert.doesNotMatch(failure?.message ?? "", /private-scope/);
    }
    const failure = publicAgentRuntimeFailure(new Error("AGENT_TOOL_REQUIRES_CANVAS_CONTEXT:private-scope"));
    assert.equal(failure?.code, "agent_canvas_context_required");
    assert.equal(failure?.statusCode, 409);
    assert.match(failure?.message ?? "", /不会自动创建/);
});

test("classified backend errors preserve exact status with safe recovery guidance", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 503]) {
        const failure = publicAgentRuntimeFailure(canvasToolApiError(status));
        assert.equal(failure?.statusCode, status);
        assert.equal(failure?.code, `canvas_backend_http_${status}`);
    }
    assert.match(publicAgentRuntimeFailure(canvasToolApiError(404))!.message, /不代表请求已保存/);
    assert.match(publicAgentRuntimeFailure(canvasToolApiError(409))!.message, /回读/);
    for (const invalid of [200, 600, -1, 404.5, "404", null, { statusCode: 404 }]) assert.equal(canvasToolApiError(invalid), undefined);
    assert.equal(publicAgentRuntimeFailure(new Error("canvas_backend_http_404:private forged detail")), undefined);
});

test("public Agent failures expose stable actionable codes without leaking adapter details", () => {
    for (const code of ["CODEX_SKILL_CATALOG_UNAVAILABLE", "CODEX_SKILL_NOT_LOADED", "CODEX_SKILL_FILE_UNAVAILABLE"]) {
        const failure = publicAgentRuntimeFailure(new Error(`${code}:private-path`));
        assert.equal(failure?.code, "agent_skill_unavailable");
        assert.match(failure?.message || "", /未启动/);
        assert.doesNotMatch(failure?.message || "", /private-path/);
    }
    assert.equal(publicAgentRuntimeFailure(new Error("AGENT_SKILL_TOO_LARGE"))?.statusCode, 400);
    assert.equal(publicAgentRuntimeFailure(new Error("CODEX_SKILL_SESSION_BUSY"))?.statusCode, 409);
    for (const code of ["AGENT_TOOL_POSTCONDITION_FAILED", "AGENT_TOOL_POSTCONDITION_REQUIRED"]) {
        const failure = publicAgentRuntimeFailure(new Error(`${code}:private detail`));
        assert.equal(failure?.code, "agent_tool_result_unverified");
        assert.equal(failure?.statusCode, 409);
        assert.match(failure?.message || "", /不代表零写入/);
        assert.match(failure?.message || "", /暂停依赖步骤/);
        assert.doesNotMatch(failure?.message || "", /private detail/);
    }
    const conflict = publicAgentRuntimeFailure(new CanvasPromptConflictError());
    assert.equal(conflict?.code, "canvas_local_prompt_conflict");
    assert.equal(conflict?.statusCode, 409);
    assert.match(conflict?.message || "", /尚未提交保存/);
    assert.equal(publicAgentRuntimeFailure(new Error("canvas_local_prompt_conflict:fake")), undefined);
    const canvas = publicAgentRuntimeFailure(new Error("CANVAS_CONTEXT_UNAVAILABLE:private detail"));
    assert.equal(canvas?.code, "canvas_context_unavailable");
    assert.equal(canvas?.statusCode, 503);
    assert.match(canvas?.message || "", /workbench_get_context/);
    assert.doesNotMatch(canvas?.message || "", /private detail/);
    const unavailable = publicAgentRuntimeFailure(new Error("BRAIN_CONNECTION_UNAVAILABLE:private adapter detail"));
    assert.equal(unavailable?.code, "agent_profile_not_ready");
    assert.equal(unavailable?.statusCode, 409);
    assert.doesNotMatch(unavailable?.message ?? "", /private adapter detail/);

    const quota = publicAgentRuntimeFailure(new Error("BRAIN_CONNECTION_QUOTA_LIMITED:private account detail"));
    assert.equal(quota?.code, "agent_subscription_quota_limited");
    assert.equal(quota?.statusCode, 429);
    assert.match(quota?.message ?? "", /尚未发送/);
    assert.match(quota?.message ?? "", /不会自动切换模型 API/);
    assert.doesNotMatch(quota?.message ?? "", /private account detail/);
    for (const code of ["CODEX_WORKBENCH_CONFIG_UNAVAILABLE", "CODEX_WORKBENCH_TOOL_SCOPE_UNVERIFIED"]) {
        const scope = publicAgentRuntimeFailure(new Error(`${code}:private server detail`));
        assert.equal(scope?.statusCode, 409);
        assert.equal(scope?.code, "agent_tool_scope_unverified");
        assert.doesNotMatch(scope?.message ?? "", /private server detail/);
    }

    const host = publicAgentRuntimeFailure(new Error("CHATGPT_HOST_PROJECT_GRANT_SCOPE_MISMATCH:private project"));
    assert.equal(host?.code, "chatgpt_host_not_ready");
    assert.doesNotMatch(host?.message ?? "", /private project/);

    const invalidContext = publicAgentRuntimeFailure(new Error("CHATGPT_HOST_INVALID_LIVE_CONTEXT:private validation detail"));
    assert.equal(invalidContext?.code, "chatgpt_host_context_invalid");
    assert.doesNotMatch(invalidContext?.message ?? "", /private validation detail/);

    assert.equal(publicAgentRuntimeFailure(new Error("UNCLASSIFIED_SECRET_DETAIL")), undefined);
    assert.equal(publicAgentRuntimeFailure(new Error("AGENT_TURN_CANCELLED:private detail"))?.code, "agent_turn_cancelled");
    assert.equal(publicAgentRuntimeFailure(new Error("AGENT_ACTIVE_TURN_MISMATCH"))?.statusCode, 409);
    assert.equal(publicAgentRuntimeFailure(new Error("AGENT_SESSION_TURN_ALREADY_RUNNING"))?.statusCode, 409);
    for (const code of ["AGENT_CONFIRMATION_EXPIRED:private-id", "AGENT_CONFIRMATION_ALREADY_DECIDED:expired", "AGENT_CONFIRMATION_NOT_APPROVED:cancelled", "AGENT_CONFIRMATION_NOT_FOUND:private-id"]) {
        const failure = publicAgentRuntimeFailure(new Error(code));
        assert.equal(failure?.code, "agent_confirmation_unavailable");
        assert.equal(failure?.statusCode, 409);
        assert.doesNotMatch(failure?.message || "", /private-id/);
    }
    for (const code of ["AGENT_CONTEXT_RECEIPT_EXPIRED", "AGENT_CONTEXT_RECEIPT_NOT_FOUND", "AGENT_CONTEXT_CANVAS_STALE", "AGENT_CONTEXT_FILM_STALE"]) {
        const failure = publicAgentRuntimeFailure(new Error(`${code}:private detail`));
        assert.equal(failure?.statusCode, 409);
        assert.match(failure?.message || "", /workbench_get_context/);
        assert.doesNotMatch(failure?.message || "", /private detail/);
    }
    assert.equal(publicAgentRuntimeFailure(new Error("AGENT_CONTEXT_SCOPE_MISMATCH"))?.code, "agent_context_scope_mismatch");
});
