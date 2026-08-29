import type { AgentConversation, BrainSession, BrainSessionStatus } from "./contracts.js";

export interface BrainSessionStore {
    saveSession(session: BrainSession): Promise<void>;
    getSession(sessionId: string): Promise<BrainSession | undefined>;
    listSessions(scope?: { projectId?: string; canvasId?: string; brainProfileId?: string; conversationId?: string }): Promise<BrainSession[]>;
    updateSession(sessionId: string, patch: Partial<Pick<BrainSession, "providerThreadId" | "permissionGrantId" | "status" | "lastContextReceiptId" | "updatedAt" | "closedAt">>): Promise<BrainSession>;
    saveConversation(conversation: AgentConversation): Promise<void>;
    getConversation(conversationId: string): Promise<AgentConversation | undefined>;
}

export class MemoryBrainSessionStore implements BrainSessionStore {
    private readonly sessions = new Map<string, BrainSession>();
    private readonly conversations = new Map<string, AgentConversation>();

    async saveSession(session: BrainSession) {
        const existing = this.sessions.get(session.id);
        if (existing && sessionScopeKey(existing) !== sessionScopeKey(session)) {
            throw new Error(`Session scope is immutable: ${session.id}`);
        }
        this.sessions.set(session.id, structuredClone(session));
    }

    async getSession(sessionId: string) {
        const session = this.sessions.get(sessionId);
        return session ? structuredClone(session) : undefined;
    }

    async listSessions(scope: { projectId?: string; canvasId?: string; brainProfileId?: string; conversationId?: string } = {}) {
        return [...this.sessions.values()]
            .filter((session) => !scope.projectId || session.projectId === scope.projectId)
            .filter((session) => !scope.canvasId || session.canvasId === scope.canvasId)
            .filter((session) => !scope.brainProfileId || session.brainProfileId === scope.brainProfileId)
            .filter((session) => !scope.conversationId || session.conversationId === scope.conversationId)
            .map((session) => structuredClone(session));
    }

    async updateSession(sessionId: string, patch: Partial<Pick<BrainSession, "providerThreadId" | "permissionGrantId" | "status" | "lastContextReceiptId" | "updatedAt" | "closedAt">>) {
        const current = this.sessions.get(sessionId);
        if (!current) throw new Error(`Unknown brain session: ${sessionId}`);
        const next = { ...current, ...patch };
        assertValidTransition(current.status, next.status);
        this.sessions.set(sessionId, structuredClone(next));
        return structuredClone(next);
    }

    async saveConversation(conversation: AgentConversation) {
        const existing = this.conversations.get(conversation.id);
        if (existing && (existing.projectId !== conversation.projectId || existing.canvasId !== conversation.canvasId)) {
            throw new Error(`Conversation scope is immutable: ${conversation.id}`);
        }
        this.conversations.set(conversation.id, structuredClone(conversation));
    }

    async getConversation(conversationId: string) {
        const conversation = this.conversations.get(conversationId);
        return conversation ? structuredClone(conversation) : undefined;
    }
}

const allowedTransitions: Record<BrainSessionStatus, readonly BrainSessionStatus[]> = {
    creating: ["ready", "failed", "closed"],
    ready: ["running", "closed", "failed", "interrupted"],
    running: ["awaiting_confirmation", "completed", "interrupted", "failed", "closed"],
    awaiting_confirmation: ["running", "completed", "interrupted", "failed", "closed"],
    completed: ["running", "ready", "closed"],
    interrupted: ["running", "ready", "closed", "failed"],
    failed: ["ready", "closed"],
    closed: [],
};

function assertValidTransition(from: BrainSessionStatus, to: BrainSessionStatus) {
    if (from === to) return;
    if (!allowedTransitions[from].includes(to)) throw new Error(`Invalid brain session transition: ${from} -> ${to}`);
}

export function sessionScopeKey(session: Pick<BrainSession, "projectId" | "canvasId" | "brainProfileId">) {
    return `${session.projectId}\u0000${session.canvasId}\u0000${session.brainProfileId}`;
}
