import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { register } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The bootstrap materializes local file: packages before they have dist files.
// Refuse every @filmos runtime import instead of hiding/removing live installs.
if (process.env.FILMOS_CONTRACT_IMPORT_GUARD === "1") {
  register(`data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('@filmos/') || /[/\\\\]node_modules[/\\\\]@filmos[/\\\\]/.test(specifier)) throw new Error('BUILD_RUNTIME_IMPORT_FORBIDDEN:' + specifier);
      return nextResolve(specifier, context);
    }
  `)}`, import.meta.url);
} else {
  test("contract generation works without importing built Agent runtime packages", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", fileURLToPath(import.meta.url), "scripts/generate.ts", "--check"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), env: { ...process.env, FILMOS_CONTRACT_IMPORT_GUARD: "1" }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const forbidden = spawnSync(process.execPath, ["--import", fileURLToPath(import.meta.url), "--input-type=module", "-e", "await import('@filmos/agent-contracts')"], {
      env: { ...process.env, FILMOS_CONTRACT_IMPORT_GUARD: "1" }, encoding: "utf8", timeout: 10_000,
    });
    assert.notEqual(forbidden.status, 0);
    assert.match(forbidden.stderr, /BUILD_RUNTIME_IMPORT_FORBIDDEN/);
  });
}
