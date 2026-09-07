import { applyWorkbenchContext, buildWorkbenchContext, buildProjectWorkbenchContext, buildWorkspaceWorkbenchContext, publishWorkbenchContext } from "@/film/agent/workbench-context";
import { defineFilmOSHostContribution, resolveFilmOSHostContribution } from "@/film/contracts/contribution-slots";

const contribution = defineFilmOSHostContribution({
    slot: "workbench-context-publisher",
    contributionId: "yingce.workbench-context-publisher",
    owner: "yingce",
    value: {
        apply: applyWorkbenchContext,
        build: buildWorkbenchContext,
        buildProject: buildProjectWorkbenchContext,
        buildWorkspace: buildWorkspaceWorkbenchContext,
        publish: publishWorkbenchContext,
    },
});

const publisher = resolveFilmOSHostContribution(contribution, "workbench-context-publisher");

export const applyYingceWorkbenchContext = publisher.apply;
export const buildYingceWorkbenchContext = publisher.build;
export const buildYingceProjectContext = publisher.buildProject;
export const buildYingceWorkspaceContext = publisher.buildWorkspace;
export const publishYingceWorkbenchContext = publisher.publish;
