import { expect, test } from "bun:test";
import { buildShotDialogueReview } from "../src/film/story/shot-source-review";
import type { ProjectShotContext } from "../src/services/api/projects";

function context(): ProjectShotContext {
    const dialogue = [{ paragraphId: "p1", speaker: "林夏", text: "  我陪你。" }, { paragraphId: "p2", speaker: "周宁", text: "好。" }];
    return {
        unit: { id: "u", projectId: "p", kind: "chapter", title: "样例", sourceText: "正文", revision: 1, shotRevision: 1, status: "draft", position: 0, createdAt: "now", updatedAt: "now" },
        sourceHash: "source", paragraphs: dialogue.map(d => ({ id: d.paragraphId, text: d.speaker + "：" + d.text, dialogue: d })), staleShotIds: [],
        coverage: { coveredParagraphIds: ["p1", "p2"], missingParagraphIds: [], dialogueMatches: true, chapterComplete: true },
        shots: dialogue.map((d, i) => ({ id: "s" + i, projectId: "p", unitId: "u", title: "镜头", description: "描述", position: i, durationMs: 5000, status: "draft", revision: 1, sourceRevision: 1, sourceHash: "source", content: { sourceReferences: [], scene: "客厅", characters: [d.speaker], dialogue: [structuredClone(d)], action: "回应", camera: "中景" }, createdAt: "now", updatedAt: "now" })),
    };
}

test("shot review reuses exact dialogue diff and combines continuous split delivery", () => {
    const c = context();
    expect(buildShotDialogueReview(c)).toMatchObject({ faithful: true, sourceCueCount: 2, targetCueCount: 2 });
    const extra = structuredClone(c.shots[0]);
    c.shots[0].content.dialogue![0].text = "  我陪";
    extra.id = "split"; extra.position = 0.5;
    extra.content.dialogue![0].text = "你。";
    c.shots.push(extra);
    expect(buildShotDialogueReview(c)).toMatchObject({ faithful: true, targetCueCount: 2 });
});

test("shot review exposes changed speaker, exact whitespace, omission and repetition", () => {
    for (const kind of ["speaker", "whitespace", "omission", "repetition", "reorder", "stale"]) {
        const c = context();
        if (kind === "speaker") c.shots[0].content.dialogue![0].speaker = "周宁";
        if (kind === "whitespace") c.shots[0].content.dialogue![0].text = "我陪你。";
        if (kind === "omission") c.shots.shift();
        if (kind === "repetition") { const s = structuredClone(c.shots[0]); s.id = "duplicate"; s.position = 2; c.shots.push(s); }
        if (kind === "reorder") c.shots[0].position = 2;
        if (kind === "stale") c.shots[0].sourceRevision = 0;
        expect(buildShotDialogueReview(c).faithful, kind).toBe(false);
    }
});

test("large diff avoids quadratic allocation without truncating source or bypassing server result", () => {
    const c = context();
    c.paragraphs = Array.from({ length: 1001 }, (_, i) => ({ id: "p" + i, text: "台词", dialogue: { paragraphId: "p" + i, speaker: "林夏", text: "台词" } }));
    c.shots[0].content.dialogue = c.paragraphs.map(p => p.dialogue!);
    c.shots = c.shots.slice(0, 1);
    c.coverage.dialogueMatches = false;
    expect(buildShotDialogueReview(c)).toMatchObject({ faithful: false, sourceCueCount: 1001, detailedDiff: "NOT_COMPUTED_SIZE_LIMIT" });
    expect(c.paragraphs).toHaveLength(1001);
});
