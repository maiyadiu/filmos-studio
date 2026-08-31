import {
    hashGenerationEngineConnection,
    type GenerationEngineConnection,
} from "@filmos/generation-contracts";

import type { DreaminaCliStatus } from "@/services/local-dreamina-cli";
import type { BrainGenerationRoutingConfig } from "./user-config";
import {
    localAccountBindingRef,
    type LocalAccountBindingRefResolver,
} from "./local-account-binding-ref";

export type EngineConnectionObservation = {
    engineId: string;
    connectionId: string;
    authScope: "account" | "local_instance" | "anonymous" | "manual";
    status: GenerationEngineConnection["status"];
    accountBindingRef?: GenerationEngineConnection["accountBindingRef"];
    connectionInstanceRef: GenerationEngineConnection["connectionInstanceRef"];
    catalogSnapshotId?: string;
    catalogEvidenceSource?: string;
    observedAt: string;
    errorCode?: string;
};

export type EngineConnectionSyncResult = {
    config: BrainGenerationRoutingConfig;
    changedConnectionIds: string[];
    bindingRotatedConnectionIds: string[];
};

export class EngineConnectionSynchronizer {
    async synchronize(config: BrainGenerationRoutingConfig, observations: readonly EngineConnectionObservation[]): Promise<EngineConnectionSyncResult> {
        const byKey = new Map(observations.map((observation) => [key(observation.engineId, observation.connectionId), observation]));
        const changedConnectionIds: string[] = [];
        const bindingRotatedConnectionIds: string[] = [];
        const engineConnections = await Promise.all(config.engineConnections.map(async (current) => {
            const observation = byKey.get(key(current.engineId, current.connectionId));
            if (!observation) return current;
            if (observation.authScope !== current.authScope || observation.connectionInstanceRef !== current.connectionInstanceRef) {
                throw new Error("ENGINE_CONNECTION_OBSERVATION_SCOPE_MISMATCH");
            }
            const bindingRotated = current.accountBindingRef !== observation.accountBindingRef;
            const nextBase: Omit<GenerationEngineConnection, "contentHash"> = {
                schemaVersion: 1,
                entityVersion: current.entityVersion + 1,
                connectionId: current.connectionId,
                engineId: current.engineId,
                enabled: current.enabled,
                authScope: current.authScope,
                status: observation.status,
                ...(observation.accountBindingRef ? { accountBindingRef: observation.accountBindingRef } : {}),
                connectionInstanceRef: current.connectionInstanceRef,
                ...(current.region ? { region: current.region } : {}),
                ...(current.endpointProfileId ? { endpointProfileId: current.endpointProfileId } : {}),
                lastCheckedAt: observation.observedAt,
                ...(observation.errorCode ? { lastError: observation.errorCode } : {}),
                createdAt: current.createdAt,
                updatedAt: observation.observedAt,
            };
            const semanticallyEqual = current.status === nextBase.status
                && current.accountBindingRef === nextBase.accountBindingRef
                && current.lastError === nextBase.lastError;
            if (semanticallyEqual && current.lastCheckedAt === nextBase.lastCheckedAt) return current;
            changedConnectionIds.push(current.connectionId);
            if (bindingRotated) bindingRotatedConnectionIds.push(current.connectionId);
            return { ...nextBase, contentHash: await hashGenerationEngineConnection(nextBase) };
        }));
        if (!changedConnectionIds.length) return { config, changedConnectionIds, bindingRotatedConnectionIds };
        const rotated = new Set(bindingRotatedConnectionIds);
        const generationDefaults = Object.fromEntries(Object.entries(config.generationDefaults).filter(([, route]) => !route || !rotated.has(route.connectionId))) as BrainGenerationRoutingConfig["generationDefaults"];
        return {
            config: { ...config, engineConnections, generationDefaults },
            changedConnectionIds,
            bindingRotatedConnectionIds,
        };
    }
}

export async function dreaminaConnectionObservation(input: {
    current: GenerationEngineConnection;
    runtimeConnected: boolean;
    moduleAvailable: boolean;
    status?: DreaminaCliStatus;
    observedAt?: string;
    accountBindingRefResolver?: LocalAccountBindingRefResolver;
}): Promise<EngineConnectionObservation> {
    const observedAt = input.observedAt || new Date().toISOString();
    const status = !input.runtimeConnected
        ? "offline"
        : !input.moduleAvailable || input.status?.state === "missing"
            ? "not_installed"
            : input.status?.authenticated && input.status.accountBinding
                ? "ready"
                : input.status?.state === "error"
                    ? "degraded"
                    : input.status?.state === "installed" || input.status?.state === "login_pending"
                        ? "auth_required"
                        : "not_configured";
    const accountBindingRef = input.status?.authenticated && input.status.accountBinding
        ? await pseudonymousAccountBindingRef("dreamina_cli", input.status.accountBinding, input.accountBindingRefResolver)
        : undefined;
    return {
        engineId: "dreamina_cli",
        connectionId: input.current.connectionId,
        authScope: input.current.authScope,
        status,
        ...(accountBindingRef ? { accountBindingRef } : {}),
        connectionInstanceRef: input.current.connectionInstanceRef,
        ...(input.status?.version ? { catalogEvidenceSource: `runtime_discovery:${input.status.version}` } : {}),
        observedAt,
        ...(input.status?.code ? { errorCode: input.status.code } : {}),
    };
}

export async function configuredEngineConnectionObservation(input: {
    current: GenerationEngineConnection;
    configured: boolean;
    doctorPassed: boolean;
    accountSource?: string;
    observedAt?: string;
    offline?: boolean;
    errorCode?: string;
    catalogSnapshotId?: string;
    catalogEvidenceSource?: string;
    accountBindingRefResolver?: LocalAccountBindingRefResolver;
}): Promise<EngineConnectionObservation> {
    const accountBindingRef = input.current.authScope === "account" && input.accountSource
        ? await pseudonymousAccountBindingRef(input.current.engineId, input.accountSource, input.accountBindingRefResolver)
        : undefined;
    const status = !input.configured
        ? "not_configured"
        : input.offline
            ? "offline"
            : input.doctorPassed
                ? "ready"
                : input.current.authScope === "account" && !accountBindingRef
                    ? "auth_required"
                    : "degraded";
    return {
        engineId: input.current.engineId,
        connectionId: input.current.connectionId,
        authScope: input.current.authScope,
        status,
        ...(accountBindingRef ? { accountBindingRef } : {}),
        connectionInstanceRef: input.current.connectionInstanceRef,
        ...(input.catalogSnapshotId ? { catalogSnapshotId: input.catalogSnapshotId } : {}),
        ...(input.catalogEvidenceSource ? { catalogEvidenceSource: input.catalogEvidenceSource } : {}),
        observedAt: input.observedAt || new Date().toISOString(),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    };
}

/**
 * Flova project selection is local Film Core policy evidence, not proof of CLI
 * authentication.  Selection alone therefore advances only to auth_required;
 * ready additionally requires an observed authenticated Doctor result.
 */
export async function flovaProjectSelectionObservation(input: {
    current: GenerationEngineConnection;
    externalProjectId?: string;
    doctorPassed: boolean;
    authenticatedAccountSource?: string;
    observedAt?: string;
    errorCode?: string;
    accountBindingRefResolver?: LocalAccountBindingRefResolver;
}): Promise<EngineConnectionObservation> {
    if (input.current.engineId !== "flova_cli") throw new Error("FLOVA_CONNECTION_REQUIRED");
    const projectSelected = Boolean(input.externalProjectId?.trim());
    const accountBindingRef = projectSelected && input.doctorPassed && input.authenticatedAccountSource
        ? await pseudonymousAccountBindingRef("flova_cli", input.authenticatedAccountSource, input.accountBindingRefResolver)
        : undefined;
    return {
        engineId: input.current.engineId,
        connectionId: input.current.connectionId,
        authScope: input.current.authScope,
        status: !projectSelected ? "not_configured" : accountBindingRef ? "ready" : "auth_required",
        ...(accountBindingRef ? { accountBindingRef } : {}),
        connectionInstanceRef: input.current.connectionInstanceRef,
        observedAt: input.observedAt || new Date().toISOString(),
        ...(!projectSelected ? { errorCode: "READY_FOR_USER_SELECTION" } : input.errorCode ? { errorCode: input.errorCode } : {}),
    };
}

export async function pseudonymousAccountBindingRef(
    engineId: string,
    sourceBinding: string,
    resolver: LocalAccountBindingRefResolver = localAccountBindingRef,
): Promise<GenerationEngineConnection["accountBindingRef"]> {
    return await resolver(engineId, sourceBinding) as GenerationEngineConnection["accountBindingRef"];
}

function key(engineId: string, connectionId: string) {
    return `${engineId}\0${connectionId}`;
}
