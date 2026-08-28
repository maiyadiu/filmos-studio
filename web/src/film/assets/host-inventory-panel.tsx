import type { ProjectDetail } from "@/services/api/projects";

import { projectProjectDetailAssetInventory, resolveHostAssetReadonlyEnabled, type HostAssetInventoryProjection } from "./host-inventory";

export function FilmHostAssetReadonlyEntry({ detail, env }: { detail: ProjectDetail; env?: Record<string, unknown> }) {
    if (!resolveHostAssetReadonlyEnabled(env)) return null;
    return <HostAssetInventoryPanel projections={projectProjectDetailAssetInventory(detail)} />;
}

export function HostAssetInventoryPanel({ projections }: { projections: readonly HostAssetInventoryProjection[] }) {
    return (
        <section data-film-feature="host-asset-readonly" aria-labelledby="film-host-assets-title" className="mb-4 rounded-lg border border-border/80 bg-background/55 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <p className="text-[var(--fs-tiny)] font-semibold text-foreground/40">FilmOS 只读投影</p>
                    <h3 id="film-host-assets-title" className="mt-1 text-sm font-semibold">
                        Host Asset / Version / Representation / Resource
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-foreground/48">Host 继续唯一持有通用资产与媒体；此处不创建副本、不上传，也不把 Host confirmed 映射为 Film Approved。</p>
                </div>
                <span className="rounded-full bg-foreground/[.055] px-2 py-1 text-[var(--fs-tiny)] text-foreground/48">本地只读</span>
            </div>

            <div className="mt-3 space-y-2">
                {projections.length ? (
                    projections.map((projection) => <HostAssetProjectionCard key={projection.asset.id} projection={projection} />)
                ) : (
                    <p className="rounded-md bg-surface-active px-3 py-3 text-xs text-foreground/48">当前项目没有可投影的 Host 资产。</p>
                )}
            </div>
        </section>
    );
}

function HostAssetProjectionCard({ projection }: { projection: HostAssetInventoryProjection }) {
    return (
        <article className="rounded-md border border-border/70 bg-background/70 px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <strong className="block truncate text-xs font-medium">{projection.asset.title}</strong>
                    <code className="mt-1 block break-all text-[var(--fs-micro)] text-foreground/42">Asset {projection.asset.id}</code>
                </div>
                <span className="rounded bg-foreground/[.05] px-1.5 py-0.5 text-[var(--fs-micro)] text-foreground/48">Host {projection.asset.status}</span>
            </div>
            <dl className="mt-2 grid gap-x-4 gap-y-1 text-[var(--fs-tiny)] sm:grid-cols-2">
                <Fact label="AssetVersion ID" value={projection.version.id ?? "Host summary 未提供"} />
                <Fact label="Version" value={projection.version.number === null ? "未提供" : `v${projection.version.number}`} />
                <Fact label="Content SHA-256" value={projection.version.contentHash ?? "Host summary 未提供"} />
                <Fact label="完整性" value={projection.integrity?.state ?? "Host summary 未提供"} />
                <Fact label="Film 用途绑定" value={`${projection.bindings.candidates.length} Candidate / ${projection.bindings.approved.length} Approved`} />
                <Fact label="授权" value={authorizationLabel(projection)} />
                <Fact label="来源" value={projection.provenance ? `${projection.provenance.kind} · ${projection.provenance.sourceReceiptId}` : "Host summary 未提供"} />
            </dl>
            <div className="mt-2 space-y-1">
                {projection.representations.length ? (
                    projection.representations.map((representation) => (
                        <div key={representation.id} className="rounded bg-surface-active px-2 py-1.5 text-[var(--fs-micro)] text-foreground/48">
                            <code className="break-all">Representation {representation.id}</code>
                            <span className="mx-1">·</span>
                            <code className="break-all">Resource {representation.resource.id}</code>
                            <span className="mx-1">·</span>
                            <span>
                                {representation.role} / {representation.mediaType}
                            </span>
                            {Object.keys(representation.metadata).length ? <span className="mt-1 block break-all">metadata {JSON.stringify(representation.metadata)}</span> : null}
                        </div>
                    ))
                ) : (
                    <p className="text-[var(--fs-micro)] text-foreground/38">Host summary 未提供 Representation。</p>
                )}
            </div>
            {projection.missingFields.length ? (
                <p role="note" className="mt-2 text-[var(--fs-micro)] text-amber-700">
                    事实缺口：{projection.missingFields.join("、")}。等待 Host 只读详情 API，不补造。
                </p>
            ) : null}
        </article>
    );
}

function Fact({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0">
            <dt className="text-foreground/38">{label}</dt>
            <dd className="break-all font-mono text-foreground/56">{value}</dd>
        </div>
    );
}

function authorizationLabel(projection: HostAssetInventoryProjection) {
    if (!projection.authorization) return "Host summary 未提供";
    if (projection.authorization.state === "verified") return `verified · ${projection.authorization.evidenceId} · ${projection.authorization.scope}`;
    if (projection.authorization.state === "not_required") return `not_required · ${projection.authorization.reason}`;
    return "unverified";
}
