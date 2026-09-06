import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { VERSION } from "../../config.js";
import type { AgentEmit } from "../../types.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";

const require = createRequire(import.meta.url);

export class CodexAppServerProcessManager {
    private clientPromise?: Promise<CodexAppServerClient>;
    private readonly sessionProcesses = new Map<string, CodexAppServerProcessManager>();

    constructor(
        private readonly processEmit: AgentEmit = () => undefined,
        private readonly startClient: (options: Parameters<typeof CodexAppServerClient.start>[0]) => Promise<CodexAppServerClient> = CodexAppServerClient.start,
    ) {}

    async client(sessionId?: string, replaceSession = false): Promise<CodexAppServerClient> {
        if (sessionId) {
            let scoped = this.sessionProcesses.get(sessionId);
            if (!scoped) {
                scoped = new CodexAppServerProcessManager(this.processEmit, this.startClient);
                this.sessionProcesses.set(sessionId, scoped);
            }
            // Loaded provider threads retain their original MCP environment.
            // Grant rotation replaces only this session's process, not peers.
            return replaceSession ? await scoped.restart() : await scoped.client();
        }
        if (!this.clientPromise) {
            const invocation = codexInvocation();
            this.clientPromise = this.startClient({
                command: invocation.command,
                args: [...invocation.args, "app-server", "--stdio"],
                emit: this.processEmit,
                version: VERSION,
                onExit: () => { this.clientPromise = undefined; },
            }).catch((error) => {
                this.clientPromise = undefined;
                throw error;
            });
        }
        return await this.clientPromise;
    }

    async probe() {
        const client = await this.client();
        const [account, limits] = await Promise.all([client.readAccount(), client.readRateLimits().catch(() => undefined)]);
        return { account, limits };
    }

    async startChatGPTLogin() {
        return await (await this.client()).startChatGPTLogin();
    }

    async logoutAccount() {
        return await (await this.client()).logoutAccount();
    }

    async restart() {
        const existing = this.clientPromise ? await this.clientPromise.catch(() => undefined) : undefined;
        this.clientPromise = undefined;
        await existing?.dispose();
        return await this.client();
    }

    async dispose() {
        const sessions = [...this.sessionProcesses.values()];
        this.sessionProcesses.clear();
        await Promise.all(sessions.map(session => session.dispose()));
        const existing = this.clientPromise ? await this.clientPromise.catch(() => undefined) : undefined;
        this.clientPromise = undefined;
        await existing?.dispose();
    }

    async releaseSession(sessionId: string) {
        const scoped = this.sessionProcesses.get(sessionId);
        this.sessionProcesses.delete(sessionId);
        await scoped?.dispose();
    }
}

export function codexBin() {
    return path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
}

export function codexInvocation() {
    const explicit = String(process.env.FILMOS_CODEX_EXECUTABLE || "").trim();
    const nativeCandidates = [
        explicit,
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/Applications/Codex.app/Contents/Resources/codex",
    ].filter(Boolean);
    const native = nativeCandidates.find((candidate) => {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    });
    if (native) return { command: native, args: [] as string[], source: explicit && native === explicit ? "explicit" as const : "official_app" as const };
    return { command: process.execPath, args: [codexBin()], source: "node_package" as const };
}
