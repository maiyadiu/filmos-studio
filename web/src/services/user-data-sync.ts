import { getMediaBlob } from "@/services/file-storage";
import { CanvasPromptConflictError } from "../../../packages/filmos-agent-contracts/src/index";
import { getImageBlob } from "@/services/image-storage";
import { deleteRemoteAsset, deleteRemoteCanvasProject, getRemoteCanvasProject, getRemoteUserDataSnapshot, upsertRemoteAsset, upsertRemoteCanvasProject } from "@/services/api/user-data";
import { resourceFileUrl, resourceIdFromStorageKey, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import type { Asset } from "@/stores/use-asset-store";
import { flushAssetStorePersistence, useAssetStore } from "@/stores/use-asset-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { flushCanvasStorePersistence, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { getActiveUserScope } from "@/lib/user-scope";
import { hashScriptContent } from "@/film/story/script-version";
import { CanvasPromptSaveError, canvasPromptRequestHash, getCanvasPrompt, getCanvasPromptReceipt, saveAndVerifyCanvasPrompt, verifyCanvasPromptContext, type CanvasPromptContext, type CanvasPromptInput, type CanvasPromptTarget } from "@/services/api/canvas-prompts";
import { ApiError } from "@/services/api/request";
import { CANVAS_PROMPT_UPDATED_EVENT, localCanvasPromptBaseline, mergeCanvasPromptContext, type CanvasPromptLocalBaseline, type CanvasPromptUpdatedEvent } from "@/lib/canvas/canvas-prompt-merge";
import { requireCanvasContentHash, sameCanvasJSON, type CanvasSyncBaseline } from "@/lib/canvas/canvas-sync-baseline";
import { assertProjectStoryboardContext, CANVAS_STORYBOARD_UPDATED_EVENT, mergeProjectStoryboardReadback, upsertProjectChapterStoryboard, type CanvasStoryboardUpdatedEvent, type ProjectStoryboardSyncInput } from "@/lib/canvas/project-chapter-storyboard";
import { acquireChapterCanvas, getProject, getProjectUnit, getProjectShotContext, linkCanvasUnit } from "@/services/api/projects";

let activeRemoteUserId = "";
let remoteSessionRevision = 0;
type RemoteUserDataPhase = "inactive" | "hydrating" | "ready" | "failed";

let remoteUserDataPhase: RemoteUserDataPhase = "inactive";
let syncTimer: number | null = null;
let syncPromise: Promise<void> | null = null;
let syncQueued = false;
let remoteOperationTail: Promise<void> = Promise.resolve();
let subscriptionsInstalled = false;
let acknowledgedAssets = new Map<string, Asset>();
let acknowledgedProjects = new Map<string, CanvasProject>();
// The server JSON differs from the local media cache representation. Keep its
// exact acknowledged version here so later auto-sync cannot undo an Agent save.
let acknowledgedCanvasStates = new Map<string, CanvasSyncBaseline>();

const LOCAL_STORAGE_KEY_PATTERN = /^(image|video|audio|file|video-reference|audio-reference):/;

export async function syncRemoteUserData(userId?: string | null) {
    await withRemoteUserDataSyncExclusive(async () => {
        activeRemoteUserId = userId || "";
        remoteSessionRevision++;
        acknowledgedProjects.clear();
        acknowledgedCanvasStates.clear();
        acknowledgedAssets.clear();
        if (!activeRemoteUserId) {
            remoteUserDataPhase = "inactive";
            return;
        }
        remoteUserDataPhase = "hydrating";
        const revision = remoteSessionRevision, scope = getActiveUserScope();
        const assertHydrating = () => {
            if (revision !== remoteSessionRevision || scope !== getActiveUserScope()) throw new Error("用户会话已改变，未应用旧账号快照");
        };
        try {
            // 登录只拉一次聚合快照。摘要列表再逐条请求详情会把 N 条数据放大成 2N+2 个请求，
            // 并且会在登录阶段同时触发大量媒体解析，任何一项失败都会污染登录结果。
            const snapshot = await getRemoteUserDataSnapshot();
            assertHydrating();
            const canvasStates = new Map(snapshot.projects.map(project => [project.id, { project, contentHash: requireCanvasContentHash(snapshot.projectContentHashes?.[project.id]) }]));
            // 登录时服务端是实体真相。浏览器 IndexedDB 只作为首屏缓存，不能把服务端已删除的记录补回去。
            // 这里只替换结构化记录，不在登录阶段解析图片/视频/音频 URL；媒体由实际使用方按需解析。
            useCanvasStore.getState().replaceProjects(snapshot.projects);
            useAssetStore.getState().replaceAssets(snapshot.assets);
            await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence()]);
            assertHydrating();
            acknowledgedProjects = new Map(snapshot.projects.map((project) => [project.id, project]));
            acknowledgedCanvasStates = canvasStates;
            acknowledgedAssets = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
            remoteUserDataPhase = "ready";
        } catch (error) {
            if (revision === remoteSessionRevision) remoteUserDataPhase = "failed";
            throw error;
        }
    });
}

export function installRemoteUserDataAutoSync() {
    if (subscriptionsInstalled) return;
    subscriptionsInstalled = true;
    useCanvasStore.subscribe((state, previous) => {
        if (state.projects !== previous.projects) scheduleRemoteUserDataSync();
    });
    useAssetStore.subscribe((state, previous) => {
        if (state.assets !== previous.assets) scheduleRemoteUserDataSync();
    });
}

export function resetRemoteUserDataSync() {
    remoteSessionRevision++;
    activeRemoteUserId = "";
    remoteUserDataPhase = "inactive";
    acknowledgedAssets.clear();
    acknowledgedProjects.clear();
    acknowledgedCanvasStates.clear();
    if (syncTimer) {
        window.clearTimeout(syncTimer);
        syncTimer = null;
    }
    syncQueued = false;
}

export function withRemoteUserDataSyncExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = remoteOperationTail.catch(() => undefined).then(operation);
    remoteOperationTail = pending.then(
        () => undefined,
        () => undefined,
    );
    return pending;
}

function remoteSyncSession() {
    requireRemoteUserDataBaseline();
    const userId = activeRemoteUserId, scope = getActiveUserScope(), revision = remoteSessionRevision;
    if (!userId) throw new Error("画布保存需要已登录的同步会话");
    return () => {
        if (activeRemoteUserId !== userId || getActiveUserScope() !== scope || revision !== remoteSessionRevision) throw new Error("用户会话已改变，未把画布结果写入另一账号");
        requireRemoteUserDataBaseline();
    };
}

// Called only inside the existing sync queue. An absent hash is create-only,
// never permission to overwrite a canvas we have not read.
async function saveCanvasSyncPayload(payload: CanvasProject, acknowledge = true): Promise<CanvasSyncBaseline> {
    const assertCurrent = remoteSyncSession();
    const before = acknowledgedCanvasStates.get(payload.id);
    if (!before && acknowledgedProjects.has(payload.id)) throw new Error("当前画布缺少已确认的服务端版本，未执行写入");
    let saved: CanvasSyncBaseline;
    try {
        const result = await upsertRemoteCanvasProject(payload, before?.contentHash ?? "");
        assertCurrent();
        if (result.project.id !== payload.id) throw new Error("画布保存回执目标不一致");
        saved = { project: payload, contentHash: requireCanvasContentHash(result.project.contentHash) };
    } catch (error) {
        assertCurrent();
        if (error instanceof ApiError && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 409) throw error;
        // Lost response: one read, no second PUT. Only the exact intended JSON
        // can recover this operation; a conflict does not adopt remote edits.
        let remote: Awaited<ReturnType<typeof getRemoteCanvasProject>>;
        try { remote = await getRemoteCanvasProject(payload.id); }
        catch { assertCurrent(); throw error; }
        assertCurrent();
        if (remote.project.id !== payload.id || !sameCanvasJSON(remote.project, payload)) throw error;
        saved = { project: remote.project, contentHash: requireCanvasContentHash(remote.contentHash) };
    }
    assertCurrent();
    if (acknowledge) acknowledgedCanvasStates.set(payload.id, saved);
    return saved;
}

function canvasPromptSession(canvasId: string, target: CanvasPromptTarget) {
    requireRemoteUserDataBaseline();
    if (!activeRemoteUserId) throw new Error("提示词保存需要已登录的同步会话");
    const userId = activeRemoteUserId, userScope = getActiveUserScope();
    const assertCurrent = () => {
        if (activeRemoteUserId !== userId || getActiveUserScope() !== userScope) throw new Error("用户会话已改变，未把提示词结果写入另一账号");
        requireRemoteUserDataBaseline();
        const project = useCanvasStore.getState().projects.find(project => project.id === canvasId);
        if (!project || project.projectId !== target.projectId) throw new Error("提示词不属于当前画布和业务项目");
        return project;
    };
    return { userScope, assertCurrent };
}

async function applyCanvasPromptReadback(canvasId: string, userScope: string, before: CanvasPromptLocalBaseline, context: CanvasPromptContext) {
    const assertCurrent = remoteSyncSession();
    const current = useCanvasStore.getState().projects.find(project => project.id === canvasId);
    if (!current || getActiveUserScope() !== userScope || current.projectId !== context.projectId) return false;
    let nodes: CanvasProject["nodes"];
    try { nodes = mergeCanvasPromptContext(current.nodes, before, context); } catch { return false; }
    const detail: CanvasPromptUpdatedEvent = { canvasId, userScope, before, context };
    // The live canvas owns immediate pointer/keyboard state. Give its existing
    // lifecycle a chance to reject a conflicting edit before updating the store.
    window.dispatchEvent(new CustomEvent(CANVAS_PROMPT_UPDATED_EVENT, { detail }));
    if (detail.rejected) return false;
    if (nodes !== current.nodes || current.promptWriteToken !== context.writeToken) useCanvasStore.getState().updateProject(canvasId, { nodes, promptWriteToken: context.writeToken });
    const acknowledged = acknowledgedProjects.get(canvasId);
    if (acknowledged) {
        try {
            acknowledgedProjects.set(canvasId, { ...acknowledged, nodes: mergeCanvasPromptContext(acknowledged.nodes, localCanvasPromptBaseline(acknowledged.nodes, context), context), promptWriteToken: context.writeToken, updatedAt: useCanvasStore.getState().projects.find(project => project.id === canvasId)!.updatedAt });
        } catch { /* Keep the prior baseline dirty; never acknowledge a fabricated row. */ }
    }
    const remoteBaseline = acknowledgedCanvasStates.get(canvasId);
    if (remoteBaseline) {
        try {
            // Prompt save updates this timestamp in the same transaction. Use
            // its observed value, not the older canvas time or our local clock.
            const projected = { ...remoteBaseline.project, nodes: mergeCanvasPromptContext(remoteBaseline.project.nodes, localCanvasPromptBaseline(remoteBaseline.project.nodes, context), context), promptWriteToken: context.writeToken, updatedAt: context.canvasUpdatedAt };
            const remote = await getRemoteCanvasProject(canvasId);
            assertCurrent();
            if (acknowledgedCanvasStates.get(canvasId) === remoteBaseline && sameCanvasJSON(projected, remote.project)) acknowledgedCanvasStates.set(canvasId, { project: remote.project, contentHash: requireCanvasContentHash(remote.contentHash) });
        } catch { /* Preserve the older CAS baseline; unrelated remote changes must not be acknowledged blindly. */ }
    }
    await flushCanvasStorePersistence();
    assertCurrent();
    return true;
}

export function loadSyncedCanvasPrompt(canvasId: string, target: CanvasPromptTarget) {
    return withRemoteUserDataSyncExclusive(async () => {
        const session = canvasPromptSession(canvasId, target);
        const before = localCanvasPromptBaseline(session.assertCurrent().nodes, target);
        const context = await getCanvasPrompt(canvasId, target);
        await verifyCanvasPromptContext(context, canvasId, target);
        session.assertCurrent();
        const cleanLiteral = await canvasPromptLiteralIsClean(canvasId, target, before);
        const appliedLocally = context.managed && cleanLiteral ? await applyCanvasPromptReadback(canvasId, session.userScope, before, context) : context.prompt === before.prompt;
        return { context, appliedLocally };
    });
}

async function canvasPromptLiteralIsClean(canvasId: string, target: CanvasPromptTarget, before: CanvasPromptLocalBaseline) {
    const knownState = before.state?.[target.kind];
    if (knownState) return knownState.contentHash === await hashScriptContent(before.prompt);
    const acknowledged = acknowledgedProjects.get(canvasId);
    if (!acknowledged) return false;
    try { return localCanvasPromptBaseline(acknowledged.nodes, target).prompt === before.prompt; } catch { return false; }
}

export function saveSyncedCanvasPrompt(canvasId: string, input: CanvasPromptInput) {
    return withRemoteUserDataSyncExclusive(async () => {
        // Until a 404 proves no receipt exists, this may be recovery of a
        // previously committed request, even before this invocation sends POST.
        let promptRequestStarted = true;
        try {
        const session = canvasPromptSession(canvasId, input);
        const source = session.assertCurrent();
        const before = localCanvasPromptBaseline(source.nodes, input);
        let priorReceipt: Awaited<ReturnType<typeof getCanvasPromptReceipt>> | undefined;
        try { priorReceipt = await getCanvasPromptReceipt(canvasId, input.requestId); }
        catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; promptRequestStarted = false; }
        session.assertCurrent();
        if (priorReceipt) {
            if (priorReceipt.requestHash !== await canvasPromptRequestHash(input)) throw new CanvasPromptConflictError();
            // Recovery must not first push a stale local canvas over a saved
            // prompt. Verify the original request, even after later edits.
            promptRequestStarted = true;
            const result = await saveAndVerifyCanvasPrompt(canvasId, input);
            session.assertCurrent();
            const appliedLocally = await canvasPromptLiteralIsClean(canvasId, input, before) && await applyCanvasPromptReadback(canvasId, session.userScope, before, result.context);
            return { ...result, appliedLocally };
        }
        if ((before.state?.[input.kind]?.revision || 0) !== input.expectedRevision || await hashScriptContent(before.prompt) !== input.expectedContentHash) throw new CanvasPromptConflictError();
        // Reuse the existing synchronization path, scoped to this one canvas;
        // do not flush/delete unrelated projects or create a second sync queue.
        if (!sameEntitySnapshot(acknowledgedProjects.get(canvasId), source)) {
            const payload = await ensureRemoteResourceReferences(source, new Map(), false);
            session.assertCurrent();
            await saveCanvasSyncPayload(payload);
            session.assertCurrent();
            acknowledgedProjects.set(canvasId, source);
        }
        promptRequestStarted = true;
        const result = await saveAndVerifyCanvasPrompt(canvasId, input);
        session.assertCurrent();
        const appliedLocally = await applyCanvasPromptReadback(canvasId, session.userScope, before, result.context);
        return { ...result, appliedLocally };
        } catch (error) {
            if (!promptRequestStarted) throw new CanvasPromptSaveError(error instanceof Error ? error.message : "提示词保存前检查未通过", "rejected", { cause: error });
            throw error;
        }
    });
}

export function syncSyncedProjectStoryboard(canvasId: string, input: ProjectStoryboardSyncInput) {
    return withRemoteUserDataSyncExclusive(async () => {
        const assertCurrent = remoteSyncSession(), userScope = getActiveUserScope();
        const currentCanvas = () => {
            assertCurrent();
            const canvas = useCanvasStore.getState().projects.find(project => project.id === canvasId);
            if (!canvas || canvas.projectId !== input.projectId) throw new Error("分镜同步必须使用当前已绑定的业务项目画布");
            return canvas;
        };
        currentCanvas();
        const context = await getProjectShotContext(input.projectId, input.unitId);
        if (context.unit.chapterCanvasId && context.unit.chapterCanvasId !== canvasId) throw new Error("本章已绑定另一个唯一画布，请从章节入口打开；未写入当前画布");
        assertProjectStoryboardContext(context, input);
        const source = currentCanvas();
        const merged = upsertProjectChapterStoryboard(source.nodes, source.connections, { unit: context.unit, shots: context.shots, newNodeId: `project-chapter:${input.unitId}` });
        const before = source.nodes.find(node => node.id === merged.scriptNodeId), after = merged.nodes.find(node => node.id === merged.scriptNodeId)!;
        const checkLocal = (phase: CanvasStoryboardUpdatedEvent["phase"]) => {
            const canvas = currentCanvas();
            const nodes = mergeProjectStoryboardReadback(canvas.nodes, before, after);
            const detail: CanvasStoryboardUpdatedEvent = { canvasId, userScope, before, after, phase };
            window.dispatchEvent(new CustomEvent(CANVAS_STORYBOARD_UPDATED_EVENT, { detail }));
            if (detail.rejected) throw new Error("当前画布分镜有尚未同步的手工修改，已保留");
            return { canvas, nodes };
        };
        checkLocal("check");
        const priorRemote = acknowledgedCanvasStates.get(canvasId);
        const unchanged = sameCanvasJSON(merged.nodes, source.nodes) && sameEntitySnapshot(acknowledgedProjects.get(canvasId), source);
        const payload = unchanged && priorRemote ? priorRemote.project : await ensureRemoteResourceReferences({ ...source, nodes: merged.nodes }, new Map(), false);
        checkLocal("check");
        // Do not acknowledge remote state until the local node was safely
        // applied. A failed local merge leaves auto-sync's old CAS fence intact.
        const saved = unchanged && priorRemote ? priorRemote : await saveCanvasSyncPayload(payload, false);
        const remote = await getRemoteCanvasProject(canvasId);
        currentCanvas();
        if (remote.project.id !== canvasId || !sameCanvasJSON(remote.project, saved.project) || requireCanvasContentHash(remote.contentHash) !== saved.contentHash) throw new Error("分镜保存后的画布已变化或回读不一致，未宣称同步完成；请回读核对");
        const location = { projectId: input.projectId, canvasId, unitId: input.unitId, nodeId: merged.scriptNodeId, rows: context.shots.slice().sort((a, b) => a.position - b.position).map(shot => ({ shotId: shot.id, rowId: `project-shot:${shot.id}`, position: shot.position, revision: shot.revision })) };
        let appliedLocally = false, linked = false, sourceCurrent = false, issue = "";
        try {
            const local = checkLocal("apply");
            if (local.nodes !== local.canvas.nodes) useCanvasStore.getState().updateProject(canvasId, { nodes: local.nodes });
            await flushCanvasStorePersistence();
            const applied = currentCanvas();
            mergeProjectStoryboardReadback(applied.nodes, after, after);
            acknowledgedCanvasStates.set(canvasId, saved);
            // Acknowledge only the pre-existing local snapshot plus our node,
            // not unrelated edits made while this network operation was pending.
            acknowledgedProjects.set(canvasId, { ...source, nodes: merged.nodes, updatedAt: applied.updatedAt });
            appliedLocally = true;
            const beforeLink = await getProject(input.projectId);
            if (!beforeLink.canvasUnitLinks.some(link => link.canvasId === canvasId && link.unitId === input.unitId && ["storyboard", "production"].includes(link.role))) {
                const result = await linkCanvasUnit(input.projectId, { canvasId, unitId: input.unitId, role: "storyboard" });
                currentCanvas();
                if (result.link.projectId !== input.projectId || result.link.canvasId !== canvasId || result.link.unitId !== input.unitId || result.link.role !== "storyboard") throw new Error("章节关联回执身份不一致");
            }
            const detail = await getProject(input.projectId);
            currentCanvas();
            linked = detail.project.id === input.projectId && detail.canvasUnitLinks.some(link => link.canvasId === canvasId && link.unitId === input.unitId && ["storyboard", "production"].includes(link.role));
            const latest = await getProjectShotContext(input.projectId, input.unitId);
            const finalLocal = currentCanvas();
            appliedLocally = sameCanvasJSON(finalLocal.nodes.find(node => node.id === after.id), after);
            if (!appliedLocally) throw new Error("关联核对期间本地分镜发生修改，已保留；请回读核对");
            assertProjectStoryboardContext(latest, input);
            if (latest.unit.chapterCanvasId && latest.unit.chapterCanvasId !== canvasId) throw new Error("章节唯一画布已变化，请回读核对");
            sourceCurrent = sameCanvasJSON(latest.shots, context.shots);
        } catch (error) { issue = error instanceof Error ? error.message : "分镜保存后核对未完成"; }
        return { location, verification: { ok: appliedLocally && linked && sourceCurrent, persisted: true, appliedLocally, linked, sourceCurrent }, issue };
    });
}

export function scheduleRemoteUserDataSync() {
    if (!activeRemoteUserId || remoteUserDataPhase !== "ready") return;
    if (syncPromise) {
        syncQueued = true;
        return;
    }
    if (syncTimer) window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => {
        syncTimer = null;
        void saveRemoteUserDataNow().catch((error) => console.warn("云端自动同步失败", error));
    }, 1200);
}

export async function createCanvasProjectWithRemoteSync(title: string, projectId?: string, initialContent?: Partial<Pick<CanvasProject, "nodes" | "connections">>) {
    const id = useCanvasStore.getState().createProject(title, projectId);
    if (initialContent) useCanvasStore.getState().updateProject(id, initialContent);
    if (!activeRemoteUserId) return { id, syncError: new Error("尚未建立云端同步会话") };
    try {
        await saveRemoteUserDataNow();
        return { id };
    } catch (syncError) {
        scheduleRemoteUserDataSync();
        return { id, syncError };
    }
}

export function acquireSyncedChapterCanvas(projectId: string, unitId: string, preferredCanvasId?: string) {
    return withRemoteUserDataSyncExclusive(async () => {
        const assertCurrent = remoteSyncSession();
        const result = await acquireChapterCanvas(projectId, unitId, preferredCanvasId);
        assertCurrent();
        if (result.disposition === "selection_required") {
            if (!result.candidates?.length || result.candidates.some(canvas => !canvas.id || canvas.projectId !== projectId)) throw new Error("历史画布候选归属不一致");
            return { ...result, localPending: false };
        }
        if (!result.canvas?.id || result.canvas.projectId !== projectId) throw new Error("章节画布回执身份不一致");
        const canvasId = result.canvas.id;
        const [remote, currentUnit] = await Promise.all([getRemoteCanvasProject(canvasId), getProjectUnit(projectId, unitId)]);
        assertCurrent();
        if (remote.project.id !== canvasId || remote.project.projectId !== projectId || currentUnit.unit.id !== unitId || currentUnit.unit.projectId !== projectId || currentUnit.unit.chapterCanvasId !== canvasId) throw new Error("章节画布回读不一致，未应用结果");
        const contentHash = requireCanvasContentHash(remote.contentHash);
        const local = useCanvasStore.getState().projects.find(canvas => canvas.id === canvasId);
        if (local && local.projectId !== projectId) throw new Error("本地画布归属冲突，未覆盖本地内容");
        // Opening is not permission to erase a draft or acknowledge unseen
        // changes. Keep the dirty local object and its previous CAS baseline.
        const localPending = Boolean(local && !sameCanvasJSON(local, acknowledgedProjects.get(canvasId)));
        if (!localPending) {
            acknowledgedProjects.set(canvasId, remote.project);
            acknowledgedCanvasStates.set(canvasId, { project: remote.project, contentHash });
            const projects = useCanvasStore.getState().projects;
            useCanvasStore.getState().replaceProjects(local ? projects.map(canvas => canvas.id === canvasId ? remote.project : canvas) : [...projects, remote.project]);
            await flushCanvasStorePersistence();
            assertCurrent();
        }
        return { ...result, localPending };
    });
}

// Association changes only the persisted relationship, not the user's pending
// node edits. Apply locally after CAS and readback; a rejection leaves it intact.
export function reassignSyncedCanvasProjects(ids: string[], projectId?: string) {
    return withRemoteUserDataSyncExclusive(async () => {
        const assertCurrent = remoteSyncSession();
        const completed: string[] = [];
        try {
            for (const id of [...new Set(ids)]) {
                assertCurrent();
                const baseline = acknowledgedCanvasStates.get(id), localBaseline = acknowledgedProjects.get(id);
                const current = () => {
                    assertCurrent();
                    const canvas = useCanvasStore.getState().projects.find(canvas => canvas.id === id);
                    if (!canvas || (canvas.projectId || "") !== (baseline?.project.projectId || "")) throw new Error("画布归属在操作期间发生变化，请核对；未覆盖本地修改");
                    return canvas;
                };
                if (!baseline || !localBaseline) throw new Error("画布缺少已确认的服务端版本，请先完成同步");
                current();
                if ((baseline.project.projectId || "") === (projectId || "")) { completed.push(id); continue; }
                const payload = { ...baseline.project, projectId, updatedAt: new Date().toISOString() };
                const saved = await saveCanvasSyncPayload(payload, false);
                const remote = await getRemoteCanvasProject(id);
                current();
                if (remote.project.id !== id || !sameCanvasJSON(remote.project, saved.project) || requireCanvasContentHash(remote.contentHash) !== saved.contentHash) throw new Error("画布关系已请求保存，但回读不一致，请核对");
                useCanvasStore.getState().updateProject(id, { projectId });
                acknowledgedCanvasStates.set(id, saved);
                acknowledgedProjects.set(id, { ...localBaseline, projectId, updatedAt: useCanvasStore.getState().projects.find(canvas => canvas.id === id)!.updatedAt });
                await flushCanvasStorePersistence();
                assertCurrent();
                completed.push(id);
            }
            return { completedIds: completed };
        } catch (error) {
            const detail = error instanceof Error ? error.message : "画布关系未完成";
            throw new Error(completed.length ? `已有 ${completed.length} 个画布关系完成并回读；其余未确认：${detail}` : detail, { cause: error });
        }
    });
}

export async function deleteAssetWithRemoteSync(id: string) {
    const assetId = id.trim();
    if (!assetId) throw new Error("素材 ID 不能为空");
    await withRemoteUserDataSyncExclusive(async () => {
        if (activeRemoteUserId) {
            requireRemoteUserDataBaseline();
            await deleteRemoteAsset(assetId);
            acknowledgedAssets.delete(assetId);
        }
        await useAssetStore.getState().removeAsset(assetId);
        await flushAssetStorePersistence();
    });
}

export async function deleteCanvasProjectsWithRemoteSync(ids: string[]) {
    const projectIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    if (!projectIds.length) return;
    await withRemoteUserDataSyncExclusive(async () => {
        if (activeRemoteUserId) requireRemoteUserDataBaseline();
        for (const id of projectIds) {
            if (activeRemoteUserId) {
                await deleteRemoteCanvasProject(id);
                acknowledgedProjects.delete(id);
                acknowledgedCanvasStates.delete(id);
            }
            useCanvasStore.getState().deleteProjects([id]);
            // 批量删除允许部分成功；每个已成功远端删除的实体都立即落实到本地 durable cache。
            await flushCanvasStorePersistence();
        }
    });
}

export async function saveRemoteUserDataNow() {
    if (!activeRemoteUserId) return;
    requireRemoteUserDataBaseline();
    if (syncPromise) {
        syncQueued = true;
        return syncPromise;
    }
    syncPromise = withRemoteUserDataSyncExclusive(async () => {
        requireRemoteUserDataBaseline();
        await drainRemoteUserDataChanges();
    });
    try {
        await syncPromise;
    } finally {
        syncPromise = null;
    }
}

async function drainRemoteUserDataChanges() {
    do {
        syncQueued = false;
        await saveRemoteUserDataBatch();
    } while (syncQueued);
}

async function saveRemoteUserDataBatch() {
    const assertCurrent = remoteSyncSession();
    const currentProjects = useCanvasStore.getState().projects;
    const currentAssets = useAssetStore.getState().assets;
    const dirtyProjects = currentProjects.filter((project) => !sameEntitySnapshot(acknowledgedProjects.get(project.id), project));
    const dirtyAssets = currentAssets.filter((asset) => !sameEntitySnapshot(acknowledgedAssets.get(asset.id), asset));
    const currentProjectIds = new Set(currentProjects.map((project) => project.id));
    const currentAssetIds = new Set(currentAssets.map((asset) => asset.id));
    const deletedProjectIds = [...acknowledgedProjects.keys()].filter((id) => !currentProjectIds.has(id));
    const deletedAssetIds = [...acknowledgedAssets.keys()].filter((id) => !currentAssetIds.has(id));
    if (!dirtyProjects.length && !dirtyAssets.length && !deletedProjectIds.length && !deletedAssetIds.length) return;

    const uploaded = new Map<string, string>();
    // 转换后的 resource: 引用只属于发往服务端的 payload，不能反写整份实时 store。
    // 已确认快照记录的是本次上传所依据的本地实体；上传期间的新编辑会在下一轮继续提交。
    for (const source of dirtyProjects) {
        const remotePayload = await ensureRemoteResourceReferences(source, uploaded);
        assertCurrent();
        await saveCanvasSyncPayload(remotePayload);
        assertCurrent();
        acknowledgedProjects.set(source.id, source);
    }
    for (const source of dirtyAssets) {
        const remotePayload = await ensureRemoteResourceReferences(source, uploaded);
        assertCurrent();
        await upsertRemoteAsset(remotePayload);
        assertCurrent();
        acknowledgedAssets.set(source.id, source);
    }
    for (const id of deletedProjectIds) {
        await deleteRemoteCanvasProject(id);
        assertCurrent();
        acknowledgedProjects.delete(id);
        acknowledgedCanvasStates.delete(id);
    }
    for (const id of deletedAssetIds) {
        await deleteRemoteAsset(id);
        assertCurrent();
        acknowledgedAssets.delete(id);
    }
}

async function ensureRemoteResourceReferences<T>(value: T, uploaded = new Map<string, string>(), allowUpload = true): Promise<T> {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        const result: unknown[] = [];
        for (const item of value) result.push(await ensureRemoteResourceReferences(item, uploaded, allowUpload));
        return result as T;
    }

    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        next[key] = await ensureRemoteResourceReferences(child, uploaded, allowUpload);
    }

    const storageKey = typeof next.storageKey === "string" ? next.storageKey : "";
    const remoteResourceId = resourceIdFromStorageKey(storageKey);
    if (remoteResourceId) return applyResourceReference(next, storageKey) as T;

    if (!isLocalStorageKey(storageKey)) {
        const inline = inlineMediaDataUrl(next);
        if (!inline) return next as T;
        if (!allowUpload) throw new Error("画布含尚未同步的本地媒体，请先通过原素材入口同步；提示词保存不会代为上传");
        const resourceStorage = await uploadInlineDataUrl(inline);
        return applyResourceReference(next, resourceStorage) as T;
    }

    if (!allowUpload) throw new Error("画布含尚未同步的本地素材，请先通过原素材入口同步；提示词保存不会代为上传");
    const cached = uploaded.get(storageKey);
    const resourceStorage = cached || (await uploadLocalStorageKey(storageKey, next));
    uploaded.set(storageKey, resourceStorage);
    return applyResourceReference(next, resourceStorage) as T;
}

function applyResourceReference(payload: Record<string, unknown>, storageKey: string) {
    const url = resourceFileUrl(storageKey.slice("resource:".length));
    payload.storageKey = storageKey;
    for (const key of ["content", "dataUrl", "url", "coverUrl"]) {
        if (typeof payload[key] === "string") payload[key] = url;
    }
    return payload;
}

function inlineMediaDataUrl(payload: Record<string, unknown>) {
    for (const key of ["dataUrl", "content", "url", "coverUrl"]) {
        const value = payload[key];
        if (typeof value === "string" && /^data:(image|video|audio)\//i.test(value)) return value;
    }
    return "";
}

async function uploadInlineDataUrl(dataUrl: string) {
    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error("内嵌媒体读取失败");
    const blob = await response.blob();
    const kind: "image" | "video" | "audio" | "file" = blob.type.startsWith("image/") ? "image" : blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : "file";
    const resource = await uploadResourceFile(blob, kind);
    return resourceStorageKey(resource.id);
}

async function uploadLocalStorageKey(storageKey: string, payload: Record<string, unknown>) {
    const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
    if (!blob) throw new Error(`本地媒体不存在：${storageKey}`);
    const kind = blob.type.startsWith("image/") ? "image" : blob.type.startsWith("video/") ? "video" : blob.type.startsWith("audio/") ? "audio" : "file";
    const resource = await uploadResourceFile(blob, kind, {
        width: numberValue(payload.naturalWidth) || numberValue(payload.width),
        height: numberValue(payload.naturalHeight) || numberValue(payload.height),
        durationMs: numberValue(payload.durationMs),
    });
    return resourceStorageKey(resource.id);
}

function requireRemoteUserDataBaseline() {
    if (remoteUserDataPhase !== "ready") throw new Error("云端数据基线尚未建立，已停止写入");
}

function sameEntitySnapshot<T>(acknowledged: T | undefined, current: T) {
    return acknowledged !== undefined && (acknowledged === current || JSON.stringify(acknowledged) === JSON.stringify(current));
}

function isLocalStorageKey(value: string) {
    return LOCAL_STORAGE_KEY_PATTERN.test(value) && !resourceIdFromStorageKey(value);
}

function numberValue(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}
