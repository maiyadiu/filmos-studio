export const FILM_PROMPT_KERNEL_FLAG = "film.prompt_kernel" as const;
export const FILM_PROMPT_COMPILER_VERSION = "filmos.prompt-compiler.v0" as const;

export type ProviderKind = "manual_web" | "dreamina_cli" | "flova_cli" | "comfy_bridge" | "blender" | "generic_api";
export type PromptOutputKind = "text" | "image" | "video" | "audio" | "scene";
export type HostReferenceKind = "project" | "unit" | "shot" | "asset" | "asset_version" | "canvas" | "resource";

export type HostReference = {
    kind: HostReferenceKind;
    id: string;
};

export type FilmHostBinding = {
    filmEntityId: string;
    entityType: string;
    version: number;
    contentHash: string;
    hostReferences: readonly HostReference[];
};

export type PromptAssetBinding = {
    binding: FilmHostBinding;
    role: string;
    priority: number;
};

export type ProviderCapabilityProfile = {
    profileId: string;
    profileVersion: number;
    providerKind: ProviderKind;
    outputKind: PromptOutputKind;
    dialect: string;
    supports: {
        referenceAssets: boolean;
        negativePrompt: boolean;
        deterministicSeed: boolean;
        cameraControl: boolean;
        audio: boolean;
    };
    requires: {
        aspectRatio: boolean;
        durationSeconds: boolean;
    };
    limits: {
        maxPromptCharacters: number;
        maxReferenceAssets: number;
    };
};

export type ProviderParameters = {
    aspectRatio: string | null;
    durationSeconds: number | null;
    seed: number | null;
    negativePrompt: string | null;
};

export type PromptDraftCompilerInput = {
    schemaVersion: "filmos.prompt-compiler-input.v0";
    feature: {
        key: typeof FILM_PROMPT_KERNEL_FLAG;
        enabled: boolean;
    };
    draft: {
        filmEntityId: string;
        expectedVersion: number;
        targetVersion: number;
    };
    scope: {
        project: FilmHostBinding;
        shot: FilmHostBinding;
        directorUnit: FilmHostBinding;
    };
    directorIrText: string;
    visualLock: {
        binding: FilmHostBinding;
        lockText: string;
    };
    template: {
        hostPromptTemplateId: string;
        operation: string;
        version: number;
        contentHash: string;
        content: string;
    };
    assets: readonly PromptAssetBinding[];
    providerCapability: ProviderCapabilityProfile;
    providerParameters: ProviderParameters;
};

export type PromptAuditFinding = {
    code: string;
    status: "PASS" | "FAIL";
    message: string;
};

export type PromptAuditReport = {
    status: "PASS" | "FAIL";
    findings: readonly PromptAuditFinding[];
};

export type CompiledPromptDraft = {
    compilerVersion: typeof FILM_PROMPT_COMPILER_VERSION;
    promptDraft: {
        ref: {
            film_entity_id: string;
            entity_type: "prompt_draft";
            version: number;
            content_hash: string;
        };
        states: {
            creative_stage: "authored";
            execution_state: "not_started";
            review_state: "not_reviewed";
            lock_state: "unlocked";
            delivery_state: "not_ready";
            stale_state: "fresh";
        };
        director_ir_hash: string;
        visual_lock_hash: string;
        model_capability_profile: string;
        prompt_text: string;
    };
    bindings: {
        expected_version: number;
        project: FilmHostBinding;
        shot: FilmHostBinding;
        director_unit: FilmHostBinding;
        visual_lock: FilmHostBinding;
        prompt_template: PromptDraftCompilerInput["template"];
        assets: readonly PromptAssetBinding[];
    };
    provider: {
        capability: ProviderCapabilityProfile;
        capability_hash: string;
        parameters: ProviderParameters;
    };
    hashes: {
        input_hash: string;
        prompt_hash: string;
    };
    lifecycleBoundary: {
        submission_state: "NOT_SUBMITTED";
        generated_result_state: "CANDIDATE_ONLY";
        approval_state: "SEPARATE_HUMAN_ACTION_REQUIRED";
    };
    audit: PromptAuditReport;
};

export class PromptDraftCompileError extends Error {
    readonly report: PromptAuditReport;

    constructor(report: PromptAuditReport) {
        super(report.findings.filter((finding) => finding.status === "FAIL").map((finding) => `${finding.code}: ${finding.message}`).join("; "));
        this.name = "PromptDraftCompileError";
        this.report = report;
    }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HOST_REFERENCE_KINDS: readonly HostReferenceKind[] = ["project", "unit", "shot", "asset", "asset_version", "canvas", "resource"];
const PATH_OR_PUBLIC_URL = /(?:[\\/]|^(?:~|file:|https?:|[a-zA-Z]:))/;

export async function compilePromptDraft(input: PromptDraftCompilerInput): Promise<CompiledPromptDraft> {
    const preflight = await auditPromptDraftInput(input);
    if (preflight.status === "FAIL") throw new PromptDraftCompileError(preflight);

    const normalized = normalizeInput(input);
    const report = await auditPromptDraftInput(normalized);
    if (report.status === "FAIL") throw new PromptDraftCompileError(report);

    const promptText = buildPromptText(normalized);
    const promptHash = await sha256Text(promptText);
    const inputHash = await sha256Text(canonicalJson(normalized));
    const capabilityHash = await sha256Text(canonicalJson(normalized.providerCapability));

    return {
        compilerVersion: FILM_PROMPT_COMPILER_VERSION,
        promptDraft: {
            ref: {
                film_entity_id: normalized.draft.filmEntityId,
                entity_type: "prompt_draft",
                version: normalized.draft.targetVersion,
                content_hash: promptHash,
            },
            states: {
                creative_stage: "authored",
                execution_state: "not_started",
                review_state: "not_reviewed",
                lock_state: "unlocked",
                delivery_state: "not_ready",
                stale_state: "fresh",
            },
            director_ir_hash: normalized.scope.directorUnit.contentHash,
            visual_lock_hash: normalized.visualLock.binding.contentHash,
            model_capability_profile: `${normalized.providerCapability.profileId}@${normalized.providerCapability.profileVersion}`,
            prompt_text: promptText,
        },
        bindings: {
            expected_version: normalized.draft.expectedVersion,
            project: normalized.scope.project,
            shot: normalized.scope.shot,
            director_unit: normalized.scope.directorUnit,
            visual_lock: normalized.visualLock.binding,
            prompt_template: normalized.template,
            assets: normalized.assets,
        },
        provider: {
            capability: normalized.providerCapability,
            capability_hash: capabilityHash,
            parameters: normalized.providerParameters,
        },
        hashes: {
            input_hash: inputHash,
            prompt_hash: promptHash,
        },
        lifecycleBoundary: {
            submission_state: "NOT_SUBMITTED",
            generated_result_state: "CANDIDATE_ONLY",
            approval_state: "SEPARATE_HUMAN_ACTION_REQUIRED",
        },
        audit: report,
    };
}

export async function auditPromptDraftInput(input: PromptDraftCompilerInput): Promise<PromptAuditReport> {
    const findings: PromptAuditFinding[] = [];
    const fail = (code: string, message: string) => findings.push({ code, status: "FAIL", message });
    const pass = (code: string, message: string) => findings.push({ code, status: "PASS", message });

    if (input.schemaVersion !== "filmos.prompt-compiler-input.v0") {
        fail("SCHEMA_VERSION_INVALID", "schemaVersion must be filmos.prompt-compiler-input.v0");
    } else {
        pass("SCHEMA_VERSION_BOUND", "Compiler input schema version verified");
    }

    if (input.feature?.key !== FILM_PROMPT_KERNEL_FLAG || input.feature.enabled !== true) {
        fail("FEATURE_DISABLED", `${FILM_PROMPT_KERNEL_FLAG} must be explicitly enabled by the caller`);
    } else {
        pass("FEATURE_ENABLED", `${FILM_PROMPT_KERNEL_FLAG} was explicitly enabled`);
    }

    if (!UUID_V4.test(input.draft?.filmEntityId ?? "")) fail("DRAFT_ID_INVALID", "PromptDraft filmEntityId must be a lowercase UUIDv4");
    if (!Number.isInteger(input.draft?.expectedVersion) || input.draft.expectedVersion < 0) fail("EXPECTED_VERSION_INVALID", "expectedVersion must be a non-negative integer");
    if (!Number.isInteger(input.draft?.targetVersion) || input.draft.targetVersion !== input.draft.expectedVersion + 1) {
        fail("TARGET_VERSION_INVALID", "targetVersion must equal expectedVersion + 1");
    }

    validateBinding(input.scope?.project, "PROJECT", "project", findings);
    validateBinding(input.scope?.shot, "SHOT", "shot", findings);
    validateBinding(input.scope?.directorUnit, "DIRECTOR_UNIT", undefined, findings);
    validateBinding(input.visualLock?.binding, "VISUAL_LOCK", undefined, findings);
    input.assets?.forEach((asset, index) => {
        validateBinding(asset.binding, `ASSET_${index}`, undefined, findings);
        if (!asset.role?.trim()) fail(`ASSET_${index}_ROLE_INVALID`, "Asset role must be explicit");
        if (!Number.isInteger(asset.priority) || asset.priority < 0 || asset.priority > 100) fail(`ASSET_${index}_PRIORITY_INVALID`, "Asset priority must be an integer from 0 to 100");
    });

    validateRequiredText(input.directorIrText, "DIRECTOR_IR_TEXT_INVALID", "Director IR text", findings);
    validateRequiredText(input.visualLock?.lockText, "VISUAL_LOCK_TEXT_INVALID", "Visual lock text", findings);
    validateTemplate(input.template, findings);
    validateCapability(input.providerCapability, findings);
    validateProviderParameters(input.providerParameters, input.providerCapability, findings);
    validateAssetCapability(input.assets, input.providerCapability, findings);

    if (!findings.some((finding) => finding.status === "FAIL")) {
        const directorHash = await sha256Text(input.directorIrText);
        if (directorHash !== input.scope.directorUnit.contentHash) fail("DIRECTOR_IR_HASH_MISMATCH", "Director IR text does not match the bound contentHash");
        else pass("DIRECTOR_IR_HASH_BOUND", "Director IR content hash verified");

        const visualLockHash = await sha256Text(input.visualLock.lockText);
        if (visualLockHash !== input.visualLock.binding.contentHash) fail("VISUAL_LOCK_HASH_MISMATCH", "Visual lock text does not match the bound contentHash");
        else pass("VISUAL_LOCK_HASH_BOUND", "Visual lock content hash verified");

        const templateHash = await sha256Text(input.template.content);
        if (templateHash !== input.template.contentHash) fail("TEMPLATE_HASH_MISMATCH", "Prompt template content does not match contentHash");
        else pass("TEMPLATE_HASH_BOUND", "Host PromptTemplate version and content hash verified");
    }

    if (!findings.some((finding) => finding.status === "FAIL")) {
        const promptText = buildPromptText(input);
        const promptCharacters = [...promptText].length;
        if (promptCharacters > input.providerCapability.limits.maxPromptCharacters) {
            fail("PROMPT_LIMIT_EXCEEDED", `Compiled prompt has ${promptCharacters} characters; provider limit is ${input.providerCapability.limits.maxPromptCharacters}`);
        } else {
            pass("PROVIDER_CAPABILITY_SATISFIED", "Provider capability and prompt limits verified without silent downgrade");
        }
    }

    if (!findings.some((finding) => finding.status === "FAIL")) {
        pass("STABLE_BINDINGS_COMPLETE", "Film IDs, Host IDs, versions, content hashes, asset hashes and visual lock hash are bound");
        pass("NO_SUBMISSION_PATH", "Compiler output is a local PromptDraft only; generated results remain Candidate-only");
    }

    return {
        status: findings.some((finding) => finding.status === "FAIL") ? "FAIL" : "PASS",
        findings,
    };
}

export async function sha256Text(value: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeInput(input: PromptDraftCompilerInput): PromptDraftCompilerInput {
    const normalizeBinding = (binding: FilmHostBinding): FilmHostBinding => ({
        ...binding,
        hostReferences: [...binding.hostReferences].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`, "en")),
    });
    return {
        ...input,
        scope: {
            project: normalizeBinding(input.scope.project),
            shot: normalizeBinding(input.scope.shot),
            directorUnit: normalizeBinding(input.scope.directorUnit),
        },
        visualLock: {
            ...input.visualLock,
            binding: normalizeBinding(input.visualLock.binding),
        },
        template: { ...input.template },
        assets: input.assets
            .map((asset) => ({ ...asset, binding: normalizeBinding(asset.binding) }))
            .sort((left, right) => `${left.role}:${left.binding.filmEntityId}`.localeCompare(`${right.role}:${right.binding.filmEntityId}`, "en")),
        providerCapability: {
            ...input.providerCapability,
            supports: { ...input.providerCapability.supports },
            requires: { ...input.providerCapability.requires },
            limits: { ...input.providerCapability.limits },
        },
        providerParameters: { ...input.providerParameters },
    };
}

function buildPromptText(input: PromptDraftCompilerInput): string {
    const assetLines = input.assets.length
        ? input.assets.map((asset) => canonicalJson({
            film_entity_id: asset.binding.filmEntityId,
            host_references: asset.binding.hostReferences,
            version: asset.binding.version,
            content_hash: asset.binding.contentHash,
            role: asset.role,
            priority: asset.priority,
        })).join("\n")
        : "[]";

    return [
        FILM_PROMPT_COMPILER_VERSION,
        "[SCOPE_BINDINGS]",
        canonicalJson({ project: input.scope.project, shot: input.scope.shot, director_unit: input.scope.directorUnit }),
        "[HOST_PROMPT_TEMPLATE]",
        canonicalJson({ id: input.template.hostPromptTemplateId, operation: input.template.operation, version: input.template.version, content_hash: input.template.contentHash }),
        input.template.content,
        "[DIRECTOR_IR]",
        input.directorIrText,
        "[VISUAL_LOCK]",
        canonicalJson(input.visualLock.binding),
        input.visualLock.lockText,
        "[ASSET_BINDINGS]",
        assetLines,
        "[PROVIDER_CAPABILITY]",
        canonicalJson(input.providerCapability),
        "[PROVIDER_PARAMETERS]",
        canonicalJson(input.providerParameters),
    ].join("\n");
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not allow non-finite numbers");
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map((key) => {
            if (record[key] === undefined) throw new TypeError(`Canonical JSON does not allow undefined at ${key}`);
            return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
        }).join(",")}}`;
    }
    throw new TypeError(`Canonical JSON does not allow ${typeof value}`);
}

function validateBinding(binding: FilmHostBinding | undefined, code: string, requiredHostKind: HostReferenceKind | undefined, findings: PromptAuditFinding[]) {
    const fail = (suffix: string, message: string) => findings.push({ code: `${code}_${suffix}`, status: "FAIL", message });
    if (!binding) {
        fail("MISSING", "Film/Host binding is required");
        return;
    }
    if (!UUID_V4.test(binding.filmEntityId)) fail("FILM_ID_INVALID", "filmEntityId must be a lowercase UUIDv4");
    if (!binding.entityType?.trim()) fail("ENTITY_TYPE_INVALID", "entityType is required");
    if (!Number.isInteger(binding.version) || binding.version < 1) fail("VERSION_INVALID", "version must be a positive integer");
    if (!SHA256.test(binding.contentHash)) fail("HASH_INVALID", "contentHash must be a lowercase SHA-256");
    if (!Array.isArray(binding.hostReferences) || binding.hostReferences.length === 0) {
        fail("HOST_REF_MISSING", "At least one explicit Host reference is required");
        return;
    }
    const seen = new Set<string>();
    binding.hostReferences.forEach((reference, index) => {
        if (!reference?.kind || !reference.id?.trim()) fail(`HOST_REF_${index}_INVALID`, "Host reference kind and id are required");
        else {
            if (!HOST_REFERENCE_KINDS.includes(reference.kind)) fail(`HOST_REF_${index}_KIND_INVALID`, "Host reference kind is outside the Film Contracts V0 allow-list");
            if (PATH_OR_PUBLIC_URL.test(reference.id.trim())) fail(`HOST_REF_${index}_ID_INVALID`, "Host reference id must be opaque, not a path or public URL");
        }
        const key = `${reference?.kind}:${reference?.id}`;
        if (seen.has(key)) fail(`HOST_REF_${index}_DUPLICATE`, "Host references must be unique");
        seen.add(key);
    });
    if (requiredHostKind && !binding.hostReferences.some((reference) => reference.kind === requiredHostKind)) {
        fail("HOST_KIND_MISSING", `A ${requiredHostKind} Host reference is required`);
    }
}

function validateRequiredText(value: string | undefined, code: string, label: string, findings: PromptAuditFinding[]) {
    if (!value?.trim()) findings.push({ code, status: "FAIL", message: `${label} must be explicit and non-empty` });
}

function validateTemplate(template: PromptDraftCompilerInput["template"] | undefined, findings: PromptAuditFinding[]) {
    const fail = (code: string, message: string) => findings.push({ code, status: "FAIL", message });
    if (!template) {
        fail("TEMPLATE_MISSING", "Host PromptTemplate binding is required");
        return;
    }
    if (!template.hostPromptTemplateId?.trim() || PATH_OR_PUBLIC_URL.test(template.hostPromptTemplateId.trim())) fail("TEMPLATE_HOST_ID_INVALID", "Host PromptTemplate id must be an opaque reference");
    if (!template.operation?.trim()) fail("TEMPLATE_OPERATION_INVALID", "PromptTemplate operation is required");
    if (!Number.isInteger(template.version) || template.version < 1) fail("TEMPLATE_VERSION_INVALID", "PromptTemplate version must be positive");
    if (!SHA256.test(template.contentHash)) fail("TEMPLATE_HASH_INVALID", "PromptTemplate contentHash must be a lowercase SHA-256");
    validateRequiredText(template.content, "TEMPLATE_CONTENT_INVALID", "PromptTemplate content", findings);
}

function validateCapability(capability: ProviderCapabilityProfile | undefined, findings: PromptAuditFinding[]) {
    const fail = (code: string, message: string) => findings.push({ code, status: "FAIL", message });
    if (!capability) {
        fail("CAPABILITY_MISSING", "Provider capability profile is required");
        return;
    }
    if (!capability.profileId?.trim() || PATH_OR_PUBLIC_URL.test(capability.profileId.trim()) || !capability.dialect?.trim()) fail("CAPABILITY_ID_INVALID", "Capability profile id must be opaque and dialect is required");
    if (!["manual_web", "dreamina_cli", "flova_cli", "comfy_bridge", "blender", "generic_api"].includes(capability.providerKind)) fail("CAPABILITY_PROVIDER_INVALID", "providerKind is not supported by Film Contracts V0");
    if (capability.providerKind === "flova_cli") fail("CAPABILITY_PROVIDER_UNVERIFIED", "Flova capability is not verified in the current source and remains DEFER");
    if (!["text", "image", "video", "audio", "scene"].includes(capability.outputKind)) fail("CAPABILITY_OUTPUT_INVALID", "outputKind is invalid");
    if (!Number.isInteger(capability.profileVersion) || capability.profileVersion < 1) fail("CAPABILITY_VERSION_INVALID", "Capability profile version must be positive");
    if (!Number.isInteger(capability.limits?.maxPromptCharacters) || capability.limits.maxPromptCharacters < 1) fail("CAPABILITY_PROMPT_LIMIT_INVALID", "maxPromptCharacters must be positive");
    if (!Number.isInteger(capability.limits?.maxReferenceAssets) || capability.limits.maxReferenceAssets < 0) fail("CAPABILITY_ASSET_LIMIT_INVALID", "maxReferenceAssets must be non-negative");
    const booleanValues = [
        capability.supports?.referenceAssets,
        capability.supports?.negativePrompt,
        capability.supports?.deterministicSeed,
        capability.supports?.cameraControl,
        capability.supports?.audio,
        capability.requires?.aspectRatio,
        capability.requires?.durationSeconds,
    ];
    if (booleanValues.some((value) => typeof value !== "boolean")) fail("CAPABILITY_BOOLEAN_INVALID", "All support and requirement capabilities must be explicit booleans");
    if (capability.outputKind === "audio" && capability.supports.audio !== true) fail("CAPABILITY_AUDIO_CONFLICT", "Audio output requires explicit audio support");
}

function validateAssetCapability(assets: readonly PromptAssetBinding[] | undefined, capability: ProviderCapabilityProfile | undefined, findings: PromptAuditFinding[]) {
    if (!assets || !capability) return;
    const fail = (code: string, message: string) => findings.push({ code, status: "FAIL" as const, message });
    if (assets.length > 0 && !capability.supports.referenceAssets) fail("REFERENCE_ASSETS_UNSUPPORTED", "Provider capability does not support reference assets");
    if (assets.length > capability.limits.maxReferenceAssets) fail("REFERENCE_ASSET_LIMIT_EXCEEDED", `Input binds ${assets.length} assets; provider limit is ${capability.limits.maxReferenceAssets}`);
}

function validateProviderParameters(parameters: ProviderParameters | undefined, capability: ProviderCapabilityProfile | undefined, findings: PromptAuditFinding[]) {
    const fail = (code: string, message: string) => findings.push({ code, status: "FAIL", message });
    if (!parameters || !capability) {
        fail("PROVIDER_PARAMETERS_MISSING", "Provider parameters are required even when their explicit value is null");
        return;
    }
    const requiredKeys: (keyof ProviderParameters)[] = ["aspectRatio", "durationSeconds", "seed", "negativePrompt"];
    if (requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(parameters, key))) {
        fail("PROVIDER_PARAMETERS_INCOMPLETE", "Every provider parameter must be present; use null when intentionally unused");
        return;
    }
    if (capability.requires.aspectRatio && !parameters.aspectRatio?.trim()) fail("ASPECT_RATIO_REQUIRED", "Provider capability requires aspectRatio");
    if (capability.requires.durationSeconds && (!Number.isFinite(parameters.durationSeconds) || (parameters.durationSeconds ?? 0) <= 0)) fail("DURATION_REQUIRED", "Provider capability requires a positive durationSeconds");
    if (parameters.seed !== null && !capability.supports.deterministicSeed) fail("SEED_UNSUPPORTED", "Provider capability does not support deterministic seed");
    if (parameters.negativePrompt !== null && !capability.supports.negativePrompt) fail("NEGATIVE_PROMPT_UNSUPPORTED", "Provider capability does not support negativePrompt");
    if (parameters.durationSeconds !== null && (!Number.isFinite(parameters.durationSeconds) || parameters.durationSeconds <= 0)) fail("DURATION_INVALID", "durationSeconds must be null or a positive number");
    if (parameters.seed !== null && !Number.isInteger(parameters.seed)) fail("SEED_INVALID", "seed must be null or an integer");
}
