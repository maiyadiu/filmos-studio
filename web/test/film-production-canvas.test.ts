import { describe, expect, test } from "bun:test";

import { FILM_PRODUCTION_CANVAS_DEFAULT_ENABLED, buildCreateProductionCanvasCommand, candidateFromGeneratedResult, projectProductionCanvas, resolveProductionCanvasNavigation, type FilmProductionCanvasSnapshot } from "../src/film/canvas/production-canvas";
import { hashHostUnitSourceText } from "../src/film/canvas/production-canvas-api";

const HASH = "a".repeat(64);
const FILM_IDS = {
    scene: "00000000-0000-4000-8000-000000000001",
    director1: "00000000-0000-4000-8000-000000000002",
    director2: "00000000-0000-4000-8000-000000000003",
    shot1: "00000000-0000-4000-8000-000000000004",
    shot2: "00000000-0000-4000-8000-000000000005",
    candidate: "00000000-0000-4000-8000-000000000006",
    relation1: "00000000-0000-4000-8000-000000000101",
    relation2: "00000000-0000-4000-8000-000000000102",
    relation3: "00000000-0000-4000-8000-000000000103",
    relation4: "00000000-0000-4000-8000-000000000104",
} as const;

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

    test("Host SourceText guard uses exact UTF-8 SHA-256", async () => {
        expect(await hashHostUnitSourceText("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        expect(await hashHostUnitSourceText("甲：你来了。")).not.toBe(await hashHostUnitSourceText("甲：你来了。\n"));
    });

    test("provider result can only materialize as Candidate", () => {
        expect(candidateFromGeneratedResult({ id: FILM_IDS.candidate, providerResultId: "result-1" })).toEqual({
            id: FILM_IDS.candidate,
            kind: "candidate",
            providerResultId: "result-1",
        });
        expect(() => candidateFromGeneratedResult({ id: "client-picked-id", providerResultId: "result-1" })).toThrow("Film Core UUIDv4");
    });

    test("projection persists IDs, layout and relationships without duplicating film facts", () => {
        const snapshot = productionSnapshot();
        const first = projectProductionCanvas(snapshot);
        const shotNode = first.nodes.find((node) => node.entityId === FILM_IDS.shot1)!;
        const moved = projectProductionCanvas(snapshot, { [shotNode.id]: { x: 999, y: 333 } });

        expect(moved.nodes.find((node) => node.entityId === FILM_IDS.shot1)?.layout).toEqual({ x: 999, y: 333 });
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
            { id: FILM_IDS.scene, kind: "scene", position: 0 },
            { id: FILM_IDS.director1, kind: "director_unit", position: 0 },
            { id: FILM_IDS.director2, kind: "director_unit", position: 1 },
            { id: FILM_IDS.shot1, kind: "shot", position: 0 },
            { id: FILM_IDS.shot2, kind: "shot", position: 1 },
            { id: FILM_IDS.candidate, kind: "candidate", position: 0 },
        ],
        relations: [
            { id: FILM_IDS.relation1, fromEntityId: FILM_IDS.scene, toEntityId: FILM_IDS.director1, kind: "contains" },
            { id: FILM_IDS.relation2, fromEntityId: FILM_IDS.director1, toEntityId: FILM_IDS.shot1, kind: "coverage" },
            { id: FILM_IDS.relation3, fromEntityId: FILM_IDS.director1, toEntityId: FILM_IDS.shot2, kind: "coverage" },
            { id: FILM_IDS.relation4, fromEntityId: FILM_IDS.director2, toEntityId: FILM_IDS.shot2, kind: "coverage" },
        ],
    };
}
