import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";

import { auditRecord, JsonlAuditSink, type AuditSink } from "./audit.js";
import { FilmCoreReadClient, type FilmOSReadDataSource } from "./data-source.js";
import { JsonProjectGrantStore, type ProjectGrant, type ProjectGrantStore } from "./grants.js";
import { ChatGPTHostContextStore } from "./host-context.js";
import { authorizeMediaProxy, EmptyMediaProxyStore, MediaProxyError, type MediaProxyStore } from "./media.js";
import { buildFilmOSMcpManifest, createFilmOSMcpServer } from "./mcp.js";
import { PythonProposalPreviewAdapter, ProposalPreviewError, type ProposalPreviewAdapter } from "./proposal-preview.js";
import { HttpReviewReadSource, type ReviewReadSource } from "./review-source.js";

type TunnelContext = { tunneled: boolean; challengeId: string | null };
type Session = { transport: StreamableHTTPServerTransport; grant: ProjectGrant; tunnel: TunnelContext };

type ExternalObservation = {
  connection_id: string;
  mcp_session_id: string;
  grant_id: string;
  project_id: string;
  last_chatgpt_mcp_request_at: string;
  tool_name: string;
  request_id: string;
  project_scope: string;
  challenge_id: string;
  result_hash: string | null;
  handoff_id: string | null;
  observed_at: string;
  expires_at: string;
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
  connectionId?: string;
  hostProfileId?: string;
  externalObservationTtlMs?: number;
  hostContext?: ChatGPTHostContextStore;
  reviewRead?: ReviewReadSource;
};

export function createFilmOSChatGPTApp(options: FilmOSChatGPTAppOptions) {
  const app = express();
  const mcpInstanceId = randomUUID();
  const sessions = new Map<string, Session>();
  const observations = new Map<string, { last_read_at: string; last_context_snapshot: { uri: string | null; version: number | null; state_hash: string | null } }>();
  const externalObservations = new Map<string, Map<string, ExternalObservation>>();
  const hostContext = options.hostContext ?? new ChatGPTHostContextStore();
  const connectionId = options.connectionId ?? "chatgpt.subscription.host";
  const hostProfileId = options.hostProfileId ?? "chatgpt.subscription.host.pro_readonly";
  const proposalHandoffEnabled = options.proposalHandoffEnabled && hostProfileAllowsProposal(hostProfileId);
  const manifest = buildFilmOSMcpManifest({
    readToolsEnabled: options.readToolsEnabled,
    widgetsEnabled: options.widgetsEnabled,
    proposalHandoffEnabled,
    reviewReadToolsEnabled: Boolean(options.reviewRead),
  });
  const manifestCounts = countManifestRisks(manifest);
  const observationTtlMs = boundedObservationTtl(options.externalObservationTtlMs);
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
    mcp_instance_id: mcpInstanceId,
    feature: "film.chatgpt_app",
    enabled: options.enabled,
    profile_id: hostProfileId,
    billing_mode: "subscription_host_no_extra_model_api",
    model_api_adapter_available: false,
    fallback_enabled: false,
    proposal_handoff_enabled: proposalHandoffEnabled,
    public_listener: false,
    mcp_manifest: manifest,
    mcp_tool_names: manifest.map((tool) => tool.name),
    mcp_tool_count: manifest.length,
    ...manifestCounts,
    review_bus_read_tools_enabled: Boolean(options.reviewRead),
    review_bus_read_tool_count: manifest.filter((tool) => tool.feature_flag === "film.review_bus_readonly").length,
    external_account_connected: false,
    observation_scope: "authenticated_handoff_status_only",
    chatgpt_tool_auth: "noauth",
    project_authorization: "secure_tunnel_injected_project_grant",
  }));

  const oauthNotConfigured = (_req: Request, res: Response) => res.status(404).json({
    code: "OAUTH_NOT_CONFIGURED",
    chatgpt_tool_auth: "noauth",
    project_authorization: "secure_tunnel_injected_project_grant",
  });
  app.get("/.well-known/oauth-protected-resource", oauthNotConfigured);
  app.get("/.well-known/oauth-protected-resource/mcp", oauthNotConfigured);
  app.get("/.well-known/oauth-authorization-server", oauthNotConfigured);

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
      const result = await session.transport.handleRequest(req, res, req.body);
      if (req.method === "DELETE") clearExternalSession(sessions, externalObservations, sessionId, session.grant.grant_id);
      return result;
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
      proposalHandoffEnabled,
      proposalSigningSecret: options.proposalSigningSecret,
      readToolsEnabled: options.readToolsEnabled,
      widgetsEnabled: options.widgetsEnabled,
      reviewRead: options.reviewRead,
      reviewReadToolsEnabled: Boolean(options.reviewRead),
      liveGate: tunnel.challengeId ? { challengeId: tunnel.challengeId, tunneled: tunnel.tunneled } : undefined,
      hostContext,
      onRead: (snapshot) => {
        observations.set(authorization.grant.grant_id, {
          last_read_at: snapshot.read_at,
          last_context_snapshot: { uri: snapshot.uri, version: snapshot.version, state_hash: snapshot.state_hash },
        });
        if (tunnel.tunneled && tunnel.challengeId) {
          const sessionId = transport.sessionId;
          if (!sessionId) return;
          const observedAt = new Date(snapshot.read_at);
          const grantExpiry = new Date(authorization.grant.expires_at).getTime();
          const expiresAt = new Date(Math.min(grantExpiry, observedAt.getTime() + observationTtlMs));
          let handoffId: string | null = null;
          try {
            handoffId = hostContext.requireHandoff(authorization.grant, tunnel.challengeId, observedAt).handoff_id;
          } catch {
            // A regular MCP read can be externally observed without belonging to an Agent Handoff.
          }
          const value: ExternalObservation = {
            connection_id: connectionId,
            mcp_session_id: sessionId,
            grant_id: authorization.grant.grant_id,
            project_id: authorization.grant.project_id,
            last_chatgpt_mcp_request_at: snapshot.read_at,
            tool_name: snapshot.tool_name,
            request_id: snapshot.request_id,
            project_scope: authorization.grant.project_id,
            challenge_id: tunnel.challengeId,
            result_hash: snapshot.state_hash,
            handoff_id: handoffId,
            observed_at: observedAt.toISOString(),
            expires_at: expiresAt.toISOString(),
          };
          const scoped = externalObservations.get(authorization.grant.grant_id) ?? new Map<string, ExternalObservation>();
          scoped.set(sessionId, value);
          externalObservations.set(authorization.grant.grant_id, scoped);
        }
      },
    });
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (!sessionId) return;
      clearExternalSession(sessions, externalObservations, sessionId, authorization.grant.grant_id);
      hostContext.revokeChallenge(authorization.grant.grant_id, tunnel.challengeId);
    };
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
    const externalObservation = freshestObservation(externalObservations, authorization.grant);
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
      profile_id: hostProfileId,
      billing_mode: "subscription_host_no_extra_model_api",
      model_api_adapter_available: false,
      fallback_enabled: false,
      proposal_handoff_enabled: proposalHandoffEnabled,
      mcp_manifest: manifest,
      mcp_tool_names: manifest.map((tool) => tool.name),
      mcp_tool_count: manifest.length,
      ...manifestCounts,
      last_chatgpt_mcp_request_at: externalObservation?.last_chatgpt_mcp_request_at ?? null,
      tool_name: externalObservation?.tool_name ?? null,
      request_id: externalObservation?.request_id ?? null,
      project_scope: externalObservation?.project_scope ?? null,
      challenge_id: externalObservation?.challenge_id ?? null,
      result_hash: externalObservation?.result_hash ?? null,
      handoff_id: externalObservation?.handoff_id ?? null,
      connection_id: externalObservation?.connection_id ?? connectionId,
      mcp_session_id: externalObservation?.mcp_session_id ?? null,
      observation_expires_at: externalObservation?.expires_at ?? null,
      status_code: externalObservation ? "CHATGPT_REACHED_FILMOS" : "WAITING_FOR_CHATGPT",
    };
    await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.status", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "ALLOW", result_size: byteSize(body) }));
    return res.json(body);
  });
  app.put("/handoff/live-context", async (req, res) => {
    if (!options.enabled) return res.status(404).json({ code: "FILM_CHATGPT_APP_DISABLED" });
    const authorization = await authenticate(req, res);
    if (!authorization) return;
    try {
      assertExactKeys(req.body, ["challenge_id", "context"]);
      const context = hostContext.publishContext(authorization.grant, String(req.body.challenge_id || ""), req.body.context);
      const body = { accepted: true, project_id: authorization.grant.project_id, context_receipt_id: context.context_receipt_id, expires_at: context.expires_at };
      await options.audit.write(auditRecord({
        correlation_id: randomUUID(),
        action: "handoff.live_context.publish",
        grant_id: authorization.grant.grant_id,
        project_id: authorization.grant.project_id,
        outcome: "ALLOW",
        output_hash: context.canvas_state_hash,
        context_receipt_id: context.context_receipt_id,
        challenge_id: String(req.body.challenge_id),
        result_size: byteSize(body),
      }));
      return res.json(body);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "INVALID_LIVE_CONTEXT";
      const body = { code };
      await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.live_context.publish", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "DENY", result_size: byteSize(body), code }));
      return res.status(400).json(body);
    }
  });
  app.post("/handoff/pending-agent", async (req, res) => {
    if (!options.enabled) return res.status(404).json({ code: "FILM_CHATGPT_APP_DISABLED" });
    const authorization = await authenticate(req, res);
    if (!authorization) return;
    try {
      assertExactKeys(req.body, ["challenge_id", "handoff"]);
      const handoff = hostContext.publishHandoff(authorization.grant, String(req.body.challenge_id || ""), req.body.handoff);
      const body = { accepted: true, project_id: authorization.grant.project_id, handoff_id: handoff.handoff_id, status: handoff.status, expires_at: handoff.expires_at };
      await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.pending_agent.publish", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "ALLOW", result_size: byteSize(body) }));
      return res.json(body);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "INVALID_PENDING_HANDOFF";
      const body = { code };
      await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.pending_agent.publish", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "DENY", result_size: byteSize(body), code }));
      return res.status(400).json(body);
    }
  });
  app.post("/handoff/disconnect", async (req, res) => {
    if (!options.enabled) return res.status(404).json({ code: "FILM_CHATGPT_APP_DISABLED" });
    const authorization = await authenticate(req, res);
    if (!authorization) return;
    externalObservations.delete(authorization.grant.grant_id);
    observations.delete(authorization.grant.grant_id);
    hostContext.revokeGrant(authorization.grant.grant_id);
    for (const [sessionId, session] of sessions) {
      if (session.grant.grant_id !== authorization.grant.grant_id) continue;
      sessions.delete(sessionId);
      await session.transport.close().catch(() => undefined);
    }
    const body = { disconnected: true, grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id };
    await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.disconnect", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "ALLOW", result_size: byteSize(body) }));
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
    externalObservations.delete(authorization.grant.grant_id);
    observations.delete(authorization.grant.grant_id);
    hostContext.revokeGrant(authorization.grant.grant_id);
    for (const [sessionId, session] of sessions) {
      if (session.grant.grant_id !== authorization.grant.grant_id) continue;
      sessions.delete(sessionId);
      await session.transport.close().catch(() => undefined);
    }
    const body = { revoked: true, grant_id: authorization.grant.grant_id, revoked_at: revokedAt.toISOString() };
    await options.audit.write(auditRecord({ correlation_id: randomUUID(), action: "handoff.grant.revoke", grant_id: authorization.grant.grant_id, project_id: authorization.grant.project_id, outcome: "ALLOW", result_size: byteSize(body) }));
    return res.json(body);
  });
  app.post("/handoff/proposals/preview", async (req, res) => {
    if (!options.enabled) return res.status(404).json({ code: "FILM_CHATGPT_APP_DISABLED" });
    const authorization = await authenticate(req, res);
    if (!authorization) return;
    if (!proposalHandoffEnabled) {
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
  return { app, sessions, externalObservations };
}

export async function startFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.FILMOS_CHATGPT_APP_ENABLED === "true";
  const readToolsEnabled = env.FILMOS_CHATGPT_READ_TOOLS_ENABLED === "true";
  const widgetsEnabled = env.FILMOS_CHATGPT_WIDGETS_ENABLED === "true";
  const proposalHandoffEnabled = env.FILMOS_CHATGPT_PROPOSAL_HANDOFF_ENABLED === "true";
  const hostProfileId = env.FILMOS_CHATGPT_HOST_PROFILE ?? "chatgpt.subscription.host.pro_readonly";
  const host = env.FILMOS_CHATGPT_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error("FilmOS ChatGPT MCP must bind to loopback");
  const port = Number(env.FILMOS_CHATGPT_PORT ?? 17840);
  const localDir = resolve(env.FILMOS_CHATGPT_LOCAL_DIR ?? ".local/filmos-chatgpt");
  const pidFile = env.FILMOS_CHATGPT_PID_FILE ? resolve(env.FILMOS_CHATGPT_PID_FILE) : null;
  const reviewReadEnabled = env.FILMOS_REVIEW_BUS_READ_ENABLED === "true";
  const reviewTokenFile = resolve(env.FILMOS_REVIEW_BUS_AUTH_FILE ?? resolve(homedir(), "Library/Application Support/FilmOS Studio/review-bus/review-bus.token"));
  const reviewToken = reviewReadEnabled ? (env.FILMOS_REVIEW_BUS_TOKEN ?? readFileSync(reviewTokenFile, "utf8").trim()) : null;
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
    connectionId: env.FILMOS_CHATGPT_CONNECTION_ID ?? "chatgpt.subscription.host",
    hostProfileId,
    externalObservationTtlMs: Number(env.FILMOS_CHATGPT_OBSERVATION_TTL_MS ?? 300_000),
    reviewRead: reviewReadEnabled && reviewToken ? new HttpReviewReadSource(env.FILMOS_REVIEW_BUS_BASE_URL ?? "http://127.0.0.1:17920", reviewToken) : undefined,
  });
  const httpServer = instance.app.listen(port, host);
  await new Promise<void>((resolveListening, rejectListening) => {
    const onError = (error: Error) => rejectListening(error);
    httpServer.once("error", onError);
    httpServer.once("listening", () => {
      httpServer.off("error", onError);
      resolveListening();
    });
  });
  if (pidFile) {
    writeFileSync(pidFile, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
    httpServer.once("close", () => {
      try {
        if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) unlinkSync(pidFile);
      } catch {
        // A missing or replaced PID file already represents a completed cleanup.
      }
    });
  }
  return { ...instance, httpServer, host, port };
}

function byteSize(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }

function assertExactKeys(value: unknown, expected: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST_BODY");
  const actual = Object.keys(value as Record<string, unknown>).sort();
  if (actual.join("\n") !== [...expected].sort().join("\n")) throw new Error("INVALID_REQUEST_BODY");
}

function hostProfileAllowsProposal(profileId: string): boolean {
  return profileId === "chatgpt.subscription.host.pro_readonly" || profileId === "chatgpt.host.full_mcp";
}

function boundedObservationTtl(value: number | undefined): number {
  return Number.isFinite(value) ? Math.min(15 * 60_000, Math.max(100, Number(value))) : 5 * 60_000;
}

function countManifestRisks(manifest: ReturnType<typeof buildFilmOSMcpManifest>) {
  const count = (risk: string) => manifest.filter((tool) => tool.risk === risk).length;
  return {
    mcp_read_tool_count: count("read"),
    mcp_write_tool_count: count("write"),
    mcp_paid_tool_count: count("paid"),
    mcp_destructive_tool_count: count("destructive"),
  };
}

function freshestObservation(store: Map<string, Map<string, ExternalObservation>>, grant: ProjectGrant): ExternalObservation | null {
  const scoped = store.get(grant.grant_id);
  if (!scoped) return null;
  const now = Date.now();
  for (const [sessionId, value] of scoped) {
    if (value.project_id !== grant.project_id || Date.parse(value.expires_at) <= now || Date.parse(grant.expires_at) <= now) scoped.delete(sessionId);
  }
  if (!scoped.size) { store.delete(grant.grant_id); return null; }
  return [...scoped.values()].sort((left, right) => Date.parse(right.observed_at) - Date.parse(left.observed_at))[0] ?? null;
}

function clearExternalSession(
  sessions: Map<string, Session>,
  observations: Map<string, Map<string, ExternalObservation>>,
  sessionId: string,
  grantId: string,
) {
  sessions.delete(sessionId);
  const scoped = observations.get(grantId);
  scoped?.delete(sessionId);
  if (!scoped?.size) observations.delete(grantId);
}

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
