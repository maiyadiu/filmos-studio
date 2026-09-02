import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { defineFilmOSHostContribution, resolveFilmOSHostContribution } from "@/film/contracts/contribution-slots";

const contribution = defineFilmOSHostContribution({
    slot: "generation-composer",
    contributionId: "yingce.generation-composer",
    owner: "yingce",
    value: CanvasConfigComposer,
});

export const YingceGenerationComposer = resolveFilmOSHostContribution(contribution, "generation-composer");
