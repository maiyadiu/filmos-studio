import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { SourceMaintenanceWorkspace } from "../../src/brains/source-maintenance.js";

export function sourceFixture(t: TestContext) {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "filmos-source-fixture-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
    const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "core.fsmonitor=false", ...args], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    const write = (relative: string, value: string | Buffer) => {
        const target = path.join(root, relative);
        mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, value); return target;
    };
    git("init", "--initial-branch=integration");
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    write("web/src/view.ts", "export const title = 'fixture';\n// line two\n// line three");
    write("web/package.json", "{\"name\":\"fixture\"}");
    write("README.md", "fixture-only repository"); write(".gitignore", ".local/\n");
    git("add", "web", "README.md", ".gitignore"); git("commit", "-m", "fixture");
    const workspace = new SourceMaintenanceWorkspace(root);
    return { root, write, git, workspace };
}
