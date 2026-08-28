import { CircleAlert, CloudCog, FileCheck2, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
    authorityModes,
    buildRemotePublishPreview,
    confirmRemoteSyncPreviewLocally,
    createBrowserRemoteSyncSessionStore,
    recoverLatestRemoteSyncSession,
    type AuthorityMode,
    type RecoveredRemoteSyncSession,
    type RemotePublishPlanInput,
    type RemotePublishPreview,
    type RemoteSyncLocalSession,
    type RemoteSyncSessionStore,
} from "@/film/sync";
import type { ProjectDetail } from "@/services/api/projects";

export const FILM_REMOTE_SYNC_ENV = "VITE_FILM_REMOTE_SYNC";
const MAX_LOCAL_MANIFEST_BYTES = 1024 * 1024;

export function resolveFilmRemoteSyncEnabled(env: Record<string, unknown> = import.meta.env) {
    const value = env[FILM_REMOTE_SYNC_ENV];
    return typeof value === "string" && value.trim().toLowerCase() === "true";
}

export async function prepareRemoteSyncPreviewForHost(rawJson: string, hostProjectId: string, authorityMode: AuthorityMode) {
    if (new TextEncoder().encode(rawJson).byteLength > MAX_LOCAL_MANIFEST_BYTES) throw new Error("本地 manifest 不得超过 1 MiB");
    let plan: RemotePublishPlanInput;
    try {
        plan = JSON.parse(rawJson) as RemotePublishPlanInput;
    } catch {
        throw new Error("本地 manifest 不是有效 JSON");
    }
    const preview = await buildRemotePublishPreview(plan, { enabled: true, authority_mode: authorityMode });
    if (preview.host_project_id !== hostProjectId) throw new Error("manifest 不属于当前 Host 项目");
    return { plan, preview };
}

export function FilmRemoteSyncEntry({ detail, env, store }: { detail: ProjectDetail; env?: Record<string, unknown>; store?: RemoteSyncSessionStore }) {
    if (!resolveFilmRemoteSyncEnabled(env)) return null;
    return <FilmRemoteSyncEntryPanel detail={detail} store={store} />;
}

export function FilmRemoteSyncEntryPanel({ detail, store: injectedStore }: { detail: ProjectDetail; store?: RemoteSyncSessionStore }) {
    const [authorityMode, setAuthorityMode] = useState<AuthorityMode>("LOCAL_AUTHORITY");
    const [plan, setPlan] = useState<RemotePublishPlanInput | null>(null);
    const [preview, setPreview] = useState<RemotePublishPreview | null>(null);
    const [session, setSession] = useState<RemoteSyncLocalSession | null>(null);
    const [recovery, setRecovery] = useState<RecoveredRemoteSyncSession>({ state: "NONE" });
    const [confirming, setConfirming] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState("");
    const store = useMemo(() => injectedStore ?? createBrowserRemoteSyncSessionStore(detail.project.userId), [detail.project.userId, injectedStore]);

    useEffect(() => {
        let active = true;
        void recoverLatestRemoteSyncSession(detail.project.userId, detail.project.id, store)
            .then((result) => {
                if (active) setRecovery(result);
            })
            .catch((reason) => {
                if (active) setError(reason instanceof Error ? reason.message : "本地 Remote/Hybrid 会话恢复失败");
            });
        return () => {
            active = false;
        };
    }, [detail.project.id, detail.project.userId, store]);

    const importManifest = async (file: File | undefined) => {
        if (!file) return;
        setPending(true);
        setError("");
        setConfirming(false);
        setSession(null);
        try {
            if (file.size > MAX_LOCAL_MANIFEST_BYTES) throw new Error("本地 manifest 不得超过 1 MiB");
            const prepared = await prepareRemoteSyncPreviewForHost(await file.text(), detail.project.id, authorityMode);
            setPlan(prepared.plan);
            setPreview(prepared.preview);
        } catch (reason) {
            setPlan(null);
            setPreview(null);
            setError(reason instanceof Error ? reason.message : "Remote/Hybrid 离线预演失败");
        } finally {
            setPending(false);
        }
    };

    const confirm = async () => {
        if (!plan || !preview) return;
        setPending(true);
        setError("");
        try {
            if (!crypto.randomUUID) throw new Error("当前环境缺少安全的 Human 确认 ID");
            const confirmed = await confirmRemoteSyncPreviewLocally(
                {
                    userScope: detail.project.userId,
                    hostProjectId: detail.project.id,
                    plan,
                    policy: { enabled: true, authority_mode: authorityMode },
                    humanConfirmed: true,
                    confirmationId: crypto.randomUUID(),
                    expectedManifestVersion: preview.manifest_version,
                    expectedManifestHash: preview.manifest_hash,
                },
                { store },
            );
            setSession(confirmed);
            setRecovery({ state: "RECOVERED", session: confirmed, preview: confirmed.preview });
            setConfirming(false);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "本地同步会话保存失败");
        } finally {
            setPending(false);
        }
    };

    const canConfirm = Boolean(preview?.publishable_after_explicit_execution && !preview.blockers.length && detail.project.status !== "archived");
    const receipt = session?.receipt ?? (recovery.state === "RECOVERED" ? recovery.session.receipt : null);

    return (
        <section data-film-feature="remote-sync" aria-labelledby="film-remote-sync-title" className="rounded-lg border border-border/80 bg-background/55 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[var(--fs-tiny)] font-semibold text-foreground/40">
                        <CloudCog className="size-3.5" /> FilmOS 离线同步边界
                    </div>
                    <h2 id="film-remote-sync-title" className="mt-1 text-base font-semibold">
                        Remote / Hybrid 预演
                    </h2>
                    <p className="mt-1 text-xs leading-5 text-foreground/48">只读取用户选择的本地 JSON，重算 manifest hash 并保存本地确认回执；不上传、不访问远端、不自动批准。</p>
                </div>
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 text-[var(--fs-tiny)] font-medium text-amber-700">
                    <ShieldCheck className="size-3" /> Local receipt only
                </span>
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
                <label className="text-xs text-foreground/60">
                    Authority Mode
                    <select
                        className="mt-1 block w-full rounded-md border border-border bg-background px-2 py-2 text-xs"
                        value={authorityMode}
                        onChange={(event) => {
                            setAuthorityMode(event.target.value as AuthorityMode);
                            setPlan(null);
                            setPreview(null);
                            setSession(null);
                            setConfirming(false);
                        }}
                    >
                        {authorityModes.map((mode) => (
                            <option key={mode} value={mode}>
                                {mode}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="text-xs text-foreground/60">
                    导入当前项目的离线 Publish Plan
                    <input
                        type="file"
                        accept="application/json,.json"
                        disabled={pending}
                        onChange={(event) => void importManifest(event.currentTarget.files?.[0])}
                        className="mt-1 block w-full rounded-md border border-dashed border-border bg-background px-2 py-1.5 text-xs file:mr-2 file:rounded file:border-0 file:bg-surface-active file:px-2 file:py-1 file:text-xs"
                    />
                </label>
            </div>

            {error ? (
                <p role="alert" className="mt-3 flex items-start gap-1.5 text-xs text-red-600">
                    <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                    {error}；未记录执行或发布成功。
                </p>
            ) : null}
            {recovery.state === "STALE_MANIFEST" ? (
                <p role="alert" className="mt-3 text-xs text-amber-700">
                    已恢复历史会话，但清单已 STALE：{recovery.reason}。必须重新导入和确认。
                </p>
            ) : null}
            {preview ? (
                <div className="mt-3 rounded-md border border-border/70 bg-surface-active px-3 py-2.5 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1 font-medium">
                            <FileCheck2 className="size-3.5" /> Preview {preview.blockers.length ? "BLOCKED" : "READY"}
                        </span>
                        <span className="font-mono text-[10px] text-foreground/45">
                            v{preview.manifest_version} · {preview.manifest_hash}
                        </span>
                    </div>
                    <p className="mt-1 text-foreground/52">
                        {preview.selection.content_units.length} ContentUnits · {preview.selection.assets.length} Assets · {preview.inbound_results.length} Candidate-only results · network.executed=false
                    </p>
                    {preview.blockers.length ? (
                        <ul className="mt-2 list-disc pl-4 text-amber-700">
                            {preview.blockers.map((blocker) => (
                                <li key={`${blocker.path}:${blocker.code}`}>
                                    {blocker.code}: {blocker.message}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    {confirming ? (
                        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
                            <p className="leading-5 text-foreground/60">Human 确认只会将当前 manifest version/hash 与回执保存到用户隔离的本地存储，不会执行 Remote Publish。</p>
                            <div className="mt-2 flex gap-2">
                                <button type="button" disabled={pending || !canConfirm} onClick={() => void confirm()} className="rounded-md bg-[var(--btn-solid-bg)] px-2.5 py-1.5 font-medium text-[var(--btn-solid-fg)] disabled:opacity-50">
                                    {pending ? "重算并保存中" : "Human 确认保存本地会话"}
                                </button>
                                <button type="button" disabled={pending} onClick={() => setConfirming(false)} className="rounded-md border border-border px-2.5 py-1.5 text-foreground/60">
                                    取消
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button type="button" disabled={!canConfirm} onClick={() => setConfirming(true)} className="mt-3 rounded-md border border-border bg-background px-2.5 py-1.5 font-medium text-foreground/70 disabled:opacity-50">
                            准备记录本地确认
                        </button>
                    )}
                </div>
            ) : null}

            {receipt ? (
                <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-xs">
                    <strong className="font-medium">本地会话可恢复，Remote 仍未执行</strong>
                    <p className="mt-1 text-foreground/52">
                        Receipt {receipt.receipt_id} · manifest {receipt.expected_manifest_hash} · {receipt.execution_state} · Candidate-only
                    </p>
                </div>
            ) : null}
        </section>
    );
}
