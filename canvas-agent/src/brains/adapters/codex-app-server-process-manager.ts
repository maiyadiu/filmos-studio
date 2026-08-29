import { createRequire } from "node:module";
import path from "node:path";

import { VERSION } from "../../config.js";
import type { AgentEmit } from "../../types.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";

const require = createRequire(import.meta.url);

export class CodexAppServerProcessManager {
    private clientPromise?: Promise<CodexAppServerClient>;

    constructor(
        private readonly processEmit: AgentEmit = () => undefined,
        private readonly startClient: (options: Parameters<typeof CodexAppServerClient.start>[0]) => Promise<CodexAppServerClient> = CodexAppServerClient.start,
    ) {}

    async client() {
        if (!this.clientPromise) {
            const args = [codexBin(), "app-server", "--stdio"];
            this.clientPromise = this.startClient({
                command: process.execPath,
                args,
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
        const existing = this.clientPromise ? await this.clientPromise.catch(() => undefined) : undefined;
        this.clientPromise = undefined;
        await existing?.dispose();
    }
}

export function codexBin() {
    return path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
}
