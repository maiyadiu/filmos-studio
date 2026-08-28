import { describe, expect, test } from "bun:test";

import { runRcSurface } from "./rc_surface";

describe("Stage 6 RC local surface recovery", () => {
  test("Remote receipt, flags, Agent Apply and lost sessions fail closed", async () => {
    const result = await runRcSurface();
    expect(result.status).toBe("PASSED_LOCAL_RC_SURFACE_RECOVERY");
    expect(result.remote.source_unchanged).toBe(true);
    expect(result.remote.replayed_same_receipt).toBe(true);
    expect(result.remote.receipt_id).toBe(result.remote.recovered_receipt_id);
    expect(result.remote.execution_state).toBe("NOT_EXECUTED");
    expect(result.remote.inbound_result_policy).toBe("CANDIDATE_ONLY");
    expect(result.remote.network_executed).toBe(false);
    expect(result.remote.uploaded_asset_ids).toEqual([]);
    expect(result.remote.publication_receipts).toEqual([]);
    expect(result.feature_flag_rollback.all_default_false).toBe(true);
    expect(result.feature_flag_rollback.remote_disabled_blocker).toBe(true);
    expect(result.feature_flag_rollback.rollback_rule_present).toBe(true);
    expect(result.agent.deepseek_apply_error).toBe("human_apply_required");
    expect(result.agent.session_loss_error).toBe("read_required");
    expect(result.agent.apply_calls).toBe(0);
    expect(result.agent.agent_denial_audited).toBe(true);
    expect(result.agent.session_denial_audited).toBe(true);
    expect(result.network_calls).toBe(0);
    expect(result.external_provider_calls).toBe(0);
    expect(result.formal_apply_calls).toBe(0);
  });
});
