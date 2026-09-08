import { create } from "zustand";

import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";
import type { CanvasAssistantSession } from "@/types/canvas";
import type { AgentTurnPlan } from "@/film/agent/agent-client";
import type { CodexModelReceipt, CodexModelSelection } from "../../../../packages/filmos-agent-contracts/src/codex-models";
import { storyboardActionBusy, type StoryboardButtonAction } from "@/film/agent/storyboard-button-action";
import { characterActionBusy, type CharacterButtonAction } from "@/film/agent/character-button-action";

export type AgentChatRole = "user" | "assistant" | "system" | "tool" | "error";
export type AgentAttachment = { id: string; name: string; type: string; size: number; url: string; dataUrl: string };
export type AgentChatItem = { id: string; role: AgentChatRole; title?: string; text: string; meta?: string; detail?: unknown; attachments?: AgentAttachment[]; streamId?: string; streamMode?: "append" | "snapshot" | "complete" };
export type AgentEventLog = { id: string; time: string; title: string; text: string; raw?: unknown };
export type AgentPendingToolCall = {
    requestId: string;
    name: string;
    input?: { ops?: CanvasAgentOp[] } & Record<string, unknown>;
    canonicalRequestId?: string;
    canonicalSessionId?: string;
    canonicalContextReceiptId?: string;
    canonicalConfirmationId?: string;
    canonicalBrokerGrantId?: string;
    canonicalBrokerGrantContentHash?: string;
    canonicalBrokerDecisionReceiptId?: string;
    canonicalBrokerDecisionReceiptContentHash?: string;
    canonicalAuthorizedByActorRef?: string;
    canonicalConfirmedAt?: string;
    canonicalConfirmation?: { id: string; sessionId: string; summary: string; impact: string[] };
};
export type AgentThreadSummary = { id: string; preview: string; name?: string | null; cwd?: string; status?: string; source?: unknown; createdAt?: number; updatedAt?: number };
export type AgentPanelTab = "chat" | "setup" | "history" | "log";

type CanvasAgentStore = {
    width: number;
    connected: boolean;
    enabled: boolean;
    prompt: string;
    attachments: AgentAttachment[];
    sending: boolean;
    waiting: boolean;
    messages: AgentChatItem[];
    eventLogs: AgentEventLog[];
    threads: AgentThreadSummary[];
    activeThreadId: string;
    sessionScopeKey: string;
    sessionUserId: string | null;
    latestPlan: AgentTurnPlan | null;
    latestModelReceipt: CodexModelReceipt | null;
    codexModel: CodexModelSelection | null;
    storyboardAction: StoryboardButtonAction | null;
    characterAction: CharacterButtonAction | null;
    workspacePath: string;
    loadingThreads: boolean;
    activeTab: AgentPanelTab;
    confirmTools: boolean;
    activity: string;
    connectError: string;
    pendingTool: AgentPendingToolCall | null;
    profileSessions: Record<string, { sessions: CanvasAssistantSession[]; activeSessionId: string | null }>;
    setAgentState: (patch: Partial<Omit<CanvasAgentStore, "setAgentState" | "addMessage" | "addEventLog" | "clearEventLogs" | "saveProfileSessions">>) => void;
    saveProfileSessions: (key: string, sessions: CanvasAssistantSession[], activeSessionId: string | null) => void;
    addMessage: (item: AgentChatItem) => void;
    addEventLog: (item: AgentEventLog) => void;
    clearEventLogs: () => void;
};

const CANVAS_AGENT_ENABLED_STORAGE_KEY = "canvas-agent-enabled";

type CanvasAgentPreferenceStorage = {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
};

export function readCanvasAgentEnabledPreference(storage: Pick<CanvasAgentPreferenceStorage, "getItem"> | undefined = browserPreferenceStorage()) {
    try {
        return storage?.getItem(CANVAS_AGENT_ENABLED_STORAGE_KEY) === "true";
    } catch {
        return false;
    }
}

export function writeCanvasAgentEnabledPreference(enabled: boolean, storage: Pick<CanvasAgentPreferenceStorage, "setItem"> | undefined = browserPreferenceStorage()) {
    try {
        storage?.setItem(CANVAS_AGENT_ENABLED_STORAGE_KEY, String(enabled));
    } catch {
        // 浏览器隐私模式可能拒绝本地偏好写入；连接本身仍可继续。
    }
}

export function canvasAgentConnectionStartingPatch() {
    return { enabled: true, connected: false, activity: "连接中", connectError: "", activeTab: "chat" as const };
}

export function canvasAgentTransientDisconnectPatch(activity: string, connectError: string) {
    return { enabled: true, connected: false, activity, connectError };
}

export function canvasAgentConnectionStatusText({ enabled, connected, activity, connectError }: Pick<CanvasAgentStore, "enabled" | "connected" | "activity" | "connectError">) {
    if (enabled && !connected && activity === "正在重连") return activity;
    return connectError ? "连接失败" : connected ? activity : enabled ? "连接中" : "未连接";
}

function browserPreferenceStorage(): CanvasAgentPreferenceStorage | undefined {
    return typeof window === "undefined" ? undefined : window.localStorage;
}

export const useCanvasAgentStore = create<CanvasAgentStore>((set) => ({
    width: typeof window === "undefined" ? 440 : Number(localStorage.getItem("canvas-agent-panel-width")) || 440,
    connected: false,
    enabled: readCanvasAgentEnabledPreference(),
    prompt: "",
    attachments: [],
    sending: false,
    waiting: false,
    messages: [],
    eventLogs: [],
    threads: [],
    activeThreadId: "",
    sessionScopeKey: "",
    sessionUserId: null,
    latestPlan: null,
    latestModelReceipt: null,
    codexModel: null,
    storyboardAction: null,
    characterAction: null,
    workspacePath: "",
    loadingThreads: false,
    activeTab: "chat",
    confirmTools: true,
    activity: "就绪",
    connectError: "",
    pendingTool: null,
    profileSessions: {},
    setAgentState: (patch) => {
        if (typeof patch.enabled === "boolean") writeCanvasAgentEnabledPreference(patch.enabled);
        set(patch);
    },
    addMessage: (item) => set((state) => ({ messages: [...state.messages.slice(-120), item] })),
    saveProfileSessions: (key, sessions, activeSessionId) => set((state) => ({ profileSessions: { ...state.profileSessions, [key]: { sessions, activeSessionId } } })),
    addEventLog: (item) => set((state) => ({ eventLogs: [...state.eventLogs.slice(-160), item] })),
    clearEventLogs: () => set({ eventLogs: [] }),
}));

// One ephemeral UI intent. BrainSession remains the only execution authority.
export function queueStoryboardButtonAction(action: StoryboardButtonAction) {
    const current = useCanvasAgentStore.getState();
    if (current.sending || current.waiting || current.pendingTool || storyboardActionBusy(current.storyboardAction) || characterActionBusy(current.characterAction)) throw new Error("已有任务执行中或结果待核对；未重复发送分镜任务");
    current.setAgentState({ storyboardAction: action, enabled: true, activeTab: "chat" });
}

export function patchStoryboardButtonAction(id: string, patch: Partial<Pick<StoryboardButtonAction, "status" | "sessionId" | "message" | "beforeBusiness">>) {
    const current = useCanvasAgentStore.getState();
    if (current.storyboardAction?.id !== id) return false;
    current.setAgentState({ storyboardAction: { ...current.storyboardAction, ...patch } });
    return true;
}

export function claimStoryboardButtonAction(id: string) {
    if (useCanvasAgentStore.getState().storyboardAction?.status !== "queued") return false;
    return patchStoryboardButtonAction(id, { status: "preparing", message: "正在核对原节点与保存状态" });
}

export function queueCharacterButtonAction(action: CharacterButtonAction) {
    const current = useCanvasAgentStore.getState();
    if (current.sending || current.waiting || current.pendingTool || storyboardActionBusy(current.storyboardAction) || characterActionBusy(current.characterAction)) throw new Error("已有任务执行中或结果待核对；角色任务未发送");
    current.setAgentState({ characterAction: action, enabled: true, activeTab: "chat" });
}

export function patchCharacterButtonAction(id: string, patch: Partial<Pick<CharacterButtonAction, "status" | "message" | "sessionId" | "beforeCandidates">>) {
    const current = useCanvasAgentStore.getState();
    if (current.characterAction?.id !== id) return false;
    current.setAgentState({ characterAction: { ...current.characterAction, ...patch } });
    return true;
}

export function claimCharacterButtonAction(id: string) {
    if (useCanvasAgentStore.getState().characterAction?.status !== "queued") return false;
    return patchCharacterButtonAction(id, { status: "preparing", message: "正在核对完整章节和已有角色" });
}
