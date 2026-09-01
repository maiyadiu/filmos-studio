export const CHATGPT_NOAUTH_SECURITY_SCHEMES = [{ type: "noauth" }] as const;

export function chatGPTNoauthMeta(existing?: Record<string, unknown>): Record<string, unknown> {
  return {
    ...existing,
    // ChatGPT treats the Secure Tunnel as the authenticated transport. The
    // tunnel injects the short-lived Project Grant before this server sees the
    // request, so the ChatGPT-facing tool itself must never trigger OAuth.
    securitySchemes: CHATGPT_NOAUTH_SECURITY_SCHEMES,
    "openai/securitySchemes": CHATGPT_NOAUTH_SECURITY_SCHEMES,
  };
}
