import { expect, test } from "bun:test";

import { runSurfacePerformance } from "./performance_surface";

test("Remote and Agent Beta performance surfaces stay within their local budgets", async () => {
  const result = await runSurfacePerformance();

  expect(result.test_status).toBe("PASSED");
  expect(result.failures).toEqual([]);
  expect(Object.values(result.checks).every(Boolean)).toBe(true);
  expect(result.counts.agent_preview_calls).toBe(result.dataset.agent_samples);
  expect(result.counts.agent_apply_calls).toBe(0);
  expect(result.network_actions).toBe(0);
  expect(result.uploaded_assets).toBe(0);
  expect(result.external_provider_calls).toBe(0);
});
