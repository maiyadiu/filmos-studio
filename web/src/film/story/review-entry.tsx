import { useEffect, useState } from "react";

import { WorkspaceState } from "@/components/layout/workspace-state";

import { StoryStudioReviewPanel } from "./review-panel";
import { buildHostStoryReviewPreview, htmlToScriptReviewText, type StoryStudioReviewModel } from "./review-preview";

export type StoryStudioReviewEntryProps = Readonly<{
    hostUnitId: string;
    sourceHtml: string;
    draftHtml: string;
    dirty: boolean;
    shots: readonly Readonly<{ id: string; description: string }>[];
}>;

export function StoryStudioReviewEntry(props: StoryStudioReviewEntryProps) {
    const [model, setModel] = useState<StoryStudioReviewModel | null>(null);
    const [error, setError] = useState("");
    useEffect(() => {
        let active = true;
        setModel(null);
        setError("");
        void buildHostStoryReviewPreview({
            hostUnitId: props.hostUnitId,
            sourceText: htmlToScriptReviewText(props.sourceHtml),
            targetText: htmlToScriptReviewText(props.draftHtml),
            sourceContentForHash: props.sourceHtml,
            targetContentForHash: props.draftHtml,
            dirty: props.dirty,
            shotDependencies: props.shots,
        }).then(
            (next) => {
                if (active) setModel(next);
            },
            (reason) => {
                if (active) setError(reason instanceof Error ? reason.message : "剧本预览计算失败");
            },
        );
        return () => {
            active = false;
        };
    }, [props.dirty, props.draftHtml, props.hostUnitId, props.shots, props.sourceHtml]);

    if (error)
        return (
            <aside data-film-feature="story-studio" role="alert" className="min-h-0 border-t border-border/70 p-3 text-xs text-red-600 lg:border-l lg:border-t-0">
                Story Review 预览失败：{error}
            </aside>
        );
    if (!model)
        return (
            <aside data-film-feature="story-studio" className="min-h-0 border-t border-border/70 lg:border-l lg:border-t-0">
                <WorkspaceState icon="loading" compact className="h-full" title="正在计算剧本差异" description="只在本机内存计算，不写入 Film Core。" />
            </aside>
        );
    return <StoryStudioReviewPanel model={model} />;
}
