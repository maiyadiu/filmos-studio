import { describe, expect, test } from "bun:test";

import { contextFromPathname, createLocalIssueDraft } from "../src/film/governance/report-issue";

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
});
