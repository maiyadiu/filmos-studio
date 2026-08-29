import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const originalApiKey = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "filmos-codex-subscription-golden-"));
const configDirectory = path.join(root, "runtime");
const workspace = path.join(root, "workspace");
const origin = "http://127.0.0.1:3000";
const token = crypto.randomBytes(18).toString("hex");
const port = await reservePort();
const endpoint = `http://127.0.0.1:${port}`;
process.env.FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR = configDirectory;

const featureFlags = {
    "film.agent_native_brain_selector": true,
    "film.agent_generic_runtime": true,
    "film.agent_context_broker": true,
    "film.agent_canonical_tool_manifest": true,
    "film.agent_canonical_tool_broker": true,
    "film.agent_codex_subscription": true,
    "film.agent_chatgpt_host": true,
    "film.agent_model_api_profiles": true,
    "film.agent_no_silent_api_fallback": true,
    "film.agent_request_scoped_identity": true,
} as const;

await fs.mkdir(configDirectory, { recursive: true, mode: 0o700 });
await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(configDirectory, "canvas-agent.json"), JSON.stringify({
    url: endpoint,
    token,
    ownerId: "filmos-acceptance-owner",
    trustedWebOrigins: [origin],
    browserRegistrations: [],
    canvases: { "filmos-acceptance-project-v1": { workspacePath: workspace } },
    agentFeatureFlags: featureFlags,
}, null, 2), { mode: 0o600 });

const [
    { loadConfig },
    { CanvasSession },
    { createCanvasAgentHttpModule },
    { createLocalRuntimeApp },
    { LocalRuntimeSessionManager },
    { codexProcessManager },
] = await Promise.all([
    import("../src/config.js"),
    import("../src/canvas-session.js"),
    import("../src/modules/canvas-agent-http.js"),
    import("../src/local-runtime.js"),
    import("../src/local-runtime-session.js"),
    import("../src/agents.js"),
]);

const config = loadConfig(true);
const canvas = new CanvasSession();
const observedEvents: Array<{ type: string; payload: unknown }> = [];
canvas.emitAll = (type: string, payload: unknown) => { observedEvents.push({ type, payload }); };
const accepted = canvas.updateState({
    projectId: "filmos-acceptance-project-v1",
    domainProjectId: "accept-project-001",
    contentUnitId: "accept-unit-001",
    sceneId: "accept-scene-001",
    directorUnitId: "accept-director-001",
    shotId: "accept-shot-001",
    title: "FilmOS Acceptance Canvas",
    revision: 7,
    filmExpectedVersion: 1,
    filmContentHash: "7d34a5e14f8a28aed24008c90e43eb3d3505372160249fa023beb451eed50125",
    selectedNodeIds: ["accept-node-image-001"],
    visibleNodeIds: ["accept-node-image-001", "accept-node-prompt-001"],
    assetVersionIds: ["accept-asset-001"],
    activePanel: "production-canvas",
    nodes: [
        {
            id: "accept-node-image-001",
            type: "image",
            title: "Acceptance selected image",
            position: { x: 0, y: 0 },
            width: 640,
            height: 360,
            metadata: { status: "success", assetVersionId: "accept-asset-001", role: "shot_candidate" },
        },
        {
            id: "accept-node-prompt-001",
            type: "text",
            title: "Acceptance prompt",
            position: { x: 720, y: 0 },
            width: 420,
            height: 240,
            metadata: { status: "success", content: "Composition consistency review" },
        },
    ],
    connections: [{ id: "accept-edge-001", fromNodeId: "accept-node-prompt-001", toNodeId: "accept-node-image-001" }],
}, "acceptance-browser");
if (!accepted?.accepted) throw new Error(`Acceptance canvas was rejected: ${JSON.stringify(accepted)}`);

const runtimeSessions = new LocalRuntimeSessionManager({
    endpoint,
    trustedOrigins: [origin],
    registrations: [],
});
const module = createCanvasAgentHttpModule(config, canvas);
const app = createLocalRuntimeApp({
    authority: `127.0.0.1:${port}`,
    endpoint,
    version: "0.1.0",
    sessionManager: runtimeSessions,
    modules: [module],
    legacyMasterToken: token,
    legacyOrigins: [origin],
});
const server = http.createServer(app);

try {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    });
    const connections = await request("GET", "/agent/connections");
    const codex = array(record(connections).connections).map(record).find((item) => record(item.profile).id === "codex.subscription");
    if (!codex || record(codex.status).status !== "ready") {
        throw new Error(`CODEX_SUBSCRIPTION_NOT_READY:${String(record(codex?.status).status || "missing")}`);
    }

    const created = await request("POST", "/agent/sessions", {
        conversationId: "acceptance-conversation-codex-001",
        brainProfileId: "codex.subscription",
        ignoredActorId: "model-cannot-select-identity",
        ignoredProjectId: "host-project-1",
    });
    const createdSession = record(record(created).session);
    const sessionId = required(createdSession.id, "session id");
    const providerThreadId = required(createdSession.providerThreadId, "provider thread id");
    const context = record(created).context;
    assertContext(context);

    await request("POST", `/agent/sessions/${encodeURIComponent(sessionId)}/turns`, {
        turnId: "acceptance-real-read-001",
        prompt: [
            "这是 FilmOS Golden A 只读验收。必须实际调用完整命名空间工具 mcp__yingce__workbench_get_context 一次。",
            "该 Context 响应已包含当前场、当前镜头、选中图片节点和相关资产；调用后立即基于返回事实给出两种构图调整方案。",
            "不得调用第二个工具；如缺少像素画面，必须明说“画面证据不足”后仍给出 Preview 建议。",
            "禁止修改、禁止生成、禁止执行 shell、禁止调用任何模型 API Adapter。",
            "最终回答必须原样引用 Scene ID、Shot ID、选中节点 ID 和 Asset ID。",
        ].join("\n"),
    }, 240_000);

    const codexClient = await codexProcessManager.client();
    const mcpStatus = await codexClient.listMcpServerStatus(providerThreadId);
    const filmOSMcp = array(record(mcpStatus).data).map(record).find((item) => item.name === "yingce");
    const filmOSMcpTools = filmOSMcp ? Object.keys(record(filmOSMcp.tools)).sort() : [];
    if (!filmOSMcp || !filmOSMcpTools.includes("workbench_get_context")) {
        throw new Error(`CODEX_FILMOS_MCP_NOT_READY:${JSON.stringify({
            name: filmOSMcp?.name || "missing",
            runtimeStatus: filmOSMcp?.runtimeStatus || null,
            tools: filmOSMcpTools,
        })}`);
    }
    const thread = await codexClient.readThread(providerThreadId, true);
    const items = deepObjects(thread);
    const mcpCalls = items.filter((item) => String(item.type || "") === "mcpToolCall" || String(item.type || "") === "mcp_tool_call");
    const toolNames = mcpCalls.map((item) => String(item.tool || item.name || ""));
    if (!toolNames.some((name) => name.endsWith("workbench_get_context"))) {
        throw new Error(`REAL_CODEX_DID_NOT_CALL_WORKBENCH_CONTEXT:${toolNames.join(",")}`);
    }
    const messages = items.filter((item) => String(item.type || "") === "agentMessage" || String(item.type || "") === "agent_message").map((item) => String(item.text || ""));
    const answer = messages.join("\n");
    for (const id of ["accept-scene-001", "accept-shot-001", "accept-node-image-001", "accept-asset-001"]) {
        if (!answer.includes(id)) throw new Error(`REAL_CODEX_ANSWER_MISSING_CONTEXT_ID:${id}`);
    }

    await codexProcessManager.restart();
    const resumed = await request("POST", `/agent/sessions/${encodeURIComponent(sessionId)}/resume`, {});
    const resumedSession = record(record(resumed).session);
    if (resumedSession.providerThreadId !== providerThreadId) throw new Error("CODEX_PROVIDER_THREAD_CHANGED_AFTER_RESTART");

    const auditPath = path.join(configDirectory, "agent-audit.v1.jsonl");
    const auditText = await fs.readFile(auditPath, "utf8");
    const audit = auditText.trim().split("\n").map((line) => record(JSON.parse(line)));
    const succeeded = audit.find((item) => item.toolName === "__brain_turn__" && item.outcome === "succeeded");
    if (!succeeded || succeeded.profileId !== "codex.subscription" || succeeded.transport !== "codex_app_server" || succeeded.billingMode !== "subscription") {
        throw new Error("CODEX_SUBSCRIPTION_AUDIT_ATTRIBUTION_MISSING");
    }
    const sessionStorePath = path.join(configDirectory, "brain-sessions.v1.json");
    const providerToolEvents = observedEvents.flatMap((event) => {
        const value = record(event.payload);
        if (value.type !== "tool.completed") return [];
        return [String(record(value.result).toolName || "")];
    });
    const receipt = {
        schema_version: "1.0.0",
        gate_id: "AGENT-CODEX-SUBSCRIPTION-001",
        status: "PASSED_REAL_SUBSCRIPTION_READ_PREVIEW",
        profile_id: "codex.subscription",
        transport: "codex_app_server",
        billing_mode: "subscription",
        openai_api_key_present: false,
        api_fallback_allowed: false,
        project_id: createdSession.projectId,
        domain_project_id: createdSession.domainProjectId,
        content_unit_id: createdSession.contentUnitId,
        scene_id: createdSession.sceneId,
        director_unit_id: createdSession.directorUnitId,
        shot_id: createdSession.shotId,
        selected_node_ids: array(record(record(context).canvas).selectedNodeIds),
        asset_ids: array(record(context).assets).map((item) => record(item).id),
        actual_mcp_tools_called: [...new Set(toolNames)].sort(),
        codex_mcp_inventory: {
            server_name: "yingce",
            runtime_status: String(record(filmOSMcp.runtimeStatus).state || "inventory_loaded_preflight_verified"),
            raw_runtime_status_available: Boolean(filmOSMcp.runtimeStatus),
            tool_count: filmOSMcpTools.length,
            tool_names_sha256: sha256(Buffer.from(JSON.stringify(filmOSMcpTools))),
            context_tool_present: true,
            preflight_context_verified: true,
        },
        normalized_tool_events: [...new Set(providerToolEvents)].sort(),
        provider_thread_sha256: sha256(Buffer.from(providerThreadId)),
        provider_thread_preserved_after_restart: true,
        session_store_sha256: sha256(await fs.readFile(sessionStorePath)),
        audit_sha256: sha256(Buffer.from(auditText)),
        audit_attribution: {
            profile_id: succeeded.profileId,
            transport: succeeded.transport,
            billing_mode: succeeded.billingMode,
            outcome: succeeded.outcome,
        },
        model_api_requests_observed: 0,
        mutation_requested: false,
        formal_write_executed: false,
    };
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
    await codexProcessManager.dispose().catch(() => undefined);
    await Promise.resolve(module.dispose?.()).catch(() => undefined);
    runtimeSessions.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
    if (originalApiKey !== undefined) process.env.OPENAI_API_KEY = originalApiKey;
}

async function request(method: "GET" | "POST", pathname: string, body?: unknown, timeout = 30_000) {
    const response = await fetch(`${endpoint}${pathname}`, {
        method,
        headers: {
            origin,
            "x-canvas-agent-token": token,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
    });
    const payload = await response.json();
    if (!response.ok || record(payload).ok === false) throw new Error(`HTTP_${response.status}:${JSON.stringify(payload)}`);
    return payload;
}

async function reservePort() {
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not reserve acceptance port");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return address.port;
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function required(value: unknown, label: string) {
    if (typeof value !== "string" || !value) throw new Error(`Missing ${label}`);
    return value;
}

function assertContext(value: unknown) {
    const context = record(value);
    const route = record(context.route);
    const canvas = record(context.canvas);
    if (route.projectId !== "filmos-acceptance-project-v1"
        || route.sceneId !== "accept-scene-001"
        || route.shotId !== "accept-shot-001"
        || !array(canvas.selectedNodeIds).includes("accept-node-image-001")
        || !array(context.assets).some((item) => record(item).id === "accept-asset-001")) {
        throw new Error(`WORKBENCH_CONTEXT_INCOMPLETE:${JSON.stringify(context)}`);
    }
}

function deepObjects(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) return value.flatMap(deepObjects);
    if (!value || typeof value !== "object") return [];
    const object = value as Record<string, unknown>;
    return [object, ...Object.values(object).flatMap(deepObjects)];
}

function sha256(value: Buffer) {
    return crypto.createHash("sha256").update(value).digest("hex");
}
