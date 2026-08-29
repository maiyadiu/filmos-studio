import { describe, expect, test } from "bun:test";

import { AGENT_FEATURE_FLAG_IDS, isAgentFeatureEnabled, readAgentFeatureFlags } from "./feature-flags.ts";

describe("Agent feature flags", () => {
    test("the ten correction flags are default-off", () => {
        const flags = readAgentFeatureFlags({});
        expect(AGENT_FEATURE_FLAG_IDS).toHaveLength(10);
        expect(Object.values(flags).every((value) => value === false)).toBe(true);
    });

    test("only an explicit true string enables a flag", () => {
        expect(isAgentFeatureEnabled("film.agent_generic_runtime", { VITE_FILM_AGENT_GENERIC_RUNTIME: "true" })).toBe(true);
        expect(isAgentFeatureEnabled("film.agent_generic_runtime", { VITE_FILM_AGENT_GENERIC_RUNTIME: true })).toBe(false);
        expect(isAgentFeatureEnabled("film.agent_generic_runtime", { VITE_FILM_AGENT_GENERIC_RUNTIME: "1" })).toBe(false);
    });
});
