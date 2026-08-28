import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import type { ProjectDetail } from "@/services/api/projects";
import { DEFAULT_FILM_CORE_BASE_URL, FilmProductionEntryPanel, probeFilmCorePort, resolveFilmProductionEntryConfig, resolveFilmProductionEntryState } from "@/pages/projects/detail/production-entry";

describe("Film Production 项目入口", () => {
    test("两个 VITE flag 未同时显式 true 时保持关闭", () => {
        expect(resolveFilmProductionEntryConfig({}).enabled).toBe(false);
        expect(resolveFilmProductionEntryConfig({ VITE_FILM_PRODUCTION_CORE: "true" }).enabled).toBe(false);
        expect(resolveFilmProductionEntryConfig({ VITE_FILM_PRODUCTION_CORE: "1", VITE_FILM_PRODUCTION_CANVAS: "true" }).enabled).toBe(false);
        expect(resolveFilmProductionEntryConfig({ VITE_FILM_CORE_URL: "https://ignored.invalid:8091" })).toEqual({ enabled: false, baseUrl: DEFAULT_FILM_CORE_BASE_URL });
        expect(resolveFilmProductionEntryConfig({ VITE_FILM_PRODUCTION_CORE: "true", VITE_FILM_PRODUCTION_CANVAS: "TRUE" })).toEqual({
            enabled: true,
            baseUrl: DEFAULT_FILM_CORE_BASE_URL,
        });
    });

    test("只接受可用的本机 Sidecar health 端口", async () => {
        const calls: string[] = [];
        const healthy = await probeFilmCorePort(DEFAULT_FILM_CORE_BASE_URL, {
            fetchImpl: (async (input: string | URL | Request) => {
                calls.push(String(input));
                return new Response(JSON.stringify({ status: "ok", service: "film-production-core" }), { status: 200 });
            }) as typeof fetch,
        });
        expect(healthy).toBe(true);
        expect(calls).toEqual([`${DEFAULT_FILM_CORE_BASE_URL}/health`]);
        expect(await probeFilmCorePort(DEFAULT_FILM_CORE_BASE_URL, { fetchImpl: (async () => new Response("no", { status: 503 })) as typeof fetch })).toBe(false);
        expect(() => resolveFilmProductionEntryConfig({ VITE_FILM_PRODUCTION_CORE: "true", VITE_FILM_PRODUCTION_CANVAS: "true", VITE_FILM_CORE_URL: "https://remote.example:8091" })).toThrow("本机 HTTP Sidecar");
    });

    test("flag-off 或端口不可用时不产生 Film DOM，恢复后可回滚关闭", () => {
        const disabled = markup({ state: "disabled" });
        const unavailable = markup({ state: "unavailable" });
        const availableState = resolveFilmProductionEntryState({ enabled: true, baseUrl: DEFAULT_FILM_CORE_BASE_URL }, true);
        const recovered = markup(availableState);
        const rolledBack = markup(resolveFilmProductionEntryState({ enabled: false, baseUrl: DEFAULT_FILM_CORE_BASE_URL }, true));

        expect(disabled).toBe("");
        expect(unavailable).toBe("");
        expect(recovered).toContain("Film Production Canvas");
        expect(rolledBack).toBe(disabled);
    });

    test("唯一 production 画布可复用，缺失时显示 Human 二次确认入口", () => {
        const detail = projectDetail();
        detail.canvasUnitLinks.push(link("link-production", "canvas-production", "production"));
        detail.canvases.push(canvas("canvas-production"));
        const reusable = markup({ state: "available", baseUrl: DEFAULT_FILM_CORE_BASE_URL }, detail);
        expect(reusable).toContain("打开生产画布");
        expect(reusable).toContain("/canvas/canvas-production");

        const previewOnly = markup({ state: "available", baseUrl: DEFAULT_FILM_CORE_BASE_URL });
        expect(previewOnly).toContain("创建预演");
        expect(previewOnly).toContain("准备正式创建");
        expect(previewOnly).not.toContain("Host 已持久化");
    });

    test("重复 production 关联 fail closed 且不静默导航", () => {
        const detail = projectDetail();
        detail.canvases.push(canvas("canvas-a"), canvas("canvas-b"));
        detail.canvasUnitLinks.push(link("link-a", "canvas-a", "production"), link("link-b", "canvas-b", "production"));
        const html = markup({ state: "available", baseUrl: DEFAULT_FILM_CORE_BASE_URL }, detail);
        expect(html).toContain("production 关联冲突");
        expect(html).toContain("canvas-a · canvas-b");
        expect(html).not.toContain("打开生产画布");
    });
});

function markup(entryState: Parameters<typeof FilmProductionEntryPanel>[0]["entryState"], detail = projectDetail()) {
    return renderToStaticMarkup(
        <MemoryRouter>
            <FilmProductionEntryPanel detail={detail} entryState={entryState} />
        </MemoryRouter>,
    );
}

function projectDetail(): ProjectDetail {
    return {
        project: {
            id: "project-1",
            userId: "user-1",
            name: "Golden A",
            type: "short-drama",
            aspectRatio: "9:16",
            sourceType: "blank",
            description: "",
            stylePresetId: "",
            status: "active",
            revision: 7,
            createdAt: "2026-08-28T00:00:00Z",
            updatedAt: "2026-08-28T00:00:00Z",
        },
        units: [{ id: "unit-1", projectId: "project-1", kind: "chapter", title: "第一章", sourceText: "", status: "draft", position: 0, createdAt: "2026-08-28T00:00:00Z", updatedAt: "2026-08-28T00:00:00Z" }],
        canvases: [],
        canvasUnitLinks: [],
        assets: [],
        assetFolders: [],
        workflows: [],
        shots: [],
        shotReferences: [],
        assetCandidates: [],
    };
}

function canvas(id: string) {
    return { id, projectId: "project-1", title: id, createdAt: "2026-08-28T00:00:00Z", updatedAt: "2026-08-28T00:00:00Z" };
}

function link(id: string, canvasId: string, role: string) {
    return { id, projectId: "project-1", canvasId, unitId: "unit-1", role, createdAt: "2026-08-28T00:00:00Z" };
}
