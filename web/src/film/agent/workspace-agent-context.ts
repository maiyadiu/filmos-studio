import { hashCanvasAgentSnapshot, type CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";

const workspacePages = {
    "/home": { panel: "home", title: "首页" },
    "/projects": { panel: "projects", title: "项目列表" },
    "/canvas": { panel: "canvases", title: "画布列表" },
    "/assets": { panel: "assets", title: "素材库" },
    "/settings": { panel: "settings", title: "设置" },
} as const;

export function workspaceAgentPage(pathname: string) {
    return Object.hasOwn(workspacePages, pathname) ? workspacePages[pathname as keyof typeof workspacePages] : null;
}

export type WorkspaceAgentSnapshot = Omit<CanvasAgentSnapshot, "contextKind" | "projectId" | "title" | "viewport"> & {
    contextKind: "workspace";
    projectId: null;
    workspaceId: string;
    title?: never;
    viewport?: never;
};
export type AgentPageSnapshot = CanvasAgentSnapshot | WorkspaceAgentSnapshot;

export function buildWorkspaceAgentSnapshot(workspaceId: string, pathname: string): WorkspaceAgentSnapshot {
    const page = workspaceAgentPage(pathname);
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(workspaceId) || !page) throw new Error("工作区身份或页面尚未确认");
    return { contextKind: "workspace", workspaceId, projectId: null, activePanel: page.panel,
        nodes: [], connections: [], selectedNodeIds: [], visibleNodeIds: [], assetVersionIds: [] };
}

export function agentWorkspaceId(snapshot: AgentPageSnapshot) {
    return snapshot.contextKind === "workspace" ? snapshot.workspaceId : undefined;
}

export function requireAgentProjectSnapshot(snapshot: AgentPageSnapshot): CanvasAgentSnapshot {
    if (snapshot.contextKind === "workspace") throw new Error("当前没有绑定作品，未执行操作");
    return snapshot;
}

export function hashAgentPageSnapshot(snapshot: AgentPageSnapshot) {
    return snapshot.contextKind === "workspace" ? JSON.stringify([snapshot.contextKind, snapshot.workspaceId, snapshot.activePanel]) : hashCanvasAgentSnapshot(snapshot);
}
