// One explicit UI action authorizes only this turn's new chapters and bounded
// polishing. It never authorizes existing chapters, media or formal approval.
export class ScriptCreationScope {
    private readonly units = new Set<string>();
    readonly requestId: string;
    readonly chapterCount: number;
    readonly polishRounds: number;
    constructor(private readonly projectId: string, input: unknown) {
        const value = record(input);
        if (!projectId || typeof value.requestId !== "string" || !/^script-[a-zA-Z0-9-]{1,80}$/.test(value.requestId)
            || !Number.isSafeInteger(value.chapterCount) || Number(value.chapterCount) < 1 || Number(value.chapterCount) > 50
            || !Number.isSafeInteger(value.polishRounds) || Number(value.polishRounds) < 0 || Number(value.polishRounds) > 3) throw new Error("SCRIPT_CREATION_SCOPE_INVALID");
        this.requestId = value.requestId;
        this.chapterCount = Number(value.chapterCount);
        this.polishRounds = Number(value.polishRounds);
    }
    allows(name: string, input: Record<string, unknown>) {
        if (input.projectId !== undefined && input.projectId !== this.projectId) return false;
        if (name === "project_create_script") return input.requestId === this.requestId && Array.isArray(input.chapters) && input.chapters.length === this.chapterCount;
        return name === "project_revise_script" && typeof input.unitId === "string" && this.units.has(input.unitId)
            && Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) >= 1 && Number(input.expectedRevision) <= this.polishRounds;
    }
    observeCreation(output: unknown) {
        const result = record(output), data = record(result.data), receipt = record(data.receipt), verification = record(data.verification);
        if (result.ok !== true || verification.ok !== true || verification.persisted !== true || verification.matchesCurrent !== true || receipt.projectId !== this.projectId || receipt.requestId !== this.requestId
            || !Array.isArray(receipt.unitIds) || receipt.unitIds.length !== this.chapterCount || new Set(receipt.unitIds).size !== this.chapterCount
            || !receipt.unitIds.every(id => typeof id === "string" && id.length > 0)) return;
        for (const id of receipt.unitIds) this.units.add(String(id));
    }
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
