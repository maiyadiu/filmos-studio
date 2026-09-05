import { expect, test } from "bun:test";
import { apiClient } from "../src/services/api/request";
import { runProjectScriptTool } from "../src/services/api/project-script-tools";
import { listProjectScriptRevisions } from "../src/services/api/projects";

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
