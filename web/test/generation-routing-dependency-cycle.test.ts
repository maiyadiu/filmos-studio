import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";


const routingRoot = path.resolve(import.meta.dir, "../src/film/generation-routing");

function importGraph() {
    const files = fs.readdirSync(routingRoot)
        .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
        .map((name) => path.join(routingRoot, name));
    const known = new Set(files);
    return new Map(files.map((file) => {
        const source = fs.readFileSync(file, "utf8");
        const dependencies = [...source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)]
            .map((match) => path.resolve(path.dirname(file), match[1]!))
            .flatMap((candidate) => [candidate, `${candidate}.ts`, `${candidate}.tsx`, path.join(candidate, "index.ts")])
            .filter((candidate, index, values) => known.has(candidate) && values.indexOf(candidate) === index);
        return [file, dependencies] as const;
    }));
}

function cycles(graph: Map<string, string[]>) {
    const found = new Set<string>();
    const active: string[] = [];
    const activeSet = new Set<string>();
    const finished = new Set<string>();
    const visit = (node: string) => {
        if (activeSet.has(node)) {
            const start = active.indexOf(node);
            const cycle = [...active.slice(start), node].map((file) => path.basename(file));
            const rotations = cycle.slice(0, -1).map((_, index) => {
                const body = [...cycle.slice(index, -1), ...cycle.slice(0, index)];
                return [...body, body[0]].join(" -> ");
            });
            found.add(rotations.sort()[0]!);
            return;
        }
        if (finished.has(node)) return;
        active.push(node);
        activeSet.add(node);
        for (const dependency of graph.get(node) ?? []) visit(dependency);
        active.pop();
        activeSet.delete(node);
        finished.add(node);
    };
    for (const node of graph.keys()) visit(node);
    return [...found].sort();
}

describe("generation-routing dependency graph", () => {
    test("contains no production import cycle, including type-only edges", () => {
        expect(cycles(importGraph())).toEqual([]);
    });

    test("AcceptanceMockBindings lives in a type-only neutral contract", () => {
        const contract = fs.readFileSync(path.join(routingRoot, "acceptance-production-contract.ts"), "utf8");
        const runtime = fs.readFileSync(path.join(routingRoot, "acceptance-production-runtime.ts"), "utf8");
        const composer = fs.readFileSync(path.resolve(routingRoot, "../../components/canvas/canvas-config-composer.tsx"), "utf8");
        expect(contract).toContain("export type AcceptanceMockBindings");
        expect(contract).not.toMatch(/\bexport\s+(?:const|function|class)\b/);
        expect(contract.match(/^import\s+(?!type\b)/gm) ?? []).toEqual([]);
        expect(runtime).not.toContain('export type { AcceptanceMockBindings }');
        expect(composer).toContain('import type { AcceptanceMockBindings } from "@/film/generation-routing/acceptance-production-contract"');
    });
});
