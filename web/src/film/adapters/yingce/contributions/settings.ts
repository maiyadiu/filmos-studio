import { defineFilmOSHostContribution, resolveFilmOSHostContribution } from "@/film/contracts/contribution-slots";

export function defineYingceSettingsContribution<Value>(contributionId: string, value: Value) {
    return defineFilmOSHostContribution({ slot: "settings", contributionId, owner: "yingce", value });
}

export function resolveYingceSettingsContribution<Value>(contribution: ReturnType<typeof defineYingceSettingsContribution<Value>>) {
    return resolveFilmOSHostContribution(contribution, "settings");
}
