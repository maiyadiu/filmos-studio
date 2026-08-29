import { randomUUID, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";

import { auditRecord, JsonlAuditSink, type AuditSink } from "./audit.js";
import { FilmCoreReadClient, type FilmOSReadDataSource } from "./data-source.js";
import { JsonProjectGrantStore, type ProjectGrant, type ProjectGrantStore } from "./grants.js";
import { authorizeMediaProxy, EmptyMediaProxyStore, MediaProxyError, type MediaProxyStore } from "./media.js";
import { createFilmOSMcpServer } from "./mcp.js";
import { PythonProposalPreviewAdapter, ProposalPreviewError, type ProposalPreviewAdapter } from "./proposal-preview.js";

type TunnelContext = { tunneled: boolean; challengeId: string | null };
type Session = { transport: StreamableHTTPServerTransport; grant: ProjectGrant; tunnel: TunnelContext };

type ExternalObservation = {
  last_chatgpt_mcp_request_at: string;
  tool_name: string;
  request_id: string;
  project_scope: string;
  challenge_id: string;
  result_hash: string | null;
};

export type FilmOSChatGPTAppOptions = {
  enabled: boolean;
  readToolsEnabled?: boolean;
  widgetsEnabled?: boolean;
  proposalHandoffEnabled: boolean;
  proposalSigningSecret?: string;
  grants: ProjectGrantStore;
  dataSource: FilmOSReadDataSource;
  audit: AuditSink;
  media?: MediaProxyStore;
  allowedOrigins?: string[];
  proposalPreview?: ProposalPreviewAdapter;
  secureTunnelProof?: string;
};

export function createFilmOSChatGPTApp(options: FilmOSChatGPTAppOptions) {
  const app = express();
  const sessions = new Map<string, Session>();
  const observations = new Map<string, { last_read_at: string; last_context_snapshot: { uri: string | null; version: number | null; state_hash: string | null } }>();
  let externalObservation: ExternalObservation | null = null;
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
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
    external_account_connected: externalObservation !== null,
    last_chatgpt_mcp_request_at: externalObservation?.last_chatgpt_mcp_request_at ?? null,
    tool_name: externalObservation?.tool_name ?? null,
    request_id: externalObservation?.request_id ?? null,
    project_scope: externalObservation?.project_scope ?? null,
    challenge_id: externalObservation?.challenge_id ?? null,
    result_hash: externalObservation?.result_hash ?? null,
  }));

  const authenticate = async (req: Request, res: Response): Promise<{ grant: ProjectGrant } | null> => {
    const authorization = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match) { res.status(401).json({ code: "PROJECT_GRANT_REQUIRED" }); return null; }
    try { return { grant: await options.grants.authorize(match[1]) }; }
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
    const tunnel = secureTunnelContext(req, options.secureTunnelProof);
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id: string) => { sessions.set(id, { transport, grant: authorization.grant, tunnel }); },
    });
    const server = createFilmOSMcpServer({
      grant: authorization.grant,
      dataSource: options.dataSource,
      audit: options.audit,
      proposalHandoffEnabled: options.proposalHandoffEnabled,
      proposalSigningSecret: options.proposalSigningSecret,
      readToolsEnabled: options.readToolsEnabled,
      widgetsEnabled: options.widgetsEnabled,
      liveGate: tunnel.challengeId ? { challengeId: tunnel.challengeId, tunneled: tunnel.tunneled } : undefined,
      onRead: (snapshot) => {
        observations.set(authorization.grant.grant_id, {
          last_read_at: snapshot.read_at,
          last_context_snapshot: { uri: snapshot.uri, version: snapshot.version, state_hash: snapshot.state_hash },
        });
        if (tunnel.tunneled && tunnel.challengeId) {
          externalObservation = {
            last_chatgpt_mcp_request_at: snapshot.read_at,
            tool_name: snapshot.tool_name,
            request_id: snapshot.request_id,
            project_scope: authorization.grant.project_id,
            challenge_id: tunnel.challengeId,
            result_hash: snapshot.state_hash,
          };
        }
      },
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await server.connect(transport);
    return transport.handleRequest(req, res, req.body);
  };

  app.post("/mcp", sessionRequest);
  app.get("/mcp", sessionRequest);
  app.delete("/mcp", sessionRequest);
  app.get("/handoff/status", async (req, res) => {
    if (!options.enabled) return res.status(404).json({ code: "FILM_CHATGPT_APP_DISABLED" });
    const authorization = await authenticate(req, res);
    if (!authorization) return;
    const requestedProjectId = req.query.project_id;
    if (requestedProjectId !== undefined && (typeof requestedProjectId !== "string" || requestedProjectId !== authorization.grant.project_id)) {
      const body = { code: "PROJECT_SCOPE_DENIED" };
      await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.status", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "DENY", result_size: byteSize(body), code: body.code }));
      return res.status(403).json(body);
    }
    const observation = observations.get(authorization.grant.grant_id);
    const body = {
      connection: externalObservation ? "connected" : "disconnected",
      local_mcp_ready: true,
      external_account_connected: externalObservation !== null,
      authorized_project: {
        project_id: authorization.grant.project_id,
        grant_id: authorization.grant.grant_id,
        expires_at: authorization.grant.expires_at,
      },
      last_read_at: observation?.last_read_at ?? null,
      last_context_snapshot: observation?.last_context_snapshot ?? null,
      proposal_handoff_enabled: options.proposalHandoffEnabled,
      last_chatgpt_mcp_request_at: externalObservation?.last_chatgpt_mcp_request_at ?? null,
      tool_name: externalObservation?.tool_name ?? null,
      request_id: externalObservation?.request_id ?? null,
      project_scope: externalObservation?.project_scope ?? null,
      challenge_id: externalObservation?.challenge_id ?? null,
      result_hash: externalObservation?.result_hash ?? null,
      status_code: externalObservation ? "CHATGPT_REACHED_FILMOS" : "WAITING_FOR_CHATGPT",
    };
    await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.status", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "ALLOW", result_size: byteSize(body) }));
    return res.json(body);
  });
  app.post("/handoff/grants/revoke", async (req, res) => {
    if (!options.enabled) return res.status(404).json({ code: "FILM_CHATGPT_APP_DISABLED" });
    const authorization = await authenticate(req, res);
    if (!authorization) return;
    if (req.body?.grant_id && req.body.grant_id !== authorization.grant.grant_id) {
      const body = { code: "GRANT_SCOPE_DENIED" };
      await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.grant.revoke", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "DENY", result_size: byteSize(body), code: body.code }));
      return res.status(403).json(body);
    }
    const revokedAt = new Date();
    await options.grants.revoke(authorization.grant.grant_id, revokedAt);
    const body = { revoked: true, grant_id: authorization.grant.grant_id, revoked_at: revokedAt.toISOString() };
    await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.grant.revoke", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "ALLOW", result_size: byteSize(body) }));
    return res.json(body);
  });
  app.post("/handoff/proposals/preview", async (req, res) => {
    if (!options.enabled) return res.status(404).json({ code: "FILM_CHATGPT_APP_DISABLED" });
    const authorization = await authenticate(req, res);
    if (!authorization) return;
    if (!options.proposalHandoffEnabled) {
      const body = { code: "FILM_CHATGPT_PROPOSAL_HANDOFF_DISABLED" };
      await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.proposal.preview", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "DENY", result_size: byteSize(body), code: body.code }));
      return res.status(404).json(body);
    }
    if (!options.proposalPreview) {
      const body = { code: "PROPOSAL_IMPORT_NOT_CONFIGURED", status: "BLOCKED_LOCAL_CONFIG" };
      await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.proposal.preview", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "DENY", result_size: byteSize(body), code: body.code }));
      return res.status(503).json(body);
    }
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || !("package" in req.body) || !req.body.package || typeof req.body.package !== "object" || Array.isArray(req.body.package)) {
      const body = { code: "INVALID_PROPOSAL_PACKAGE", status: "REJECTED" };
      await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.proposal.preview", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "DENY", result_size: byteSize(body), code: body.code }));
      return res.status(400).json(body);
    }
    try {
      const context = await options.dataSource.read("filmos_get_project_context", {}, authorization.grant);
      const result = await options.proposalPreview.preview(req.body.package, authorization.grant, { state_hash: context.state_hash, versions: { [context.uri]: context.version } });
      if (result.ok !== true || result.kind !== "FILMOS_PROPOSAL_IMPORT_PREVIEW" || !result.preview) throw new ProposalPreviewError("INVALID_IMPORTER_RESPONSE", "Film Core proposal importer returned an invalid response");
      await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.proposal.preview", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "ALLOW", output_hash: context.state_hash, result_size: byteSize(result) }));
      return res.json(result);
    } catch (error) {
      const code = error instanceof ProposalPreviewError ? error.code : "PROPOSAL_IMPORT_FAILED";
      const body = { code, status: "REJECTED" };
      await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.proposal.preview", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "DENY", result_size: byteSize(body), code }));
      return res.status(409).json(body);
    }
  });
  app.get("/media/:id", async (req, res) => {
    if (!options.enabled) return res.status(404).json({ code: "FILM_CHATGPT_APP_DISABLED" });
    const authorization = await authenticate(req, res);
    if (!authorization) return;
    try {
      const object = await authorizeMediaProxy(options.media ?? new EmptyMediaProxyStore(), authorization.grant, req.params.id);
      await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "media.proxy", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "ALLOW", result_size: object.bytes.byteLength }));
      res.type(object.content_type).set("Content-Length", String(object.bytes.byteLength)).send(Buffer.from(object.bytes));
    } catch (error) {
      const code = error instanceof MediaProxyError ? error.code : "MEDIA_PROXY_FAILED";
      const status = error instanceof MediaProxyError ? error.status : 500;
      const body = { code };
      await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "media.proxy", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: error instanceof MediaProxyError ? "DENY" : "ERROR", result_size: byteSize(body), code }));
      return res.status(status).json(body);
    }
  });
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    const status = Number((error as { status?: unknown }).status ?? 0);
    const type = String((error as { type?: unknown }).type ?? "");
    if (status === 413 || type === "entity.too.large") return res.status(413).json({ code: "REQUEST_TOO_LARGE" });
    if (status === 400 || error instanceof SyntaxError) return res.status(400).json({ code: "INVALID_JSON" });
    return next(error);
  });
  return { app, sessions };
}

export async function startFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.FILMOS_CHATGPT_APP_ENABLED === "true";
  const readToolsEnabled = env.FILMOS_CHATGPT_READ_TOOLS_ENABLED === "true";
  const widgetsEnabled = env.FILMOS_CHATGPT_WIDGETS_ENABLED === "true";
  const proposalHandoffEnabled = env.FILMOS_CHATGPT_PROPOSAL_HANDOFF_ENABLED === "true";
  const host = env.FILMOS_CHATGPT_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("FilmOS ChatGPT MCP must bind to loopback");
  const port = Number(env.FILMOS_CHATGPT_PORT ?? 17840);
  const localDir = resolve(env.FILMOS_CHATGPT_LOCAL_DIR ?? ".local/filmos-chatgpt");
  const grants = await JsonProjectGrantStore.open(resolve(localDir, "grants.json"));
  const instance = createFilmOSChatGPTApp({
    enabled,
    readToolsEnabled,
    widgetsEnabled,
    proposalHandoffEnabled,
    proposalSigningSecret: env.FILMOS_CHATGPT_PROPOSAL_SIGNING_SECRET,
    grants,
    dataSource: new FilmCoreReadClient(env.FILMOS_CORE_BASE_URL ?? "http://127.0.0.1:17650/film"),
    audit: new JsonlAuditSink(resolve(localDir, "audit.jsonl")),
    allowedOrigins: (env.FILMOS_CHATGPT_ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean),
    proposalPreview: env.FILMOS_CHATGPT_IMPORT_PYTHON && env.FILMOS_CHATGPT_IMPORT_MODULE_ROOT && env.FILMOS_CHATGPT_PROPOSAL_SIGNING_SECRET ? new PythonProposalPreviewAdapter({
      pythonExecutable: env.FILMOS_CHATGPT_IMPORT_PYTHON,
      moduleRoot: env.FILMOS_CHATGPT_IMPORT_MODULE_ROOT,
      signingSecret: env.FILMOS_CHATGPT_PROPOSAL_SIGNING_SECRET,
      receiptDirectory: resolve(localDir, "proposal-receipts"),
    }) : undefined,
    secureTunnelProof: env.FILMOS_SECURE_TUNNEL_PROOF,
  });
  const httpServer = instance.app.listen(port, host);
  return { ...instance, httpServer, host, port };
}

function byteSize(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }

function isLoopbackHost(value: string | undefined): boolean {
  if (!value) return false;
  const host = value.startsWith("[") ? value.slice(1, value.indexOf("]")) : value.split(":")[0];
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function secureTunnelContext(req: Request, expectedProof?: string): TunnelContext {
  const transport = req.header("x-filmos-transport") ?? "";
  const proof = req.header("x-filmos-transport-proof") ?? "";
  const challengeId = req.header("x-filmos-live-gate-challenge") ?? "";
  const validChallenge = /^live_[A-Za-z0-9_-]{8,96}$/.test(challengeId);
  return {
    tunneled: transport === "secure-mcp-tunnel" && safeTextEqual(proof, expectedProof ?? "") && validChallenge,
    challengeId: validChallenge ? challengeId : null,
  };
}

function safeTextEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

export function isExecutedAsMain(moduleUrl: string, argvPath: string | undefined): boolean {
  return Boolean(argvPath) && fileURLToPath(moduleUrl) === resolve(argvPath!);
}

if (isExecutedAsMain(import.meta.url, process.argv[1])) {
  startFromEnvironment().then(({ host, port }) => process.stdout.write(`FilmOS ChatGPT local MCP: http://${host}:${port}/mcp\n`)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : error}\n`); process.exitCode = 1; });
}
