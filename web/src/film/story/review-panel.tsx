import { Alert, Tag } from "antd";
import { FileDiff, GitBranch, LockKeyhole, ShieldAlert } from "lucide-react";

import type { DialogueChange, ScriptImpact } from "./types";
import type { StoryStudioReviewModel } from "./review-preview";

export function StoryStudioReviewPanel({ model }: { model: StoryStudioReviewModel }) {
    const changedSectionIds = model.diff.changedSectionIds;
    return (
        <aside data-film-feature="story-studio" aria-labelledby="story-studio-review-title" className="thin-scrollbar min-h-0 overflow-y-auto border-t border-border/70 bg-background/70 p-3 lg:border-l lg:border-t-0">
            <div className="flex items-start justify-between gap-2">
                <div>
                    <div className="flex items-center gap-1.5 text-[var(--fs-tiny)] font-semibold text-foreground/42">
                        <FileDiff className="size-3.5" /> Story / Script Review
                    </div>
                    <h3 id="story-studio-review-title" className="mt-1 text-sm font-semibold">
                        版本与影响预览
                    </h3>
                </div>
                <Tag color={model.mode === "film_core" ? "green" : "gold"}>{model.mode === "film_core" ? "Core 正式" : "本地预览"}</Tag>
            </div>

            <Alert className="mt-3" type="warning" showIcon title="预览不写正式状态" description="当前面板只展示逐字差异与 STALE 建议。正式锁定必须调用 Film Core 的 filmScriptVersionLock 并由人确认；Agent 不得批准。" />

            <section className="mt-3 space-y-2" aria-label="剧本版本">
                <VersionCard version={model.source} />
                <VersionCard version={model.target} />
            </section>

            <section className="mt-4" aria-labelledby="story-dialogue-diff-title">
                <div className="flex items-center justify-between gap-2">
                    <h4 id="story-dialogue-diff-title" className="text-xs font-semibold">
                        逐字对白差异
                    </h4>
                    <span className="text-[var(--fs-micro)] tabular-nums text-foreground/42">
                        {model.diff.dialogue.sourceCueCount} → {model.diff.dialogue.targetCueCount} Cue
                    </span>
                </div>
                {model.diff.dialogue.faithful ? (
                    <p className="mt-2 rounded-md bg-emerald-500/8 px-2.5 py-2 text-xs text-emerald-700">说话人、文字与顺序完全一致。</p>
                ) : (
                    <div className="mt-2 space-y-2">
                        {model.diff.dialogue.changes.slice(0, 20).map((change, index) => (
                            <DialogueChangeCard key={`${change.cueId}-${change.kind}-${index}`} change={change} />
                        ))}
                        {model.diff.dialogue.changes.length > 20 ? <p className="text-[var(--fs-micro)] text-foreground/42">另有 {model.diff.dialogue.changes.length - 20} 项差异，请在正式审查工具中展开。</p> : null}
                    </div>
                )}
            </section>

            <section className="mt-4" aria-labelledby="story-impact-title">
                <div className="flex items-center justify-between gap-2">
                    <h4 id="story-impact-title" className="flex items-center gap-1.5 text-xs font-semibold">
                        <GitBranch className="size-3.5" />
                        稳定 Cue / Section 影响
                    </h4>
                    <span className="text-[var(--fs-micro)] text-foreground/42">不自动写 STALE</span>
                </div>
                {changedSectionIds.length ? <p className="mt-2 break-words font-mono text-[var(--fs-micro)] text-foreground/48">Section: {changedSectionIds.join(" · ")}</p> : null}
                <div className="mt-2 space-y-2">
                    {model.impact.impacts.map((impact) => (
                        <ImpactCard key={impact.targetId} impact={impact} />
                    ))}
                    {model.impact.unresolvedTargetIds.map((targetId) => (
                        <div key={targetId} className="rounded-md border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-xs">
                            <div className="flex items-center gap-1.5 font-medium">
                                <ShieldAlert className="size-3.5 text-amber-600" />
                                {targetId}
                            </div>
                            <p className="mt-1 text-[var(--fs-micro)] leading-4 text-foreground/48">正文已变，但缺少 Core Cue/Section 映射；保持 unresolved，不批量误标。</p>
                        </div>
                    ))}
                    {!model.impact.impacts.length && !model.impact.unresolvedTargetIds.length ? <p className="rounded-md bg-surface-active px-2.5 py-2 text-xs text-foreground/48">当前没有可证实的下游影响。</p> : null}
                </div>
            </section>

            <section className="mt-4 rounded-md border border-border/70 bg-surface-active px-2.5 py-2" aria-label="正式锁定边界">
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                    <LockKeyhole className="size-3.5" />
                    正式 Script Lock
                </div>
                <p className="mt-1 text-[var(--fs-micro)] leading-4 text-foreground/48">当前 Host 预览未取得可查询的 Core ScriptVersion，因此不提供伪锁定按钮。接入正式版本端口后仍需显示 expected version/hash，并由人确认。</p>
            </section>
        </aside>
    );
}

function VersionCard({ version }: { version: StoryStudioReviewModel["source"] }) {
    return (
        <div className="rounded-md border border-border/70 bg-background/80 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
                <strong className="truncate text-xs font-medium">{version.label}</strong>
                <span className="text-[var(--fs-micro)] text-foreground/40">{version.formal ? "正式版本" : "非正式快照"}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
                <Tag>{version.reviewState}</Tag>
                <Tag>{version.lockState}</Tag>
            </div>
            <code className="mt-1.5 block break-all text-[var(--fs-micro)] leading-4 text-foreground/48" title={version.contentHash}>
                SHA-256 {version.contentHash}
            </code>
        </div>
    );
}

function DialogueChangeCard({ change }: { change: DialogueChange }) {
    const label: Record<DialogueChange["kind"], string> = { added: "新增", removed: "删除", speaker_changed: "说话人变化", text_changed: "文字变化", moved: "顺序变化" };
    return (
        <div className="rounded-md border border-border/70 bg-background/75 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
                <code className="break-all text-[var(--fs-micro)] text-foreground/52">{change.cueId}</code>
                <Tag color="blue">{label[change.kind]}</Tag>
            </div>
            {change.sourceSpeaker || change.targetSpeaker ? (
                <p className="mt-1 text-[var(--fs-micro)] text-foreground/50">
                    {change.sourceSpeaker || "∅"} → {change.targetSpeaker || "∅"}
                </p>
            ) : null}
            {change.sourceText !== undefined || change.targetText !== undefined ? (
                <div className="mt-1 space-y-1 whitespace-pre-wrap text-xs leading-5">
                    <p className="rounded bg-red-500/6 px-1.5 py-1 text-foreground/60">− {change.sourceText ?? "∅"}</p>
                    <p className="rounded bg-emerald-500/7 px-1.5 py-1 text-foreground/65">+ {change.targetText ?? "∅"}</p>
                </div>
            ) : null}
        </div>
    );
}

function ImpactCard({ impact }: { impact: ScriptImpact }) {
    return (
        <div className="rounded-md border border-red-500/20 bg-red-500/5 px-2.5 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
                <strong className="break-all font-medium">
                    {impact.targetType} · {impact.targetId}
                </strong>
                <Tag color="red">建议 STALE</Tag>
            </div>
            {impact.affectedDialogueCueIds.length ? <p className="mt-1 break-words font-mono text-[var(--fs-micro)] text-foreground/48">Cue: {impact.affectedDialogueCueIds.join(" · ")}</p> : null}
            {impact.affectedSectionIds.length ? <p className="mt-1 break-words font-mono text-[var(--fs-micro)] text-foreground/48">Section: {impact.affectedSectionIds.join(" · ")}</p> : null}
        </div>
    );
}
