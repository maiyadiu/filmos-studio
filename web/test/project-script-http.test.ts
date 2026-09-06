import { expect, test } from "bun:test";
import { apiClient } from "../src/services/api/request";
import { runProjectScriptTool } from "../src/services/api/project-script-tools";
import { createProjectUnit, getProjectUnit, listProjectScriptRevisions, updateProjectUnit } from "../src/services/api/projects";

// Start TestProjectScriptBrowserFixture first. This calls the real Go handlers
// and SQLite through the shared frontend client, never production data.
const fixtureURL = process.env.FILMOS_SCRIPT_TEST_URL;
test.skipIf(!fixtureURL)("script tool persists and reads back over real HTTP", async () => {
    const url = new URL(fixtureURL!);
    expect(url.hostname).toBe("127.0.0.1");
    const probe = await fetch(`${url.origin}/api/script-fixture-session`);
    expect(await probe.json()).toEqual({ fixture: true });
    const previousURL = apiClient.defaults.baseURL;
    const previousCookie = apiClient.defaults.headers.common.Cookie;
    apiClient.defaults.baseURL = `${url.origin}/api`;
    apiClient.defaults.headers.common.Cookie = "open_ai_canvas_session=script-session.script-test-token";
    try {
        const input = { unitId: "unit", expectedRevision: 1, requestId: "http-edit", note: "仅修改林夏一句对白", edits: [{ oldText: "我不走。", newText: "我陪你。" }] };
        expect(await runProjectScriptTool("project_get_script", { unitId: "unit" }, "project")).toMatchObject({ unit: { revision: 1 }, editable: true });
        const saved = await runProjectScriptTool("project_revise_script", input, "project");
        expect(saved).toMatchObject({ ok: true, data: { replayed: false, after: { revision: 2 }, verification: { persisted: true, ok: true } } });
        expect(await runProjectScriptTool("project_revise_script", input, "project")).toMatchObject({ ok: true, data: { replayed: true } });
        await expect(runProjectScriptTool("project_revise_script", { ...input, requestId: "stale" }, "project")).rejects.toMatchObject({ status: 409 });
        expect(await runProjectScriptTool("project_get_script_revision", { unitId: "unit", revision: 1 }, "project")).toMatchObject({ revision: { sourceText: "<p>场景：客厅</p><p>林夏：我不走。</p><p>动作：门关上。</p>" } });
        expect(await runProjectScriptTool("project_get_script", { unitId: "unit" }, "project")).toMatchObject({ unit: { revision: 2, sourceText: "<p>场景：客厅</p><p>林夏：我陪你。</p><p>动作：门关上。</p>" } });
        expect((await listProjectScriptRevisions("project", "unit")).revisions.map((r) => r.revision)).toEqual([2, 1]);
    } finally {
        apiClient.defaults.baseURL = previousURL;
        if (previousCookie === undefined) delete apiClient.defaults.headers.common.Cookie;
        else apiClient.defaults.headers.common.Cookie = previousCookie;
    }
});

test.skipIf(!fixtureURL)("lost HTTP response retries idempotently and a later manual edit wins", async () => {
    const url = new URL(fixtureURL!);
    expect(url.hostname).toBe("127.0.0.1");
    expect(await fetch(`${url.origin}/api/script-fixture-session`).then(r => r.json())).toEqual({ fixture: true });
    const previousURL = apiClient.defaults.baseURL;
    const previousCookie = apiClient.defaults.headers.common.Cookie;
    apiClient.defaults.baseURL = `${url.origin}/api`;
    apiClient.defaults.headers.common.Cookie = "open_ai_canvas_session=script-session.script-test-token";
    let interceptor: number | undefined;
    try {
        const sourceText = "<p>故障样例：原句。</p>";
        const { unit } = await createProjectUnit("project", { kind: "chapter", title: "HTTP故障隔离章", sourceText });
        const input = { unitId: unit.id, expectedRevision: 1, requestId: "lost-response", note: "重试保真", edits: [{ oldText: "原句", newText: "新句" }] };
        // The real POST commits in Go/SQLite; only its reply is lost to this caller.
        interceptor = apiClient.interceptors.response.use(response => {
            if (response.config.method === "post" && response.config.url?.endsWith("/script-revisions")) throw new Error("SIMULATED_LOST_RESPONSE");
            return response;
        });
        await expect(runProjectScriptTool("project_revise_script", input, "project")).rejects.toThrow("SIMULATED_LOST_RESPONSE");
        apiClient.interceptors.response.eject(interceptor);
        interceptor = undefined;
        expect((await getProjectUnit("project", unit.id)).unit.revision).toBe(2);
        expect(await runProjectScriptTool("project_revise_script", input, "project")).toMatchObject({ data: { replayed: true, after: { revision: 2 } } });
        expect((await listProjectScriptRevisions("project", unit.id)).revisions.map(r => r.revision)).toEqual([2, 1]);
        await updateProjectUnit("project", unit.id, { expectedRevision: 2, requestId: "manual", title: unit.title, sourceText: "<p>用户手工编辑保留。</p>" });
        await expect(runProjectScriptTool("project_revise_script", { ...input, expectedRevision: 2, requestId: "stale-after-manual", edits: [{ oldText: "新句", newText: "过期覆盖" }] }, "project")).rejects.toMatchObject({ status: 409 });
        expect((await getProjectUnit("project", unit.id)).unit).toMatchObject({ revision: 3, sourceText: "<p>用户手工编辑保留。</p>" });
        expect((await listProjectScriptRevisions("project", unit.id)).revisions.map(r => r.revision)).toEqual([3, 2, 1]);
    } finally {
        if (interceptor !== undefined) apiClient.interceptors.response.eject(interceptor);
        apiClient.defaults.baseURL = previousURL;
        if (previousCookie === undefined) delete apiClient.defaults.headers.common.Cookie;
        else apiClient.defaults.headers.common.Cookie = previousCookie;
    }
});
