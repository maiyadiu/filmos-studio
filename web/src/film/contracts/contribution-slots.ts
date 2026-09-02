export const FILMOS_HOST_CONTRIBUTION_SLOTS = [
    "agent-panel",
    "generation-composer",
    "settings",
    "global-issue-portal",
    "workbench-context-publisher",
] as const;

export type FilmOSHostContributionSlot = (typeof FILMOS_HOST_CONTRIBUTION_SLOTS)[number];

export type FilmOSHostContribution<Slot extends FilmOSHostContributionSlot, Value> = Readonly<{
    slot: Slot;
    contributionId: string;
    owner: "yingce";
    value: Value;
}>;

export function defineFilmOSHostContribution<Slot extends FilmOSHostContributionSlot, Value>(input: {
    slot: Slot;
    contributionId: string;
    owner: "yingce";
    value: Value;
}): FilmOSHostContribution<Slot, Value> {
    if (!/^[a-z][a-z0-9.-]{2,95}$/.test(input.contributionId)) throw new Error("INVALID_HOST_CONTRIBUTION_ID");
    return Object.freeze({ ...input });
}

export function resolveFilmOSHostContribution<Slot extends FilmOSHostContributionSlot, Value>(
    contribution: FilmOSHostContribution<Slot, Value>,
    expectedSlot: Slot,
): Value {
    if (contribution.slot !== expectedSlot) throw new Error("HOST_CONTRIBUTION_SLOT_MISMATCH");
    return contribution.value;
}
