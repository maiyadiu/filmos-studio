export type AgentWorkbenchScope = {
    projectId: string | null;
    /** Runtime-owned workspace identity, only present when no project is selected. */
    workspaceId?: string;
    domainProjectId?: string;
    /** null is a project/workspace page, never a synthetic or last-opened canvas. */
    canvasId: string | null;
    contentUnitId?: string;
    sceneId?: string;
    directorUnitId?: string;
    shotId?: string;
};

export function assertAgentWorkbenchScope(scope: AgentWorkbenchScope): void {
    if (scope.projectId === null) {
        if (scope.canvasId !== null || scope.domainProjectId !== undefined || typeof scope.workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(scope.workspaceId)) throw new Error("AGENT_CONTEXT_WORKSPACE_REQUIRED");
        if ([scope.contentUnitId, scope.sceneId, scope.directorUnitId, scope.shotId].some(value => value !== undefined)) throw new Error("AGENT_WORKSPACE_CONTEXT_HAS_PROJECT_DATA");
        return;
    }
    if (scope.workspaceId !== undefined) throw new Error("AGENT_CONTEXT_WORKSPACE_PROJECT_MIXED");
    if (typeof scope.projectId !== "string" || !scope.projectId.trim()) throw new Error("AGENT_CONTEXT_PROJECT_REQUIRED");
    if (scope.canvasId === null) {
        if (scope.domainProjectId !== scope.projectId) throw new Error("AGENT_CONTEXT_DOMAIN_PROJECT_MISMATCH");
    } else if (typeof scope.canvasId !== "string" || !scope.canvasId.trim()) {
        throw new Error("AGENT_CONTEXT_CANVAS_REQUIRED");
    }
}

// These existing tools use the business project API without a canvas document.
// Unknown/new tools fail closed until their context dependency has been reviewed.
const projectPageTools = new Set([
    "workbench_get_context",
    "project_get_context", "project_list_units",
    "project_create_script", "project_get_script_batch", "project_get_script", "project_get_script_revision", "project_revise_script",
    "project_create_or_update_shots", "project_get_shots", "project_get_shot_batch", "project_get_shot_revisions",
    "project_extract_asset_candidates", "project_confirm_asset_candidate", "project_link_asset", "project_link_shot_asset",
    "project_upsert_asset_version", "project_start_workflow_step", "project_register_task_output",
]);

export function isProjectPageTool(name: string): boolean {
    return projectPageTools.has(name);
}

export function toolsForWorkbenchScope(names: readonly string[], scope: AgentWorkbenchScope): string[] {
    assertAgentWorkbenchScope(scope);
    if (scope.projectId === null) return names.filter(name => name === "workbench_get_context");
    return names.filter((name) => scope.canvasId !== null || isProjectPageTool(name));
}
