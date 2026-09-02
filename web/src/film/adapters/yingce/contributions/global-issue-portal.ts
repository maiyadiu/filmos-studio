import { ReportIssuePortal } from "@/components/governance/ReportIssuePortal";
import { defineFilmOSHostContribution, resolveFilmOSHostContribution } from "@/film/contracts/contribution-slots";

const contribution = defineFilmOSHostContribution({
    slot: "global-issue-portal",
    contributionId: "yingce.global-issue-portal",
    owner: "yingce",
    value: ReportIssuePortal,
});

export const YingceGlobalIssuePortal = resolveFilmOSHostContribution(contribution, "global-issue-portal");
