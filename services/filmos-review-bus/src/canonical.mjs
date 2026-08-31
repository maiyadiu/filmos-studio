import { createHash, timingSafeEqual } from "node:crypto";

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  return value;
}

export function sha256(value) {
  const bytes = typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(bytes).digest("hex");
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function exactObject(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw problem("INVALID_BODY");
  const actual = Object.keys(value).sort();
  if (actual.join("\n") !== [...allowed].sort().join("\n")) throw problem("INVALID_BODY");
  return value;
}

export function problem(code, message = code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

