export type UserSelectableBrainProfileId =
    | "codex.subscription"
    | "chatgpt.subscription.host"
    | "openai.api"
    | "anthropic.api"
    | "deepseek.api"
    | "local.model";

export type MutableAuthorityRecord = {
    schemaVersion: number;
    entityVersion: number;
    contentHash: string;
    createdAt: string;
    updatedAt: string;
};

export type ImmutableBusinessSnapshot = {
    schemaVersion: number;
    contentHash: string;
    createdAt: string;
};

export type EphemeralCacheSnapshot = {
    schemaVersion: number;
    snapshotId: string;
    contentHash: string;
    observedAt: string;
    expiresAt?: string;
};

export type BrainProfileBinding = MutableAuthorityRecord & {
    schemaVersion: 1;
    profileId: UserSelectableBrainProfileId;
    enabled: boolean;
    channelId?: string;
    modelId?: string;
    requiredCapabilities: Array<"text" | "tool_calling" | "structured_output" | "vision" | "attachments">;
    transport: "codex_app_server" | "chatgpt_host_mcp" | "model_api" | "local_model";
    authMode: "chatgpt_managed" | "chatgpt_host" | "api_key" | "local";
    billingMode: "subscription" | "metered_api" | "local_compute";
    interactionSurface: "native_stream" | "host_handoff";
    allowApiFallback: false;
};

export type ProjectBrainPolicy = MutableAuthorityRecord & {
    schemaVersion: 1;
    projectId: string;
    defaultProfileId?: UserSelectableBrainProfileId;
    allowedProfileIds: UserSelectableBrainProfileId[];
    profileOverrides: Partial<Record<UserSelectableBrainProfileId, { channelId?: string; modelId?: string }>>;
};

export type PseudonymousBindingRef = string;

export type GenerationTaskKind =
    | "text_to_image" | "reference_to_image" | "image_to_image" | "image_edit" | "inpaint" | "outpaint"
    | "text_to_video" | "image_to_video" | "first_frame_video" | "first_last_frame_video" | "video_extend"
    | "audio" | "workflow";

export type GenerationEngineDescriptor = {
    engineId: string;
    displayName: string;
    transport: "cli" | "project_cli" | "workflow_api" | "bridge" | "manual";
    capabilities: Array<"image" | "video" | "audio" | "workflow">;
    catalogSourceCapabilities: Array<"runtime_discovery" | "remote_catalog" | "verified_static_version_bound" | "manual_unverified">;
    externalProjectRequired: boolean;
    supportsCostEstimate: boolean;
    supportsCancellation: boolean;
    supportsResume: boolean;
};

export type GenerationEngineConnection = MutableAuthorityRecord & {
    schemaVersion: 1;
    connectionId: string;
    engineId: string;
    enabled: boolean;
    authScope: "account" | "local_instance" | "anonymous" | "manual";
    status: "not_installed" | "not_configured" | "auth_required" | "ready" | "degraded" | "offline" | "blocked";
    accountBindingRef?: PseudonymousBindingRef;
    connectionInstanceRef: PseudonymousBindingRef;
    region?: string;
    endpointProfileId?: string;
    lastCheckedAt?: string;
    lastError?: string;
};

export type CatalogEvidence =
    | { source: "runtime_discovery"; runtimeVersion: string; sourceLocatorId: string; observedAt: string }
    | { source: "remote_catalog"; sourceLocatorId: string; observedAt: string; etag?: string }
    | { source: "verified_static_version_bound"; adapterVersion: string; supportedCliVersionRange: string; sourceEvidence: string[]; manifestHash: string; verifiedAt: string; expiresAt: string }
    | { source: "manual_unverified"; enteredByActorRef: string; observedAt: string };

export type DescriptorAvailability = "available" | "unavailable" | "deprecated" | "requires_upgrade" | "unknown";
export type DescriptorCapability = "image" | "video" | "audio" | "workflow";

export type GenerationModelDescriptor = {
    schemaVersion: 1;
    engineId: string;
    connectionId: string;
    modelId: string;
    providerModelId: string;
    displayName: string;
    upstreamVendor?: string;
    modelFamily?: string;
    modelVersion?: string;
    capability: DescriptorCapability;
    operations: GenerationTaskKind[];
    parameterSchema: Record<string, unknown>;
    uiSchema?: Record<string, unknown>;
    constraints: {
        supportedAspectRatios?: string[];
        supportedNativeSizes?: Array<{ width: number; height: number; label?: string }>;
        supportedResolutionTiers?: string[];
        supportedDurationsSeconds?: number[];
        supportedFps?: number[];
        minReferences?: number;
        maxReferences?: number;
        supportsMask?: boolean;
        supportsNegativePrompt?: boolean;
        supportsFirstFrame?: boolean;
        supportsLastFrame?: boolean;
        supportsSeed?: boolean;
    };
    billing: { mode: "credits" | "per_request" | "per_image" | "per_second" | "token" | "unknown"; estimateAvailable: boolean; currencyOrUnit?: string };
    availability: DescriptorAvailability;
    descriptorHash: string;
    parameterSchemaHash: string;
};

export type GenerationWorkflowDescriptor = {
    schemaVersion: 1;
    engineId: string;
    connectionId: string;
    workflowId: string;
    displayName: string;
    version?: string;
    capability: DescriptorCapability;
    operations: string[];
    inputSchema: Record<string, unknown>;
    uiSchema?: Record<string, unknown>;
    exposedModelIds?: string[];
    descriptorHash: string;
    inputSchemaHash: string;
};

export type GenerationSkillDescriptor = {
    schemaVersion: 1;
    engineId: string;
    connectionId: string;
    skillId: string;
    displayName: string;
    version?: string;
    operations: string[];
    inputSchema?: Record<string, unknown>;
    descriptorHash: string;
};

export type GenerationCatalogSnapshot = EphemeralCacheSnapshot & {
    schemaVersion: 1;
    engineId: string;
    connectionId: string;
    authScope: string;
    accountBindingRef?: PseudonymousBindingRef;
    connectionInstanceRef: PseudonymousBindingRef;
    catalogRevision: string;
    catalogValidUntil: string;
    evidence: CatalogEvidence;
    models: GenerationModelDescriptor[];
    workflows: GenerationWorkflowDescriptor[];
    skills: GenerationSkillDescriptor[];
};

export type SelectedGenerationDescriptor =
    | { descriptorKind: "model"; descriptorId: string; descriptorHash: string; descriptor: GenerationModelDescriptor }
    | { descriptorKind: "workflow"; descriptorId: string; descriptorHash: string; descriptor: GenerationWorkflowDescriptor }
    | { descriptorKind: "skill"; descriptorId: string; descriptorHash: string; descriptor: GenerationSkillDescriptor };

export type SelectedGenerationDescriptorRef = Omit<SelectedGenerationDescriptor, "descriptor">;
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type ResolvedDescriptorPayload =
    | { storage: "inline"; selectedDescriptors: NonEmptyReadonlyArray<SelectedGenerationDescriptor> }
    | { storage: "project_content_addressed_blob"; descriptorBlobId: string; descriptorBlobContentHash: string; mediaType: "application/vnd.filmos.selected-generation-descriptors+json"; selectedDescriptorRefs: NonEmptyReadonlyArray<SelectedGenerationDescriptorRef> };

export type ResolvedGenerationDescriptorReceipt = ImmutableBusinessSnapshot & {
    schemaVersion: 1;
    descriptorReceiptId: string;
    engineId: string;
    connectionId: string;
    accountBindingRef?: PseudonymousBindingRef;
    connectionInstanceRef: PseudonymousBindingRef;
    payload: ResolvedDescriptorPayload;
    catalogSnapshotId: string;
    catalogSnapshotContentHash: string;
    catalogRevision: string;
    catalogValidUntil: string;
    catalogEvidence: CatalogEvidence;
    descriptorSemanticHash: string;
};

export type CatalogValidationReceipt = ImmutableBusinessSnapshot & {
    schemaVersion: 1;
    catalogValidationReceiptId: string;
    descriptorReceiptId: string;
    descriptorReceiptContentHash: string;
    descriptorSemanticHash: string;
    routeSnapshotId: string;
    routeSnapshotContentHash: string;
    routeContentHash: string;
    engineId: string;
    connectionId: string;
    accountBindingRef?: PseudonymousBindingRef;
    connectionInstanceRef: PseudonymousBindingRef;
    catalogSnapshotId: string;
    catalogSnapshotContentHash: string;
    catalogRevision: string;
    catalogValidUntil: string;
    selectedDescriptorRefs: NonEmptyReadonlyArray<SelectedGenerationDescriptorRef>;
    validationMode: "runtime_revalidation" | "remote_catalog_revalidation" | "verified_static_version_check";
    validatedAt: string;
    submitNotAfter: string;
    result: "valid";
    catalogValidationSemanticHash: string;
};

export type GenerationReferenceRole = "subject_identity" | "costume" | "scene_layout" | "architecture" | "style" | "composition" | "first_frame" | "last_frame" | "mask" | "generic_reference";
export type GenerationReferenceBinding = {
    bindingId: string;
    role: GenerationReferenceRole;
    assetId: string;
    assetVersionId: string;
    assetVersionContentHash: string;
    mediaType: string;
    ordinal: number;
};

export type GenerationRouteDraft = {
    schemaVersion: 1;
    entityVersion: number;
    contentHash: string;
    capability: DescriptorCapability;
    engineId: string;
    connectionId: string;
    taskKind: GenerationTaskKind;
    modelId?: string;
    workflowId?: string;
    skillId?: string;
    parameters: Record<string, unknown>;
    references: GenerationReferenceBinding[];
    promptDraftId: string;
    selectionSource: "explicit_task" | "node_override" | "project_default" | "global_default";
    createdAt: string;
    updatedAt: string;
};

export type GenerationDefaultRoute = {
    engineId: string;
    connectionId: string;
    modelId?: string;
    workflowId?: string;
    skillId?: string;
};

export type GenerationDefaultPolicy = Partial<Record<GenerationTaskKind, GenerationDefaultRoute>>;

export type ProjectGenerationPolicy = MutableAuthorityRecord & {
    schemaVersion: 1;
    projectId: string;
    allowedEngineIds: string[];
    defaultRoutes: GenerationDefaultPolicy;
    externalProjectBindings: Record<string, {
        connectionId: string;
        externalProjectId: string;
        bindingVersion: number;
    }>;
    uploadPolicy: {
        allowProviderUpload: boolean;
        requirePerSubmitPreview: boolean;
    };
};

export type ProjectGenerationTaskLock = {
    engineId: string;
    connectionId?: string;
    modelId?: string;
    providerModelId?: string;
    modelVersion?: string;
    modelDescriptorHash?: string;
    workflowId?: string;
    workflowVersion?: string;
    workflowDescriptorHash?: string;
    skillId?: string;
    skillVersion?: string;
    skillDescriptorHash?: string;
    catalogRevision?: string;
    parameterPresetId?: string;
    enforcement: "strict" | "warn";
};

export type ProjectGenerationLock = MutableAuthorityRecord & {
    schemaVersion: 1;
    projectId: string;
    taskLocks: Partial<Record<GenerationTaskKind, ProjectGenerationTaskLock>>;
};

export type PromptIntent = {
    subject: string[]; identityLocks: string[]; action: string[]; environment: string[];
    sceneLayout: string[]; camera: string[]; lens: string[]; composition: string[];
    lighting: string[]; color: string[]; continuity: string[]; negativeConstraints: string[];
    deliveryRequirements: string[];
};

export type CompiledPromptReceipt = ImmutableBusinessSnapshot & {
    schemaVersion: 1;
    compiledPromptReceiptId: string;
    text: string;
    negativeText?: string;
    referenceSlots: Array<{ role: string; assetVersionId: string; assetVersionContentHash: string }>;
    engineId: string;
    modelId?: string;
    compilerVersion: string;
    templateVersion: string;
    intentHash: string;
    compiledTextHash: string;
    negativeTextHash?: string;
    compiledPromptSemanticHash: string;
};

export type ProviderInputAuthorizationSnapshot = ImmutableBusinessSnapshot & {
    schemaVersion: 1;
    authorizationSnapshotId: string;
    routeSnapshotId: string;
    routeSnapshotContentHash: string;
    routeContentHash: string;
    engineId: string;
    connectionId: string;
    accountBindingRef?: PseudonymousBindingRef;
    connectionInstanceRef: PseudonymousBindingRef;
    externalProjectId?: string;
    grants: Array<{ bindingId: string; assetVersionId: string; assetVersionContentHash: string; preparedRepresentationId?: string; preparedRepresentationContentHash?: string; permission: "provider_upload" | "provider_local_read" | "provider_remote_reference"; destinationScope: string; authorizedAt: string; expiresAt?: string }>;
    authorizationEvidence: { confirmationId: string; brokerGrantId: string; brokerGrantContentHash: string; brokerDecisionReceiptId: string; brokerDecisionReceiptContentHash: string; toolRequestId: string; authorizedByActorRef: string; confirmedAt: string };
    authorizationScopeHash: string;
};

export type VersionedEntityGuard = { guardKind: "versioned_entity"; entityType: string; entityId: string; expectedVersion: number; expectedContentHash: string };
export type CanvasStateGuard = { guardKind: "canvas_state"; canvasId: string; nodeId?: string; expectedRevision: number; expectedStateHash: string };
export type GenerationExecutionGuard = VersionedEntityGuard | CanvasStateGuard;
export type GenerationExecutionGuardSet = {
    primaryTarget: GenerationExecutionGuard;
    promptDraft: VersionedEntityGuard & { entityType: "prompt_draft" };
    projectPolicy: VersionedEntityGuard & { entityType: "project_generation_policy" };
    engineConnection: VersionedEntityGuard & { entityType: "generation_engine_connection" };
    projectLock?: VersionedEntityGuard & { entityType: "project_generation_lock" };
    budgetGrant?: VersionedEntityGuard & { entityType: "generation_budget_grant" };
    dependencies: GenerationExecutionGuard[];
};

export type AuthorizedGenerationSubmission = ImmutableBusinessSnapshot & {
    schemaVersion: 1;
    authorizedSubmissionId: string;
    generationAttemptId: string;
    routeSnapshotId: string;
    routeSnapshotContentHash: string;
    routeContentHash: string;
    descriptorReceiptId: string;
    descriptorReceiptContentHash: string;
    catalogValidationReceiptId: string;
    catalogValidationReceiptContentHash: string;
    catalogValidationSemanticHash: string;
    catalogValidationSubmitNotAfter: string;
    providerInputAuthorizationSnapshotId: string;
    providerInputAuthorizationContentHash: string;
    authorizationScopeHash: string;
    proposalId: string;
    proposalHash: string;
    confirmationId: string;
    brokerGrantId: string;
    brokerGrantContentHash: string;
    brokerDecisionReceiptId: string;
    brokerDecisionReceiptContentHash: string;
    confirmedByActorRef: string;
    confirmedAt: string;
    accountBindingRef?: PseudonymousBindingRef;
    connectionInstanceRef: PseudonymousBindingRef;
    executionGuards: GenerationExecutionGuardSet;
    executionGuardHash: string;
    budgetReservationId?: string;
    budgetReservationContentHash?: string;
    budgetReservationSemanticHash?: string;
    authorizedSubmissionSemanticHash: string;
    idempotencyKey: string;
};

export type GenerationRouteSnapshot = ImmutableBusinessSnapshot & {
    schemaVersion: 1;
    routeSnapshotId: string;
    generationAttemptId: string;
    engineId: string;
    connectionId: string;
    accountBindingRef?: PseudonymousBindingRef;
    connectionInstanceRef: PseudonymousBindingRef;
    capability: DescriptorCapability;
    taskKind: GenerationTaskKind;
    descriptorReceiptId: string;
    descriptorReceiptContentHash: string;
    descriptorSemanticHash: string;
    modelId?: string;
    workflowId?: string;
    skillId?: string;
    normalizedParameters: Record<string, unknown>;
    parameterHash: string;
    references: GenerationReferenceBinding[];
    referenceHash: string;
    promptDraftVersion: number;
    promptDraftContentHash: string;
    compiledPromptSemanticHash: string;
    compiledPromptTextHash: string;
    compilerVersion: string;
    templateVersion: string;
    userConfigRevision: string;
    projectPolicyVersion: number;
    projectPolicyHash: string;
    projectLockVersion?: number;
    projectLockHash?: string;
    nodeDraftVersion: number;
    selectionSource: "explicit_task" | "node_override" | "project_default" | "global_default";
    resolvedAt: string;
    routeContentHash: string;
};

export type CanonicalUnsignedMicrounits = string;
export type CanonicalSignedMicrounitsDelta = string;
export type BudgetAmount = { unit: string; amountMicrounits: CanonicalUnsignedMicrounits };
export type GenerationBudgetGrant = MutableAuthorityRecord & {
    schemaVersion: 1;
    grantId: string;
    projectId: string;
    engineId: string;
    connectionId?: string;
    accountBindingRef?: PseudonymousBindingRef;
    connectionInstanceRef: PseudonymousBindingRef;
    status: "active" | "expired" | "revoked" | "binding_rotated";
    bindingRevision: number;
    allowedModelIds: string[];
    allowedTaskKinds: GenerationTaskKind[];
    maxTasks: number;
    maxTotalCost?: BudgetAmount;
    expiresAt: string;
    grantedByActorRef: string;
    brokerGrantId: string;
    confirmationId: string;
};

export type BudgetReservation = ImmutableBusinessSnapshot & {
    schemaVersion: 1;
    reservationId: string;
    ledgerId: string;
    budgetGrantId: string;
    generationAttemptId: string;
    routeSnapshotId: string;
    routeContentHash: string;
    accountBindingRef?: PseudonymousBindingRef;
    connectionInstanceRef: PseudonymousBindingRef;
    budgetGrantExpectedVersion: number;
    budgetGrantExpectedContentHash: string;
    ledgerExpectedVersion: number;
    ledgerExpectedContentHash: string;
    reservedTasks: number;
    reservedCost?: BudgetAmount;
    expiresAt: string;
    budgetReservationSemanticHash: string;
};
export type BudgetLedgerStatus = "active" | "exhausted" | "expired" | "revoked" | "binding_rotated" | "reconciliation_required";
export type BudgetLedger = MutableAuthorityRecord & {
    schemaVersion: 1;
    ledgerId: string;
    grantId: string;
    projectId: string;
    engineId: string;
    connectionId?: string;
    accountBindingRef?: PseudonymousBindingRef;
    connectionInstanceRef: PseudonymousBindingRef;
    costUnit?: string;
    reservedTasks: number;
    reservedCostMicrounits: CanonicalUnsignedMicrounits;
    consumedTasks: number;
    consumedCostMicrounits: CanonicalUnsignedMicrounits;
    openReservationIds: string[];
    lastEventSequence: number;
    status: BudgetLedgerStatus;
};

export type SignedBudgetLedgerEffects = {
    reservedTasksDelta: number;
    reservedCostMicrounitsDelta: CanonicalSignedMicrounitsDelta;
    consumedTasksDelta: number;
    consumedCostMicrounitsDelta: CanonicalSignedMicrounitsDelta;
};

export type BudgetLedgerEvent = ImmutableBusinessSnapshot & {
    schemaVersion: 1;
    eventId: string;
    ledgerId: string;
    grantId: string;
    accountBindingRef?: PseudonymousBindingRef;
    connectionInstanceRef: PseudonymousBindingRef;
    sequence: number;
    eventType: "reserved" | "submitted" | "released" | "expired" | "settled" | "adjusted" | "revoked" | "binding_rotated" | "reconciliation_required";
    reservationId?: string;
    generationAttemptId?: string;
    bindingTransition?: { previousAccountBindingRef?: PseudonymousBindingRef; previousConnectionInstanceRef: PseudonymousBindingRef; nextAccountBindingRef?: PseudonymousBindingRef; nextConnectionInstanceRef?: PseudonymousBindingRef; replacementGrantId?: string; replacementLedgerId?: string };
    costUnit?: string;
    effects: SignedBudgetLedgerEffects;
    providerTaskId?: string;
    providerReceiptId?: string;
    reasonCode: string;
    occurredAt: string;
    budgetLedgerEventSemanticHash: string;
    idempotencyKey: string;
};

export type RedactionReceipt = ImmutableBusinessSnapshot & {
    schemaVersion: 1;
    redactionReceiptId: string;
    sourceObjectType: string;
    sourceContentHash: string;
    redactedObjectType: string;
    redactedContentHash: string;
    aliasScopeId: string;
    redactionPolicyVersion: string;
    redactedFieldPaths: string[];
    sourceCommit: string;
    sourceRunId: string;
    sourceArtifactId: string;
    redactionSemanticHash: string;
};

export type LocalConfigMigrationResult = "MIGRATED_AUTOMATICALLY" | "NO_OP_EQUIVALENT" | "SKIPPED_NEEDS_CONFIGURATION" | "BLOCKED_MIGRATION_CONFLICT" | "FAILED_ROLLED_BACK";
