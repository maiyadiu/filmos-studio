import { describe, expect, test } from "bun:test";

import { inferIssueRoutingRisk } from "../src/film/governance/issue-lane";
import { contextFromPathname, createLocalIssueDraft, issueDraftReplayMode, issueEvidenceFilesFromClipboard, pastedIssueUploadDescriptor, selectPastedIssueEvidence } from "../src/film/governance/report-issue";

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
            { pathname: "/projects/project-1", localDraftId: "local-draft-12345678-1234-4123-8123-123456789abc", submissionId: "FILMOS-SUBMISSION-12345678-1234-4123-8123-123456789abc", now: "2026-08-31T00:00:00.000Z", build },
        );
        expect(draft).toMatchObject({
            localDraftId: "local-draft-12345678-1234-4123-8123-123456789abc",
            submissionId: "FILMOS-SUBMISSION-12345678-1234-4123-8123-123456789abc",
            state: "OBSERVED_IN_USE",
            occurred: "点击后报错",
            expected: "继续工作",
            blocking: true,
            delivery: "LOCAL_PENDING_REVIEW_BUS",
            build,
        });
    });

    test("rejects empty observations and oversized local evidence", () => {
        expect(() => createLocalIssueDraft({ occurred: " ", expected: "ok", blocking: false }, { submissionId: "FILMOS-SUBMISSION-12345678-1234-4123-8123-123456789abc", now: "2026-08-31T00:00:00.000Z", build })).toThrow("请填写发生了什么");
        expect(() => createLocalIssueDraft({ occurred: "bad", expected: "ok", blocking: false, attachments: [{ id: "a", name: "large.mov", mediaType: "video/quicktime", size: 26 * 1024 * 1024, content: new Blob() }] }, { submissionId: "FILMOS-SUBMISSION-12345678-1234-4123-8123-123456789abc", now: "2026-08-31T00:00:00.000Z", build })).toThrow("单个不超过25MB");
    });

    test("generates only local draft and submission identifiers before Review Bus acceptance", () => {
        const draft = createLocalIssueDraft(
            { occurred: "error", expected: "work", blocking: false },
            { pathname: "/", now: "2026-08-31T00:00:00.000Z", build },
        );
        expect(draft.localDraftId).toMatch(/^local-draft-[0-9a-f-]{36}$/i);
        expect(draft.submissionId).toMatch(/^FILMOS-SUBMISSION-[0-9a-f-]{36}$/i);
        expect(draft.canonicalIssueId).toBeUndefined();
    });

    test("never POSTs again after a formal Receipt has been persisted", () => {
        const draft = createLocalIssueDraft(
            { occurred: "服务端成功但客户端在回执后崩溃", expected: "重启后只做读回", blocking: false },
            { pathname: "/projects/project-1", submissionId: "FILMOS-SUBMISSION-b3274782-30a0-44a1-a05e-01730678da8b", now: "2026-09-01T16:16:00.955Z", build },
        );
        expect(issueDraftReplayMode(draft)).toBe("SUBMIT_OR_RESUME");
        expect(issueDraftReplayMode({ ...draft, delivery: "SUBMISSION_STAGED" })).toBe("SUBMIT_OR_RESUME");
        expect(issueDraftReplayMode({ ...draft, delivery: "ACCEPTED_AWAITING_READBACK", canonicalIssueId: "FILMOS-ARCH-b3274782-30a0-44a1-a05e-01730678da8b" })).toBe("READBACK_ONLY");
        expect(issueDraftReplayMode({ ...draft, delivery: "CONFIRMED" })).toBe("NONE");
        expect(issueDraftReplayMode({ ...draft, delivery: "STOPPED", stoppedReason: "PROJECT_SCOPE_DENIED" })).toBe("NONE");
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

    test("reads screenshot bytes from clipboard items when WKWebView exposes an empty files list", () => {
        const screenshot = new File(["image"], "clipboard.png", { type: "image/png", lastModified: 123 });
        const selected = issueEvidenceFilesFromClipboard({
            files: [],
            items: [
                { kind: "string", getAsFile: () => null },
                { kind: "file", getAsFile: () => screenshot },
                { kind: "file", getAsFile: () => screenshot },
            ],
        });
        expect(selected).toHaveLength(1);
        expect(selected[0]).toBe(screenshot);
    });

    test("wraps pasted evidence without mutating browser File readonly properties", () => {
        const screenshot = new File(["image"], "连接失败截图.png", { type: "image/png", lastModified: 123 });
        const ownKeysBefore = Reflect.ownKeys(screenshot);
        const descriptor = pastedIssueUploadDescriptor(screenshot, "paste-123");
        expect(descriptor).toMatchObject({
            uid: "paste-123",
            name: "连接失败截图.png",
            mediaType: "image/png",
            size: 5,
            status: "done",
        });
        expect(descriptor.file).toBe(screenshot);
        expect(Reflect.ownKeys(screenshot)).toEqual(ownKeysBefore);
        expect(Object.prototype.hasOwnProperty.call(screenshot, "uid")).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(screenshot, "lastModifiedDate")).toBe(false);
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
