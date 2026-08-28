import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RemotePublishPlanInput, RemoteSyncSessionStore } from "@/film/sync";
import { FilmRemoteSyncEntry, prepareRemoteSyncPreviewForHost, resolveFilmRemoteSyncEnabled } from "@/pages/projects/detail/remote-sync-entry";
import type { ProjectDetail } from "@/services/api/projects";

const plan = JSON.parse(await Bun.file(new URL("./fixtures/film-remote-plan.json", import.meta.url)).text()) as RemotePublishPlanInput;

describe("Film Remote/Hybrid Host project entry", () => {
    test("feature defaults off and produces no Remote DOM or storage read", () => {
        const store: RemoteSyncSessionStore = {
            async read() {
                throw new Error("disabled entry must not read local sessions");
            },
            async write() {
                throw new Error("disabled entry must not write local sessions");
            },
        };
        expect(resolveFilmRemoteSyncEnabled({})).toBe(false);
        expect(resolveFilmRemoteSyncEnabled({ VITE_FILM_REMOTE_SYNC: "false" })).toBe(false);
        expect(renderToStaticMarkup(createElement(FilmRemoteSyncEntry, { detail: projectDetail(), env: {}, store }))).not.toContain("data-film-feature");
    });

    test("explicit flag exposes only the offline manifest and local receipt boundary", () => {
        const markup = renderToStaticMarkup(createElement(FilmRemoteSyncEntry, { detail: projectDetail(), env: { VITE_FILM_REMOTE_SYNC: "true" }, store: memoryStore() }));
        expect(markup).toContain('data-film-feature="remote-sync"');
        expect(markup).toContain("Remote / Hybrid 预演");
        expect(markup).toContain("不上传、不访问远端、不自动批准");
        expect(markup).toContain("Local receipt only");
        expect(markup).not.toContain("执行 Remote Publish</button>");
    });

    test("local JSON preparation validates Host ownership and performs no fetch", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (() => {
            throw new Error("network must not be called");
        }) as typeof fetch;
        try {
            const prepared = await prepareRemoteSyncPreviewForHost(JSON.stringify(plan), plan.host_project_id, "LOCAL_AUTHORITY");
            expect(prepared.preview.execution_state).toBe("PREVIEW_ONLY");
            expect(prepared.preview.network.executed).toBe(false);
            await expect(prepareRemoteSyncPreviewForHost(JSON.stringify(plan), "wrong-project", "LOCAL_AUTHORITY")).rejects.toThrow("不属于当前 Host 项目");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

function memoryStore(): RemoteSyncSessionStore {
    return {
        async read() {
            return [];
        },
        async write() {},
    };
}

function projectDetail(): ProjectDetail {
    return {
        project: {
            id: plan.host_project_id,
            userId: "user-remote-001",
            name: "Remote Test",
            type: "short-drama",
            aspectRatio: "9:16",
            sourceType: "original",
            description: "",
            stylePresetId: "",
            status: "active",
            revision: 1,
            createdAt: "2026-08-28T09:00:00.000Z",
            updatedAt: "2026-08-28T09:00:00.000Z",
        },
        units: [],
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
