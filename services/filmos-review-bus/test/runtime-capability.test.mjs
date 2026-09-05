import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { startFromEnvironment } from "../src/server.mjs";
import { assertExternalReadRuntimeCapability, ReviewBusStore } from "../src/store.mjs";

test("supported Node exposes the complete external-read authorizer contract", () => {
  assert.doesNotThrow(assertExternalReadRuntimeCapability);
});

test("missing authorizer rejects both entry points before creating or inspecting storage", () => {
  const root = mkdtempSync(join(tmpdir(), "filmos-node-capability-"));
  const localDir = join(root, "must-not-exist");
  const original = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "setAuthorizer");
  try {
    Object.defineProperty(DatabaseSync.prototype, "setAuthorizer", { configurable: true, value: undefined });
    const expected = { code: "EXTERNAL_READ_RUNTIME_NODE_CAPABILITY_REQUIRED" };
    assert.throws(() => new ReviewBusStore(join(localDir, "review-bus.sqlite"), { runtimeMode: "external-read" }), expected);
    assert.throws(() => startFromEnvironment({
      FILMOS_REVIEW_BUS_RUNTIME_MODE: "external-read",
      FILMOS_REVIEW_BUS_LOCAL_DIR: localDir,
    }), expected);
    assert.equal(existsSync(localDir), false);
  } finally {
    if (original) Object.defineProperty(DatabaseSync.prototype, "setAuthorizer", original);
    else delete DatabaseSync.prototype.setAuthorizer;
    rmSync(root, { recursive: true, force: true });
  }
});
