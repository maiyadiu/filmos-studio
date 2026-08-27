import { describe, expect, test } from "bun:test";

import { FILM_PRODUCTION_CANVAS_DEFAULT_ENABLED, buildCreateProductionCanvasCommand, candidateFromGeneratedResult, projectProductionCanvas, resolveProductionCanvasNavigation, type FilmProductionCanvasSnapshot } from "../src/film/canvas/production-canvas";

const HASH = "a".repeat(64);

describe("Film Production Canvas navigation", () => {
    test("feature defaults off", () => {
        expect(FILM_PRODUCTION_CANVAS_DEFAULT_ENABLED).toBe(false);
        expect(resolveProductionCanvasNavigation({ unitId: "unit-1", links: [], canvases: [] })).toEqual({ state: "disabled" });
    });

    test("reopens the single production canvas and ignores storyboard links", () => {
        expect(
            resolveProductionCanvasNavigation({
                enabled: true,
                unitId: "unit-1",
                canvases: [{ id: "canvas-production" }, { id: "canvas-storyboard" }],
                links: [
                    { unitId: "unit-1", canvasId: "canvas-storyboard", role: "storyboard" },
                    { unitId: "unit-1", canvasId: "canvas-production", role: "production" },
                ],
            }),
        ).toEqual({ state: "reuse", canvasId: "canvas-production", href: "/canvas/canvas-production" });
    });

    test("does not silently choose between duplicate defaults", () => {
        const result = resolveProductionCanvasNavigation({
            enabled: true,
            unitId: "unit-1",
            canvases: [{ id: "canvas-b" }, { id: "canvas-a" }],
            links: [
                { unitId: "unit-1", canvasId: "canvas-b", role: "production" },
                { unitId: "unit-1", canvasId: "canvas-a", role: "production" },
            ],
        });
        expect(result.state).toBe("conflict");
        if (result.state === "conflict") expect(result.canvasIds).toEqual(["canvas-a", "canvas-b"]);
    });
});

describe("Film Production Canvas writes and projections", () => {
    test("formal create intent carries revision and content hash", () => {
        expect(
            buildCreateProductionCanvasCommand({
                hostProjectId: "project-1",
                hostUnitId: "unit-1",
                expectedRevision: 7,
                expectedContentHash: HASH,
            }),
        ).toMatchObject({ expectedRevision: 7, expectedContentHash: HASH, role: "production" });
        expect(() =>
            buildCreateProductionCanvasCommand({
                hostProjectId: "project-1",
                hostUnitId: "unit-1",
                expectedRevision: 7,
                expectedContentHash: "not-a-hash",
            }),
        ).toThrow("小写 SHA-256");
    });

    test("provider result can only materialize as Candidate", () => {
        expect(candidateFromGeneratedResult({ id: "candidate-1", providerResultId: "result-1" })).toEqual({
            id: "candidate-1",
            kind: "candidate",
            providerResultId: "result-1",
        });
    });

    test("projection persists IDs, layout and relationships without duplicating film facts", () => {
        const snapshot = productionSnapshot();
        const first = projectProductionCanvas(snapshot);
        const shotNode = first.nodes.find((node) => node.entityId === "shot-1")!;
        const moved = projectProductionCanvas(snapshot, { [shotNode.id]: { x: 999, y: 333 } });

        expect(moved.nodes.find((node) => node.entityId === "shot-1")?.layout).toEqual({ x: 999, y: 333 });
        expect(moved.edges).toHaveLength(4);
        expect(JSON.stringify(moved)).not.toContain("台词正文不得进入画布");
        expect(Object.keys(moved.nodes[0]).sort()).toEqual(["entityId", "id", "kind", "lane", "layout"]);
    });

    test("coverage is many-to-many rather than DirectorUnit to Shot one-to-one", () => {
        const projection = projectProductionCanvas(productionSnapshot());
        const coverageEdges = projection.edges.filter((edge) => edge.kind === "coverage");
        expect(coverageEdges).toHaveLength(3);
        expect(new Set(coverageEdges.map((edge) => edge.fromNodeId)).size).toBe(2);
        expect(new Set(coverageEdges.map((edge) => edge.toNodeId)).size).toBe(2);
    });
});

function productionSnapshot(): FilmProductionCanvasSnapshot {
    return {
        hostProjectId: "project-1",
        hostUnitId: "unit-1",
        filmCoreVersion: 3,
        contentHash: HASH,
        entities: [
            { id: "scene-1", kind: "scene", position: 0 },
            { id: "director-1", kind: "director_unit", position: 0 },
            { id: "director-2", kind: "director_unit", position: 1 },
            { id: "shot-1", kind: "shot", position: 0 },
            { id: "shot-2", kind: "shot", position: 1 },
            { id: "candidate-1", kind: "candidate", position: 0 },
        ],
        relations: [
            { id: "scene-director", fromEntityId: "scene-1", toEntityId: "director-1", kind: "contains" },
            { id: "coverage-1", fromEntityId: "director-1", toEntityId: "shot-1", kind: "coverage" },
            { id: "coverage-2", fromEntityId: "director-1", toEntityId: "shot-2", kind: "coverage" },
            { id: "coverage-3", fromEntityId: "director-2", toEntityId: "shot-2", kind: "coverage" },
        ],
    };
}
