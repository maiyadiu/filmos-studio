import { describe, expect, test } from "bun:test";

import { inferIssueRoutingRisk } from "../src/film/governance/issue-lane";
import { contextFromPathname, createLocalIssueDraft, selectPastedIssueEvidence } from "../src/film/governance/report-issue";

const build = {
    commit: "6ea93bfa08381264a1379fe938ade3a7513c7bba",
    tree: "51896f7874e21cc9868cb1bfa33b302cd323a925",
    buildId: "pilot-base-0",
    channel: "pilot",
    version: "0.7.0",
    externalPaidSubmitEnabled: false,
};

describe("usage issue intake", () => {
    test("derives only stable route context and strips query secrets", () => {
        expect(contextFromPathname("/projects/project-1/chapters/unit-2?token=secret")).toEqual({
            pathname: "/projects/project-1/chapters/unit-2",
            surface: "content-unit",
            projectId: "project-1",
            contentUnitId: "unit-2",
        });
        expect(contextFromPathname("/canvas/canvas-3#private")).toEqual({
            pathname: "/canvas/canvas-3",
            surface: "canvas",
            canvasId: "canvas-3",
        });
    });

    test("is SSR-safe and binds the observation to build identity", () => {
        expect(globalThis.window).toBeUndefined();
        const draft = createLocalIssueDraft(
            { occurred: " 点击后报错 ", expected: " 继续工作 ", blocking: true },
            { pathname: "/projects/project-1", issueId: "FILMOS-ISSUE-12345678-1234-4123-8123-123456789abc", now: "2026-08-31T00:00:00.000Z", build },
        );
        expect(draft).toMatchObject({
            issueId: "FILMOS-ISSUE-12345678-1234-4123-8123-123456789abc",
            state: "OBSERVED_IN_USE",
            occurred: "点击后报错",
            expected: "继续工作",
            blocking: true,
            delivery: "LOCAL_PENDING_REVIEW_BUS",
            build,
        });
    });

    test("rejects empty observations and oversized local evidence", () => {
        expect(() => createLocalIssueDraft({ occurred: " ", expected: "ok", blocking: false }, { issueId: "FILMOS-ISSUE-12345678-1234-4123-8123-123456789abc", now: "2026-08-31T00:00:00.000Z", build })).toThrow("请填写发生了什么");
        expect(() => createLocalIssueDraft({ occurred: "bad", expected: "ok", blocking: false, attachments: [{ id: "a", name: "large.mov", mediaType: "video/quicktime", size: 26 * 1024 * 1024, content: new Blob() }] }, { issueId: "FILMOS-ISSUE-12345678-1234-4123-8123-123456789abc", now: "2026-08-31T00:00:00.000Z", build })).toThrow("单个不超过25MB");
    });

    test("generates the cross-track canonical issue id", () => {
        const draft = createLocalIssueDraft(
            { occurred: "error", expected: "work", blocking: false },
            { pathname: "/", now: "2026-08-31T00:00:00.000Z", build },
        );
        expect(draft.issueId).toMatch(/^FILMOS-ISSUE-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    test("pasted evidence accepts only bounded image/video bytes and respects remaining slots", () => {
        const image = new File(["image"], "shot.png", { type: "image/png" });
        const video = new File(["video"], "screen.mov", { type: "video/quicktime" });
        const text = new File(["text"], "note.txt", { type: "text/plain" });
        const oversized = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "large.png", { type: "image/png" });
        const selected = selectPastedIssueEvidence([image, text, video, oversized], 4);
        expect(selected.accepted.map((file) => file.name)).toEqual(["shot.png"]);
        expect(selected.oversizedCount).toBe(1);
        expect(selected.truncatedCount).toBe(1);
    });

    test("infers lane risk without asking the reporter to classify the issue", () => {
        expect(inferIssueRoutingRisk({
            occurred: "按钮文案不清楚",
            expected: "改成更容易理解的中文",
            blocking: false,
            context: { surface: "project", pathname: "/projects/p1/overview" },
        })).toEqual({});
        expect(inferIssueRoutingRisk({
            occurred: "Review Bus 没有形成 Candidate A 到 B 的双专家签名",
            expected: "ChatGPT Findings 写回后才允许 Pilot Gate 通过",
            blocking: true,
            context: { surface: "project", pathname: "/projects/p1/overview" },
        })).toEqual({ core_state: true });
        expect(inferIssueRoutingRisk({
            occurred: "现有结构不符合真实工作，需要重新设计",
            expected: "形成可持续架构",
            blocking: true,
            context: { surface: "project", pathname: "/projects/p1/overview" },
        })).toEqual({ architecture_gap: true });
    });
});
