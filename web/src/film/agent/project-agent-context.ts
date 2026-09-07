import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import type { ProjectDetail } from "@/services/api/projects";
import type { BrainSessionView } from "./agent-client";
import { agentWorkspaceId, type AgentPageSnapshot } from "./workspace-agent-context";

export type ProjectChapterContext = { projectId: string; unitId: string; revision?: number; ready: boolean; dirty: boolean };

export function buildProjectAgentSnapshot(detail: ProjectDetail, activePanel: string, chapter?: ProjectChapterContext | null): CanvasAgentSnapshot {
    const project = detail.project;
    if (!project.id) throw new Error("项目身份未加载");
    const unit = activePanel === "chapters" && chapter?.projectId === project.id ? detail.units.find(item => item.id === chapter.unitId) : undefined;
    const blockers: string[] = [];
    if (project.status === "archived") blockers.push("项目已归档，仅可读取");
    if (activePanel === "chapters" && (!unit || !chapter?.ready)) blockers.push("当前章节正文尚未确认，仅可读取已保存内容");
    if (activePanel === "chapters" && chapter?.projectId === project.id && chapter.dirty) blockers.push("当前章节有未保存草稿，请先保存；Agent读取的是已保存版本");
    return {
        contextKind: "project", projectId: project.id, domainProjectId: project.id, projectRevision: project.revision,
        ...(unit ? { contentUnitId: unit.id, contentUnitRevision: chapter?.revision } : {}),
        title: project.name, activePanel, blockers,
        nodes: [], connections: [], selectedNodeIds: [], visibleNodeIds: [], assetVersionIds: [], viewport: { x: 0, y: 0, k: 1 },
    };
}

export function agentSnapshotCanvasId(snapshot: AgentPageSnapshot) {
    return snapshot.contextKind === "project" || snapshot.contextKind === "workspace" ? null : snapshot.projectId;
}

export function matchesAgentSessionScope(session: BrainSessionView, snapshot: AgentPageSnapshot, profile: string) {
    return session.projectId === snapshot.projectId && session.canvasId === agentSnapshotCanvasId(snapshot)
        && session.workspaceId === agentWorkspaceId(snapshot) && session.domainProjectId === snapshot.domainProjectId && session.contentUnitId === snapshot.contentUnitId && session.brainProfileId === profile;
}
