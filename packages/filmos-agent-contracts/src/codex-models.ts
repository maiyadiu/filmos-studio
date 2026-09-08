export type CodexModelSelection = { model: string; effort: string };
export type CodexModelOption = {
    model: string;
    displayName: string;
    defaultReasoningEffort: string;
    supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
};
export type CodexModelReceipt = {
    turnId: string;
    providerTurnId: string;
    requested: CodexModelSelection | null;
    /** Thread metadata read after turn/start, not an inference from the request. */
    reported: { model: string | null; effort: string | null };
    source: "thread/read" | "not_reported";
};

const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(value);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function parseCodexModelSelection(value: unknown): CodexModelSelection | undefined {
    if (value === undefined) return undefined;
    const item = record(value);
    if (Object.keys(item).length !== 2 || !identifier(item.model) || !identifier(item.effort)) throw new Error("CODEX_MODEL_SELECTION_INVALID");
    return { model: item.model, effort: item.effort };
}

export function parseCodexModelPage(value: unknown): { models: CodexModelOption[]; nextCursor: string | null } {
    const page = record(value);
    if (!Array.isArray(page.data) || page.data.length > 100 || !(page.nextCursor === null || (typeof page.nextCursor === "string" && page.nextCursor.length > 0 && page.nextCursor.length <= 1024))) throw new Error("CODEX_MODEL_CATALOG_UNAVAILABLE");
    const models = page.data.filter(value => record(value).hidden !== true).map(value => {
        const item = record(value);
        if (!identifier(item.model) || typeof item.displayName !== "string" || !item.displayName.trim() || item.displayName.length > 200 || !identifier(item.defaultReasoningEffort) || !Array.isArray(item.supportedReasoningEfforts) || item.supportedReasoningEfforts.length > 20) throw new Error("CODEX_MODEL_CATALOG_UNAVAILABLE");
        const efforts = item.supportedReasoningEfforts.map(value => {
            const effort = record(value);
            if (!identifier(effort.reasoningEffort) || typeof effort.description !== "string" || effort.description.length > 2000) throw new Error("CODEX_MODEL_CATALOG_UNAVAILABLE");
            return { reasoningEffort: effort.reasoningEffort, description: effort.description };
        });
        if (!efforts.some(effort => effort.reasoningEffort === item.defaultReasoningEffort) || new Set(efforts.map(effort => effort.reasoningEffort)).size !== efforts.length) throw new Error("CODEX_MODEL_CATALOG_UNAVAILABLE");
        return { model: item.model, displayName: item.displayName, defaultReasoningEffort: item.defaultReasoningEffort, supportedReasoningEfforts: efforts };
    });
    return { models, nextCursor: page.nextCursor as string | null };
}

export function reportedCodexModel(value: unknown, threadId: string): Pick<CodexModelReceipt, "reported" | "source"> {
    const thread = record(record(value).thread);
    if (thread.id !== threadId) return { source: "not_reported", reported: { model: null, effort: null } };
    const model = identifier(thread.model) ? thread.model : null;
    const effort = identifier(thread.reasoningEffort) ? thread.reasoningEffort : null;
    return { source: model || effort ? "thread/read" : "not_reported", reported: { model, effort } };
}
