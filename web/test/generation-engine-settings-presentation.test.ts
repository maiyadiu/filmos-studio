import { describe, expect, it } from "bun:test";

import {
    FLOVA_EXTERNAL_GATE_STATES,
    generationEngineExternalGatePresentation,
} from "../src/pages/settings/generation-engine-settings-pane";

describe("generation engine settings presentation", () => {
    it("projects the verified Flova capability state without using internal connection status", () => {
        expect(generationEngineExternalGatePresentation("flova_cli")).toEqual({
            state: "READY_FOR_USER_SELECTION",
            label: "Flova 待选择",
            detail: "F0/F1 真实只读能力核验已完成；必须先选择现有 Project，当前尚未发生外部写入。",
        });
    });

    it("keeps the complete user-facing Flova state vocabulary explicit", () => {
        expect(FLOVA_EXTERNAL_GATE_STATES).toEqual([
            { state: "PASS_AUTOMATED", label: "Flova 尚未接入" },
            { state: "READY_FOR_USER_SELECTION", label: "Flova 待选择" },
            { state: "READY_FOR_USER_AUTHORIZATION", label: "Flova 待授权" },
            { state: "PASS_REAL_EXTERNAL", label: "Flova 可用" },
            { state: "BLOCKED_BY_VERIFIED_PROVIDER_CAPABILITY", label: "Flova 能力已验证但被上游阻断" },
        ]);
    });

    it("does not invent external states for other engines", () => {
        expect(generationEngineExternalGatePresentation("dreamina_cli")).toBeUndefined();
    });
});
