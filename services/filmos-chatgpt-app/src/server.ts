import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";

import { JsonlAuditSink, type AuditSink } from "./audit.js";
import { FilmCoreReadClient, type FilmOSReadDataSource } from "./data-source.js";
import { JsonProjectGrantStore, type ProjectGrant, type ProjectGrantStore } from "./grants.js";
import { authorizeMediaProxy, EmptyMediaProxyStore, MediaProxyError, type MediaProxyStore } from "./media.js";
import { createFilmOSMcpServer } from "./mcp.js";

type Session = { transport: StreamableHTTPServerTransport; grant: ProjectGrant; token: string };

export type FilmOSChatGPTAppOptions = {
  enabled: boolean;
  proposalHandoffEnabled: boolean;
  proposalSigningSecret?: string;
  grants: ProjectGrantStore;
  dataSource: FilmOSReadDataSource;
  audit: AuditSink;
  media?: MediaProxyStore;
  allowedOrigins?: string[];
};

export function createFilmOSChatGPTApp(options: FilmOSChatGPTAppOptions) {
  const app = express();
  const sessions = new Map<string, Session>();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!isLoopbackHost(req.headers.host)) return res.status(400).json({ code: "LOOPBACK_HOST_REQUIRED" });
    const origin = req.headers.origin;
    if (origin && !(options.allowedOrigins ?? []).includes(origin)) return res.status(403).json({ code: "ORIGIN_DENIED" });
    next();
  });

  app.get("/health", (_req, res) => res.json({
    ok: true,
    feature: "film.chatgpt_app",
    enabled: options.enabled,
    proposal_handoff_enabled: options.proposalHandoffEnabled,
    public_listener: false,
    external_account_connected: false,
  }));

  const authenticate = async (req: Request, res: Response): Promise<{ token: string; grant: ProjectGrant } | null> => {
    const authorization = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match) { res.status(401).json({ code: "PROJECT_GRANT_REQUIRED" }); return null; }
    try { return { token: match[1], grant: await options.grants.authorize(match[1]) }; }
    catch (error) { res.status(401).json({ code: (error as { code?: string }).code ?? "UNAUTHORIZED" }); return null; }
  };

  const sessionRequest = async (req: Request, res: Response) => {
    if (!options.enabled) return res.status(404).json({ code: "FILM_CHATGPT_APP_DISABLED" });
    const authorization = await authenticate(req, res);
    if (!authorization) return;
    const sessionId = req.header("mcp-session-id");
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return res.status(404).json({ code: "MCP_SESSION_NOT_FOUND" });
      if (session.grant.grant_id !== authorization.grant.grant_id) return res.status(403).json({ code: "SESSION_GRANT_MISMATCH" });
      return session.transport.handleRequest(req, res, req.body);
    }
    if (req.method !== "POST" || !isInitializeRequest(req.body)) return res.status(400).json({ code: "MCP_INITIALIZE_REQUIRED" });
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id: string) => { sessions.set(id, { transport, grant: authorization.grant, token: authorization.token }); },
    });
    const server = createFilmOSMcpServer({
      grant: authorization.grant,
      dataSource: options.dataSource,
      audit: options.audit,
      proposalHandoffEnabled: options.proposalHandoffEnabled,
      proposalSigningSecret: options.proposalSigningSecret,
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await server.connect(transport);
    return transport.handleRequest(req, res, req.body);
  };

  app.post("/mcp", sessionRequest);
  app.get("/mcp", sessionRequest);
  app.delete("/mcp", sessionRequest);
  app.get("/media/:id", async (req, res) => {
    if (!options.enabled) return res.status(404).json({ code: "FILM_CHATGPT_APP_DISABLED" });
    const authorization = await authenticate(req, res);
    if (!authorization) return;
    try {
      const object = await authorizeMediaProxy(options.media ?? new EmptyMediaProxyStore(), authorization.grant, req.params.id);
      res.type(object.content_type).set("Content-Length", String(object.bytes.byteLength)).send(Buffer.from(object.bytes));
    } catch (error) {
      if (error instanceof MediaProxyError) return res.status(error.status).json({ code: error.code });
      return res.status(500).json({ code: "MEDIA_PROXY_FAILED" });
    }
  });
  return { app, sessions };
}

export async function startFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.FILMOS_CHATGPT_APP_ENABLED === "true";
  const proposalHandoffEnabled = env.FILMOS_CHATGPT_PROPOSAL_HANDOFF_ENABLED === "true";
  const host = env.FILMOS_CHATGPT_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("FilmOS ChatGPT MCP must bind to loopback");
  const port = Number(env.FILMOS_CHATGPT_PORT ?? 17840);
  const localDir = resolve(env.FILMOS_CHATGPT_LOCAL_DIR ?? ".local/filmos-chatgpt");
  const grants = await JsonProjectGrantStore.open(resolve(localDir, "grants.json"));
  const instance = createFilmOSChatGPTApp({
    enabled,
    proposalHandoffEnabled,
    proposalSigningSecret: env.FILMOS_CHATGPT_PROPOSAL_SIGNING_SECRET,
    grants,
    dataSource: new FilmCoreReadClient(env.FILMOS_CORE_BASE_URL ?? "http://127.0.0.1:17650/film"),
    audit: new JsonlAuditSink(resolve(localDir, "audit.jsonl")),
    allowedOrigins: (env.FILMOS_CHATGPT_ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean),
  });
  const httpServer = instance.app.listen(port, host);
  return { ...instance, httpServer, host, port };
}

function isLoopbackHost(value: string | undefined): boolean {
  if (!value) return false;
  const host = value.replace(/^\[/, "").split("]")[0].split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startFromEnvironment().then(({ host, port }) => process.stdout.write(`FilmOS ChatGPT local MCP: http://${host}:${port}/mcp\n`)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; });
}
