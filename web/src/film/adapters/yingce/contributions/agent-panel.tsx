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
