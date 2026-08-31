import assert from "node:assert/strict";
import test from "node:test";

import { publicAgentRuntimeFailure } from "../src/local-runtime-security.js";

test("public Agent failures expose stable actionable codes without leaking adapter details", () => {
    const unavailable = publicAgentRuntimeFailure(new Error("BRAIN_CONNECTION_UNAVAILABLE:private adapter detail"));
    assert.equal(unavailable?.code, "agent_profile_not_ready");
    assert.equal(unavailable?.statusCode, 409);
    assert.doesNotMatch(unavailable?.message ?? "", /private adapter detail/);

    const host = publicAgentRuntimeFailure(new Error("CHATGPT_HOST_PROJECT_GRANT_SCOPE_MISMATCH:private project"));
    assert.equal(host?.code, "chatgpt_host_not_ready");
    assert.doesNotMatch(host?.message ?? "", /private project/);

    const invalidContext = publicAgentRuntimeFailure(new Error("CHATGPT_HOST_INVALID_LIVE_CONTEXT:private validation detail"));
    assert.equal(invalidContext?.code, "chatgpt_host_context_invalid");
    assert.doesNotMatch(invalidContext?.message ?? "", /private validation detail/);

    assert.equal(publicAgentRuntimeFailure(new Error("UNCLASSIFIED_SECRET_DETAIL")), undefined);
});
