import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleAlert, Film, ShieldCheck } from "lucide-react";
import { Link } from "react-router";

import { resolveProductionCanvasNavigation, type ProductionCanvasNavigation } from "@/film/canvas/production-canvas";
import { projectFilmOverview } from "@/film/project";
import type { ProjectDetail } from "@/services/api/projects";

export const FILM_PRODUCTION_CORE_ENV = "VITE_FILM_PRODUCTION_CORE";
export const FILM_PRODUCTION_CANVAS_ENV = "VITE_FILM_PRODUCTION_CANVAS";
export const FILM_CORE_URL_ENV = "VITE_FILM_CORE_URL";
export const DEFAULT_FILM_CORE_BASE_URL = "http://127.0.0.1:8091";

export type FilmProductionEntryConfig = {
    enabled: boolean;
    baseUrl: string;
};

export type FilmProductionEntryState = { state: "disabled" } | { state: "unavailable" } | { state: "available"; baseUrl: string };

export function resolveFilmProductionEntryConfig(env: Record<string, unknown> = import.meta.env): FilmProductionEntryConfig {
    const enabled = isExplicitTrue(env[FILM_PRODUCTION_CORE_ENV]) && isExplicitTrue(env[FILM_PRODUCTION_CANVAS_ENV]);
    return {
        enabled,
        baseUrl: enabled ? normalizeFilmCoreBaseUrl(env[FILM_CORE_URL_ENV]) : DEFAULT_FILM_CORE_BASE_URL,
    };
}

export function resolveFilmProductionEntryState(config: FilmProductionEntryConfig, portAvailable: boolean): FilmProductionEntryState {
    if (!config.enabled) return { state: "disabled" };
    if (!portAvailable) return { state: "unavailable" };
    return { state: "available", baseUrl: config.baseUrl };
}

export async function probeFilmCorePort(baseUrl: string, options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<boolean> {
    const fetchImpl = options.fetchImpl ?? fetch;
    try {
        const response = await fetchImpl(`${normalizeFilmCoreBaseUrl(baseUrl)}/health`, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: options.signal,
        });
        if (!response.ok) return false;
        const value = (await response.json()) as { status?: unknown; service?: unknown };
        return value.status === "ok" && value.service === "film-production-core";
    } catch (error) {
        if (options.signal?.aborted) throw error;
        return false;
    }
}

export function FilmProductionEntry({ detail }: { detail: ProjectDetail }) {
    const config = resolveFilmProductionEntryConfig();
    const health = useQuery({
        queryKey: ["film-production-core-health", config.baseUrl],
        queryFn: ({ signal }) => probeFilmCorePort(config.baseUrl, { signal }),
        enabled: config.enabled,
        retry: 1,
        refetchInterval: config.enabled ? 15_000 : false,
        refetchOnWindowFocus: true,
    });
    const state = resolveFilmProductionEntryState(config, health.data === true);
    return <FilmProductionEntryPanel detail={detail} entryState={state} />;
}

export function FilmProductionEntryPanel({ detail, entryState }: { detail: ProjectDetail; entryState: FilmProductionEntryState }) {
    if (entryState.state !== "available") return null;

    const overview = projectFilmOverview(detail);
    const navigationByUnit = new Map<string, ProductionCanvasNavigation>();
    for (const unit of overview.units) {
        navigationByUnit.set(
            unit.hostUnitId,
            resolveProductionCanvasNavigation({
                enabled: true,
                unitId: unit.hostUnitId,
                links: detail.canvasUnitLinks,
                canvases: detail.canvases,
            }),
        );
    }

    return (
        <section data-film-feature="production-canvas" aria-labelledby="film-production-canvas-title" className="rounded-lg border border-border/80 bg-background/55 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[var(--fs-tiny)] font-semibold text-foreground/40">
                        <Film className="size-3.5" />
                        FilmOS 本地投影
                    </div>
                    <h2 id="film-production-canvas-title" className="mt-1 text-base font-semibold">
                        Film Production Canvas
                    </h2>
                    <p className="mt-1 text-xs leading-5 text-foreground/48">只读取当前 Project、ContentUnit 与 CanvasUnitLink。画布不是影视事实源；正式身份、版本和内容哈希仍由 Film Core 提供。</p>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--workspace-accent-soft)] px-2 py-1 text-[var(--fs-tiny)] font-medium text-[var(--workspace-accent)]">
                    <ShieldCheck className="size-3" />
                    Sidecar 可用
                </span>
            </div>

            <div className="mt-4 space-y-2">
                {overview.units.length ? (
                    overview.units.map((unit) => <ProductionUnitEntry key={unit.hostUnitId} title={unit.title} unitId={unit.hostUnitId} navigation={navigationByUnit.get(unit.hostUnitId)!} />)
                ) : (
                    <p className="rounded-md bg-surface-active px-3 py-3 text-xs text-foreground/48">项目尚无 ContentUnit，当前没有可投影的生产画布入口。</p>
                )}
            </div>
        </section>
    );
}

function ProductionUnitEntry({ title, unitId, navigation }: { title: string; unitId: string; navigation: ProductionCanvasNavigation }) {
    if (navigation.state === "reuse") {
        return (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-border/70 bg-background/70 px-3 py-2.5">
                <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm font-medium">{title}</strong>
                    <span className="mt-0.5 block truncate text-[var(--fs-micro)] text-foreground/40">复用唯一 production 关联：{navigation.canvasId}</span>
                </span>
                <Link to={navigation.href} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-[var(--workspace-accent)]">
                    打开生产画布
                    <ArrowRight className="size-3.5" />
                </Link>
            </div>
        );
    }
    if (navigation.state === "conflict") {
        return (
            <div role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <CircleAlert className="size-4 text-amber-600" />
                    {title}：production 关联冲突
                </div>
                <p className="mt-1 text-xs leading-5 text-foreground/52">{navigation.reason}</p>
                <p className="mt-1 break-all font-mono text-[var(--fs-micro)] text-foreground/42">{navigation.canvasIds.join(" · ")}</p>
            </div>
        );
    }
    if (navigation.state === "create_required") {
        return (
            <div className="rounded-md border border-dashed border-border bg-surface-active px-3 py-2.5">
                <strong className="block text-sm font-medium">{title}</strong>
                <p className="mt-1 text-xs leading-5 text-foreground/48">创建预演：Unit {unitId} 尚无 production 关联。当前 Host 没有带 expected revision/content hash 的唯一正式创建 API，因此这里只显示安全预演，不创建画布。</p>
            </div>
        );
    }
    return null;
}

function isExplicitTrue(value: unknown): boolean {
    return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function normalizeFilmCoreBaseUrl(value: unknown): string {
    const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_FILM_CORE_BASE_URL;
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname) || !url.port) {
        throw new Error("VITE_FILM_CORE_URL 必须是带显式端口的本机 HTTP Sidecar 地址");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}
