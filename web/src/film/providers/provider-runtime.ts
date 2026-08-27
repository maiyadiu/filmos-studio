import { canonicalize } from "json-canonicalize";

const FILM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{2,63}$/;
const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i;
const SECRET_KEY_PATTERN = /(?:api[_-]?key|secret|token|cookie|authorization|password|credential)/i;
const LOCATOR_KEY_PATTERN = /(?:^|[_-])(?:url|uri|path|file|filename|upload|base64|binary)(?:$|[_-])/i;
const FORBIDDEN_STRING_PATTERN = /^(?:data:|blob:|file:|https?:\/\/|\/|~\/|[A-Za-z]:[\\/])/i;
const REFERENCE_KINDS = new Set(["asset", "asset_version", "representation", "shot_asset_reference", "resource"]);
const OUTPUT_KINDS = new Set(["text", "image", "video", "audio", "workflow", "three_d"]);
const MANUAL_SOURCE_KINDS = new Set(["provider_console", "manual_download", "local_runtime_export", "other_authorized"]);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ProviderSourceState = "VERIFIED_SOURCE_PRESENT" | "UNVERIFIED_SOURCE_ABSENT";
export type ProviderBoundary = "LOCAL_MANUAL_BOUNDARY" | "REUSE_HOST_RUNTIME" | "DEFERRED";

export type FilmProviderDescriptor = {
    providerId: string;
    displayName: string;
    sourceState: ProviderSourceState;
    boundary: ProviderBoundary;
    capabilityIds: readonly string[];
    canPreparePackage: boolean;
    canImportManualResult: boolean;
    externalExecution: "NOT_EXPOSED" | "UNVERIFIED";
    evidence: readonly string[];
};

export const BUILTIN_FILM_PROVIDERS: readonly FilmProviderDescriptor[] = Object.freeze([
    Object.freeze({
        providerId: "manual_web",
        displayName: "Manual Web Import",
        sourceState: "VERIFIED_SOURCE_PRESENT",
        boundary: "LOCAL_MANUAL_BOUNDARY",
        capabilityIds: Object.freeze(["text", "image", "video", "audio", "workflow", "three_d"]),
        canPreparePackage: true,
        canImportManualResult: true,
        externalExecution: "NOT_EXPOSED",
        evidence: Object.freeze(["film-contracts/schemas/core.schema.json#GenerationPackage", "web/src/film/providers/provider-runtime.ts"]),
    }),
    Object.freeze({
        providerId: "dreamina_cli",
        displayName: "Dreamina CLI",
        sourceState: "VERIFIED_SOURCE_PRESENT",
        boundary: "REUSE_HOST_RUNTIME",
        capabilityIds: Object.freeze(["text", "image", "video"]),
        canPreparePackage: true,
        canImportManualResult: true,
        externalExecution: "NOT_EXPOSED",
        evidence: Object.freeze([
            "canvas-agent/src/dreamina-cli-contract.ts",
            "canvas-agent/src/dreamina-task-contract.ts",
            "canvas-agent/src/dreamina-cli-runtime.ts",
        ]),
    }),
    Object.freeze({
        providerId: "comfy_bridge",
        displayName: "Comfy Bridge",
        sourceState: "VERIFIED_SOURCE_PRESENT",
        boundary: "REUSE_HOST_RUNTIME",
        capabilityIds: Object.freeze(["workflow"]),
        canPreparePackage: true,
        canImportManualResult: true,
        externalExecution: "NOT_EXPOSED",
        evidence: Object.freeze([
            "backend/internal/model/models_bridge.go",
            "backend/internal/service/comfy_bridge.go",
            "backend/internal/repository/comfy_bridge.go",
        ]),
    }),
    Object.freeze({
        providerId: "flova_cli",
        displayName: "Flova CLI",
        sourceState: "UNVERIFIED_SOURCE_ABSENT",
        boundary: "DEFERRED",
        capabilityIds: Object.freeze([]),
        canPreparePackage: false,
        canImportManualResult: false,
        externalExecution: "UNVERIFIED",
        evidence: Object.freeze(["UNVERIFIED_SOURCE_ABSENT"]),
    }),
]);

export class FilmProviderBoundaryError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "FilmProviderBoundaryError";
    }
}

export class FilmProviderRegistry {
    readonly enabled: boolean;
    private readonly providers = new Map<string, FilmProviderDescriptor>();

    constructor(options: { enabled?: boolean; providers?: readonly FilmProviderDescriptor[] } = {}) {
        this.enabled = options.enabled === true;
        for (const descriptor of options.providers ?? BUILTIN_FILM_PROVIDERS) {
            const normalized = normalizeDescriptor(descriptor);
            if (this.providers.has(normalized.providerId)) {
                throw new FilmProviderBoundaryError("provider_duplicate", `Provider ${normalized.providerId} is registered more than once`);
            }
            this.providers.set(normalized.providerId, normalized);
        }
    }

    list(): FilmProviderDescriptor[] {
        return [...this.providers.values()].map(cloneDescriptor);
    }

    get(providerId: string): FilmProviderDescriptor | undefined {
        const descriptor = this.providers.get(providerId);
        return descriptor ? cloneDescriptor(descriptor) : undefined;
    }

    requireLocalBoundary(providerId: string, capabilityId: string, operation: "prepare" | "manual_import"): FilmProviderDescriptor {
        if (!this.enabled) {
            throw new FilmProviderBoundaryError("provider_runtime_disabled", "Film Provider runtime is disabled by default");
        }
        assertProviderId(providerId);
        assertCapabilityId(capabilityId);
        const descriptor = this.providers.get(providerId);
        if (!descriptor) {
            throw new FilmProviderBoundaryError("provider_not_registered", `Provider ${providerId} is not registered`);
        }
        if (descriptor.sourceState !== "VERIFIED_SOURCE_PRESENT") {
            throw new FilmProviderBoundaryError(
                "provider_source_unverified",
                `Provider ${providerId} is ${descriptor.sourceState}; defer until source capability is verified`,
            );
        }
        if (!descriptor.capabilityIds.includes(capabilityId)) {
            throw new FilmProviderBoundaryError("provider_capability_unsupported", `Provider ${providerId} does not declare capability ${capabilityId}`);
        }
        if (operation === "prepare" && !descriptor.canPreparePackage) {
            throw new FilmProviderBoundaryError("provider_prepare_deferred", `Provider ${providerId} package preparation is deferred`);
        }
        if (operation === "manual_import" && !descriptor.canImportManualResult) {
            throw new FilmProviderBoundaryError("provider_manual_import_deferred", `Provider ${providerId} manual result import is deferred`);
        }
        return cloneDescriptor(descriptor);
    }
}

export type FilmWriteGuard = {
    filmEntityId: string;
    expectedVersion: number;
    expectedContentHash: string;
};

export type SubmissionReference = {
    filmReferenceId: string;
    hostReferenceId: string;
    referenceKind: "asset" | "asset_version" | "representation" | "shot_asset_reference" | "resource";
    contentHash: string;
    authorization: {
        decision: "authorized_for_provider_input";
        evidenceId: string;
        scopeHash: string;
    };
};

export type PrepareSubmissionPackageInput = {
    submissionPackageId: string;
    generationAttemptId: string;
    promptDraftId: string;
    hostProjectId: string;
    target: FilmWriteGuard;
    providerId: string;
    capabilityId: string;
    promptText: string;
    parameters?: JsonObject;
    references?: readonly SubmissionReference[];
    acceptanceChecklist: readonly string[];
    preparedAt: string;
};

export type SubmissionPackageFileName = "task.json" | "prompt.txt" | "references.json" | "acceptance-checklist.md";

export type PreparedSubmissionPackage = {
    schemaVersion: 1;
    ref: {
        filmEntityId: string;
        entityType: "generation_package";
        version: 1;
        contentHash: string;
    };
    generationAttemptId: string;
    promptDraftId: string;
    hostProjectId: string;
    target: FilmWriteGuard;
    providerId: string;
    capabilityId: string;
    promptText: string;
    parameters: JsonObject;
    references: SubmissionReference[];
    acceptanceChecklist: string[];
    preparedAt: string;
    lifecycle: "prepared";
    externalSubmission: "not_submitted";
    promptHash: string;
    parameterHash: string;
    referenceHash: string;
    inputHash: string;
    files: Array<{
        name: SubmissionPackageFileName;
        mediaType: "application/json" | "text/plain" | "text/markdown";
        contentHash: string;
    }>;
};

export async function prepareSubmissionPackage(
    registry: FilmProviderRegistry,
    input: PrepareSubmissionPackageInput,
    cryptoImpl: Crypto = globalThis.crypto,
): Promise<PreparedSubmissionPackage> {
    registry.requireLocalBoundary(input.providerId, input.capabilityId, "prepare");
    assertFilmId(input.submissionPackageId, "submissionPackageId");
    assertFilmId(input.generationAttemptId, "generationAttemptId");
    assertFilmId(input.promptDraftId, "promptDraftId");
    assertWriteGuard(input.target);
    assertOpaqueId(input.hostProjectId, "hostProjectId");
    assertIsoTimestamp(input.preparedAt, "preparedAt");
    if (!input.promptText.trim()) {
        throw new FilmProviderBoundaryError("prompt_empty", "promptText must contain non-whitespace text");
    }

    const parameters = normalizeSafeJsonObject(input.parameters ?? {}, "parameters");
    const references = normalizeReferences(input.references ?? []);
    const acceptanceChecklist = normalizeChecklist(input.acceptanceChecklist);
    const promptHash = await sha256Text(input.promptText, cryptoImpl);
    const parameterHash = await sha256Canonical(parameters, cryptoImpl);
    const referenceHash = await sha256Canonical(references, cryptoImpl);
    const checklistMarkdown = renderAcceptanceChecklist(acceptanceChecklist);
    const inputHash = await sha256Canonical(
        submissionInputMaterial({
            generationAttemptId: input.generationAttemptId,
            promptDraftId: input.promptDraftId,
            hostProjectId: input.hostProjectId,
            target: input.target,
            providerId: input.providerId,
            capabilityId: input.capabilityId,
            promptHash,
            parameterHash,
            referenceHash,
        }),
        cryptoImpl,
    );
    const taskDocument = submissionTaskDocument({
        generationAttemptId: input.generationAttemptId,
        submissionPackageId: input.submissionPackageId,
        promptDraftId: input.promptDraftId,
        hostProjectId: input.hostProjectId,
        target: input.target,
        providerId: input.providerId,
        capabilityId: input.capabilityId,
        promptHash,
        parameterHash,
        referenceHash,
        inputHash,
    });
    const files: PreparedSubmissionPackage["files"] = [
        { name: "task.json", mediaType: "application/json", contentHash: await sha256Text(taskDocument, cryptoImpl) },
        { name: "prompt.txt", mediaType: "text/plain", contentHash: promptHash },
        { name: "references.json", mediaType: "application/json", contentHash: referenceHash },
        { name: "acceptance-checklist.md", mediaType: "text/markdown", contentHash: await sha256Text(checklistMarkdown, cryptoImpl) },
    ];

    const packageWithoutContentHash = {
        schemaVersion: 1 as const,
        ref: {
            filmEntityId: input.submissionPackageId,
            entityType: "generation_package" as const,
            version: 1 as const,
        },
        generationAttemptId: input.generationAttemptId,
        promptDraftId: input.promptDraftId,
        hostProjectId: input.hostProjectId,
        target: { ...input.target },
        providerId: input.providerId,
        capabilityId: input.capabilityId,
        promptText: input.promptText,
        parameters,
        references,
        acceptanceChecklist,
        preparedAt: input.preparedAt,
        lifecycle: "prepared" as const,
        externalSubmission: "not_submitted" as const,
        promptHash,
        parameterHash,
        referenceHash,
        inputHash,
        files,
    };
    const contentHash = await sha256Canonical(packageWithoutContentHash, cryptoImpl);
    return {
        ...packageWithoutContentHash,
        ref: { ...packageWithoutContentHash.ref, contentHash },
    };
}

export type ImportedResultOutput = {
    filmRepresentationId: string;
    hostResourceId: string;
    outputKind: "text" | "image" | "video" | "audio" | "workflow" | "three_d";
    contentHash: string;
    mimeType: string;
    bytes: number;
};

export type ManualResultImportInput = {
    candidateId: string;
    generationPackage: PreparedSubmissionPackage;
    expectedTargetVersion: number;
    expectedTargetContentHash: string;
    expectedInputHash: string;
    providerTaskId: string;
    receipt: {
        receiptId: string;
        contentHash: string;
        capturedAt: string;
    };
    manualSource: {
        sourceId: string;
        sourceKind: "provider_console" | "manual_download" | "local_runtime_export" | "other_authorized";
        importedBy: string;
        importedAt: string;
        authorizationEvidenceId: string;
    };
    outputs: readonly ImportedResultOutput[];
};

export type ManualImportedCandidate = {
    schemaVersion: 1;
    ref: {
        filmEntityId: string;
        entityType: "candidate";
        version: 1;
        contentHash: string;
    };
    generationPackageId: string;
    generationAttemptId: string;
    target: FilmWriteGuard;
    providerEvidence: {
        providerId: string;
        providerTaskId: string;
        receiptId: string;
        receiptHash: string;
        receiptCapturedAt: string;
        promptHash: string;
        parameterHash: string;
        inputHash: string;
    };
    parameters: JsonObject;
    manualImport: {
        sourceId: string;
        sourceKind: ManualResultImportInput["manualSource"]["sourceKind"];
        importedBy: string;
        importedAt: string;
        authorizationEvidenceId: string;
    };
    outputs: ImportedResultOutput[];
    status: "candidate";
    reviewState: "pending";
    approvalState: "not_approved";
};

export async function importManualProviderResult(
    registry: FilmProviderRegistry,
    input: ManualResultImportInput,
    cryptoImpl: Crypto = globalThis.crypto,
): Promise<ManualImportedCandidate> {
    const generationPackage = input.generationPackage;
    registry.requireLocalBoundary(generationPackage.providerId, generationPackage.capabilityId, "manual_import");
    await verifySubmissionPackage(generationPackage, cryptoImpl);
    assertFilmId(input.candidateId, "candidateId");
    assertExpectedVersion(input.expectedTargetVersion, "expectedTargetVersion");
    assertHash(input.expectedTargetContentHash, "expectedTargetContentHash");
    assertHash(input.expectedInputHash, "expectedInputHash");
    if (input.expectedTargetVersion !== generationPackage.target.expectedVersion) {
        throw new FilmProviderBoundaryError("expected_version_conflict", "Manual import expectedTargetVersion does not match the prepared package");
    }
    if (input.expectedInputHash !== generationPackage.inputHash) {
        throw new FilmProviderBoundaryError("input_hash_conflict", "Manual import expectedInputHash does not match the prepared package");
    }
    if (input.expectedTargetContentHash !== generationPackage.target.expectedContentHash) {
        throw new FilmProviderBoundaryError("expected_content_hash_conflict", "Manual import target content hash does not match the prepared package");
    }
    assertOpaqueId(input.providerTaskId, "providerTaskId");
    assertOpaqueId(input.receipt.receiptId, "receipt.receiptId");
    assertHash(input.receipt.contentHash, "receipt.contentHash");
    assertIsoTimestamp(input.receipt.capturedAt, "receipt.capturedAt");
    assertOpaqueId(input.manualSource.sourceId, "manualSource.sourceId");
    if (!MANUAL_SOURCE_KINDS.has(input.manualSource.sourceKind)) {
        throw new FilmProviderBoundaryError("manual_source_kind_invalid", "manualSource.sourceKind is not supported");
    }
    assertOpaqueId(input.manualSource.importedBy, "manualSource.importedBy");
    assertOpaqueId(input.manualSource.authorizationEvidenceId, "manualSource.authorizationEvidenceId");
    assertIsoTimestamp(input.manualSource.importedAt, "manualSource.importedAt");
    const outputs = normalizeOutputs(input.outputs);
    if (outputs.some((output) => output.outputKind !== generationPackage.capabilityId)) {
        throw new FilmProviderBoundaryError("provider_result_capability_mismatch", "Manual result output kind does not match the prepared capability");
    }

    const candidateWithoutContentHash = {
        schemaVersion: 1 as const,
        ref: {
            filmEntityId: input.candidateId,
            entityType: "candidate" as const,
            version: 1 as const,
        },
        generationPackageId: generationPackage.ref.filmEntityId,
        generationAttemptId: generationPackage.generationAttemptId,
        target: { ...generationPackage.target },
        providerEvidence: {
            providerId: generationPackage.providerId,
            providerTaskId: input.providerTaskId,
            receiptId: input.receipt.receiptId,
            receiptHash: input.receipt.contentHash,
            receiptCapturedAt: input.receipt.capturedAt,
            promptHash: generationPackage.promptHash,
            parameterHash: generationPackage.parameterHash,
            inputHash: generationPackage.inputHash,
        },
        parameters: normalizeSafeJsonObject(generationPackage.parameters, "generationPackage.parameters"),
        manualImport: {
            sourceId: input.manualSource.sourceId,
            sourceKind: input.manualSource.sourceKind,
            importedBy: input.manualSource.importedBy,
            importedAt: input.manualSource.importedAt,
            authorizationEvidenceId: input.manualSource.authorizationEvidenceId,
        },
        outputs,
        status: "candidate" as const,
        reviewState: "pending" as const,
        approvalState: "not_approved" as const,
    };
    const contentHash = await sha256Canonical(candidateWithoutContentHash, cryptoImpl);
    return {
        ...candidateWithoutContentHash,
        ref: { ...candidateWithoutContentHash.ref, contentHash },
    };
}

export async function verifySubmissionPackage(generationPackage: PreparedSubmissionPackage, cryptoImpl: Crypto = globalThis.crypto): Promise<void> {
    if (
        generationPackage.schemaVersion !== 1 ||
        generationPackage.ref.entityType !== "generation_package" ||
        generationPackage.ref.version !== 1 ||
        generationPackage.lifecycle !== "prepared" ||
        generationPackage.externalSubmission !== "not_submitted"
    ) {
        throw new FilmProviderBoundaryError("submission_package_state_invalid", "Submission package is not a prepared, unsubmitted v1 package");
    }
    assertFilmId(generationPackage.ref.filmEntityId, "generationPackage.ref.filmEntityId");
    assertFilmId(generationPackage.generationAttemptId, "generationPackage.generationAttemptId");
    assertFilmId(generationPackage.promptDraftId, "generationPackage.promptDraftId");
    assertHash(generationPackage.ref.contentHash, "generationPackage.ref.contentHash");
    assertHash(generationPackage.promptHash, "generationPackage.promptHash");
    assertHash(generationPackage.parameterHash, "generationPackage.parameterHash");
    assertHash(generationPackage.referenceHash, "generationPackage.referenceHash");
    assertHash(generationPackage.inputHash, "generationPackage.inputHash");
    assertWriteGuard(generationPackage.target);
    assertProviderId(generationPackage.providerId);
    assertCapabilityId(generationPackage.capabilityId);
    assertOpaqueId(generationPackage.hostProjectId, "generationPackage.hostProjectId");
    assertIsoTimestamp(generationPackage.preparedAt, "generationPackage.preparedAt");
    if (!generationPackage.promptText.trim()) {
        throw new FilmProviderBoundaryError("prompt_empty", "generationPackage.promptText must contain non-whitespace text");
    }

    const promptHash = await sha256Text(generationPackage.promptText, cryptoImpl);
    const parameters = normalizeSafeJsonObject(generationPackage.parameters, "generationPackage.parameters");
    const references = normalizeReferences(generationPackage.references);
    const acceptanceChecklist = normalizeChecklist(generationPackage.acceptanceChecklist);
    const parameterHash = await sha256Canonical(parameters, cryptoImpl);
    const referenceHash = await sha256Canonical(references, cryptoImpl);
    const inputHash = await sha256Canonical(
        submissionInputMaterial({
            generationAttemptId: generationPackage.generationAttemptId,
            promptDraftId: generationPackage.promptDraftId,
            hostProjectId: generationPackage.hostProjectId,
            target: generationPackage.target,
            providerId: generationPackage.providerId,
            capabilityId: generationPackage.capabilityId,
            promptHash,
            parameterHash,
            referenceHash,
        }),
        cryptoImpl,
    );
    if (
        promptHash !== generationPackage.promptHash ||
        parameterHash !== generationPackage.parameterHash ||
        referenceHash !== generationPackage.referenceHash ||
        inputHash !== generationPackage.inputHash
    ) {
        throw new FilmProviderBoundaryError("submission_package_input_hash_mismatch", "Submission package input evidence does not match its content");
    }
    const taskDocument = submissionTaskDocument({
        generationAttemptId: generationPackage.generationAttemptId,
        submissionPackageId: generationPackage.ref.filmEntityId,
        promptDraftId: generationPackage.promptDraftId,
        hostProjectId: generationPackage.hostProjectId,
        target: generationPackage.target,
        providerId: generationPackage.providerId,
        capabilityId: generationPackage.capabilityId,
        promptHash,
        parameterHash,
        referenceHash,
        inputHash,
    });
    const expectedFiles: PreparedSubmissionPackage["files"] = [
        { name: "task.json", mediaType: "application/json", contentHash: await sha256Text(taskDocument, cryptoImpl) },
        { name: "prompt.txt", mediaType: "text/plain", contentHash: promptHash },
        { name: "references.json", mediaType: "application/json", contentHash: referenceHash },
        {
            name: "acceptance-checklist.md",
            mediaType: "text/markdown",
            contentHash: await sha256Text(renderAcceptanceChecklist(acceptanceChecklist), cryptoImpl),
        },
    ];
    if (canonicalize(generationPackage.files) !== canonicalize(expectedFiles)) {
        throw new FilmProviderBoundaryError("submission_package_file_manifest_mismatch", "Submission package file manifest does not match its evidence");
    }
    const { contentHash: _contentHash, ...refWithoutContentHash } = generationPackage.ref;
    const contentHash = await sha256Canonical({ ...generationPackage, ref: refWithoutContentHash }, cryptoImpl);
    if (contentHash !== generationPackage.ref.contentHash) {
        throw new FilmProviderBoundaryError("submission_package_content_hash_mismatch", "Submission package content hash does not match its content");
    }
}

function normalizeDescriptor(descriptor: FilmProviderDescriptor): FilmProviderDescriptor {
    assertProviderId(descriptor.providerId);
    if (!descriptor.displayName.trim()) {
        throw new FilmProviderBoundaryError("provider_display_name_empty", `Provider ${descriptor.providerId} has an empty display name`);
    }
    const capabilityIds = [...new Set(descriptor.capabilityIds.map((capabilityId) => {
        assertCapabilityId(capabilityId);
        return capabilityId;
    }))].sort();
    if (descriptor.sourceState === "UNVERIFIED_SOURCE_ABSENT" && (descriptor.canPreparePackage || descriptor.canImportManualResult)) {
        throw new FilmProviderBoundaryError("provider_unverified_capability", `Unverified Provider ${descriptor.providerId} cannot expose local operations`);
    }
    return Object.freeze({
        ...descriptor,
        capabilityIds: Object.freeze(capabilityIds),
        evidence: Object.freeze([...descriptor.evidence]),
    });
}

function cloneDescriptor(descriptor: FilmProviderDescriptor): FilmProviderDescriptor {
    return { ...descriptor, capabilityIds: [...descriptor.capabilityIds], evidence: [...descriptor.evidence] };
}

function submissionInputMaterial(input: {
    generationAttemptId: string;
    promptDraftId: string;
    hostProjectId: string;
    target: FilmWriteGuard;
    providerId: string;
    capabilityId: string;
    promptHash: string;
    parameterHash: string;
    referenceHash: string;
}) {
    return {
        generationAttemptId: input.generationAttemptId,
        promptDraftId: input.promptDraftId,
        hostProjectId: input.hostProjectId,
        target: { ...input.target },
        providerId: input.providerId,
        capabilityId: input.capabilityId,
        promptHash: input.promptHash,
        parameterHash: input.parameterHash,
        referenceHash: input.referenceHash,
    };
}

function submissionTaskDocument(input: {
    generationAttemptId: string;
    submissionPackageId: string;
    promptDraftId: string;
    hostProjectId: string;
    target: FilmWriteGuard;
    providerId: string;
    capabilityId: string;
    promptHash: string;
    parameterHash: string;
    referenceHash: string;
    inputHash: string;
}): string {
    return canonicalize({
        generation_attempt_id: input.generationAttemptId,
        submission_package_id: input.submissionPackageId,
        prompt_draft_id: input.promptDraftId,
        host_project_id: input.hostProjectId,
        target: {
            film_entity_id: input.target.filmEntityId,
            expected_version: input.target.expectedVersion,
            expected_content_hash: input.target.expectedContentHash,
        },
        provider_id: input.providerId,
        capability_id: input.capabilityId,
        prompt_hash: input.promptHash,
        parameter_hash: input.parameterHash,
        reference_hash: input.referenceHash,
        input_hash: input.inputHash,
        external_submission: "not_submitted",
    });
}

function normalizeReferences(input: readonly SubmissionReference[]): SubmissionReference[] {
    const seen = new Set<string>();
    const references = input.map((reference, index) => {
        const prefix = `references[${index}]`;
        assertFilmId(reference.filmReferenceId, `${prefix}.filmReferenceId`);
        if (seen.has(reference.filmReferenceId)) {
            throw new FilmProviderBoundaryError("reference_duplicate", `Duplicate Film reference ${reference.filmReferenceId}`);
        }
        seen.add(reference.filmReferenceId);
        assertOpaqueId(reference.hostReferenceId, `${prefix}.hostReferenceId`);
        assertHash(reference.contentHash, `${prefix}.contentHash`);
        if (!REFERENCE_KINDS.has(reference.referenceKind)) {
            throw new FilmProviderBoundaryError("reference_kind_invalid", `${prefix}.referenceKind is not supported`);
        }
        if (reference.authorization.decision !== "authorized_for_provider_input") {
            throw new FilmProviderBoundaryError("reference_not_authorized", `${prefix} is not authorized for Provider input`);
        }
        assertOpaqueId(reference.authorization.evidenceId, `${prefix}.authorization.evidenceId`);
        assertHash(reference.authorization.scopeHash, `${prefix}.authorization.scopeHash`);
        return {
            filmReferenceId: reference.filmReferenceId,
            hostReferenceId: reference.hostReferenceId,
            referenceKind: reference.referenceKind,
            contentHash: reference.contentHash,
            authorization: { ...reference.authorization },
        };
    });
    return references.sort((left, right) => left.filmReferenceId.localeCompare(right.filmReferenceId));
}

function normalizeOutputs(input: readonly ImportedResultOutput[]): ImportedResultOutput[] {
    if (input.length === 0) {
        throw new FilmProviderBoundaryError("manual_result_outputs_empty", "Manual result import requires at least one output reference");
    }
    const seen = new Set<string>();
    return input
        .map((output, index) => {
            const prefix = `outputs[${index}]`;
            assertFilmId(output.filmRepresentationId, `${prefix}.filmRepresentationId`);
            if (seen.has(output.filmRepresentationId)) {
                throw new FilmProviderBoundaryError("output_duplicate", `Duplicate output ${output.filmRepresentationId}`);
            }
            seen.add(output.filmRepresentationId);
            assertOpaqueId(output.hostResourceId, `${prefix}.hostResourceId`);
            assertHash(output.contentHash, `${prefix}.contentHash`);
            if (!OUTPUT_KINDS.has(output.outputKind)) {
                throw new FilmProviderBoundaryError("output_kind_invalid", `${prefix}.outputKind is not supported`);
            }
            if (!MIME_PATTERN.test(output.mimeType)) {
                throw new FilmProviderBoundaryError("output_mime_invalid", `${prefix}.mimeType must be a MIME type`);
            }
            if (!Number.isSafeInteger(output.bytes) || output.bytes < 0) {
                throw new FilmProviderBoundaryError("output_bytes_invalid", `${prefix}.bytes must be a non-negative safe integer`);
            }
            return { ...output };
        })
        .sort((left, right) => left.filmRepresentationId.localeCompare(right.filmRepresentationId));
}

function normalizeChecklist(input: readonly string[]): string[] {
    if (input.length === 0) {
        throw new FilmProviderBoundaryError("acceptance_checklist_empty", "acceptanceChecklist must contain at least one item");
    }
    return input.map((item, index) => {
        if (!item.trim() || item !== item.trim()) {
            throw new FilmProviderBoundaryError("acceptance_checklist_invalid", `acceptanceChecklist[${index}] must be trimmed non-empty text`);
        }
        return item;
    });
}

function renderAcceptanceChecklist(items: readonly string[]): string {
    return `# Acceptance Checklist\n\n${items.map((item) => `- [ ] ${item}`).join("\n")}\n`;
}

function normalizeSafeJsonObject(input: JsonObject, field: string): JsonObject {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new FilmProviderBoundaryError("parameters_object_invalid", `${field} must be a JSON object`);
    }
    assertSafeJson(input, field, new Set<object>());
    return JSON.parse(canonicalize(input)) as JsonObject;
}

function assertSafeJson(input: JsonValue, field: string, ancestors: Set<object>): void {
    if (input === undefined || !["string", "number", "boolean", "object"].includes(typeof input)) {
        throw new FilmProviderBoundaryError("parameter_type_invalid", `${field} contains a non-JSON value`);
    }
    if (typeof input === "number" && !Number.isFinite(input)) {
        throw new FilmProviderBoundaryError("parameter_number_invalid", `${field} contains a non-finite number`);
    }
    if (typeof input === "string" && FORBIDDEN_STRING_PATTERN.test(input.trim())) {
        throw new FilmProviderBoundaryError("parameter_locator_forbidden", `${field} contains a URL, data payload, or file path`);
    }
    if (input === null || typeof input !== "object") return;
    if (ancestors.has(input)) {
        throw new FilmProviderBoundaryError("parameter_cycle", `${field} contains a cyclic value`);
    }
    ancestors.add(input);
    if (Array.isArray(input)) {
        input.forEach((value, index) => assertSafeJson(value, `${field}[${index}]`, ancestors));
    } else {
        for (const [key, value] of Object.entries(input)) {
            if (SECRET_KEY_PATTERN.test(key)) {
                throw new FilmProviderBoundaryError("parameter_secret_forbidden", `${field}.${key} is a sensitive field`);
            }
            if (LOCATOR_KEY_PATTERN.test(key)) {
                throw new FilmProviderBoundaryError("parameter_locator_field_forbidden", `${field}.${key} must use an audited reference instead`);
            }
            assertSafeJson(value, `${field}.${key}`, ancestors);
        }
    }
    ancestors.delete(input);
}

async function sha256Canonical(value: unknown, cryptoImpl: Crypto): Promise<string> {
    return sha256Text(canonicalize(value), cryptoImpl);
}

async function sha256Text(value: string, cryptoImpl: Crypto): Promise<string> {
    if (!cryptoImpl?.subtle) {
        throw new FilmProviderBoundaryError("webcrypto_unavailable", "Web Crypto SHA-256 is required for Provider evidence");
    }
    const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertWriteGuard(guard: FilmWriteGuard): void {
    assertFilmId(guard.filmEntityId, "target.filmEntityId");
    assertExpectedVersion(guard.expectedVersion, "target.expectedVersion");
    assertHash(guard.expectedContentHash, "target.expectedContentHash");
}

function assertExpectedVersion(value: number, field: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new FilmProviderBoundaryError("expected_version_invalid", `${field} must be a non-negative safe integer`);
    }
}

function assertFilmId(value: string, field: string): void {
    if (!FILM_ID_PATTERN.test(value)) {
        throw new FilmProviderBoundaryError("film_id_invalid", `${field} must be a lowercase UUID v4 Film ID`);
    }
}

function assertHash(value: string, field: string): void {
    if (!HASH_PATTERN.test(value)) {
        throw new FilmProviderBoundaryError("content_hash_invalid", `${field} must be a lowercase SHA-256 hash`);
    }
}

function assertProviderId(value: string): void {
    if (!PROVIDER_ID_PATTERN.test(value)) {
        throw new FilmProviderBoundaryError("provider_id_invalid", "providerId must be a lowercase extensible identifier");
    }
}

function assertCapabilityId(value: string): void {
    if (!CAPABILITY_ID_PATTERN.test(value)) {
        throw new FilmProviderBoundaryError("provider_capability_id_invalid", "capabilityId must be a lowercase extensible identifier");
    }
}

function assertOpaqueId(value: string, field: string): void {
    if (!OPAQUE_ID_PATTERN.test(value)) {
        throw new FilmProviderBoundaryError("opaque_id_invalid", `${field} must be an opaque identifier, not a path or URL`);
    }
}

function assertIsoTimestamp(value: string, field: string): void {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
        throw new FilmProviderBoundaryError("timestamp_invalid", `${field} must be an ISO-8601 UTC timestamp`);
    }
}
