import localforage from "localforage";

// A user-scoped navigation draft, not a second task queue. Claim before network
// dispatch; after an uncertain send, recovery uses the existing BrainSession.
const drafts = localforage.createInstance({ name: "infinite-canvas", storeName: "script_launch_drafts" });
export type ScriptLaunch = {
    id: string; userId: string; projectId: string; canvasId: string; prompt: string; skillIds: string[];
    chapterCount: number; polishRounds: number; createdAt: number; claimed: boolean;
};
const key = (userId: string, id: string) => `${encodeURIComponent(userId)}:${encodeURIComponent(id)}`;
export async function saveScriptLaunch(draft: ScriptLaunch) { await drafts.setItem(key(draft.userId, draft.id), draft); }
export function matchesScriptLaunch(value: ScriptLaunch | null, userId: string, canvasId: string, projectId: string, now = Date.now()): value is ScriptLaunch {
    return !!value && value.userId === userId && value.canvasId === canvasId && value.projectId === projectId && !!projectId
        && /^[a-zA-Z0-9-]{1,80}$/.test(value.id) && typeof value.prompt === "string" && value.prompt.length <= 50_000 && !!value.prompt.trim()
        && Array.isArray(value.skillIds) && value.skillIds.length <= 8 && value.skillIds.every(id => typeof id === "string" && id.length > 0)
        && Number.isSafeInteger(value.chapterCount) && value.chapterCount >= 1 && value.chapterCount <= 50
        && Number.isSafeInteger(value.polishRounds) && value.polishRounds >= 0 && value.polishRounds <= 3
        && value.createdAt <= now && now - value.createdAt <= 60 * 60_000 && typeof value.claimed === "boolean";
}
export async function readScriptLaunch(id: string, userId: string, canvasId: string, projectId: string) {
    const value = await drafts.getItem<ScriptLaunch>(key(userId, id));
    return matchesScriptLaunch(value, userId, canvasId, projectId) ? value : null;
}
export async function claimScriptLaunch(value: ScriptLaunch) {
    if (!navigator.locks) throw new Error("浏览器不支持可靠的单次发送，请在Agent中手动发送草稿");
    return navigator.locks.request(`script-launch:${key(value.userId, value.id)}`, async () => {
        const stored = await readScriptLaunch(value.id, value.userId, value.canvasId, value.projectId);
        if (!stored || stored.claimed) return false;
        await drafts.setItem(key(value.userId, value.id), { ...stored, claimed: true });
        return true;
    });
}
