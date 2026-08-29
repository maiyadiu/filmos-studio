import type { FilmCommand } from "./contracts.js";
import {
  FilmAgentGatewayError,
  type FilmCanvasObservationSource,
  type FilmCoreTransport,
} from "./gateway.js";

const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

type RuntimeConfig = { url: string; token: string };

export class HttpFilmCoreTransport implements FilmCoreTransport {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = normalizeFilmCoreBaseUrl(baseUrl);
  }

  getProjectContext(hostProjectId: string, signal?: AbortSignal) {
    return this.request(
      "GET",
      `/projects/${encodeURIComponent(hostProjectId)}/context`,
      undefined,
      signal,
    );
  }

  getEntity(filmEntityId: string, signal?: AbortSignal) {
    return this.request(
      "GET",
      `/entities/${encodeURIComponent(filmEntityId)}`,
      undefined,
      signal,
    );
  }

  getAuditEvents(
    input: { targetId?: string; limit?: number },
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams();
    if (input.targetId) query.set("targetId", input.targetId);
    if (input.limit) query.set("limit", String(input.limit));
    return this.request(
      "GET",
      `/audit-events${query.size ? `?${query}` : ""}`,
      undefined,
      signal,
    );
  }

  previewCommand(command: FilmCommand, signal?: AbortSignal) {
    return this.request("POST", "/commands/preview", command, signal);
  }

  applyCommand(command: FilmCommand, signal?: AbortSignal) {
    return this.request("POST", "/commands/apply", command, signal);
  }

  private async request(
    method: "GET" | "POST",
    pathname: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
    timer.unref();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method,
        headers:
          body === undefined
            ? { accept: "application/json" }
            : {
                accept: "application/json",
                "content-type": "application/json",
              },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: "manual",
      });
      const data = await readBoundedJson(response);
      if (!response.ok) {
        const code =
          response.status === 409
            ? "version_conflict"
            : `film_core_http_${response.status}`;
        throw new FilmAgentGatewayError(
          code,
          `Film Core 请求失败（HTTP ${response.status}）`,
        );
      }
      return data;
    } catch (error) {
      if (error instanceof FilmAgentGatewayError) throw error;
      throw new FilmAgentGatewayError(
        "film_core_unavailable",
        "Film Core 本地 Sidecar 不可用或响应无效",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

export class CanvasAgentObservationSource implements FilmCanvasObservationSource {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async current(signal?: AbortSignal) {
    const grantHeaders: Record<string, string> = process.env.FILMOS_AGENT_GATEWAY_ENABLED === "true" ? {
      "x-filmos-agent-grant-id": String(process.env.FILMOS_AGENT_GRANT_ID || ""),
      "x-filmos-agent-session-id": String(process.env.FILMOS_AGENT_SESSION_ID || ""),
      "x-filmos-agent-connection-id": String(process.env.FILMOS_AGENT_CONNECTION_ID || ""),
      "x-filmos-agent-project-id": String(process.env.FILMOS_AGENT_PROJECT_ID || ""),
      "x-filmos-agent-grant-nonce": String(process.env.FILMOS_AGENT_GRANT_NONCE || ""),
    } : {};
    const response = await this.fetchImpl(`${this.config.url}/api/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-canvas-agent-token": this.config.token,
        ...grantHeaders,
      },
      body: JSON.stringify({ name: "canvas_get_context", input: {} }),
      signal,
      redirect: "manual",
    });
    const envelope = await readBoundedJson(response);
    if (
      !response.ok ||
      !envelope ||
      typeof envelope !== "object" ||
      Array.isArray(envelope)
    ) {
      throw new FilmAgentGatewayError(
        "canvas_context_unavailable",
        "无法读取当前画布上下文",
      );
    }
    const source = envelope as Record<string, unknown>;
    const result = source.result;
    if (
      source.ok !== true ||
      !result ||
      typeof result !== "object" ||
      Array.isArray(result)
    ) {
      throw new FilmAgentGatewayError(
        "canvas_context_unavailable",
        "当前画布上下文不可用",
      );
    }
    const context = result as Record<string, unknown>;
    return {
      revision: Number(context.revision),
      stateHash: String(context.stateHash || ""),
    };
  }
}

export function filmAgentGatewayEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.FILMOS_AGENT_GATEWAY_ENABLED === "true";
}

export function filmCoreBaseUrl(env: NodeJS.ProcessEnv = process.env) {
  return normalizeFilmCoreBaseUrl(
    env.FILMOS_CORE_URL || "http://127.0.0.1:17471/film",
  );
}

export function normalizeFilmCoreBaseUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "FILMOS_CORE_URL must be an exact loopback http://127.0.0.1:<port>/film URL",
    );
  }
  if (url.pathname !== "/film" && url.pathname !== "/film/") {
    throw new Error("FILMOS_CORE_URL path must be /film");
  }
  return `${url.origin}/film`;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT_BYTES)
    throw new Error("response too large");
  if (!response.body) throw new Error("missing response body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_LIMIT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response too large");
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
