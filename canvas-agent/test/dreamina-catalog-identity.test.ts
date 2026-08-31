import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DreaminaCliService } from "../src/dreamina-cli.js";
import { DreaminaCliArbiter } from "../src/dreamina-cli-arbiter.js";
import { projectDreaminaCatalogEvidence, projectDreaminaModelCatalog } from "../src/dreamina-model-catalog.js";

test("Dreamina Catalog evidence dynamically binds exact CLI version, binary, locator and catalog without exposing its path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamina-catalog-identity-"));
    const executable = path.join(root, "dreamina-fixture");
    const bytes = Buffer.from("dreamina-fixture-binary-v1");
    await fs.writeFile(executable, bytes, { mode: 0o700 });
    const service = new DreaminaCliService({
        ownerId: "owner-dreamina-catalog-0001",
        arbiter: new DreaminaCliArbiter({ stateFile: path.join(root, "arbiter.json") }),
        discover: async () => ({ installed: true, executable }),
        runProcess: async (request) => {
            assert.deepEqual(request.args, ["version"]);
            return { exitCode: 0, stdout: JSON.stringify({ version: "54f1bdf-dirty", commit: "54f1bdf", build_time: "2026-06-18T12:30:12Z" }), stderr: "" };
        },
        now: () => new Date("2026-08-31T00:00:00.000Z"),
    });
    try {
        const identity = await service.catalogIdentity();
        assert.equal(identity.executableSha256, crypto.createHash("sha256").update(bytes).digest("hex"));
        assert.match(identity.sourceLocatorId, /^dreamina-cli-executable:[0-9a-f]{64}$/);
        assert.equal(JSON.stringify(identity).includes(executable), false);
        const evidence = projectDreaminaCatalogEvidence(projectDreaminaModelCatalog(), identity);
        assert.equal(evidence.supportedCliVersionRange, "=54f1bdf-dirty");
        assert.equal(evidence.cliCommit, "54f1bdf");
        assert.equal(evidence.executableSha256, identity.executableSha256);
        assert.match(evidence.catalogHash, /^[0-9a-f]{64}$/);
        assert.match(evidence.manifestHash, /^[0-9a-f]{64}$/);
        assert.equal(JSON.stringify(evidence).includes(executable), false);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
