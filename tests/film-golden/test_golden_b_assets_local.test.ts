import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");

describe("Golden B approved asset locks", () => {
  test("builds character and costume locks from separate approved bindings", () => {
    const bindings = [
      seed("character-a", "character_identity", "character", "a"),
      seed("character-b", "character_identity", "character", "b"),
      seed("character-c", "character_identity", "character", "c"),
      seed("costume-a", "costume_reference", "costume", "d"),
      seed("costume-b-v1", "costume_reference", "costume", "e"),
      seed("costume-b-v2", "costume_reference", "costume", "f"),
    ];
    const byRole = new Map(bindings.map((item) => [item.role, item.bindingId]));
    const payload = {
      hostProjectId: "host-project-golden-b",
      bindings,
      previousRoles: {
        "character:character-a": byRole.get("character-a"),
        "character:character-b": byRole.get("character-b"),
        "character:character-c": byRole.get("character-c"),
        "costume:character-a": byRole.get("costume-a"),
        "costume:character-b": byRole.get("costume-b-v1"),
      },
      nextRoles: {
        "character:character-a": byRole.get("character-a"),
        "character:character-b": byRole.get("character-b"),
        "character:character-c": byRole.get("character-c"),
        "costume:character-a": byRole.get("costume-a"),
        "costume:character-b": byRole.get("costume-b-v2"),
      },
      previousVisualLockId: randomUUID(),
      nextVisualLockId: randomUUID(),
      scopeId: randomUUID(),
      occurredAt: "2026-08-28T10:00:00Z",
    };
    const result = spawnSync(
      "bun",
      ["tests/film-golden/golden_b_assets_local.ts"],
      { cwd: ROOT, input: JSON.stringify(payload), encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(result.stderr || "Golden B asset runner failed");
    const receipt = JSON.parse(result.stdout);
    expect(receipt.prepared).toBe(true);
    expect(receipt.formalApply).toBe(false);
    expect(receipt.externalProviderCalls).toBe(0);
    expect(receipt.approvedBindings).toHaveLength(6);
    expect(receipt.approvedBindings.filter((item: any) => item.asset.semantic === "character")).toHaveLength(3);
    expect(receipt.approvedBindings.filter((item: any) => item.asset.semantic === "costume")).toHaveLength(3);
    expect(receipt.approvedBindings.every((item: any) => item.lifecycle === "approved")).toBe(true);
    const key = "referenceRoleMap:costume:character-b";
    expect(receipt.previousVisualLock.dependencyHashes[key]).not.toBe(
      receipt.nextVisualLock.dependencyHashes[key],
    );
    expect(receipt.previousVisualLock.dependencyHashes["referenceRoleMap:character:character-b"]).toBe(
      receipt.nextVisualLock.dependencyHashes["referenceRoleMap:character:character-b"],
    );
  });
});

function seed(
  role: string,
  purpose: "character_identity" | "costume_reference",
  semantic: "character" | "costume",
  hashCharacter: string,
) {
  return {
    bindingId: randomUUID(),
    candidateId: randomUUID(),
    candidateAuditEventId: randomUUID(),
    approvalAuditEventId: randomUUID(),
    reviewId: randomUUID(),
    qcReportId: randomUUID(),
    role,
    semantic,
    purpose,
    target: { kind: "director_unit", id: randomUUID() },
    hostAssetId: `host-asset-${role}`,
    hostAssetVersionId: `host-asset-version-${role}`,
    hostResourceId: `host-resource-${role}`,
    contentHash: hashCharacter.repeat(64),
  };
}
