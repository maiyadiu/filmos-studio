import { describe, expect, test } from "bun:test";

import { goldenALocalFixture, runGoldenALocalChain } from "./golden_a_local";

describe("Golden A real local Prompt/Manual Provider segment", () => {
  test("uses production projection, prompt compiler and manual import without external calls", async () => {
    const result = await runGoldenALocalChain(await goldenALocalFixture());
    expect(result).toMatchObject({
      prepared: true,
      persisted: false,
      reviewed: false,
      approved: false,
      externalProviderCalls: 0,
    });
    expect(result.canvas).toMatchObject({ nodeCount: 3, edgeCount: 1 });
    expect(result.prompt.audit).toBe("PASS");
    expect(result.package).toMatchObject({
      lifecycle: "prepared",
      externalSubmission: "not_submitted",
    });
    expect(result.candidate).toMatchObject({
      status: "candidate",
      reviewState: "pending",
      approvalState: "not_approved",
    });
  });

  test("fails closed when the DirectorUnit hash no longer binds compiler input", async () => {
    const input = await goldenALocalFixture();
    input.directorUnit.contentHash = "0".repeat(64);
    await expect(runGoldenALocalChain(input)).rejects.toThrow(
      "DirectorUnit content hash",
    );
  });

  test("fails closed on stale Shot version during manual import", async () => {
    const input = await goldenALocalFixture();
    input.shot.version = 0;
    await expect(runGoldenALocalChain(input)).rejects.toThrow(
      "SHOT_VERSION_INVALID",
    );
  });
});
