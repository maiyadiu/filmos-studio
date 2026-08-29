import { isModelApiBrainProfile, normalizeBrainProfileId, type CanvasAgentMode } from "./brain-profiles";

export function assertExplicitModelRuntimeSelection(value: CanvasAgentMode | string) {
    const profileId = normalizeBrainProfileId(value);
    if (isModelApiBrainProfile(profileId)) return { profileId, billingMode: "metered_api" as const };
    if (profileId === "local.model") return { profileId, billingMode: "local_compute" as const };
    throw new Error(`MODEL_RUNTIME_PROFILE_NOT_SELECTED:${profileId}`);
}
