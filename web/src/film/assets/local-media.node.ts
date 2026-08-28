import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type LocalMediaInspectionInput = {
    workspaceRoot: string;
    requestedPath: string;
    hostResourceId: string;
    expectedContentHash: string;
    authorizationEvidenceId: string;
    sourceReceiptId: string;
    metadata?: Readonly<Record<string, unknown>>;
};

export type SafeLocalMediaDescriptor = Readonly<{
    schemaVersion: 1;
    hostResourceId: string;
    relativePath: string;
    contentHash: string;
    bytes: number;
    authorizationEvidenceId: string;
    sourceReceiptId: string;
    metadata: Readonly<Record<string, unknown>>;
}>;

const SHA_256 = /^[0-9a-f]{64}$/;
const URL_OR_DATA = /^(?:https?:|file:|data:|blob:)/i;
const SECRET_KEY = /(?:api[_-]?key|secret|token|cookie|authorization|password|credential)/i;
const LOCATOR_KEY = /(?:^|[_-])(?:url|uri|path|file|filename|upload|base64|binary)(?:$|[_-])/i;
const CAMEL_LOCATOR_KEY = /(?:URL|Url|URI|Uri|Path|File|Filename|Upload|Base64|Binary)$/;
const VALUE_LOCATOR = /^(?:https?:|file:|data:|blob:|~[/\\]|[/\\]|[a-zA-Z]:[/\\])/i;

export function inspectWorkspaceLocalMedia(input: LocalMediaInspectionInput): SafeLocalMediaDescriptor {
    assertOpaque(input.hostResourceId, "Host Resource id");
    assertOpaque(input.authorizationEvidenceId, "authorization evidence id");
    assertOpaque(input.sourceReceiptId, "source receipt id");
    if (!SHA_256.test(input.expectedContentHash)) throw new Error("expected content hash must be a lower-case SHA-256");
    if (!input.workspaceRoot || URL_OR_DATA.test(input.workspaceRoot.trim())) throw new Error("workspace root must be a local filesystem path");
    if (!input.requestedPath || URL_OR_DATA.test(input.requestedPath.trim())) throw new Error("local media path must not be a URL or data payload");
    if (input.requestedPath.includes("\0")) throw new Error("local media path contains a null byte");

    const canonicalRoot = realpathSync.native(input.workspaceRoot);
    if (!statSync(canonicalRoot).isDirectory()) throw new Error("workspace root must resolve to a directory");
    const requested = path.isAbsolute(input.requestedPath) ? input.requestedPath : path.resolve(canonicalRoot, input.requestedPath);
    const canonicalTarget = realpathSync.native(requested);
    const relativePath = path.relative(canonicalRoot, canonicalTarget);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw new Error("local media path escapes the canonical workspace root");
    }
    const stat = statSync(canonicalTarget);
    if (!stat.isFile()) throw new Error("local media target must resolve to a regular file");

    const bytes = readFileSync(canonicalTarget);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    if (contentHash !== input.expectedContentHash) throw new Error("local media content hash mismatch");
    const metadata = sanitizeMetadata(input.metadata ?? {});
    return Object.freeze({
        schemaVersion: 1,
        hostResourceId: input.hostResourceId,
        relativePath: relativePath.split(path.sep).join("/"),
        contentHash,
        bytes: stat.size,
        authorizationEvidenceId: input.authorizationEvidenceId,
        sourceReceiptId: input.sourceReceiptId,
        metadata: Object.freeze(metadata),
    });
}

function sanitizeMetadata(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        if (SECRET_KEY.test(key)) throw new Error(`local media metadata contains secret field: ${key}`);
        if (LOCATOR_KEY.test(key) || CAMEL_LOCATOR_KEY.test(key)) throw new Error(`local media metadata contains locator field: ${key}`);
        result[key] = sanitizeValue(value, `metadata.${key}`);
    }
    return result;
}

function sanitizeValue(value: unknown, label: string): unknown {
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
        if (VALUE_LOCATOR.test(value.trim())) throw new Error(`${label} contains a URL, data payload, or absolute path`);
        return value;
    }
    if (Array.isArray(value)) return value.map((item, index) => sanitizeValue(item, `${label}[${index}]`));
    if (typeof value === "object") return sanitizeMetadata(value as Readonly<Record<string, unknown>>);
    throw new Error(`${label} contains an unsupported value`);
}

function assertOpaque(value: string, label: string) {
    if (!value?.trim() || /[\\/]/.test(value) || URL_OR_DATA.test(value.trim())) throw new Error(`${label} must be opaque`);
}
