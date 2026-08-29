import { spawn, type StdioOptions } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CANVAS_GENERATION_CONTINUATION_TIMEOUT_MS } from "./canvas-tool-timeouts.js";
import { AGENT_PROMPT, CONFIG_DIR } from "./config.js";
import { assertCodexThreadWorkspace, codexThreadInWorkspace, resolveCodexThread } from "./codex-thread.js";
import type { AgentPermissionGrant } from "./brains/contracts.js";
import { CodexAppServerProcessManager } from "./brains/adapters/codex-app-server-process-manager.js";
import { codexInput, type CodexAppServerClient, type CodexServerRequestHandler, type CodexSkillInput } from "./brains/adapters/codex-app-server-client.js";
import type { AgentAttachment, AgentEmit } from "./types.js";

type Json = Record<string, unknown>;
export type AgentSkillReference = { skillId?: string; name: string; description?: string; instruction?: string };
export type { CodexSkillInput };
type CodexRunOptions = {
    sessionId?: string;
    threadId?: string;
    cwd?: string;
    skills?: AgentSkillReference[];
    grant?: AgentPermissionGrant;
    handleServerRequest?: CodexServerRequestHandler;
    onThreadId?: (threadId: string) => void;
};
type AgentHistoryMessage = { id: string; role: "user" | "assistant" | "tool" | "error"; title?: string; text: string; detail?: unknown; streamId?: string };

const codexProcessManager = new CodexAppServerProcessManager();
const codexQueuesBySession = new Map<string, Promise<unknown>>();
const canvasAgentMcp = canvasAgentMcpCommand();
const INTERNAL_CANVAS_MCP_TIMEOUT_MARGIN_MS = 60_000;

export { codexInput };

export function withAgentPrompt(prompt: string) {
    return prompt.trim() ? `${AGENT_PROMPT}\n\n用户请求：${prompt}` : "";
}

export async function readCodexAccountStatus() {
    return await codexProcessManager.probe();
}

export async function startCodexChatGPTLogin() {
    return await codexProcessManager.startChatGPTLogin();
}

export async function logoutCodexAccount() {
    return await codexProcessManager.logoutAccount();
}

export async function runCodexTurn(prompt: string, emit: AgentEmit, attachments: AgentAttachment[] = [], options: CodexRunOptions = {}) {
    if (!prompt.trim()) return;
    const queueKey = options.threadId || options.sessionId || options.cwd || "legacy-codex-session";
    const previous = codexQueuesBySession.get(queueKey) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(() => runCodexTurnNow(prompt, emit, attachments, options));
    codexQueuesBySession.set(queueKey, queued);
    try {
        await queued;
    } finally {
        if (codexQueuesBySession.get(queueKey) === queued) codexQueuesBySession.delete(queueKey);
    }
}

async function runCodexTurnNow(prompt: string, emit: AgentEmit, attachments: AgentAttachment[], options: CodexRunOptions) {
    let files: string[] = [];
    let skillDirectories: string[] = [];
    try {
        files = await writeAttachmentFiles(attachments);
        const preparedSkills = await writeSkillFiles(options.skills || []);
        skillDirectories = preparedSkills.directories;
        const codexApp = await codexProcessManager.client();
        const threadId = await ensureCodexThread(codexApp, emit, options);
        if (threadId !== options.threadId) options.onThreadId?.(threadId);
        await codexApp.startTurn(threadId, prompt, files, preparedSkills.inputs, codexBinding(emit, options));
    } catch (error) {
        emit("agent_error", { message: errorMessage(error) });
    } finally {
        await Promise.all(files.map((file) => fs.unlink(file).catch(() => undefined)));
        await Promise.all(skillDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)));
    }
}

export async function startCodexThread(emit: AgentEmit, cwd?: string, options: Pick<CodexRunOptions, "sessionId" | "grant" | "handleServerRequest"> = {}) {
    const codexApp = await codexProcessManager.client();
    return await codexApp.startThread(cwd, codexConfig(CONFIG_DIR, options.grant), codexBinding(emit, options));
}

export async function resumeCodexThread(emit: AgentEmit, threadId: string, cwd?: string, options: Pick<CodexRunOptions, "sessionId" | "grant" | "handleServerRequest"> = {}) {
    const codexApp = await codexProcessManager.client();
    await loadCodexThread(emit, threadId, cwd, false);
    const thread = await codexApp.resumeThread(threadId, cwd, codexConfig(CONFIG_DIR, options.grant), codexBinding(emit, options));
    assertCodexThreadWorkspace(thread, cwd);
    return { thread, messages: threadMessages(thread) };
}

export async function listCodexThreads(emit: AgentEmit, options: { cwd: string; searchTerm?: string; limit?: number }) {
    const codexApp = await codexProcessManager.client();
    const result = await codexApp.listThreads({
        limit: options.limit || 40,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "appServer", "exec"],
        cwd: options.cwd,
        ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
    });
    const data = Array.isArray(field(result, "data")) ? (field(result, "data") as unknown[]).map(summarizeCodexThread).filter((thread) => codexThreadInWorkspace(thread, options.cwd)) : [];
    return { data, nextCursor: field(result, "nextCursor") || null, backwardsCursor: field(result, "backwardsCursor") || null };
}

export async function readCodexThread(emit: AgentEmit, threadId: string, cwd?: string) {
    const thread = await loadCodexThread(emit, threadId, cwd, true);
    return { thread: summarizeCodexThread(thread), messages: threadMessages(thread) };
}

export async function verifyCodexThreadWorkspace(emit: AgentEmit, threadId: string, cwd: string) {
    await loadCodexThread(emit, threadId, cwd, false);
}

export async function archiveCodexThread(emit: AgentEmit, threadId: string, cwd?: string) {
    const codexApp = await codexProcessManager.client();
    await loadCodexThread(emit, threadId, cwd, false);
    await codexApp.archiveThread(threadId);
}

export function runClaudeTurn(prompt: string, emit: AgentEmit) {
    if (!prompt.trim()) return;
    const child = spawnAgent("claude", ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--allowedTools", "mcp__yingce__*", prompt], ["ignore", "pipe", "pipe"], emit);
    if (!child) return;
    pipeJsonLines(child, emit, "claude");
}

async function ensureCodexThread(app: CodexAppServerClient, emit: AgentEmit, options: CodexRunOptions) {
    const binding = codexBinding(emit, options);
    return await resolveCodexThread({
        readThread: (threadId, includeTurns) => app.readThread(threadId, includeTurns),
        resumeThread: (threadId, cwd) => app.resumeThread(threadId, cwd, codexConfig(CONFIG_DIR, options.grant), binding),
        startThread: (cwd) => app.startThread(cwd, codexConfig(CONFIG_DIR, options.grant), binding),
    }, options, options.threadId || "");
}

export function canvasAgentMcpCommand() {
    const current = process.argv.find((arg) => /index\.(t|j)s$/.test(arg)) || "";
    const entry = path.resolve(current || fileURLToPath(new URL("./index.js", import.meta.url)));
    const tsx = path.join(path.dirname(entry), "..", "node_modules", "tsx", "dist", "cli.mjs");
    return entry.endsWith(".ts")
        ? { command: process.execPath, args: [tsx, entry, "mcp", "--surface", "workbench_operator"] }
        : { command: process.execPath, args: [entry, "mcp", "--surface", "workbench_operator"] };
}

export function codexConfig(configDir = CONFIG_DIR, grant?: AgentPermissionGrant) {
    const env = {
        FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR: configDir,
        FILMOS_AGENT_GATEWAY_ENABLED: "true",
        FILMOS_AGENT_PROFILE: "codex.subscription",
        ...(grant ? {
            FILMOS_AGENT_GRANT_ID: grant.id,
            FILMOS_AGENT_SESSION_ID: grant.sessionId,
            FILMOS_AGENT_CONNECTION_ID: grant.connectionId,
            FILMOS_AGENT_PROJECT_ID: grant.projectId,
            FILMOS_AGENT_GRANT_NONCE: grant.nonce,
        } : {}),
    };
    return {
        mcp_servers: {
            "yingce": {
                command: canvasAgentMcp.command,
                args: canvasAgentMcp.args,
                env,
                startup_timeout_sec: 20,
                tool_timeout_sec: Math.ceil((CANVAS_GENERATION_CONTINUATION_TIMEOUT_MS + INTERNAL_CANVAS_MCP_TIMEOUT_MARGIN_MS) / 1_000),
            },
        },
    };
}

async function loadCodexThread(emit: AgentEmit, threadId: string, cwd: string | undefined, includeTurns: boolean) {
    const codexApp = await codexProcessManager.client();
    const result = await codexApp.readThread(threadId, includeTurns);
    const thread = field(result, "thread") || {};
    assertCodexThreadWorkspace(thread, cwd);
    return thread;
}

function field(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Json)[key] : undefined;
}

export function summarizeCodexThread(thread: unknown) {
    return {
        id: String(field(thread, "id") || ""),
        sessionId: String(field(thread, "sessionId") || ""),
        preview: displayUserText(String(field(thread, "preview") || "")),
        name: stringOrNull(field(thread, "name")),
        cwd: String(field(thread, "cwd") || ""),
        status: String(field(thread, "status") || ""),
        source: field(thread, "source"),
        threadSource: field(thread, "threadSource"),
        createdAt: Number(field(thread, "createdAt") || 0),
        updatedAt: Number(field(thread, "updatedAt") || 0),
    };
}

function threadMessages(thread: unknown): AgentHistoryMessage[] {
    const turns = arrayValue(field(thread, "turns"));
    const messages: AgentHistoryMessage[] = [];
    turns.forEach((turn, turnIndex) => {
        arrayValue(field(turn, "items")).forEach((item, itemIndex) => {
            const type = String(field(item, "type") || "");
            const id = String(field(item, "id") || `${turnIndex}-${itemIndex}`);
            if (type === "userMessage") {
                const text = displayUserText(userInputText(field(item, "content")));
                if (text) messages.push({ id, role: "user", text });
            }
            if (type === "agentMessage") {
                const text = String(field(item, "text") || "").trim();
                if (text) messages.push({ id, role: "assistant", title: "Codex", text, streamId: id });
            }
            if (type === "mcpToolCall") {
                const tool = String(field(item, "tool") || "工具调用");
                const error = field(field(item, "error"), "message");
                messages.push({ id, role: error ? "error" : "tool", title: toolName(tool), text: error ? String(error) : `${toolName(tool)} ${String(field(item, "status") || "完成")}`, detail: item });
            }
            if (type === "commandExecution") {
                const command = String(field(item, "command") || "").trim();
                if (command) messages.push({ id, role: "tool", title: "命令", text: command, detail: { cwd: field(item, "cwd"), status: field(item, "status"), exitCode: field(item, "exitCode") } });
            }
            if (type === "fileChange") messages.push({ id, role: "tool", title: "文件变更", text: "Codex 修改了文件", detail: item });
        });
    });
    return messages.filter((item) => item.text).slice(-120);
}

function userInputText(content: unknown) {
    return arrayValue(content)
        .map((item) => {
            const type = String(field(item, "type") || "");
            if (type === "text") return String(field(item, "text") || "");
            if (type === "image" || type === "localImage") return "图片附件";
            if (type === "mention") return `@${String(field(item, "name") || "文件")}`;
            return "";
        })
        .filter(Boolean)
        .join("\n");
}

function displayUserText(text: string) {
    const value = text.trim();
    const marker = "用户请求：";
    const index = value.lastIndexOf(marker);
    return (index >= 0 ? value.slice(index + marker.length) : value).trim();
}

function arrayValue(value: unknown) {
    return Array.isArray(value) ? value : [];
}

function stringOrNull(value: unknown) {
    return typeof value === "string" && value.trim() ? value : null;
}

function toolName(name: string) {
    if (name === "canvas_apply_ops") return "画布操作";
    if (name === "canvas_get_state") return "读取画布";
    if (name === "canvas_get_context") return "读取画布上下文";
    if (name === "canvas_find_nodes") return "检索画布节点";
    if (name === "canvas_get_node") return "读取画布节点";
    if (name === "canvas_get_connection") return "读取画布连线";
    if (name === "canvas_get_generation_tasks") return "读取生成任务";
    if (name === "canvas_get_resources") return "读取画布资源";
    if (name === "canvas_validate_ops") return "校验画布操作";
    if (name === "canvas_get_selection") return "读取选区";
    if (name === "canvas_export_snapshot") return "导出快照";
    if (name === "canvas_create_text_node") return "创建文本";
    if (name === "canvas_create_image_prompt_flow") return "创建生图流程";
    if (name === "canvas_create_generation_flow") return "创建生成流程";
    if (name === "canvas_generate_text") return "生成文本";
    if (name === "canvas_generate_image") return "生成图片";
    if (name === "canvas_generate_video") return "生成视频";
    if (name === "canvas_generate_audio") return "生成音频";
    if (name === "canvas_run_generation") return "触发生成";
    return name;
}

async function writeAttachmentFiles(attachments: AgentAttachment[]) {
    return await Promise.all(attachments.filter((item) => item.dataUrl?.startsWith("data:image/")).map(writeAttachmentFile));
}

async function writeAttachmentFile(item: AgentAttachment) {
    const [, meta = "", data = ""] = item.dataUrl?.match(/^data:([^;]+);base64,(.+)$/) || [];
    if (!data) throw new Error(`图片附件无效：${item.name || "未命名图片"}`);
    const file = path.join(os.tmpdir(), `infinite-canvas-${Date.now()}-${Math.random().toString(16).slice(2)}.${imageExt(meta || item.type)}`);
    await fs.writeFile(file, Buffer.from(data, "base64"));
    return file;
}

export async function writeSkillFiles(skills: AgentSkillReference[]) {
    const directories: string[] = [];
    const inputs: CodexSkillInput[] = [];
    const usedNames = new Set<string>();
    try {
        for (const skill of skills.slice(0, 8)) {
            const instruction = String(skill.instruction || "").trim().slice(0, 24_000);
            if (!instruction) continue;
            const baseName = `canvas-${safeSkillSegment(skill.skillId || skill.name)}`;
            const name = uniqueSkillName(baseName, usedNames);
            usedNames.add(name);
            const directory = await fs.mkdtemp(path.join(os.tmpdir(), "infinite-canvas-skill-"));
            directories.push(directory);
            const file = path.join(directory, "SKILL.md");
            const description = String(skill.description || skill.name).trim().slice(0, 500).replace(/[\r\n]+/g, " ");
            const body = [`---`, `name: ${name}`, `description: ${JSON.stringify(description)}`, `---`, ``, `# ${skill.name}`, ``, instruction, ``].join("\n");
            await fs.writeFile(file, body, "utf8");
            inputs.push({ type: "skill", name, path: file });
        }
        return { directories, inputs };
    } catch (error) {
        await Promise.all(directories.map((directory) => fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)));
        throw error;
    }
}

function uniqueSkillName(baseName: string, usedNames: Set<string>) {
    if (!usedNames.has(baseName)) return baseName;
    let suffix = 2;
    while (usedNames.has(`${baseName}-${suffix}`)) suffix += 1;
    return `${baseName}-${suffix}`;
}

function safeSkillSegment(value: string) {
    const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
    return normalized || "skill";
}

function imageExt(type = "") {
    if (type.includes("png")) return "png";
    if (type.includes("webp")) return "webp";
    return "jpg";
}

function pipeJsonLines(child: ReturnType<typeof spawn>, emit: AgentEmit, agent: string) {
    let out = "";
    child.stdout?.on("data", (chunk) => {
        out += chunk.toString();
        const lines = out.split(/\r?\n/);
        out = lines.pop() || "";
        lines.filter(Boolean).forEach((line) => {
            try {
                emit("agent_event", { agent, ...JSON.parse(line) });
            } catch {
                emit("agent_event", { agent, type: "raw", text: line });
            }
        });
    });
    child.stderr?.on("data", (chunk) => emit("agent_log", { text: chunk.toString() }));
    child.on("error", (error) => emit("agent_error", { message: error.message }));
    child.on("close", (code) => emit("agent_done", { agent, code }));
}

function spawnAgent(name: string, args: string[], stdio: StdioOptions, emit: AgentEmit) {
    try {
        return spawn(name, args, { stdio, shell: process.platform === "win32", windowsHide: true });
    } catch (error) {
        emit("agent_error", { message: errorMessage(error) });
        return null;
    }
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function codexBinding(emit: AgentEmit, options: Pick<CodexRunOptions, "handleServerRequest">) {
    return {
        emit,
        ...(options.handleServerRequest ? { handleServerRequest: options.handleServerRequest } : {}),
    };
}
