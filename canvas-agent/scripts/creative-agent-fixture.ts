// Opt-in real subscription fixture. Owns only its temporary runtime and child
// app-server; never starts production services or installs a desktop App.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

if (process.env.FILMOS_CREATIVE_AGENT_FIXTURE !== "1") throw new Error("EXPLICIT_CREATIVE_FIXTURE_REQUIRED");
const origin = process.env.FILMOS_FIXTURE_WEB_ORIGIN || "http://127.0.0.1:57878";
const port = Number(process.env.FILMOS_FIXTURE_RUNTIME_PORT || 57879);
const fixtureCanvasId = process.env.FILMOS_FIXTURE_CANVAS_ID || "creative-fixture-canvas";
if (!/^[a-zA-Z0-9_-]{1,100}$/.test(fixtureCanvasId)) throw new Error("ISOLATED_CANVAS_ID_REQUIRED");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || !Number.isInteger(port) || port < 49152 || port > 65535) throw new Error("ISOLATED_LOOPBACK_PORT_REQUIRED");
delete process.env.OPENAI_API_KEY;
process.env.FILMOS_AGENT_GATEWAY_ENABLED = "true";
const evidenceRoot = path.resolve("../.local/创作验收");
await fs.mkdir(evidenceRoot, { recursive: true });
const resumeRoot = process.env.FILMOS_FIXTURE_RESUME_DIR;
const root = resumeRoot ? await fs.realpath(resumeRoot) : await fs.mkdtemp(path.join(evidenceRoot, "m1-"));
if (path.dirname(root) !== evidenceRoot || !/^m1-[a-zA-Z0-9]+$/.test(path.basename(root))) throw new Error("OWNED_FIXTURE_DIRECTORY_REQUIRED");
const configDir = path.join(root, "runtime");
const workspace = path.join(root, "workspace");
if (!resumeRoot) {
    await fs.mkdir(configDir, { mode: 0o700 });
    await fs.mkdir(workspace, { mode: 0o700 });
} else {
    const prior = JSON.parse(await fs.readFile(path.join(root, "环境.json"), "utf8"));
    if (prior.fixture !== true || prior.workspace !== workspace || prior.webOrigin !== origin || prior.runtimeEndpoint !== `http://127.0.0.1:${port}` || (prior.canvasId || "creative-fixture-canvas") !== fixtureCanvasId) throw new Error("FIXTURE_IDENTITY_CHANGED");
}
process.env.FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR = configDir;
// Imports happen after the isolated config directory has been selected.
const [{ AGENT_FEATURE_FLAG_IDS }, { loadConfig }, { CanvasSession }, { createCanvasAgentHttpModule }, { startLocalRuntime }, { codexProcessManager }] = await Promise.all([
    import("../src/brains/feature-flags.js"), import("../src/config.js"), import("../src/canvas-session.js"),
    import("../src/modules/canvas-agent-http.js"), import("../src/local-runtime-host.js"), import("../src/agents.js"),
]);
const flags = Object.fromEntries(AGENT_FEATURE_FLAG_IDS.map(id => [id, !["film.agent_model_api_profiles", "film.agent_chatgpt_host"].includes(id)]));
if (!resumeRoot) await fs.writeFile(path.join(configDir, "canvas-agent.json"), JSON.stringify({
    url: `http://127.0.0.1:${port}`, token: crypto.randomBytes(24).toString("hex"), ownerId: "creative-fixture-owner",
    trustedWebOrigins: [origin], browserRegistrations: [],
    canvases: { [fixtureCanvasId]: { workspacePath: workspace } }, agentFeatureFlags: flags,
}), { mode: 0o600 });
const config = loadConfig(true);
const canvas = new CanvasSession();
const originalEmit = canvas.emitAll.bind(canvas);
let eventWrites = Promise.resolve();
canvas.emitAll = (type, payload) => {
    originalEmit(type, payload);
    eventWrites = eventWrites.then(() => fs.appendFile(path.join(root, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), type, payload }) + "\n", { mode: 0o600 }));
};
const module = createCanvasAgentHttpModule(config, canvas);
// Diagnose only this isolated fixture's session preflight; never log requests,
// credentials, or the user prompt, and preserve the real public failure path.
const createRoute = module.routes.find(route => route.method === "POST" && route.path === "/agent/sessions");
if (createRoute) {
    const handle = createRoute.handler;
    createRoute.handler = (req, res, next) => handle(req, res, error => {
        if (error) {
            const detail = String(error instanceof Error ? error.message : "UNKNOWN_ERROR")
                .replace(/(?:Bearer\s+|sk-)[^\s"']+/gi, "[REDACTED]")
                .replace(/((?:token|key|secret|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
                .slice(0, 1200);
            console.error("CREATIVE_SESSION_CREATE_FAILED", JSON.stringify({ name: error instanceof Error ? error.name : "Error", detail }));
        }
        next(error);
    });
}
const runtime = startLocalRuntime({ config, modules: [module], port, log: () => undefined });
await runtime.ready;
const manifest = { fixture: true, canvasId: fixtureCanvasId, runtimeEndpoint: config.url, webOrigin: origin, root, workspace, pid: process.pid, profile: "codex.subscription", modelApiFallback: false, sourceFirst: true, productionData: false };
await fs.writeFile(path.join(root, "环境.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
let closed = false;
async function close() {
    if (closed) return;
    closed = true;
    await codexProcessManager.dispose();
    canvas.dispose();
    await runtime.close();
    await eventWrites;
    console.log("CREATIVE_FIXTURE_CLOSED");
    process.exit(0);
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
setTimeout(() => void close(), 30 * 60_000).unref();
