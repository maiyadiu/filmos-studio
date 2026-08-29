export const AGENT_CONTRACT_SCHEMA_VERSION = "1" as const;

export type BrainProvider =
    | "openai.codex"
    | "openai.chatgpt"
    | "openai.gpt"
    | "anthropic.claude"
    | "deepseek"
    | "local"
    | "human"
    | `custom.${string}`;

export type BrainTransport =
    | "codex_app_server"
    | "chatgpt_host_mcp"
    | "model_api"
    | "vendor_cli"
    | "local_model"
    | "human";

export type BrainAuthMode =
    | "chatgpt_managed"
    | "chatgpt_host"
    | "api_key"
    | "vendor_managed"
    | "local"
    | "none";

export type BrainBillingMode = "subscription" | "metered_api" | "local_compute" | "none";
export type BrainInteractionSurface = "native_stream" | "host_handoff" | "human";

/** V1.0 descriptor names retained for stored configuration migration. */
export type AgentHarness = "codex_app_server" | "chatgpt_hosted_app" | "filmos_api_agent" | "claude_code_cli" | "openai_compatible_local" | "human_only";
export type BillingMode = "subscription_quota" | "metered_api" | "local_compute" | "external_host";
export type AuthMode = "chatgpt_account" | "official_cli_account" | "api_key" | "project_grant" | "none";
export type InteractionSurface = "embedded_chat" | "hosted_chat" | "hybrid_control";

export type BrainConnectionStatus = "unknown" | "probing" | "needs_auth" | "ready" | "quota_limited" | "blocked_by_plan" | "unavailable" | "error";
export type BrainAvailability = "enabled" | "disabled" | "blocked_external_account";

export type BrainCapabilities = {
    streamingChat: boolean;
    threadHistory: boolean;
    threadResume: boolean;
    imageInput: boolean;
    automaticVisualContext: boolean;
    mcpTools: boolean;
    read: boolean;
    preview: boolean;
    applyAfterHumanConfirmation: boolean;
    hostedProposalReturn: boolean;
    cancelTurn: boolean;
};

export type AgentToolSurfaceId = "canvas_legacy" | "workbench_operator" | "chatgpt_hosted" | "runtime_admin";

export interface BrainProfile {
    id: string;
    displayName: string;
    provider: BrainProvider;
    transport: BrainTransport;
    authMode: BrainAuthMode;
    billingMode: BrainBillingMode;
    interactionSurface: BrainInteractionSurface;
    toolSurface: AgentToolSurfaceId;
    requiresApiKey: boolean;
    mayCreateSeparateCharges: boolean;
    availability: BrainAvailability;
    capabilities: BrainCapabilities;
    version?: string;
    legacy?: {
        harness?: AgentHarness;
        billingMode?: BillingMode;
        authMode?: AuthMode;
        interactionSurface?: InteractionSurface;
    };
}

export interface BrainRuntimeStatus {
    profileId: string;
    status: BrainConnectionStatus;
    statusReason?: string;
    checkedAt: string;
    accountLabel?: string;
    quota?: {
        remainingPercent?: number;
        resetsAt?: string;
    };
    version?: string;
}

/** V1.0 connection descriptor retained as a lossless view of a profile probe. */
export interface AgentConnectionDescriptor {
    id: string;
    brainProvider: BrainProvider;
    displayBrain: string;
    harness: AgentHarness;
    authMode: AuthMode;
    billingMode: BillingMode;
    interactionSurface: InteractionSurface;
    toolSurface: AgentToolSurfaceId;
    status: BrainConnectionStatus;
    statusReason?: string;
    requiresApiKey: boolean;
    mayCreateSeparateCharges: boolean;
    capabilities: BrainCapabilities;
    version?: string;
}

export type BrainSessionStatus = "creating" | "ready" | "running" | "awaiting_confirmation" | "completed" | "interrupted" | "failed" | "closed";

export interface BrainSession {
    id: string;
    conversationId: string;
    brainProfileId: string;
    connectionId: string;
    projectId: string;
    domainProjectId?: string;
    canvasId: string;
    contentUnitId?: string;
    sceneId?: string;
    directorUnitId?: string;
    shotId?: string;
    providerThreadId?: string;
    permissionGrantId: string;
    status: BrainSessionStatus;
    lastContextReceiptId?: string;
    createdAt: string;
    updatedAt: string;
    closedAt?: string;
}

/** V1.0 name remains import-compatible. */
export type AgentSession = BrainSession;

export interface AgentConversation {
    id: string;
    projectId: string;
    canvasId: string;
    title?: string;
    activeSessionId?: string;
    sessionIds: string[];
    createdAt: string;
    updatedAt: string;
}

export interface CreateBrainSessionInput {
    conversationId: string;
    brainProfileId: string;
    projectId: string;
    domainProjectId?: string;
    canvasId: string;
    contentUnitId?: string;
    sceneId?: string;
    directorUnitId?: string;
    shotId?: string;
    actorId: string;
}

export interface ResumeBrainSessionInput {
    sessionId: string;
    providerThreadId?: string;
}

export type EntitySummary = {
    id: string;
    type: string;
    title?: string;
    status?: string;
    version?: number;
    contentHash?: string;
    metadata?: Record<string, unknown>;
};

export type AgentContextReceipt = {
    receiptId: string;
    projectId: string;
    contentUnitId?: string;
    sceneId?: string;
    directorUnitId?: string;
    shotId?: string;
    canvasId: string;
    selectedNodeIds: string[];
    visibleNodeIds: string[];
    assetVersionIds: string[];
    canvasRevision: number;
    canvasStateHash: string;
    filmExpectedVersion?: number;
    filmContentHash?: string;
    createdAt: string;
    expiresAt: string;
};

export interface AgentContextPackV1 {
    schemaVersion: "1";
    contextReceiptId: string;
    capturedAt: string;
    route: {
        workspace?: string;
        projectId: string;
        contentUnitId?: string;
        unitId?: string;
        sceneId?: string;
        directorUnitId?: string;
        shotId?: string;
        activePanel?: string;
    };
    project: { id: string; title?: string; status?: string; domainProjectId?: string };
    currentUnit?: EntitySummary;
    currentScene?: EntitySummary;
    currentDirectorUnit?: EntitySummary;
    currentShot?: EntitySummary;
    canvas: {
        id: string;
        revision: number;
        stateHash: string;
        nodeCount: number;
        connectionCount: number;
        selectedNodeIds: string[];
        visibleNodeIds: string[];
        selectedSummaries: EntitySummary[];
    };
    assets: EntitySummary[];
    activeTasks: EntitySummary[];
    blockers: string[];
    visualContext?: {
        viewportCaptureId?: string;
        selectedMediaIds: string[];
        visualHash?: string;
    };
    permissions: {
        readableScopes: string[];
        previewableScopes: string[];
        applyRequiresConfirmation: boolean;
    };
    receipts: {
        filmVersion?: number;
        contentHash?: string;
        canvasRevision: number;
        canvasStateHash: string;
    };
}

export type NormalizedBrainEvent =
    | { type: "session.status"; sessionId: string; status: BrainSessionStatus; at: string; reason?: string }
    | { type: "turn.started"; sessionId: string; turnId: string; at: string }
    | { type: "message.delta"; sessionId: string; turnId: string; delta: string; at: string }
    | { type: "message.completed"; sessionId: string; turnId: string; text: string; at: string }
    | { type: "tool.proposed"; sessionId: string; turnId: string; request: AgentToolRequest; at: string }
    | { type: "confirmation.required"; sessionId: string; turnId: string; confirmation: AgentConfirmation; at: string }
    | { type: "tool.completed"; sessionId: string; turnId: string; result: AgentToolResult; at: string }
    | { type: "turn.failed"; sessionId: string; turnId: string; code: string; message: string; at: string }
    | { type: "turn.completed"; sessionId: string; turnId: string; at: string };

export type AgentToolRisk = "read" | "draft" | "write" | "destructive" | "paid" | "approval" | "publish";

export interface AgentToolManifest {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    risk: AgentToolRisk;
    surfaces: AgentToolSurfaceId[];
    provider: "canvas" | "host_project" | "film_core" | "director" | "prompt" | "generation" | "chatgpt_handoff" | "runtime";
    requiresFreshContext: boolean;
    mayCreateCharges: boolean;
}

export interface AgentToolRequest {
    requestId: string;
    sessionId: string;
    turnId: string;
    connectionId: string;
    projectId: string;
    toolName: string;
    input: Record<string, unknown>;
    contextReceiptId: string;
    proposedAt: string;
}

export interface AgentToolResult {
    requestId: string;
    sessionId: string;
    toolName: string;
    outcome: "succeeded" | "rejected" | "failed" | "stale";
    output?: unknown;
    errorCode?: string;
    errorMessage?: string;
    postcondition?: Record<string, unknown>;
    completedAt: string;
}

export type AgentConfirmationStatus = "pending" | "approved" | "rejected" | "expired" | "consumed" | "cancelled";

export interface AgentConfirmation {
    id: string;
    sessionId: string;
    turnId: string;
    requestId: string;
    toolName: string;
    risk: Exclude<AgentToolRisk, "read" | "draft">;
    title: string;
    summary: string;
    impact: string[];
    costPreview?: { currency?: string; estimatedAmount?: number; unit?: string; note?: string };
    contextReceiptId: string;
    status: AgentConfirmationStatus;
    createdAt: string;
    expiresAt: string;
    decidedAt?: string;
    decidedBy?: string;
}

export interface AgentPermissionGrant {
    id: string;
    sessionId: string;
    connectionId: string;
    actorId: string;
    projectId: string;
    domainProjectId?: string;
    toolSurface: AgentToolSurfaceId;
    allowedTools: string[];
    issuedAt: string;
    expiresAt: string;
    nonce: string;
}

export interface ChatGPTHostSession {
    id: string;
    brainSessionId: string;
    projectId: string;
    projectGrantId: string;
    connectionId: string;
    handoffId?: string;
    externalConversationUrl?: string;
    status: "preparing" | "waiting_for_host" | "observed" | "proposal_received" | "closed" | "blocked_external_account";
    createdAt: string;
    updatedAt: string;
}

export interface HostObservation {
    id: string;
    hostSessionId: string;
    projectId: string;
    kind: "context_read" | "tool_read" | "proposal_submitted" | "host_connected" | "host_disconnected";
    observedAt: string;
    receiptHash?: string;
    metadata?: Record<string, unknown>;
}

export interface ProposalHandoffMetadata {
    proposalId: string;
    hostSessionId: string;
    projectId: string;
    contextReceiptId: string;
    proposedBy: string;
    proposalType: string;
    payloadHash: string;
    signature: string;
    createdAt: string;
    expiresAt: string;
}

export type AgentEventSink = (event: NormalizedBrainEvent) => void | Promise<void>;

export interface AgentTurnInput {
    session: BrainSession;
    turnId: string;
    prompt: string;
    context: AgentContextPackV1;
    localImagePaths?: string[];
}

export interface AgentTurnResult {
    sessionId: string;
    turnId: string;
    providerThreadId?: string;
    text?: string;
    status: "completed" | "interrupted" | "failed" | "handoff_pending";
}

export interface AgentRuntimeAdapter {
    readonly connectionId: string;
    readonly profileId: string;
    probe(): Promise<BrainRuntimeStatus>;
    createSession(input: CreateBrainSessionInput, grant: AgentPermissionGrant): Promise<Partial<BrainSession>>;
    resumeSession(input: ResumeBrainSessionInput): Promise<Partial<BrainSession>>;
    sendTurn(input: AgentTurnInput, sink: AgentEventSink): Promise<AgentTurnResult>;
    cancelTurn(sessionId: string): Promise<void>;
    closeSession(sessionId: string): Promise<void>;
}

export const BUILTIN_BRAIN_PROFILE_IDS = {
    codexSubscription: "codex.subscription",
    chatgptHosted: "chatgpt.subscription.host",
    openaiApi: "openai.api",
    anthropicApi: "anthropic.api",
    deepseekApi: "deepseek.api",
    localModel: "local.model",
    humanOnly: "human.only",
} as const;
