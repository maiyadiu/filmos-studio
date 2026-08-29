import { describe, expect, test } from "bun:test";

import { assertExplicitModelRuntimeSelection } from "./model-api-billing-guard.ts";

describe("model API billing guard", () => {
    test("only explicit API profiles reach a metered model runtime", () => {
        expect(assertExplicitModelRuntimeSelection("openai.api")).toEqual({ profileId: "openai.api", billingMode: "metered_api" });
        expect(assertExplicitModelRuntimeSelection("anthropic.api").billingMode).toBe("metered_api");
        expect(assertExplicitModelRuntimeSelection("deepseek.api").billingMode).toBe("metered_api");
        expect(() => assertExplicitModelRuntimeSelection("codex.subscription")).toThrow("NOT_SELECTED");
        expect(() => assertExplicitModelRuntimeSelection("chatgpt.subscription.host")).toThrow("NOT_SELECTED");
    });

    test("legacy profile values migrate losslessly", () => {
        expect(() => assertExplicitModelRuntimeSelection("local")).toThrow("codex.subscription");
        expect(assertExplicitModelRuntimeSelection("online").profileId).toBe("openai.api");
        expect(assertExplicitModelRuntimeSelection("local.model").billingMode).toBe("local_compute");
    });
});
