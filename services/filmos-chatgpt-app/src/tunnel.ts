import { access } from "node:fs/promises";

import { assertLoopbackUrl } from "./security.js";

export type TunnelDoctorReceipt = {
  kind: "FILMOS_SECURE_TUNNEL_DOCTOR";
  status: "READY_LOCAL_CONFIG" | "BLOCKED_EXTERNAL_ACCOUNT" | "BLOCKED_LOCAL_CONFIG";
  tunnel_started: false;
  public_listener_created: false;
  checks: Record<string, boolean>;
  blockers: string[];
};

export async function inspectSecureTunnel(env: NodeJS.ProcessEnv = process.env): Promise<TunnelDoctorReceipt> {
  const checks: Record<string, boolean> = {};
  const blockers: string[] = [];
  try { assertLoopbackUrl(env.FILMOS_CHATGPT_MCP_URL ?? "http://127.0.0.1:17840/mcp", "MCP URL"); checks.loopback_mcp = true; }
  catch { checks.loopback_mcp = false; blockers.push("LOCAL_MCP_NOT_LOOPBACK"); }
  checks.tunnel_id = Boolean(env.OPENAI_MCP_TUNNEL_ID?.trim());
  checks.runtime_key = Boolean(env.OPENAI_MCP_TUNNEL_RUNTIME_KEY?.trim());
  if (!checks.tunnel_id) blockers.push("MISSING_PLATFORM_TUNNEL_ID");
  if (!checks.runtime_key) blockers.push("MISSING_TUNNEL_RUNTIME_KEY");
  if (env.FILMOS_TUNNEL_CLIENT_PATH) {
    try { await access(env.FILMOS_TUNNEL_CLIENT_PATH); checks.tunnel_client = true; }
    catch { checks.tunnel_client = false; blockers.push("TUNNEL_CLIENT_NOT_FOUND"); }
  } else {
    checks.tunnel_client = false;
    blockers.push("TUNNEL_CLIENT_NOT_CONFIGURED");
  }
  const externalMissing = blockers.some((item) => item.startsWith("MISSING_PLATFORM") || item.includes("RUNTIME_KEY"));
  return {
    kind: "FILMOS_SECURE_TUNNEL_DOCTOR",
    status: externalMissing ? "BLOCKED_EXTERNAL_ACCOUNT" : blockers.length ? "BLOCKED_LOCAL_CONFIG" : "READY_LOCAL_CONFIG",
    tunnel_started: false,
    public_listener_created: false,
    checks,
    blockers,
  };
}
