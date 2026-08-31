import { hashProjection, type GenerationReferenceBinding } from "@filmos/generation-contracts";

import {
    queryLocalDreaminaGenerationTask,
    refreshLocalDreaminaGenerationTask,
    runLocalDreaminaGenerationTask,
    type LocalDreaminaGenerationInput,
    type LocalDreaminaGenerationResult,
    type LocalDreaminaGenerationTask,
    type LocalDreaminaReference,
} from "@/services/local-dreamina-generation";
import { getLocalRuntimeSessionClient } from "@/stores/use-local-runtime-store";
import type { ProductionProviderExecutionPort } from "./production-provider-adapters";
import type {
    AuthorizedProviderSubmission,
    ProductionAuthorizationBundle,
    ProviderOutputReceipt,
    ProviderTaskLookup,
    ProviderTaskReceipt,
    ProviderTaskStatus,
} from "./production-composition";
import { productionReleasePolicyFromEnvironment } from "./production-composition";

export type DreaminaExecutionAuthorizationChallenge = {
    authorizedSubmissionId: string;
    confirmationId: string;
    brokerDecisionReceiptId: string;
    idempotencyKey: string;
    estimatedCostMicrounits: string;
    costUnit: string;
    expiresAt: string;
};

export type DreaminaExecutionAuthorizationDecision = {
    authorized: boolean;
    authorizationId?: string;
};

type DreaminaExecutionClient = {
    run(input: LocalDreaminaGenerationInput, idempotencyKey: string, onTaskUpdate: (task: LocalDreaminaGenerationTask) => void, signal?: AbortSignal): Promise<LocalDreaminaGenerationResult>;
    query(idempotencyKey: string, signal?: AbortSignal): Promise<LocalDreaminaGenerationTask>;
    refresh(idempotencyKey: string, signal?: AbortSignal): Promise<LocalDreaminaGenerationTask>;
};

export type DreaminaProductionExecutionPortOptions = {
    authorize(challenge: DreaminaExecutionAuthorizationChallenge): Promise<DreaminaExecutionAuthorizationDecision>;
    loadAuthorization(authorizedSubmissionId: string): Promise<ProductionAuthorizationBundle | undefined>;
    resolveReference?(reference: GenerationReferenceBinding): Promise<LocalDreaminaReference>;
    client?: DreaminaExecutionClient;
    now?: () => string;
    externalPaidSubmitEnabled?: boolean;
};

/**
 * Production adapter over the existing signed Dreamina Runtime. It never invokes
 * the CLI directly and cannot cross the paid boundary without a one-shot user
 * authorization decision bound to the canonical Broker submission.
 */
export class DreaminaProductionExecutionPort implements ProductionProviderExecutionPort {
    private readonly client: DreaminaExecutionClient;
    private readonly now: () => string;
    private readonly receipts = new Map<string, ProviderTaskReceipt>();

    constructor(private readonly options: DreaminaProductionExecutionPortOptions) {
        this.client = options.client ?? browserDreaminaExecutionClient();
        this.now = options.now ?? (() => new Date().toISOString());
    }

    async submit(input: AuthorizedProviderSubmission): Promise<ProviderTaskReceipt> {
        if (!(this.options.externalPaidSubmitEnabled ?? productionReleasePolicyFromEnvironment().externalPaidSubmitEnabled)) {
            throw new Error("PILOT_EXTERNAL_PAID_SUBMIT_DISABLED");
        }
        const challenge = authorizationChallenge(input.authorization, this.now());
        const decision = await this.options.authorize(challenge);
        if (!decision.authorized || !decision.authorizationId?.trim()) throw new Error("READY_FOR_USER_AUTHORIZATION");
        const existing = this.receipts.get(challenge.idempotencyKey);
        if (existing) return structuredClone(existing);
        let lastTask: LocalDreaminaGenerationTask | undefined;
        const request = await this.request(input.authorization);
        const result = await this.client.run(request, challenge.idempotencyKey, (task) => { lastTask = task; });
        const receipt = await receiptFromResult({
            lookup: {
                providerTaskId: lastTask?.id ?? challenge.idempotencyKey,
                authorizedSubmissionId: challenge.authorizedSubmissionId,
                idempotencyKey: challenge.idempotencyKey,
            },
            authorization: input.authorization,
            result,
            submittedAt: lastTask?.createdAt ?? input.now,
            completedAt: lastTask?.updatedAt ?? this.now(),
        });
        this.receipts.set(challenge.idempotencyKey, receipt);
        return structuredClone(receipt);
    }

    async getStatus(input: ProviderTaskLookup): Promise<ProviderTaskStatus> {
        const known = this.receipts.get(input.idempotencyKey);
        if (known) return { providerTaskId: known.providerTaskId, state: "succeeded", observedAt: known.completedAt, receipt: structuredClone(known) };
        return this.statusFromTask(input, await this.client.query(input.idempotencyKey));
    }

    async reconcile(input: ProviderTaskLookup): Promise<ProviderTaskStatus> {
        const known = this.receipts.get(input.idempotencyKey);
        if (known) return { providerTaskId: known.providerTaskId, state: "succeeded", observedAt: known.completedAt, receipt: structuredClone(known) };
        return this.statusFromTask(input, await this.client.refresh(input.idempotencyKey));
    }

    async downloadOutputs(input: ProviderTaskReceipt): Promise<ProviderOutputReceipt[]> {
        const task = await this.client.query(input.idempotencyKey);
        if (task.status !== "succeeded" || !task.result) throw new Error("DREAMINA_OUTPUT_NOT_READY");
        return outputReceipts(task.result);
    }

    private async statusFromTask(input: ProviderTaskLookup, task: LocalDreaminaGenerationTask): Promise<ProviderTaskStatus> {
        const state = task.status === "queued" ? "queued"
            : task.status === "running" ? "running"
                : task.status === "succeeded" ? "succeeded"
                    : task.stage === "submission_unknown" ? "submission_unknown"
                        : "failed";
        if (state !== "succeeded" || !task.result) return { providerTaskId: task.id, state, observedAt: task.updatedAt };
        const authorization = await this.options.loadAuthorization(input.authorizedSubmissionId);
        if (!authorization || authorization.authorizedSubmission.idempotencyKey !== input.idempotencyKey) {
            return { providerTaskId: task.id, state: "submission_unknown", observedAt: task.updatedAt };
        }
        const receipt = await receiptFromResult({ lookup: { ...input, providerTaskId: task.id }, authorization, result: task.result, submittedAt: task.createdAt, completedAt: task.updatedAt });
        this.receipts.set(input.idempotencyKey, receipt);
        return { providerTaskId: task.id, state: "succeeded", observedAt: task.updatedAt, receipt: structuredClone(receipt) };
    }

    private async request(authorization: ProductionAuthorizationBundle): Promise<LocalDreaminaGenerationInput> {
        const route = authorization.preview.routeSnapshot;
        if (route.engineId !== "dreamina_cli" || !route.modelId) throw new Error("DREAMINA_EXACT_MODEL_REQUIRED");
        const references = route.references.length
            ? await Promise.all(route.references.map((reference) => {
                if (!this.options.resolveReference) throw new Error("DREAMINA_REFERENCE_RESOLVER_REQUIRED");
                return this.options.resolveReference(reference);
            }))
            : [];
        const mode = route.capability === "video" ? "video" : route.capability === "image" ? "image" : undefined;
        if (!mode) throw new Error("DREAMINA_CAPABILITY_UNSUPPORTED");
        const parameters = route.normalizedParameters;
        return {
            model: `local:dreamina-cli:${route.modelId.replace(/^local:dreamina-cli:/, "")}`,
            mode,
            prompt: authorization.preview.compiledPromptReceipt.text,
            settings: {
                ...(stringParameter(parameters, "aspectRatio", "aspect") ? { aspect: stringParameter(parameters, "aspectRatio", "aspect") } : {}),
                ...(stringParameter(parameters, "resolution", "resolutionType") ? { resolution: stringParameter(parameters, "resolution", "resolutionType") } : {}),
                ...(integerParameter(parameters, "durationSeconds", "duration") ? { duration: integerParameter(parameters, "durationSeconds", "duration") } : {}),
                ...(integerParameter(parameters, "count") ? { count: integerParameter(parameters, "count") } : {}),
            },
            references,
            idempotencyKey: authorization.authorizedSubmission.idempotencyKey,
            clientOperationId: authorization.authorizedSubmission.authorizedSubmissionId,
            context: {
                scope: "scoped",
                projectId: authorization.preview.projectId,
                nodeId: authorization.preview.nodeId,
                attemptGroupId: authorization.preview.generationAttemptId,
            },
        };
    }
}

export function dreaminaExecutionReadiness(input: {
    runtimeReady: boolean;
    catalogReady: boolean;
    canonicalBrokerReady: boolean;
    authorizationArmed: boolean;
}): "READY_FOR_USER_AUTHORIZATION" | "FAIL" {
    if (!input.runtimeReady || !input.catalogReady || !input.canonicalBrokerReady) return "FAIL";
    // A cached/armed decision is not evidence that a paid production submit is
    // authorized for the next exact command. Final readiness therefore remains
    // at the user-authorization gate until submit() validates the one-shot
    // canonical challenge; it must never be advertised as an automated pass.
    return "READY_FOR_USER_AUTHORIZATION";
}

function browserDreaminaExecutionClient(): DreaminaExecutionClient {
    const runtime = getLocalRuntimeSessionClient();
    return {
        run: (input, idempotencyKey, onTaskUpdate, signal) => runLocalDreaminaGenerationTask(input, { client: runtime, idempotencyKey: () => idempotencyKey, onTaskUpdate }, signal),
        query: (idempotencyKey, signal) => queryLocalDreaminaGenerationTask(idempotencyKey, undefined, { client: runtime }, signal),
        refresh: (idempotencyKey, signal) => refreshLocalDreaminaGenerationTask(idempotencyKey, { client: runtime }, signal),
    };
}

function authorizationChallenge(authorization: ProductionAuthorizationBundle, now: string): DreaminaExecutionAuthorizationChallenge {
    const authorized = authorization.authorizedSubmission;
    if (!authorized.confirmationId || !authorized.brokerDecisionReceiptId || !authorized.authorizedSubmissionId) throw new Error("DREAMINA_CANONICAL_BROKER_AUTHORIZATION_REQUIRED");
    if (Date.parse(authorized.catalogValidationSubmitNotAfter) < Date.parse(now)) throw new Error("DREAMINA_AUTHORIZATION_EXPIRED");
    const estimated = authorization.preview.proposal.estimatedCost;
    if (!authorization.preview.proposal.estimateAvailable || !estimated) throw new Error("DREAMINA_COST_ESTIMATE_REQUIRED");
    return {
        authorizedSubmissionId: authorized.authorizedSubmissionId,
        confirmationId: authorized.confirmationId,
        brokerDecisionReceiptId: authorized.brokerDecisionReceiptId,
        idempotencyKey: authorized.idempotencyKey,
        estimatedCostMicrounits: estimated.amountMicrounits,
        costUnit: estimated.unit,
        expiresAt: authorized.catalogValidationSubmitNotAfter,
    };
}

async function receiptFromResult(input: {
    lookup: ProviderTaskLookup;
    authorization: ProductionAuthorizationBundle;
    result: LocalDreaminaGenerationResult;
    submittedAt: string;
    completedAt: string;
}): Promise<ProviderTaskReceipt> {
    const outputs = await outputReceipts(input.result);
    if (!outputs.length) throw new Error("DREAMINA_OUTPUT_RECEIPT_REQUIRED");
    const outputHash = await hashProjection("dreamina-output-set", "semantic", outputs.map((item) => ({ outputAssetVersionId: item.outputAssetVersionId, outputHash: item.outputHash, mediaType: item.mediaType })));
    const cost = input.authorization.preview.proposal.estimatedCost;
    if (!input.authorization.preview.proposal.estimateAvailable || !cost) throw new Error("DREAMINA_COST_ESTIMATE_REQUIRED");
    const base = {
        providerReceiptId: `dreamina-receipt-${outputHash.slice(0, 24)}`,
        providerTaskId: input.lookup.providerTaskId,
        authorizedSubmissionId: input.lookup.authorizedSubmissionId,
        idempotencyKey: input.lookup.idempotencyKey,
        outputHash,
        outputAssetVersionId: outputs[0]!.outputAssetVersionId,
        status: "succeeded" as const,
        externalNetworkRequests: 1,
        externalSpendMicrounits: cost.amountMicrounits,
        submittedAt: input.submittedAt,
        completedAt: input.completedAt,
    };
    return { ...base, contentHash: await hashProjection("dreamina-provider-receipt", "envelope", base) };
}

async function outputReceipts(result: LocalDreaminaGenerationResult): Promise<ProviderOutputReceipt[]> {
    const media = result.mode === "image"
        ? (result.images ?? []).map((item) => ({ dataUrl: item.dataUrl, mediaType: item.mimeType }))
        : result.video ? [{ dataUrl: result.video.dataUrl, mediaType: result.video.mimeType }] : [];
    return Promise.all(media.map(async (item, index) => {
        const outputHash = await hashProjection("dreamina-output", "semantic", { index, mediaType: item.mediaType, dataUrl: item.dataUrl });
        const base = { outputAssetVersionId: `dreamina-asset-version-${outputHash.slice(0, 24)}`, outputHash, mediaType: item.mediaType };
        return { ...base, contentHash: await hashProjection("provider-output-receipt", "envelope", base) };
    }));
}

function stringParameter(parameters: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) if (typeof parameters[key] === "string" && parameters[key]) return parameters[key] as string;
    return undefined;
}

function integerParameter(parameters: Record<string, unknown>, ...keys: string[]): number | undefined {
    for (const key of keys) if (Number.isSafeInteger(parameters[key]) && (parameters[key] as number) > 0) return parameters[key] as number;
    return undefined;
}
