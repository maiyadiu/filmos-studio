import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { inspectWorkspaceLocalMedia } from "./local-media.node";

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("local media inspection returns only a canonical workspace-relative path and verified hash", () => {
    const fixture = mediaFixture();
    const result = inspectWorkspaceLocalMedia({
        workspaceRoot: fixture.workspace,
        requestedPath: "media/asset.bin",
        hostResourceId: "host-resource-local-1",
        expectedContentHash: fixture.hash,
        authorizationEvidenceId: "rights-local-1",
        sourceReceiptId: "source-local-1",
        metadata: { role: "primary", take: 1 },
    });
    assert.equal(result.relativePath, "media/asset.bin");
    assert.equal(result.contentHash, fixture.hash);
    assert.equal(result.bytes, fixture.bytes.length);
    assert.equal(JSON.stringify(result).includes(fixture.root), false);
});

test("canonical containment rejects parent traversal and symlink escape", () => {
    const fixture = mediaFixture();
    const outside = path.join(fixture.root, "outside.bin");
    writeFileSync(outside, fixture.bytes);
    symlinkSync(outside, path.join(fixture.workspace, "escape.bin"));
    const base = {
        workspaceRoot: fixture.workspace,
        hostResourceId: "host-resource-local-1",
        expectedContentHash: fixture.hash,
        authorizationEvidenceId: "rights-local-1",
        sourceReceiptId: "source-local-1",
    };
    assert.throws(() => inspectWorkspaceLocalMedia({ ...base, requestedPath: "../outside.bin" }), /escapes the canonical workspace root/);
    assert.throws(() => inspectWorkspaceLocalMedia({ ...base, requestedPath: "escape.bin" }), /escapes the canonical workspace root/);
});

test("URL, data URL, secret metadata, locator metadata, and hash drift fail closed", () => {
    const fixture = mediaFixture();
    const base = {
        workspaceRoot: fixture.workspace,
        requestedPath: "media/asset.bin",
        hostResourceId: "host-resource-local-1",
        expectedContentHash: fixture.hash,
        authorizationEvidenceId: "rights-local-1",
        sourceReceiptId: "source-local-1",
    };
    assert.throws(() => inspectWorkspaceLocalMedia({ ...base, requestedPath: "https://example.invalid/a.png" }), /must not be a URL/);
    assert.throws(() => inspectWorkspaceLocalMedia({ ...base, requestedPath: "data:image/png;base64,AAAA" }), /must not be a URL/);
    assert.throws(() => inspectWorkspaceLocalMedia({ ...base, metadata: { apiToken: "hidden" } }), /secret field/);
    assert.throws(() => inspectWorkspaceLocalMedia({ ...base, metadata: { sourceUrl: "opaque" } }), /locator field/);
    assert.throws(() => inspectWorkspaceLocalMedia({ ...base, expectedContentHash: "b".repeat(64) }), /content hash mismatch/);
});

function mediaFixture() {
    const root = mkdtempSync(path.join(tmpdir(), "filmos-golden-b-"));
    temporaryRoots.push(root);
    const workspace = path.join(root, "workspace");
    const media = path.join(workspace, "media");
    mkdirSync(media, { recursive: true });
    const bytes = Buffer.from("FilmOS Golden B local media fixture\n", "utf8");
    writeFileSync(path.join(media, "asset.bin"), bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    return { root, workspace, bytes, hash };
}
