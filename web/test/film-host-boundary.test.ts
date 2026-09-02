import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { FILMOS_HOST_CONTRIBUTION_SLOTS } from "../src/film/contracts/contribution-slots";

const webRoot = resolve(import.meta.dir, "..");
const sourceRoot = resolve(webRoot, "src");

test("FilmOS exposes exactly the five frozen typed Host contribution slots", () => {
    expect(FILMOS_HOST_CONTRIBUTION_SLOTS).toEqual([
        "agent-panel",
        "generation-composer",
        "settings",
        "global-issue-portal",
        "workbench-context-publisher",
    ]);
});

test("FilmOS domain and contracts do not import Yingce Host-private modules", () => {
    const roots = [resolve(sourceRoot, "film/domain"), resolve(sourceRoot, "film/contracts")];
    const forbidden = ["@/stores/", "@/pages/", "@/components/", "@/services/", "@/lib/canvas/", "@/types/canvas"];
    const violations: string[] = [];
    for (const root of roots) for (const path of sourceFiles(root)) {
        const source = readFileSync(path, "utf8");
        for (const specifier of importSpecifiers(source)) {
            if (forbidden.some((prefix) => specifier.startsWith(prefix))) violations.push(`${path.slice(sourceRoot.length + 1)} -> ${specifier}`);
        }
    }
    expect(violations).toEqual([]);
});

test("Yingce composition roots consume the public typed contribution adapters", () => {
    const bindings = new Map([
        ["application.tsx", "@/film/adapters/yingce/contributions/global-issue-portal"],
        ["pages/canvas/project.tsx", "@/film/adapters/yingce/contributions/agent-panel"],
        ["pages/canvas/project.tsx#generation", "@/film/adapters/yingce/contributions/generation-composer"],
        ["pages/settings/index.tsx", "@/film/adapters/yingce/contributions/settings"],
        ["pages/canvas/use-canvas-agent-operations.ts", "@/film/adapters/yingce/contributions/workbench-context-publisher"],
    ]);
    for (const [label, expectedImport] of bindings) {
        const relative = label.split("#")[0];
        expect(readFileSync(resolve(sourceRoot, relative), "utf8")).toContain(expectedImport);
    }
});

function sourceFiles(root: string): string[] {
    try {
        return readdirSync(root).flatMap((entry) => {
            const path = resolve(root, entry);
            return statSync(path).isDirectory() ? sourceFiles(path) : /\.(?:ts|tsx|mjs)$/.test(path) ? [path] : [];
        });
    } catch {
        return [];
    }
}

function importSpecifiers(source: string): string[] {
    return [...source.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]);
}
