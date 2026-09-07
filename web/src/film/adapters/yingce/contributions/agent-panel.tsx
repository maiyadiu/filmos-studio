import { lazy } from "react";

import { defineFilmOSHostContribution, resolveFilmOSHostContribution } from "@/film/contracts/contribution-slots";

const component = lazy(() => import("@/components/canvas/canvas-assistant-panel").then((module) => ({ default: module.CanvasAssistantPanel })));
const contribution = defineFilmOSHostContribution({
    slot: "agent-panel",
    contributionId: "yingce.agent-panel",
    owner: "yingce",
    value: component,
});

export const YingceAgentPanel = resolveFilmOSHostContribution(contribution, "agent-panel");

const localContribution = defineFilmOSHostContribution({
    slot: "agent-panel", contributionId: "yingce.local-agent-panel", owner: "yingce",
    value: lazy(() => import("@/components/canvas/canvas-local-agent-panel").then(module => ({ default: module.CanvasLocalAgentPanel }))),
});
export const YingceLocalAgentPanel = resolveFilmOSHostContribution(localContribution, "agent-panel");

const workspaceContribution = defineFilmOSHostContribution({
    slot: "agent-panel", contributionId: "yingce.workspace-agent-entry", owner: "yingce",
    value: lazy(() => import("@/film/agent/workspace-agent-panel").then(module => ({ default: module.WorkspaceAgentEntry }))),
});
export const YingceWorkspaceAgentEntry = resolveFilmOSHostContribution(workspaceContribution, "agent-panel");
