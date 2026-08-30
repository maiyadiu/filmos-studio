import { GENERATION_ENGINES, assertGenerationEngineConnectionInvariant, type CatalogEvidence, type GenerationCatalogSnapshot, type GenerationEngineConnection } from "@filmos/generation-contracts";

import type { DreaminaLocalModel } from "@/services/local-dreamina-model-catalog";
import type { ComfyBridgeWorkflow, RunningHubWorkflow } from "@/stores/use-config-store";

export type RuntimeGenerationDescriptorOption = {
    kind: "model" | "workflow" | "skill";
    id: string;
    engineId: string;
    connectionId: string;
    label: string;
    capability: "image" | "video" | "audio" | "workflow";
    disabled: boolean;
    schema: {
        aspectRatios: string[];
        resolutionTiers: string[];
        durationsSeconds: number[];
        fps: number[];
        maxReferences?: number;
    };
};

export function routableGenerationEngineOptions(connections: readonly GenerationEngineConnection[]) {
    return GENERATION_ENGINES.flatMap((engine) => connections
        .filter((connection) => connection.engineId === engine.engineId)
        .flatMap((connection) => {
            try { assertGenerationEngineConnectionInvariant(connection); } catch { return []; }
            if (!connection.enabled || connection.status !== "ready") return [];
            return [{ value: `${engine.engineId}|${connection.connectionId}`, engineId: engine.engineId, connectionId: connection.connectionId, label: engine.displayName, capabilities: engine.capabilities }];
        }));
}

export function buildRuntimeGenerationDescriptorOptions(input: {
    dreaminaModels: readonly DreaminaLocalModel[];
    runningHubWorkflows: readonly RunningHubWorkflow[];
    comfyWorkflows: readonly ComfyBridgeWorkflow[];
}): RuntimeGenerationDescriptorOption[] {
    const dreamina = input.dreaminaModels.map((model): RuntimeGenerationDescriptorOption => ({
        kind: "model", id: model.id, engineId: "dreamina_cli", connectionId: "dreamina-local", label: model.displayName,
        capability: model.modality, disabled: !model.adapterSupported || model.currentlyObservedAvailable === "no",
        schema: {
            aspectRatios: [...model.settings.aspects], resolutionTiers: [...(model.settings.tiers || [])],
            durationsSeconds: model.settings.minDuration && model.settings.maxDuration ? integerRange(model.settings.minDuration, model.settings.maxDuration) : [],
            fps: [], maxReferences: model.settings.maxReferenceImages,
        },
    }));
    const runningHub = input.runningHubWorkflows.map((workflow): RuntimeGenerationDescriptorOption => ({
        kind: "workflow", id: workflow.workflowId, engineId: "runninghub", connectionId: "runninghub-default", label: workflow.title || workflow.workflowId,
        capability: workflow.capability || "image", disabled: false, schema: workflowSchema(workflow.fields),
    }));
    const comfy = input.comfyWorkflows.map((workflow): RuntimeGenerationDescriptorOption => ({
        kind: "workflow", id: workflow.workflowId, engineId: "comfyui", connectionId: "comfyui-default", label: workflow.title || workflow.workflowId,
        capability: workflow.capability || "image", disabled: false, schema: workflowSchema(workflow.fields),
    }));
    const manual: RuntimeGenerationDescriptorOption = {
        kind: "skill", id: "manual-contract-v1", engineId: "manual_web", connectionId: "manual", label: "人工生成包合同 V1",
        capability: "workflow", disabled: false, schema: { aspectRatios: [], resolutionTiers: [], durationsSeconds: [], fps: [] },
    };
    return [...dreamina, ...runningHub, ...comfy, manual];
}

export function generationCatalogDescriptorOptions(catalog: GenerationCatalogSnapshot): RuntimeGenerationDescriptorOption[] {
    const models = catalog.models.map((model): RuntimeGenerationDescriptorOption => ({
        kind: "model",
        id: model.modelId,
        engineId: model.engineId,
        connectionId: model.connectionId,
        label: model.displayName,
        capability: model.capability,
        disabled: model.availability !== "available",
        schema: {
            aspectRatios: [...(model.constraints.supportedAspectRatios || [])],
            resolutionTiers: [...(model.constraints.supportedResolutionTiers || [])],
            durationsSeconds: [...(model.constraints.supportedDurationsSeconds || [])],
            fps: [...(model.constraints.supportedFps || [])],
            maxReferences: model.constraints.maxReferences,
        },
    }));
    const workflows = catalog.workflows.map((workflow): RuntimeGenerationDescriptorOption => ({
        kind: "workflow",
        id: workflow.workflowId,
        engineId: workflow.engineId,
        connectionId: workflow.connectionId,
        label: workflow.displayName,
        capability: workflow.capability,
        disabled: false,
        schema: descriptorSchema(workflow.inputSchema),
    }));
    const skills = catalog.skills.map((skill): RuntimeGenerationDescriptorOption => ({
        kind: "skill",
        id: skill.skillId,
        engineId: skill.engineId,
        connectionId: skill.connectionId,
        label: skill.displayName,
        capability: "workflow",
        disabled: false,
        schema: descriptorSchema(skill.inputSchema || {}),
    }));
    return [...models, ...workflows, ...skills];
}

export function catalogEvidenceLabel(evidence: CatalogEvidence | { source: CatalogEvidence["source"] }): string {
    if (evidence.source === "runtime_discovery") return "Runtime Discovery";
    if (evidence.source === "remote_catalog") return "Remote Catalog";
    if (evidence.source === "verified_static_version_bound") return "Verified Static · CLI Version Bound";
    return "Manual Unverified";
}

function workflowSchema(fields: readonly { source?: string; fieldValue?: unknown; options?: unknown[]; min?: unknown; max?: unknown }[] | undefined): RuntimeGenerationDescriptorOption["schema"] {
    const list = fields || [];
    const options = (source: string) => list.find((field) => field.source === source)?.options?.map(String) || [];
    const duration = list.find((field) => field.source === "videoSeconds");
    return {
        aspectRatios: options("aspectRatio"), resolutionTiers: [...options("vquality"), ...options("size")],
        durationsSeconds: numericOptions(duration), fps: options("fps").map(Number).filter(Number.isFinite),
    };
}

function descriptorSchema(schema: Record<string, unknown>): RuntimeGenerationDescriptorOption["schema"] {
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
        ? schema.properties as Record<string, { enum?: unknown[] }>
        : {};
    const values = (key: string) => Array.isArray(properties[key]?.enum) ? properties[key].enum!.map(String) : [];
    return {
        aspectRatios: values("aspectRatio"),
        resolutionTiers: values("resolution"),
        durationsSeconds: values("durationSeconds").map(Number).filter(Number.isFinite),
        fps: values("fps").map(Number).filter(Number.isFinite),
    };
}

function numericOptions(field: { options?: unknown[]; min?: unknown; max?: unknown } | undefined): number[] {
    if (field?.options) return field.options.map(Number).filter(Number.isFinite);
    const min = Number(field?.min); const max = Number(field?.max);
    return Number.isInteger(min) && Number.isInteger(max) && min <= max ? integerRange(min, max) : [];
}

function integerRange(min: number, max: number) { return Array.from({ length: max - min + 1 }, (_value, index) => min + index); }
