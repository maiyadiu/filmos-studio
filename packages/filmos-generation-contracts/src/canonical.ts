const encoder = new TextEncoder();

export const CANONICALIZATION_VERSION = "filmos-jcs-v1" as const;
export const HASH_ALGORITHM = "sha256" as const;

export function canonicalize(value: unknown): string {
    return encode(value, new Set<object>());
}

function encode(value: unknown, seen: Set<object>): string {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error("FILMOS_CANONICAL_NUMBER_INVALID");
        return JSON.stringify(value);
    }
    if (typeof value !== "object" || value instanceof Map || value instanceof Set || value instanceof Date) {
        throw new Error("FILMOS_CANONICAL_VALUE_INVALID");
    }
    if (seen.has(value)) throw new Error("FILMOS_CANONICAL_CYCLE");
    seen.add(value);
    try {
        if (Array.isArray(value)) return `[${value.map((item) => encode(item, seen)).join(",")}]`;
        const record = value as Record<string, unknown>;
        const entries = Object.keys(record).sort().map((key) => {
            if (record[key] === undefined) throw new Error("FILMOS_CANONICAL_UNDEFINED");
            return `${JSON.stringify(key)}:${encode(record[key], seen)}`;
        });
        return `{${entries.join(",")}}`;
    } finally {
        seen.delete(value);
    }
}

export async function sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashProjection(entityType: string, purpose: "semantic" | "envelope", projection: unknown): Promise<string> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(entityType)) throw new Error("FILMOS_HASH_ENTITY_TYPE_INVALID");
    return sha256Hex(`filmos:${entityType}:${purpose}:v1\0${canonicalize(projection)}`);
}

export async function hashEnvelope<T extends Record<string, unknown>>(entityType: string, envelope: T): Promise<string> {
    const { contentHash: _contentHash, ...projection } = envelope;
    return hashProjection(entityType, "envelope", projection);
}

export async function hashRedactedProjection(projection: Record<string, unknown>): Promise<string> {
    const { redactedContentHash: _redactedContentHash, ...safe } = projection;
    return sha256Hex(`filmos:redacted-evidence:projection:v1\0${canonicalize(safe)}`);
}

export function canonicalSort<T>(items: readonly T[], selector: (item: T) => string): T[] {
    return [...items].sort((left, right) => selector(left).localeCompare(selector(right), "en"));
}
