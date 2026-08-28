import type { ProjectDetail } from "@/services/api/projects";

import { BINDING_PURPOSES, FILM_ASSET_SEMANTICS, projectHostAssetVersion, type AssetBindingTarget, type AssetProvenance, type AuthorizationEvidence, type BindingPurpose, type FilmAssetSemantic, type MediaIntegrity } from "./asset-layer";

export const FILM_HOST_ASSET_READONLY_ENV = "VITE_FILM_HOST_ASSET_READONLY" as const;
export const DEFAULT_FILM_HOST_ASSET_READONLY_ENABLED = false;

export type HostResourceSnapshot = {
    id: string;
    mimeType: string;
    bytes: number;
    width?: number;
    height?: number;
    durationMs?: number;
};

export type HostRepresentationSnapshot = {
    id: string;
    resource: HostResourceSnapshot;
    mediaType: string;
    role: string;
    metadata: Readonly<Record<string, unknown>>;
};

type HostBindingUseBase = {
    id: string;
    purpose: BindingPurpose;
    target: AssetBindingTarget;
    hostAssetVersionId: string;
    contentHash: string;
};

export type HostBindingUseSnapshot = (HostBindingUseBase & { lifecycle: "candidate" }) | (HostBindingUseBase & { lifecycle: "approved"; sourceCandidateId: string });

export type HostAssetInventorySnapshot = {
    schemaVersion: 1;
    asset: {
        id: string;
        title: string;
        category: string;
        status: string;
    };
    version: {
        id: string;
        number: number;
        status: string;
        contentHash: string;
    };
    representations: readonly HostRepresentationSnapshot[];
    integrity: MediaIntegrity;
    authorization: AuthorizationEvidence;
    provenance: AssetProvenance;
    bindings: readonly HostBindingUseSnapshot[];
};

export type HostAssetInventoryProjection = {
    schemaVersion: 1;
    completeness: "complete_fixture" | "partial_host_summary";
    semantic: FilmAssetSemantic;
    asset: HostAssetInventorySnapshot["asset"];
    version: {
        id: string | null;
        number: number | null;
        status: string;
        contentHash: string | null;
    };
    representations: readonly HostRepresentationSnapshot[];
    integrity: MediaIntegrity | null;
    authorization: AuthorizationEvidence | null;
    provenance: AssetProvenance | null;
    bindings: {
        candidates: readonly HostBindingUseSnapshot[];
        approved: readonly HostBindingUseSnapshot[];
    };
    missingFields: readonly string[];
};

const SHA_256 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PATH_OR_URL = /(?:[\\/]|^(?:~|file:|https?:|data:|blob:|[a-zA-Z]:))/;
const SECRET_KEY = /(?:api[_-]?key|secret|token|cookie|authorization|password|credential)/i;
const FORBIDDEN_METADATA_KEY = /(?:^|[_-])(?:url|uri|path|file|filename|upload|base64|binary)(?:$|[_-])/i;
const CAMEL_METADATA_LOCATOR_KEY = /(?:URL|Url|URI|Uri|Path|File|Filename|Upload|Base64|Binary)$/;

export function resolveHostAssetReadonlyEnabled(env: Record<string, unknown> = import.meta.env): boolean {
    const value = env[FILM_HOST_ASSET_READONLY_ENV];
    return typeof value === "string" && value.trim().toLowerCase() === "true";
}

export function projectHostAssetInventory(snapshot: HostAssetInventorySnapshot): HostAssetInventoryProjection {
    if (snapshot.schemaVersion !== 1) throw new Error("Host asset inventory schemaVersion must be 1");
    assertOpaque(snapshot.asset.id, "Host Asset id");
    assertText(snapshot.asset.title, "Host Asset title");
    assertText(snapshot.asset.category, "Host Asset category");
    assertText(snapshot.asset.status, "Host Asset status");
    assertOpaque(snapshot.version.id, "Host AssetVersion id");
    if (!Number.isInteger(snapshot.version.number) || snapshot.version.number < 1) throw new Error("Host AssetVersion number must be positive");
    assertText(snapshot.version.status, "Host AssetVersion status");
    assertHash(snapshot.version.contentHash, "Host AssetVersion content hash");
    if (!snapshot.representations.length) throw new Error("A complete Host inventory fixture requires at least one representation");

    const semantic = semanticFromCategory(snapshot.asset.category);
    const representations = snapshot.representations.map((representation) => normalizeRepresentation(representation));
    for (const representation of representations) {
        projectHostAssetVersion({
            schemaVersion: 1,
            semantic,
            host: {
                hostAssetId: snapshot.asset.id,
                hostAssetVersionId: snapshot.version.id,
                hostRepresentationId: representation.id,
                hostResourceId: representation.resource.id,
                contentHash: snapshot.version.contentHash,
            },
            media: { kind: "host_resource", hostResourceId: representation.resource.id },
            integrity: snapshot.integrity,
            authorization: snapshot.authorization,
            provenance: snapshot.provenance,
        });
    }

    const bindings = snapshot.bindings.map((binding) => normalizeBindingUse(binding, snapshot.version));
    return freezeProjection({
        schemaVersion: 1,
        completeness: "complete_fixture",
        semantic,
        asset: Object.freeze({ ...snapshot.asset }),
        version: Object.freeze({ ...snapshot.version }),
        representations: Object.freeze(representations),
        integrity: Object.freeze({ ...snapshot.integrity }),
        authorization: Object.freeze({ ...snapshot.authorization }),
        provenance: Object.freeze({ ...snapshot.provenance }),
        bindings: {
            candidates: bindings.filter((binding) => binding.lifecycle === "candidate"),
            approved: bindings.filter((binding) => binding.lifecycle === "approved"),
        },
        missingFields: [],
    });
}

export function projectProjectDetailAssetInventory(detail: ProjectDetail): readonly HostAssetInventoryProjection[] {
    return Object.freeze(
        detail.assets.map((asset) => {
            const representations: HostRepresentationSnapshot[] = (asset.character?.representations ?? []).map((representation) => ({
                id: representation.id,
                resource: {
                    id: representation.resourceId,
                    mimeType: representation.mediaType,
                    bytes: 0,
                },
                mediaType: representation.mediaType,
                role: representation.role,
                metadata: Object.freeze({}),
            }));
            const versionId = asset.character?.versionId || asset.primaryVersionId || null;
            const versionNumber = asset.character?.version ?? (versionId ? Math.max(1, asset.versionCount) : null);
            return freezeProjection({
                schemaVersion: 1,
                completeness: "partial_host_summary",
                semantic: semanticFromCategory(asset.category),
                asset: Object.freeze({ id: asset.id, title: asset.title, category: asset.category, status: asset.status }),
                version: Object.freeze({ id: versionId, number: versionNumber, status: asset.status, contentHash: null }),
                representations: Object.freeze(representations.map(normalizeRepresentation)),
                integrity: null,
                authorization: null,
                provenance: null,
                bindings: { candidates: [], approved: [] },
                missingFields: Object.freeze(["version.contentHash", "representation.metadata", "authorization", "provenance"]),
            });
        }),
    );
}

export function replayGoldenBFixture(snapshot: HostAssetInventorySnapshot) {
    const projection = projectHostAssetInventory(snapshot);
    return Object.freeze({
        goldenId: "GOLDEN-B-ASSET-LOCAL",
        testStatus: "PASSED_LOCAL_FIXTURE" as const,
        prepared: true as const,
        persisted: false as const,
        externalProviderCalls: 0 as const,
        hostOwnsMedia: true as const,
        projection,
    });
}

function normalizeRepresentation(input: HostRepresentationSnapshot): HostRepresentationSnapshot {
    assertOpaque(input.id, "Host AssetRepresentation id");
    assertOpaque(input.resource.id, "Host Resource id");
    assertText(input.mediaType, "representation media type");
    assertText(input.role, "representation role");
    assertText(input.resource.mimeType, "resource mime type");
    if (!Number.isInteger(input.resource.bytes) || input.resource.bytes < 0) throw new Error("resource bytes must be a non-negative integer");
    for (const dimension of [input.resource.width, input.resource.height, input.resource.durationMs]) {
        if (dimension !== undefined && (!Number.isInteger(dimension) || dimension < 0)) throw new Error("resource dimensions must be non-negative integers");
    }
    return Object.freeze({
        id: input.id,
        resource: Object.freeze({ ...input.resource }),
        mediaType: input.mediaType,
        role: input.role,
        metadata: Object.freeze(sanitizeMetadata(input.metadata)),
    });
}

function normalizeBindingUse(input: HostBindingUseSnapshot, version: HostAssetInventorySnapshot["version"]): HostBindingUseSnapshot {
    assertUuidV4(input.id, `${input.lifecycle} binding id`);
    if (input.lifecycle !== "candidate" && input.lifecycle !== "approved") throw new Error("Unsupported Film binding lifecycle");
    if (input.lifecycle === "approved") {
        assertUuidV4(input.sourceCandidateId, "Approved binding source Candidate id");
        if (input.sourceCandidateId === input.id) throw new Error("Approved binding must remain separate from its source Candidate");
    }
    if (!(BINDING_PURPOSES as readonly string[]).includes(input.purpose)) throw new Error("Unsupported Film binding purpose");
    assertOpaque(input.hostAssetVersionId, "binding Host AssetVersion id");
    assertHash(input.contentHash, "binding source hash");
    if (input.hostAssetVersionId !== version.id || input.contentHash !== version.contentHash) throw new Error("Film binding does not match the projected Host AssetVersion guard");
    assertTarget(input.target);
    return Object.freeze({ ...input, target: Object.freeze({ ...input.target }) });
}

function freezeProjection(input: HostAssetInventoryProjection): HostAssetInventoryProjection {
    return Object.freeze({
        ...input,
        bindings: Object.freeze({ candidates: Object.freeze([...input.bindings.candidates]), approved: Object.freeze([...input.bindings.approved]) }),
    });
}

function semanticFromCategory(category: string): FilmAssetSemantic {
    const semantic = ({ character: "character", environment: "scene", wardrobe: "costume", prop: "prop", weapon: "prop", style: "style" } as Record<string, FilmAssetSemantic>)[category] ?? "other";
    if (!(FILM_ASSET_SEMANTICS as readonly string[]).includes(semantic)) throw new Error("Unsupported Film asset semantic");
    return semantic;
}

function sanitizeMetadata(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        if (SECRET_KEY.test(key)) throw new Error(`representation metadata contains secret field: ${key}`);
        if (FORBIDDEN_METADATA_KEY.test(key) || CAMEL_METADATA_LOCATOR_KEY.test(key)) throw new Error(`representation metadata contains locator field: ${key}`);
        result[key] = sanitizeMetadataValue(value, `representation.metadata.${key}`);
    }
    return result;
}

function sanitizeMetadataValue(value: unknown, label: string): unknown {
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
        if (PATH_OR_URL.test(value.trim())) throw new Error(`${label} contains a path, URL, or data payload`);
        return value;
    }
    if (Array.isArray(value)) return value.map((item, index) => sanitizeMetadataValue(item, `${label}[${index}]`));
    if (typeof value === "object") return sanitizeMetadata(value as Readonly<Record<string, unknown>>);
    throw new Error(`${label} contains an unsupported value`);
}

function assertTarget(target: AssetBindingTarget) {
    assertText(target.kind, "binding target kind");
    if (target.kind === "film_scene" || target.kind === "director_unit") assertUuidV4(target.id, "Film binding target id");
    else assertOpaque(target.id, "Host binding target id");
}

function assertUuidV4(value: string, label: string) {
    if (!UUID_V4.test(value)) throw new Error(`${label} must be a lower-case UUIDv4`);
}

function assertOpaque(value: string, label: string) {
    assertText(value, label);
    if (PATH_OR_URL.test(value.trim())) throw new Error(`${label} must be an opaque Host id`);
}

function assertHash(value: string, label: string) {
    if (!SHA_256.test(value)) throw new Error(`${label} must be a lower-case SHA-256`);
}

function assertText(value: string, label: string) {
    if (!value?.trim()) throw new Error(`${label} is required`);
}
