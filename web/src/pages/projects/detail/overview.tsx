import { ArrowRight, CheckCircle2, CircleAlert, Clock3 } from "lucide-react";
import { Link } from "react-router";

import { WorkspaceState } from "@/components/layout/workspace-state";
import { FilmChatGPTHandoffEntry } from "@/film/chatgpt";
import { isFilmDynamicContentUnitsEnabled, projectFilmOverview, type FilmProjectOverviewProjection } from "@/film/project";
import { projectAttentionCount, projectContinueTarget, projectDetailStage, projectNextActions, projectUnitStages, type ProjectStageCell, type ProjectWorkbenchAction } from "@/lib/project-workbench";

import { formatTime, type ProjectDetailViewProps } from "./shared";
import { FilmProductionEntry } from "./production-entry";
import { FilmRemoteSyncEntry } from "./remote-sync-entry";

export default function ProjectOverviewView({ detail }: ProjectDetailViewProps) {
    const { project, units, canvases, shots } = detail;
    const completedUnits = units.filter((unit) => unit.status === "completed").length;
    const attentionCount = projectAttentionCount(detail);
    const completion = units.length ? Math.round((completedUnits / units.length) * 100) : 0;
    const stage = projectDetailStage(detail);
    const actions = projectNextActions(detail, 3);
    const primaryAction = actions[0];
    const secondaryActions = actions.slice(1);
    const continueTarget = projectContinueTarget(detail);
    const unitStages = projectUnitStages(detail);
    const filmOverview = isFilmDynamicContentUnitsEnabled() ? projectFilmOverview(detail) : null;

    return (
        <div className="space-y-8">
            <section className="project-overview-focus">
                <div className="grid lg:grid-cols-[minmax(0,1fr)_308px]">
                    <div className="project-overview-primary">
                        <div className="project-overview-eyebrow">
                            <span>当前任务</span>
                            <span className="project-overview-eyebrow-divider" aria-hidden>/</span>
                            <span className="project-overview-eyebrow-stage">{stage.label}</span>
                            {attentionCount ? <span className="project-overview-eyebrow-badge">{attentionCount} 项待处理</span> : null}
                        </div>
                        <h2 className="project-overview-title">{primaryAction.title}</h2>
                        <p className="project-overview-description">{primaryAction.description}</p>
                        <div className="project-overview-cta">
                            {/* 主按钮走 --btn-solid-* 配对色：原先是 bg-[--workspace-accent] + text-white，
                                而暗色下该 accent 是 #f5f5f5，等于白底白字。 */}
                            <Link to={primaryAction.href} className="project-overview-cta-primary">
                                <span className="truncate">{primaryAction.actionLabel}</span><ArrowRight className="size-4 shrink-0" />
                            </Link>
                            {continueTarget.href !== primaryAction.href ? <Link to={continueTarget.href} className="project-overview-cta-secondary">继续最近工作<ArrowRight className="size-3.5" /></Link> : null}
                        </div>
                    </div>

                    <aside className="project-overview-status" aria-label="项目进度">
                        <div className="project-overview-progress">
                            <div className="project-overview-progress-head">
                                <span className="project-overview-status-label">章节进度</span>
                                <span className="project-overview-progress-percent">{completion}%</span>
                            </div>
                            <div className="project-overview-progress-count">{completedUnits}<span>/ {units.length}</span></div>
                            <div className="project-overview-progress-track" aria-label={`章节完成度 ${completion}%`}><div style={{ width: `${completion}%` }} /></div>
                        </div>
                        <dl className="project-overview-facts">
                            <ProjectFact label="当前阶段" value={stage.label} />
                            <ProjectFact label="分镜镜头" value={`${shots.length} 个`} />
                            <ProjectFact label="项目画布" value={`${canvases.length} 张`} />
                            <ProjectFact label="需要处理" value={`${attentionCount} 项`} attention={attentionCount > 0} />
                        </dl>
                        {secondaryActions.length ? (
                            <div className="project-overview-next">
                                <span className="project-overview-status-label">随后处理</span>
                                <div className="mt-2 space-y-0.5">{secondaryActions.map((action) => <SecondaryAction key={action.id} action={action} />)}</div>
                            </div>
                        ) : null}
                    </aside>
                </div>
            </section>

            {filmOverview ? <DynamicContentUnitOverview overview={filmOverview} /> : null}

            <FilmProductionEntry detail={detail} />

            <FilmRemoteSyncEntry detail={detail} />

            <FilmChatGPTHandoffEntry detail={detail} />

            <section>
                <div className="project-pipeline-head">
                    <div className="min-w-0">
                        <h2 className="project-pipeline-title">章节进度</h2>
                        <p className="project-pipeline-hint">从内容确认到项目画布，每章只显示当前真实状态。</p>
                    </div>
                    <Link to={`/projects/${project.id}/chapters`} className="project-pipeline-more">查看全部章节<ArrowRight className="size-3.5" /></Link>
                </div>

                {unitStages.length ? (
                    <div className="project-pipeline-surface">
                        {unitStages.map((item) => (
                            <Link key={item.unit.id} to={`/projects/${project.id}/chapters/${item.unit.id}`} className="project-pipeline-row group">
                                <span className="project-pipeline-chapter">
                                    <span className="project-pipeline-index">{String(item.unit.position + 1).padStart(2, "0")}</span>
                                    <span className="min-w-0"><span className="project-pipeline-chapter-title">{item.unit.title}</span><span className="project-pipeline-chapter-time">更新于 {formatTime(item.unit.updatedAt)}</span></span>
                                </span>
                                <StagePipeline content={item.content} assets={item.assets} storyboard={item.storyboard} canvas={item.canvas} />
                                <ArrowRight className="project-pipeline-arrow size-4" />
                            </Link>
                        ))}
                    </div>
                ) : <div className="project-pipeline-surface p-2"><WorkspaceState icon="projects" compact title="还没有剧情章节" description="添加章节后，这里会显示内容、资产、分镜和画布的制作进度。" /></div>}
            </section>
        </div>
    );
}

function DynamicContentUnitOverview({ overview }: { overview: FilmProjectOverviewProjection }) {
    const kindSummary = overview.kindCounts.map((item) => `${item.label} ${item.count}`).join(" · ") || "暂无单元";
    return (
        <section data-film-feature="dynamic-content-units" aria-labelledby="film-content-unit-title" className="rounded-lg border border-border/80 bg-background/55 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <div className="text-[var(--fs-tiny)] font-semibold text-foreground/40">FilmOS 投影</div>
                    <h2 id="film-content-unit-title" className="mt-1 text-base font-semibold">动态 ContentUnit</h2>
                    <p className="mt-1 text-xs leading-5 text-foreground/48">复用 Host 单元、Shot 与画布链接；Film 六轴状态缺失时保持未接入，不从章节状态推断。</p>
                </div>
                <span className="shrink-0 rounded-full bg-[var(--workspace-accent-soft)] px-2 py-1 text-[var(--fs-tiny)] font-medium text-[var(--workspace-accent)]">实验入口</span>
            </div>
            <dl className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <FilmProjectionFact label="内容单元" value={String(overview.totalUnitCount)} detail={kindSummary} />
                <FilmProjectionFact label="画布关联" value={`${overview.linkedCanvasUnitCount}/${overview.totalUnitCount}`} detail="按 Host CanvasUnitLink" />
                <FilmProjectionFact label="分镜覆盖" value={`${overview.shotCoveredUnitCount}/${overview.totalUnitCount}`} detail="按 Host Shot.unitId" />
                <FilmProjectionFact label="六轴接入" value={`${overview.formalStateUnitCount}/${overview.totalUnitCount}`} detail={overview.hasFormalStateData ? "来自 Film sidecar" : "Film sidecar 未接入"} />
            </dl>
            {overview.hasFormalStateData ? (
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border/60 pt-3 text-[var(--fs-label)] text-foreground/52">
                    <span>创意锁定 {overview.creativeLockedUnitCount}</span>
                    <span>待审/需修改 {overview.reviewAttentionUnitCount}</span>
                    <span>STALE {overview.staleUnitCount}</span>
                    <span>阻断 {overview.blockedUnitCount}</span>
                </div>
            ) : null}
        </section>
    );
}

function FilmProjectionFact({ label, value, detail }: { label: string; value: string; detail: string }) {
    return <div className="min-w-0 rounded-md bg-surface-active px-3 py-2.5"><dt className="text-[var(--fs-tiny)] text-foreground/42">{label}</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-foreground/80">{value}</dd><dd className="mt-0.5 truncate text-[var(--fs-micro)] text-foreground/38" title={detail}>{detail}</dd></div>;
}

function ProjectFact({ label, value, attention = false }: { label: string; value: string; attention?: boolean }) {
    return <div className="min-w-0"><dt>{label}</dt><dd className={attention ? "is-attention" : ""}>{value}</dd></div>;
}

function SecondaryAction({ action }: { action: ProjectWorkbenchAction }) {
    const Icon = action.tone === "danger" ? CircleAlert : action.tone === "attention" ? Clock3 : CheckCircle2;
    return <Link to={action.href} className="project-overview-next-item group"><Icon className={`size-3.5 shrink-0 ${action.tone === "danger" ? "text-foreground/80" : action.tone === "attention" ? "text-foreground/60" : "text-foreground/30"}`} /><span className="min-w-0 flex-1 truncate">{action.title}</span><ArrowRight className="size-3 shrink-0 text-foreground/25 transition group-hover:text-foreground/55" /></Link>;
}

function StagePipeline({ content, assets, storyboard, canvas }: { content: ProjectStageCell; assets: ProjectStageCell; storyboard: ProjectStageCell; canvas: ProjectStageCell }) {
    const stages = [{ label: "内容", cell: content }, { label: "资产", cell: assets }, { label: "分镜", cell: storyboard }, { label: "画布", cell: canvas }];
    return (
        <span className="project-pipeline-stages">
            {stages.map(({ label, cell }) => <StageStep key={label} label={label} cell={cell} />)}
        </span>
    );
}

function StageStep({ label, cell }: { label: string; cell: ProjectStageCell }) {
    return (
        <span className={`project-pipeline-stage is-${cell.state}`}>
            <span className="project-pipeline-stage-label">{label}</span>
            <span className="project-pipeline-stage-track" />
            <span className="project-pipeline-stage-value">{cell.label}</span>
        </span>
    );
}
