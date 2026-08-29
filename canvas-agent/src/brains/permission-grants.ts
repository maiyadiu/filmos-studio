import crypto from "node:crypto";

import type { AgentPermissionGrant, AgentToolSurfaceId } from "./contracts.js";

export type IssuePermissionGrantInput = {
    sessionId: string;
    connectionId: string;
    actorId: string;
    projectId: string;
    domainProjectId?: string;
    toolSurface: AgentToolSurfaceId;
    allowedTools: string[];
    ttlMs?: number;
};

export class AgentPermissionGrantStore {
    private readonly grants = new Map<string, AgentPermissionGrant>();

    issue(input: IssuePermissionGrantInput) {
        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + (input.ttlMs ?? 15 * 60_000));
        const grant: AgentPermissionGrant = {
            id: crypto.randomUUID(),
            sessionId: required(input.sessionId, "sessionId"),
            connectionId: required(input.connectionId, "connectionId"),
            actorId: required(input.actorId, "actorId"),
            projectId: required(input.projectId, "projectId"),
            ...(input.domainProjectId ? { domainProjectId: input.domainProjectId } : {}),
            toolSurface: input.toolSurface,
            allowedTools: [...new Set(input.allowedTools)].sort(),
            issuedAt: issuedAt.toISOString(),
            expiresAt: expiresAt.toISOString(),
            nonce: crypto.randomBytes(18).toString("base64url"),
        };
        this.grants.set(grant.id, grant);
        return structuredClone(grant);
    }

    get(grantId: string) {
        const grant = this.grants.get(grantId);
        return grant ? structuredClone(grant) : undefined;
    }

    validate(grantId: string, input: { sessionId: string; connectionId: string; projectId: string; nonce?: string; toolName?: string; now?: Date }) {
        const grant = this.grants.get(grantId);
        if (!grant) throw new Error("AGENT_GRANT_NOT_FOUND");
        if (grant.sessionId !== input.sessionId || grant.connectionId !== input.connectionId || grant.projectId !== input.projectId) {
            throw new Error("AGENT_GRANT_SCOPE_MISMATCH");
        }
        if (input.nonce !== undefined && grant.nonce !== input.nonce) throw new Error("AGENT_GRANT_NONCE_MISMATCH");
        if (Date.parse(grant.expiresAt) <= (input.now ?? new Date()).getTime()) {
            this.grants.delete(grant.id);
            throw new Error("AGENT_GRANT_EXPIRED");
        }
        if (input.toolName && !grant.allowedTools.includes(input.toolName)) throw new Error("AGENT_TOOL_NOT_GRANTED");
        return structuredClone(grant);
    }

    revoke(grantId: string) {
        return this.grants.delete(grantId);
    }

    revokeSession(sessionId: string) {
        for (const [grantId, grant] of this.grants) if (grant.sessionId === sessionId) this.grants.delete(grantId);
    }
}

function required(value: string, name: string) {
    if (!value.trim()) throw new Error(`Agent permission grant ${name} is required`);
    return value;
}
