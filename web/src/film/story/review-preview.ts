import { compareScriptVersions } from "./dialogue-fidelity";
import { analyzeScriptImpact } from "./impact-analysis";
import { hashScriptContent } from "./script-version";
import type { DialogueCue, ScriptDependency, ScriptImpactAnalysis, ScriptVersion, ScriptVersionDiff } from "./types";

export type ScriptReviewSection = Readonly<{
    sectionId: string;
    title: string;
    text: string;
}>;

export type ScriptReviewDocument = Readonly<{
    sections: readonly ScriptReviewSection[];
    dialogueCues: readonly DialogueCue[];
}>;

export type ScriptReviewVersionView = Readonly<
    Pick<ScriptVersion, "id" | "contentHash" | "reviewState" | "lockState"> & {
        label: string;
        formal: boolean;
    }
>;

export type StoryStudioReviewModel = Readonly<{
    mode: "host_preview" | "film_core";
    source: ScriptReviewVersionView;
    target: ScriptReviewVersionView;
    sourceDocument: ScriptReviewDocument;
    targetDocument: ScriptReviewDocument;
    diff: ScriptVersionDiff;
    impact: ScriptImpactAnalysis;
}>;

export type HostStoryPreviewInput = Readonly<{
    hostUnitId: string;
    sourceText: string;
    targetText: string;
    sourceContentForHash?: string;
    targetContentForHash?: string;
    dirty: boolean;
    shotDependencies?: readonly Readonly<{ id: string; description: string }>[];
}>;

export async function buildHostStoryReviewPreview(input: HostStoryPreviewInput): Promise<StoryStudioReviewModel> {
    const sourceDocument = parseScriptReviewDocument(input.sourceText);
    const targetDocument = parseScriptReviewDocument(input.targetText);
    const [sourceHash, targetHash] = await Promise.all([hashScriptContent(input.sourceContentForHash ?? input.sourceText), hashScriptContent(input.targetContentForHash ?? input.targetText)]);
    const changedSectionIds = changedSections(sourceDocument.sections, targetDocument.sections);
    const diff = compareScriptVersions(
        { id: `host:${input.hostUnitId}:saved`, contentHash: sourceHash },
        { id: `host:${input.hostUnitId}:${input.dirty ? "draft" : "saved"}`, contentHash: targetHash },
        { source: sourceDocument.dialogueCues, target: targetDocument.dialogueCues, changedSectionIds },
    );
    const dependencies = deriveStrictShotDependencies(input.shotDependencies || [], sourceDocument, sourceHash);
    return Object.freeze({
        mode: "host_preview",
        source: Object.freeze({ id: diff.fromVersionId, label: "Host 已保存正文", contentHash: sourceHash, reviewState: "not_reviewed", lockState: "unlocked", formal: false }),
        target: Object.freeze({ id: diff.toVersionId, label: input.dirty ? "当前未保存草稿" : "当前正文", contentHash: targetHash, reviewState: "not_reviewed", lockState: "unlocked", formal: false }),
        sourceDocument,
        targetDocument,
        diff,
        impact: analyzeScriptImpact(diff, dependencies),
    });
}

export function parseScriptReviewDocument(text: string): ScriptReviewDocument {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const sections: Array<{ sectionId: string; title: string; lines: string[] }> = [];
    let current = { sectionId: "S-ROOT", title: "全文", lines: [] as string[] };
    sections.push(current);

    for (const line of lines) {
        const heading = sectionHeading(line);
        if (heading) {
            const occurrence = sections.filter((section) => section.title === heading).length + 1;
            current = { sectionId: `S-${stableToken(heading)}-${occurrence}`, title: heading, lines: [] };
            sections.push(current);
        } else {
            current.lines.push(line);
        }
    }

    const populatedSections = sections
        .map((section) => Object.freeze({ sectionId: section.sectionId, title: section.title, text: section.lines.join("\n") }))
        .filter((section, index) => index > 0 || section.text.trim().length > 0 || sections.length === 1);
    const dialogueCues: DialogueCue[] = [];
    for (const section of populatedSections) {
        const speakerOccurrences = new Map<string, number>();
        for (const line of section.text.split("\n")) {
            const match = line.match(/^([^：:\n]{1,24})[：:](.*)$/);
            if (!match) continue;
            const speaker = match[1].trim();
            const dialogue = match[2];
            if (!speaker || dialogue.length === 0 || /^(?:场景|时间|地点|内景|外景)$/i.test(speaker)) continue;
            const occurrence = (speakerOccurrences.get(speaker) || 0) + 1;
            speakerOccurrences.set(speaker, occurrence);
            dialogueCues.push(Object.freeze({ cueId: `D-${section.sectionId}-${stableToken(speaker)}-${occurrence}`, speaker, text: dialogue }));
        }
    }
    return Object.freeze({ sections: Object.freeze(populatedSections), dialogueCues: Object.freeze(dialogueCues) });
}

export function htmlToScriptReviewText(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(?:p|div|h[1-6]|li|blockquote)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\n+|\n+$/g, "");
}

function deriveStrictShotDependencies(shots: readonly Readonly<{ id: string; description: string }>[], source: ScriptReviewDocument, sourceContentHash: string): ScriptDependency[] {
    return shots.map((shot) => ({
        targetId: shot.id,
        targetType: "shot",
        sourceContentHash,
        // Exact source text matches are evidence; fuzzy inference stays unresolved.
        dialogueCueIds: source.dialogueCues.filter((cue) => cue.text && shot.description.includes(cue.text)).map((cue) => cue.cueId),
        sectionIds: source.sections.filter((section) => section.title !== "全文" && shot.description.includes(section.title)).map((section) => section.sectionId),
    }));
}

function changedSections(source: readonly ScriptReviewSection[], target: readonly ScriptReviewSection[]) {
    const sourceById = new Map(source.map((section) => [section.sectionId, section.text]));
    const targetById = new Map(target.map((section) => [section.sectionId, section.text]));
    return Array.from(new Set([...sourceById.keys(), ...targetById.keys()])).filter((sectionId) => sourceById.get(sectionId) !== targetById.get(sectionId));
}

function sectionHeading(line: string) {
    const normalized = line.trim().replace(/^#{1,6}\s+/, "");
    if (!normalized) return "";
    return /^(?:第[^\s]{1,12}场(?:\s|$)|场景\s*[：:]|(?:INT|EXT|INT\/EXT)\.)/i.test(normalized) ? normalized : "";
}

function stableToken(value: string) {
    let hash = 0x811c9dc5;
    for (const character of value.normalize("NFKC")) {
        hash ^= character.codePointAt(0) || 0;
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36).toUpperCase();
}
