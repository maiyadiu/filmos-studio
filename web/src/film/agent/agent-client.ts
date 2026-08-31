import type { LocalRuntimeSessionClient } from "@/services/local-runtime-session";
import { getLocalRuntimeSessionClient } from "@/stores/use-local-runtime-store";

export type BrainSessionView = {
    id: string;
    conversationId: string;
    brainProfileId: string;
    projectId: string;
    canvasId: string;
    providerThreadId?: string;
    status: string;
    updatedAt: string;
};

export type AgentHistoryMessageView = {
    id: string;
    role: "user" | "assistant" | "tool" | "system" | "error";
    text: string;
    title?: string;
    detail?: unknown;
    streamId?: string;
    at?: string;
    source: "provider" | "handoff_timeline" | "local_timeline";
};

export type AgentHistoryStatus = {
    source: "provider" | "handoff_timeline" | "not_persisted";
    complete: boolean;
    limitation?: string;
};

export type AgentRuntimeDiagnostics = {
    composition: { enabledProfileIds: string[]; adapterProfileIds: string[] };
    counters: Record<string, number>;
    featureFlags: Record<string, boolean>;
    activation: { profileId: string; featureFlagCount: number; featureFlagsHash: string; consistent: boolean };
};

type AgentRuntimeTransport = Pick<LocalRuntimeSessionClient, "request">;

export class AgentSessionClient {
    constructor(private readonly runtime: AgentRuntimeTransport = getLocalRuntimeSessionClient()) {}

    listConnections(signal?: AbortSignal) {
        return this.json<{ connections: unknown[]; toolManifest: unknown[] }>("/agent/connections", { method: "GET", signal });
    }

    diagnostics(signal?: AbortSignal) {
        return this.json<AgentRuntimeDiagnostics>("/agent/diagnostics", { method: "GET", signal });
    }

    listSessions(scope: { projectId?: string; brainProfileId?: string } = {}, signal?: AbortSignal) {
        const query = new URLSearchParams();
        // Runtime request targets are signed in canonical key order. Keep the
        // query stable before the browser signs it so restart recovery can
        // restore persisted Generic Agent sessions instead of receiving 400.
        if (scope.brainProfileId) query.set("brainProfileId", scope.brainProfileId);
        if (scope.projectId) query.set("projectId", scope.projectId);
        return this.json<{ sessions: BrainSessionView[] }>(`/agent/sessions${query.size ? `?${query}` : ""}`, { method: "GET", signal });
    }

    createSession(input: { conversationId: string; brainProfileId: string }, signal?: AbortSignal) {
        return this.post<{ session: BrainSessionView; contextReceiptId?: string }>("/agent/sessions", input, signal);
    }

    resumeSession(sessionId: string, signal?: AbortSignal) {
        return this.post<{ session: BrainSessionView; contextReceiptId?: string; history: AgentHistoryMessageView[]; historyStatus: AgentHistoryStatus }>(`/agent/sessions/${segment(sessionId)}/resume`, {}, signal);
    }

    sendTurn(sessionId: string, input: { prompt: string; turnId?: string; attachments?: Array<{ name?: string; type?: string; dataUrl?: string }>; skills?: Array<{ skillId?: string; name: string; description?: string; instruction: string }> }, signal?: AbortSignal) {
        return this.post<{ session: BrainSessionView; contextReceiptId: string; result: unknown }>(`/agent/sessions/${segment(sessionId)}/turns`, input, signal);
    }

    requestTool(sessionId: string, input: { turnId: string; toolName: string; input?: Record<string, unknown>; ordinaryConfirmationEnabled?: boolean }, signal?: AbortSignal) {
        return this.post<{ outcome: { status: "completed"; request: Record<string, unknown>; result: { output?: unknown; outcome: string } } }>(`/agent/sessions/${segment(sessionId)}/tools`, input, signal);
    }

    proposeTool(sessionId: string, input: { turnId: string; toolName: string; input?: Record<string, unknown>; ordinaryConfirmationEnabled?: boolean }, signal?: AbortSignal) {
        return this.post<{ outcome: { status: "confirmation_required" | "completed"; request: Record<string, unknown>; confirmation?: { id: string; sessionId: string; title: string; summary: string; impact: string[]; expiresAt: string }; result?: { output?: unknown; outcome: string } } }>(`/agent/sessions/${segment(sessionId)}/tool-proposals`, input, signal);
    }

    decideConfirmation(confirmationId: string, input: { sessionId: string; approved: boolean }, signal?: AbortSignal) {
        return this.post<{ outcome: unknown }>(`/agent/confirmations/${segment(confirmationId)}/decision`, input, signal);
    }

    cancelTurn(sessionId: string, turnId: string, signal?: AbortSignal) {
        return this.post<{ sessionId: string; turnId: string }>(`/agent/sessions/${segment(sessionId)}/turns/${segment(turnId)}/cancel`, {}, signal);
    }

    closeSession(sessionId: string, signal?: AbortSignal) {
        return this.post<{ session: BrainSessionView }>(`/agent/sessions/${segment(sessionId)}/close`, {}, signal);
    }

    private post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal) {
        return this.json<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    }

    private async json<T>(path: string, init: RequestInit) {
        const response = await this.runtime.request(path, init);
        const value = await response.json().catch(() => ({})) as { ok?: boolean; code?: string; message?: string } & T;
        if (!response.ok || value.ok !== true) throw new Error(value.code || value.message || `AGENT_RUNTIME_REQUEST_FAILED:${response.status}`);
        return value;
    }
}

function segment(value: string) {
    if (!value.trim()) throw new Error("Agent session identifier is required");
    return encodeURIComponent(value);
}
