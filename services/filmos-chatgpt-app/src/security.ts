const SECRET_KEY = /(api[-_]?key|authorization|cookie|password|secret|token)/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{12,}|bearer\s+[A-Za-z0-9._~-]{12,})/i;
const ABSOLUTE_PATH = /(?:^|\s)(?:\/(?!\/)[^\s]+|[A-Za-z]:[\\/][^\r\n]*)/;
const INJECTION = /(ignore|disregard|override).{0,40}(instruction|policy|permission|system)|system\s*prompt|reveal.{0,30}(secret|token|key)/i;

export class SecurityBoundaryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export function sanitizeForMcp(value: unknown): unknown {
  return sanitize(value, "root");
}

export function detectUntrustedInstructions(value: unknown): string[] {
  const warnings: string[] = [];
  walk(value, (text) => {
    if (INJECTION.test(text)) warnings.push("PROMPT_INJECTION_TEXT_IGNORED");
  });
  return [...new Set(warnings)];
}

export function assertSafeIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(value) || value.includes("..")) {
    throw new SecurityBoundaryError("invalid_identifier", `${field} is not a safe stable identifier`);
  }
  return value;
}

export function assertLoopbackUrl(raw: string, name: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new SecurityBoundaryError("non_loopback_endpoint", `${name} must be loopback HTTP`);
  }
  if (url.username || url.password) throw new SecurityBoundaryError("credential_in_url", `${name} cannot contain credentials`);
  return url;
}

function sanitize(value: unknown, key: string): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) return "[REDACTED]";
    if (ABSOLUTE_PATH.test(value)) return "[LOCAL_PATH_REDACTED]";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey)]));
  }
  return value;
}

function walk(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") return visit(value);
  if (Array.isArray(value)) return value.forEach((item) => walk(item, visit));
  if (value && typeof value === "object") Object.values(value).forEach((item) => walk(item, visit));
}
