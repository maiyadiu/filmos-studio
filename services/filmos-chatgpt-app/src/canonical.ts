import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256(value: unknown): string {
  const bytes = typeof value === "string" ? value : canonicalJson(value);
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

export function hmacSha256(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

export function safeHexEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/.test(left) || !/^[0-9a-f]+$/.test(right) || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]),
  );
}
