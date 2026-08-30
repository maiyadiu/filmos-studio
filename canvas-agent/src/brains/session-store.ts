import type { AgentConversation, BrainSession, BrainSessionStatus } from "./contracts.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface BrainSessionStore {
    saveSession(session: BrainSession): Promise<void>;
    getSession(sessionId: string): Promise<BrainSession | undefined>;
    listSessions(scope?: { projectId?: string; canvasId?: string; brainProfileId?: string; conversationId?: string }): Promise<BrainSession[]>;
    updateSession(sessionId: string, patch: Partial<Pick<BrainSession, "providerThreadId" | "permissionGrantId" | "status" | "lastContextReceiptId" | "hostHandoff" | "hostHandoffTimeline" | "updatedAt" | "closedAt">>): Promise<BrainSession>;
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

    async updateSession(sessionId: string, patch: Partial<Pick<BrainSession, "providerThreadId" | "permissionGrantId" | "status" | "lastContextReceiptId" | "hostHandoff" | "hostHandoffTimeline" | "updatedAt" | "closedAt">>) {
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

    exportSnapshot() {
        return {
            sessions: [...this.sessions.values()].map((session) => structuredClone(session)),
            conversations: [...this.conversations.values()].map((conversation) => structuredClone(conversation)),
        };
    }

    importSnapshot(snapshot: { sessions: readonly BrainSession[]; conversations: readonly AgentConversation[] }) {
        for (const session of snapshot.sessions) {
            const existing = this.sessions.get(session.id);
            if (existing && sessionScopeKey(existing) !== sessionScopeKey(session)) throw new Error(`Session scope is immutable: ${session.id}`);
            this.sessions.set(session.id, structuredClone(session));
        }
        for (const conversation of snapshot.conversations) {
            const existing = this.conversations.get(conversation.id);
            if (existing && (existing.projectId !== conversation.projectId || existing.canvasId !== conversation.canvasId)) throw new Error(`Conversation scope is immutable: ${conversation.id}`);
            this.conversations.set(conversation.id, structuredClone(conversation));
        }
    }
}

type PersistedBrainSessionsV1 = {
    schemaVersion: "1";
    sessions: BrainSession[];
    conversations: AgentConversation[];
    migrations: {
        legacyActiveThreadV1: Record<string, { sessionId: string; providerThreadId: string }>;
    };
};

export class JsonBrainSessionStore implements BrainSessionStore {
    private readonly memory = new MemoryBrainSessionStore();
    private migrations: PersistedBrainSessionsV1["migrations"] = { legacyActiveThreadV1: {} };

    constructor(
        private readonly filePath: string,
        legacyCanvases: Record<string, { activeThreadId?: string }> = {},
    ) {
        this.load();
        this.migrateLegacyActiveThreads(legacyCanvases);
    }

    async saveSession(session: BrainSession) {
        await this.memory.saveSession(session);
        this.persist();
    }

    async getSession(sessionId: string) {
        return await this.memory.getSession(sessionId);
    }

    async listSessions(scope: { projectId?: string; canvasId?: string; brainProfileId?: string; conversationId?: string } = {}) {
        return await this.memory.listSessions(scope);
    }

    async updateSession(sessionId: string, patch: Partial<Pick<BrainSession, "providerThreadId" | "permissionGrantId" | "status" | "lastContextReceiptId" | "hostHandoff" | "hostHandoffTimeline" | "updatedAt" | "closedAt">>) {
        const session = await this.memory.updateSession(sessionId, patch);
        this.persist();
        return session;
    }

    async saveConversation(conversation: AgentConversation) {
        await this.memory.saveConversation(conversation);
        this.persist();
    }

    async getConversation(conversationId: string) {
        return await this.memory.getConversation(conversationId);
    }

    migrationSnapshot() {
        return structuredClone(this.migrations);
    }

    private load() {
        let data: PersistedBrainSessionsV1;
        try {
            data = parsePersistedStore(fs.readFileSync(this.filePath, "utf8"));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
        this.migrations = structuredClone(data.migrations);
        const normalizedSessions = data.sessions.map(recoverInterruptedSession);
        this.memory.importSnapshot({ sessions: normalizedSessions, conversations: data.conversations });
        if (normalizedSessions.some((session, index) => session.status !== data.sessions[index]?.status)) this.persist();
    }

    private migrateLegacyActiveThreads(canvases: Record<string, { activeThreadId?: string }>) {
        let changed = false;
        const now = new Date().toISOString();
        const snapshot = this.memory.exportSnapshot();
        for (const [canvasId, workspace] of Object.entries(canvases)) {
            const providerThreadId = typeof workspace.activeThreadId === "string" ? workspace.activeThreadId.trim() : "";
            if (!providerThreadId) continue;
            const key = `${canvasId}\u0000${providerThreadId}`;
            if (this.migrations.legacyActiveThreadV1[key]) continue;
            const suffix = crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
            const sessionId = `legacy-codex-${suffix}`;
            const conversationId = `legacy-codex-conversation-${suffix}`;
            snapshot.sessions.push({
                id: sessionId,
                conversationId,
                brainProfileId: "codex.subscription",
                connectionId: "codex.subscription",
                projectId: canvasId,
                canvasId,
                providerThreadId,
                permissionGrantId: "legacy-pending-resume",
                status: "interrupted",
                createdAt: now,
                updatedAt: now,
            });
            snapshot.conversations.push({
                id: conversationId,
                projectId: canvasId,
                canvasId,
                activeSessionId: sessionId,
                sessionIds: [sessionId],
                createdAt: now,
                updatedAt: now,
            });
            this.migrations.legacyActiveThreadV1[key] = { sessionId, providerThreadId };
            changed = true;
        }
        if (changed) {
            this.memory.importSnapshot(snapshot);
            this.persist();
        }
    }

    private persist() {
        const directory = path.dirname(this.filePath);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
        const snapshot = this.memory.exportSnapshot();
        const sessions = snapshot.sessions;
        const conversations = this.memoryConversations(snapshot.conversations, sessions);
        const payload: PersistedBrainSessionsV1 = { schemaVersion: "1", sessions, conversations, migrations: this.migrations };
        fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, this.filePath);
        fs.chmodSync(this.filePath, 0o600);
    }

    private memoryConversations(current: AgentConversation[], sessions: BrainSession[]) {
        const values = current.map((conversation) => structuredClone(conversation));
        const known = new Set(values.map((conversation) => conversation.id));
        for (const session of sessions) if (!known.has(session.conversationId)) {
            values.push({ id: session.conversationId, projectId: session.projectId, canvasId: session.canvasId, activeSessionId: session.id, sessionIds: [session.id], createdAt: session.createdAt, updatedAt: session.updatedAt });
            known.add(session.conversationId);
        }
        return values;
    }
}

function parsePersistedStore(text: string): PersistedBrainSessionsV1 {
    const value = JSON.parse(text) as Partial<PersistedBrainSessionsV1>;
    if (value.schemaVersion !== "1" || !Array.isArray(value.sessions) || !Array.isArray(value.conversations) || !value.migrations || typeof value.migrations.legacyActiveThreadV1 !== "object") {
        throw new Error("Brain Session store is invalid");
    }
    return value as PersistedBrainSessionsV1;
}

function recoverInterruptedSession(session: BrainSession): BrainSession {
    if (!["creating", "running", "awaiting_confirmation"].includes(session.status)) return session;
    return { ...session, status: "interrupted", updatedAt: new Date().toISOString() };
}

const allowedTransitions: Record<BrainSessionStatus, readonly BrainSessionStatus[]> = {
    creating: ["ready", "failed", "closed"],
    ready: ["running", "waiting_host", "closed", "failed", "interrupted"],
    running: ["awaiting_confirmation", "waiting_host", "completed", "interrupted", "failed", "closed"],
    awaiting_confirmation: ["running", "waiting_host", "completed", "interrupted", "failed", "closed"],
    waiting_host: ["running", "ready", "interrupted", "closed"],
    completed: ["running", "ready", "waiting_host", "closed"],
    interrupted: ["running", "ready", "waiting_host", "closed", "failed"],
    failed: ["ready", "waiting_host", "closed"],
    closed: [],
};

function assertValidTransition(from: BrainSessionStatus, to: BrainSessionStatus) {
    if (from === to) return;
    if (!allowedTransitions[from].includes(to)) throw new Error(`Invalid brain session transition: ${from} -> ${to}`);
}

export function sessionScopeKey(session: Pick<BrainSession, "projectId" | "canvasId" | "brainProfileId">) {
    return `${session.projectId}\u0000${session.canvasId}\u0000${session.brainProfileId}`;
}
