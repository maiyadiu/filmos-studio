import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, App, Button, Checkbox, Input, InputNumber, Select, Switch, Tag } from "antd";
import {
    USER_SELECTABLE_BRAIN_PROFILE_IDS,
    type CatalogEvidence,
    type GenerationTaskKind,
    type UserSelectableBrainProfileId,
} from "@filmos/generation-contracts";

import { FilmCoreHttpProductionGenerationAuthority } from "@/film/generation-routing/film-core-production-authority";
import {
    buildProjectProductionBindingsV2,
    projectGenerationConnectionPolicyInputs,
} from "@/film/generation-routing/project-production-authority-builder";
import {
    normalizeProjectProductionBindings,
    type ProjectProductionBindings,
    type ProjectProductionBindingsV2,
} from "@/film/generation-routing/project-production-runtime";
import {
    buildRuntimeGenerationDescriptorOptions,
    catalogEvidenceLabel,
    createRuntimeGenerationCatalogSnapshot,
} from "@/film/generation-routing/runtime-catalog";
import { useBrainGenerationRoutingStore } from "@/stores/use-brain-generation-routing-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { useLocalDreaminaModelStore } from "@/stores/use-local-dreamina-model-store";

const BRAIN_LABELS: Record<UserSelectableBrainProfileId, string> = {
    "codex.subscription": "Codex 订阅",
    "chatgpt.subscription.host": "ChatGPT 订阅 Host",
    "openai.api": "OpenAI API",
    "anthropic.api": "Anthropic API",
    "deepseek.api": "DeepSeek API",
    "local.model": "本地模型",
};

const TASK_OPTIONS: Array<{ value: GenerationTaskKind; label: string }> = [
    { value: "text_to_image", label: "文生图" },
    { value: "reference_to_image", label: "参考图生图" },
    { value: "text_to_video", label: "文生视频" },
    { value: "image_to_video", label: "图生视频" },
    { value: "audio", label: "音频" },
    { value: "workflow", label: "工作流" },
];

export function ProjectAIGenerationSettings({ projectId, projectName }: { projectId: string; projectName: string }) {
    const { message } = App.useApp();
    const routing = useBrainGenerationRoutingStore((state) => state.config);
    const routingDocument = useBrainGenerationRoutingStore((state) => state.document);
    const effectiveConfig = useEffectiveConfig();
    const dreaminaModels = useLocalDreaminaModelStore((state) => state.models);
    const dreaminaSnapshot = useLocalDreaminaModelStore((state) => state.snapshot);
    const descriptors = useMemo(() => buildRuntimeGenerationDescriptorOptions({
        dreaminaModels,
        runningHubWorkflows: effectiveConfig.runningHub.workflows,
        comfyWorkflows: effectiveConfig.comfyBridge.workflows,
    }), [dreaminaModels, effectiveConfig.comfyBridge.workflows, effectiveConfig.runningHub.workflows]);
    const connections = routing?.engineConnections || [];
    const [connectionId, setConnectionId] = useState("");
    const selectedConnection = connections.find((item) => item.connectionId === connectionId);
    const descriptorOptions = descriptors.filter((item) => item.connectionId === connectionId && !item.disabled);
    const [descriptorValue, setDescriptorValue] = useState("");
    const selectedDescriptor = descriptorOptions.find((item) => `${item.kind}|${item.id}` === descriptorValue);
    const [taskKind, setTaskKind] = useState<GenerationTaskKind>("text_to_image");
    const [defaultBrain, setDefaultBrain] = useState<UserSelectableBrainProfileId>("codex.subscription");
    const [allowedBrains, setAllowedBrains] = useState<UserSelectableBrainProfileId[]>(["codex.subscription", "chatgpt.subscription.host"]);
    const [externalProjectId, setExternalProjectId] = useState("");
    const [strictLock, setStrictLock] = useState(true);
    const [allowUpload, setAllowUpload] = useState(false);
    const [maxTasks, setMaxTasks] = useState(20);
    const [maxCostMicrounits, setMaxCostMicrounits] = useState("0");
    const [costUnit, setCostUnit] = useState("unknown");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [loadState, setLoadState] = useState<"configured" | "not_configured" | "unavailable">("not_configured");
    const [loadedBindings, setLoadedBindings] = useState<ProjectProductionBindingsV2>();

    useEffect(() => {
        let active = true;
        const authority = new FilmCoreHttpProductionGenerationAuthority(async () => new Map());
        void authority.loadProjectAuthority<ProjectProductionBindings>(projectId)
            .then(async (stored) => {
                if (!active || !stored) return;
                const bindings = await normalizeProjectProductionBindings(stored.bindings);
                setLoadedBindings(bindings);
                const routeEntry = Object.entries(bindings.projectPolicy.defaultRoutes).find((entry) => Boolean(entry[1]));
                const route = routeEntry?.[1];
                const connection = route ? bindings.connections.find((item) => item.connectionId === route.connectionId) : bindings.connections[0];
                if (!connection) throw new Error("PROJECT_ENGINE_CONNECTION_REQUIRED");
                const grantId = bindings.projectPolicy.budgetGrantIdsByConnection[connection.connectionId];
                const grant = bindings.grants.find((item) => item.grantId === grantId);
                const ledger = bindings.ledgers.find((item) => item.grantId === grantId);
                if (!grant || !ledger) throw new Error("PROJECT_GENERATION_BUDGET_SCOPE_MISMATCH");
                setLoadState("configured");
                setConnectionId(connection.connectionId);
                if (routeEntry) setTaskKind(routeEntry[0] as GenerationTaskKind);
                if (route) setDescriptorValue(route.modelId ? `model|${route.modelId}` : route.workflowId ? `workflow|${route.workflowId}` : route.skillId ? `skill|${route.skillId}` : "");
                if (bindings.brainPolicy?.defaultProfileId) setDefaultBrain(bindings.brainPolicy.defaultProfileId);
                if (bindings.brainPolicy?.allowedProfileIds.length) setAllowedBrains(bindings.brainPolicy.allowedProfileIds);
                setExternalProjectId(bindings.projectPolicy.externalProjectBindings[connection.engineId]?.find((item) => item.connectionId === connection.connectionId)?.externalProjectId || "");
                setStrictLock(Boolean(Object.keys(bindings.projectPolicy.modelLocksByTask).length));
                setAllowUpload(bindings.projectPolicy.uploadPolicy.allowProviderUpload);
                setMaxTasks(grant.maxTasks);
                setMaxCostMicrounits(grant.maxTotalCost?.amountMicrounits || "0");
                setCostUnit(grant.maxTotalCost?.unit || ledger.costUnit || "unknown");
            })
            .catch(() => { if (active) setLoadState("unavailable"); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [projectId]);

    useEffect(() => {
        if (connectionId || !connections.length) return;
        const first = connections.find((item) => item.enabled && item.status === "ready") || connections[0];
        setConnectionId(first?.connectionId || "");
    }, [connectionId, connections]);

    useEffect(() => {
        if (selectedDescriptor || !descriptorOptions.length) return;
        const compatible = descriptorOptions.find((item) => taskCompatible(item.capability, taskKind)) || descriptorOptions[0];
        setDescriptorValue(`${compatible.kind}|${compatible.id}`);
    }, [descriptorOptions, selectedDescriptor, taskKind]);

    const save = async () => {
        if (!selectedConnection) throw new Error("PROJECT_ENGINE_CONNECTION_REQUIRED");
        if (selectedConnection.status !== "ready") throw new Error("PROJECT_ENGINE_CONNECTION_NOT_READY");
        if (!selectedDescriptor) throw new Error(selectedConnection.engineId === "flova_cli" ? "READY_FOR_USER_SELECTION" : "PROJECT_GENERATION_DESCRIPTOR_REQUIRED");
        if (!allowedBrains.includes(defaultBrain)) throw new Error("PROJECT_DEFAULT_BRAIN_NOT_ALLOWED");
        if (selectedConnection.engineId === "flova_cli" && !externalProjectId.trim()) throw new Error("FLOVA_EXTERNAL_PROJECT_SELECTION_REQUIRED");
        setSaving(true);
        try {
            const evidence = catalogEvidence(selectedConnection.engineId, dreaminaSnapshot?.evidence);
            if (!evidence) throw new Error("DREAMINA_CATALOG_EVIDENCE_REQUIRED");
            const catalog = await createRuntimeGenerationCatalogSnapshot({ connection: selectedConnection, descriptors, evidence });
            const route = {
                engineId: selectedConnection.engineId,
                connectionId: selectedConnection.connectionId,
                ...(selectedDescriptor.kind === "model" ? { modelId: selectedDescriptor.id } : {}),
                ...(selectedDescriptor.kind === "workflow" ? { workflowId: selectedDescriptor.id } : {}),
                ...(selectedDescriptor.kind === "skill" ? { skillId: selectedDescriptor.id } : {}),
            };
            const connectionInputs = loadedBindings
                ? projectGenerationConnectionPolicyInputs(loadedBindings)
                : [];
            const selectedInput = {
                connection: selectedConnection,
                catalog,
                ...(externalProjectId.trim() ? { externalProjectId: externalProjectId.trim() } : {}),
                maxTasks,
                maxTotalCostMicrounits: maxCostMicrounits,
                costUnit,
            };
            const existingIndex = connectionInputs.findIndex((item) => item.connection.engineId === selectedConnection.engineId && item.connection.connectionId === selectedConnection.connectionId);
            if (existingIndex >= 0) connectionInputs[existingIndex] = { ...connectionInputs[existingIndex], ...selectedInput };
            else connectionInputs.push(selectedInput);
            const defaultRoutes = {
                ...(loadedBindings?.projectPolicy.defaultRoutes ?? {}),
                [taskKind]: route,
            };
            const strictLockTaskKinds = new Set<GenerationTaskKind>(Object.keys(loadedBindings?.projectPolicy.modelLocksByTask ?? {}) as GenerationTaskKind[]);
            if (strictLock) strictLockTaskKinds.add(taskKind);
            else strictLockTaskKinds.delete(taskKind);
            const bindings = await buildProjectProductionBindingsV2({
                projectId,
                connections: connectionInputs,
                defaultRoutes,
                defaultBrainProfileId: defaultBrain,
                allowedBrainProfileIds: allowedBrains,
                strictLockTaskKinds: [...strictLockTaskKinds],
                allowProviderUpload: allowUpload,
            });
            const authority = new FilmCoreHttpProductionGenerationAuthority(async () => new Map());
            const stored = await authority.ensureProjectAuthority(projectId, projectName, bindings);
            setLoadedBindings(await normalizeProjectProductionBindings(stored));
            setLoadState("configured");
            message.success("项目 AI 与生成权威已写入 Film Core");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "项目 AI 与生成设置保存失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="py-5" aria-label="项目 AI 与生成设置">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div><h3 className="text-sm font-semibold">AI 与生成</h3><p className="mt-0.5 text-xs text-foreground/48">项目级 AI 大脑、生成引擎、精确路由、外部项目、版本锁与预算权威</p></div>
                <Tag color={loadState === "configured" ? "green" : loadState === "unavailable" ? "red" : "default"}>{loadState === "configured" ? "Film Core 已配置" : loadState === "unavailable" ? "Film Core 不可用" : "待配置"}</Tag>
            </div>
            <div className="grid gap-3 rounded-lg bg-surface-active p-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="项目默认 AI 大脑"><Select value={defaultBrain} options={USER_SELECTABLE_BRAIN_PROFILE_IDS.map((value) => ({ value, label: BRAIN_LABELS[value] }))} onChange={setDefaultBrain} /></Field>
                <Field label="允许的 AI 大脑"><Select mode="multiple" value={allowedBrains} options={USER_SELECTABLE_BRAIN_PROFILE_IDS.map((value) => ({ value, label: BRAIN_LABELS[value] }))} onChange={setAllowedBrains} /></Field>
                <Field label="任务路线连接"><Select loading={loading} value={connectionId || undefined} options={connections.map((item) => ({ value: item.connectionId, label: `${item.engineId} · ${item.status}` }))} onChange={(value) => { setConnectionId(value); setDescriptorValue(""); }} /></Field>
                <Field label="任务默认路线"><Select value={taskKind} options={TASK_OPTIONS} onChange={setTaskKind} /></Field>
                <Field label="精确 Model / Workflow / Skill"><Select value={descriptorValue || undefined} options={descriptorOptions.map((item) => ({ value: `${item.kind}|${item.id}`, label: `${item.kind} · ${item.label}` }))} placeholder="先让 Engine Catalog 就绪" onChange={setDescriptorValue} /></Field>
                <Field label="外部 Project Binding"><Input value={externalProjectId} onChange={(event) => setExternalProjectId(event.target.value)} placeholder={selectedConnection?.engineId === "flova_cli" ? "选择已有 Flova Project ID" : "仅需要外部项目的 Engine 填写"} /></Field>
                <Field label="Model / Version Lock"><Switch checked={strictLock} onChange={setStrictLock} checkedChildren="严格" unCheckedChildren="关闭" /></Field>
                <Field label="Budget Grant · 最大任务数"><InputNumber className="w-full" min={1} precision={0} value={maxTasks} onChange={(value) => setMaxTasks(Number(value) || 1)} /></Field>
                <Field label="Budget Grant · 最大微单位"><Input value={maxCostMicrounits} inputMode="numeric" onChange={(event) => setMaxCostMicrounits(event.target.value)} addonAfter={<Input variant="borderless" className="w-20" value={costUnit} onChange={(event) => setCostUnit(event.target.value)} />} /></Field>
                <Field label="Upload Policy"><Checkbox checked={allowUpload} onChange={(event) => setAllowUpload(event.target.checked)}>允许经逐次 Broker 确认后上传 Provider</Checkbox></Field>
                <div className="flex items-end md:col-span-2 xl:col-span-2"><Button type="primary" loading={saving} disabled={loading || !routingDocument} onClick={() => void save()}>保存到正式 Film Core</Button></div>
            </div>
            {loadedBindings ? <p className="mt-2 text-xs text-foreground/48">Policy V2 已保留 {loadedBindings.connections.length} 个 Connection 与 {Object.keys(loadedBindings.projectPolicy.defaultRoutes).length} 条 Task Route；当前保存只更新选中任务，不会删除其他路由。</p> : null}
            {selectedConnection ? <Alert className="mt-3" type={selectedConnection.status === "ready" ? "info" : "warning"} showIcon message={`Engine Connection：${selectedConnection.status}`} description={`Catalog Evidence：${catalogEvidence(selectedConnection.engineId, dreaminaSnapshot?.evidence) ? catalogEvidenceLabel(catalogEvidence(selectedConnection.engineId, dreaminaSnapshot?.evidence)!) : "Catalog 未加载"}。保存只写本地 Film Core，不会发起 Provider 请求或产生费用。`} /> : null}
        </section>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return <label className="grid gap-1.5 text-xs"><span className="font-medium text-foreground/62">{label}</span>{children}</label>;
}

function taskCompatible(capability: "image" | "video" | "audio" | "workflow", taskKind: GenerationTaskKind) {
    return taskKind === "audio" ? capability === "audio" : taskKind === "workflow" ? capability === "workflow" : taskKind.includes("video") ? capability === "video" : capability === "image";
}

function catalogEvidence(engineId: string, dreaminaEvidence?: CatalogEvidence): CatalogEvidence | undefined {
    const observedAt = new Date().toISOString();
    if (engineId === "dreamina_cli") {
        return dreaminaEvidence;
    }
    return { source: "manual_unverified", enteredByActorRef: `local-project-owner:${engineId}`, observedAt };
}
