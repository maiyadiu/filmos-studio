import { expect, test } from "bun:test";
import { apiClient } from "../src/services/api/request";
import { runProjectShotTool } from "../src/services/api/project-shot-tools";
import { createProjectUnit, getProjectShotContext, getProjectShotRevisions, saveProjectShot, updateProjectUnit } from "../src/services/api/projects";

const fixtureURL = process.env.FILMOS_SCRIPT_TEST_URL;
test.skipIf(!fixtureURL)("shot tool real HTTP saves atomically, recovers lost reply, preserves identities and detects later edits", async () => {
    const url = new URL(fixtureURL!);
    expect(url.hostname).toBe("127.0.0.1");
    expect(await fetch(`${url.origin}/api/script-fixture-session`).then(r => r.json())).toEqual({ fixture: true });
    const previousURL = apiClient.defaults.baseURL, previousCookie = apiClient.defaults.headers.common.Cookie;
    apiClient.defaults.baseURL = `${url.origin}/api`;
    apiClient.defaults.headers.common.Cookie = "open_ai_canvas_session=script-session.script-test-token";
    let interceptor: number | undefined;
    try {
        const sourceText = "<p>场景：客厅，林夏在门旁。</p><p>林夏：我陪你。</p><p>动作：林夏关门。</p>";
        const { unit } = await createProjectUnit("project", { kind: "chapter", title: "HTTP分镜隔离", sourceText });
        const before = await getProjectShotContext("project", unit.id);
        const input = {
            unitId: unit.id, requestId: "http-shots-" + unit.id, expectedShotRevision: before.unit.shotRevision, sourceRevision: unit.revision, sourceHash: before.sourceHash,
            sourceParagraphIds: before.paragraphs.map(p => p.id),
            shots: [
                { title: "回应", description: "林夏回应", position: 0, durationMs: 5000, expectedRevision: 0, content: { scene: "客厅", characters: ["林夏"], action: "林夏回应", camera: "中景", sourceReferences: before.paragraphs.slice(0, 2).map(p => ({ paragraphId: p.id, quote: p.text })), dialogue: [{ speaker: "林夏", text: "我陪你。", paragraphId: "p0002" }] } },
                { title: "关门", description: "林夏关门", position: 1, durationMs: 3000, expectedRevision: 0, content: { scene: "客厅", characters: ["林夏"], action: "林夏关门", camera: "近景", sourceReferences: [{ paragraphId: "p0003", quote: "动作：林夏关门。" }], dialogue: [] } },
            ],
        };
        const bad = structuredClone(input);
        bad.shots[1].title = "";
        await expect(runProjectShotTool("project_create_or_update_shots", bad, "project")).rejects.toMatchObject({ status: 400 });
        expect((await getProjectShotContext("project", unit.id)).shots).toHaveLength(0);
        interceptor = apiClient.interceptors.response.use(response => {
            if (response.config.method === "put" && response.config.url?.endsWith("/shots")) throw new Error("SIMULATED_LOST_SHOT_REPLY");
            return response;
        });
        await expect(runProjectShotTool("project_create_or_update_shots", input, "project")).rejects.toThrow("SIMULATED_LOST_SHOT_REPLY");
        apiClient.interceptors.response.eject(interceptor);
        interceptor = undefined;
        const first = await getProjectShotContext("project", unit.id);
        expect(first.shots).toHaveLength(2);
        expect(first.unit.shotRevision).toBe(1);
        expect(await runProjectShotTool("project_create_or_update_shots", input, "project")).toMatchObject({ data: { replayed: true, verification: { persisted: true, matchesCurrent: true } } });
        const local = { ...input, requestId: "local-" + unit.id, expectedShotRevision: first.unit.shotRevision, shots: [{ ...structuredClone(input.shots[0]), id: first.shots[0].id, expectedRevision: first.shots[0].revision }] };
        local.shots[0].content.camera = "近景，保持门侧方向";
        expect(await runProjectShotTool("project_create_or_update_shots", local, "project")).toMatchObject({ data: { replayed: false, verification: { matchesCurrent: true } } });
        const second = await getProjectShotContext("project", unit.id);
        expect(second.shots[0]).toMatchObject({ id: first.shots[0].id, revision: 2, content: { camera: "近景，保持门侧方向" } });
        expect(second.shots[1]).toEqual(first.shots[1]);
        expect((await getProjectShotRevisions("project", first.shots[0].id)).revisions.map(r => [r.revision, r.shot.content.camera])).toEqual([[2, "近景，保持门侧方向"], [1, "中景"]]);
        expect(await runProjectShotTool("project_create_or_update_shots", input, "project")).toMatchObject({ data: { verification: { persisted: true, matchesCurrent: false } } });
        await saveProjectShot("project", { ...second.shots[0], title: "手工名称保留", expectedRevision: second.shots[0].revision });
        await expect(runProjectShotTool("project_create_or_update_shots", { ...local, requestId: "stale-" + unit.id }, "project")).rejects.toMatchObject({ status: 409 });
        expect((await getProjectShotContext("project", unit.id)).shots[0]).toMatchObject({ revision: 3, title: "手工名称保留", content: { camera: "近景，保持门侧方向" } });
        await updateProjectUnit("project", unit.id, { expectedRevision: 1, requestId: "source-" + unit.id, title: unit.title, sourceText: sourceText + "<p>门外传来敲门声。</p>" });
        const changedSource = await getProjectShotContext("project", unit.id);
        expect(changedSource.staleShotIds.sort()).toEqual(first.shots.map(s => s.id).sort());
        await expect(getProjectShotContext("other-project", unit.id)).rejects.toMatchObject({ status: 404 });
        await expect(getProjectShotContext("foreign", unit.id)).rejects.toMatchObject({ status: 404 });
        console.log(JSON.stringify({ unitId: unit.id, shotIds: first.shots.map(s => s.id), initialShotRevision: first.unit.shotRevision, finalShotRevision: changedSource.unit.shotRevision, sourceRevision: changedSource.unit.revision, invalidBatchWrote: false, originalVersionsPreserved: true, lostReplyReplay: true, unrelatedShotPreserved: true }));
    } finally {
        if (interceptor !== undefined) apiClient.interceptors.response.eject(interceptor);
        apiClient.defaults.baseURL = previousURL;
        if (previousCookie === undefined) delete apiClient.defaults.headers.common.Cookie;
        else apiClient.defaults.headers.common.Cookie = previousCookie;
    }
});
