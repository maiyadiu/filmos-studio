import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    isFilmDynamicContentUnitsEnabled,
    parseFilmFeatureFlag,
    projectFilmContentUnits,
    projectFilmOverview,
    type FilmContentUnitExtension,
    type FilmFormalStateAxes,
    type HostProjectSnapshot,
} from "./index";

const freshDraft: FilmFormalStateAxes = {
    creative_stage: "draft",
    execution_state: "not_started",
    review_state: "not_reviewed",
    lock_state: "unlocked",
    delivery_state: "not_ready",
    stale_state: "fresh",
};

const snapshot: HostProjectSnapshot = {
    project: { id: "project-1" },
    units: [
        { id: "unit-b", projectId: "project-1", parentId: "unit-a", kind: "legacy-kind", title: "番外", status: "ready", position: 2, createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" },
        { id: "unit-c", projectId: "project-1", kind: "episode", title: "第二集", status: "draft", position: 1, createdAt: "2026-01-03T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z" },
        { id: "unit-a", projectId: "project-1", kind: "chapter", title: "第一章", status: "completed", position: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    ],
    canvases: [
        { id: "canvas-story", title: "分镜画布", updatedAt: "2026-02-02T00:00:00Z" },
        { id: "canvas-production", title: "生产画布", updatedAt: "2026-02-01T00:00:00Z" },
    ],
    canvasUnitLinks: [
        { id: "link-story", canvasId: "canvas-story", unitId: "unit-b", role: "storyboard", createdAt: "2026-02-02T00:00:00Z" },
        { id: "link-production", canvasId: "canvas-production", unitId: "unit-b", role: "production", createdAt: "2026-02-01T00:00:00Z" },
        { id: "link-production-duplicate", canvasId: "canvas-production", unitId: "unit-b", role: "storyboard", createdAt: "2026-02-03T00:00:00Z" },
    ],
    shots: [
        { id: "shot-1", unitId: "unit-a" },
        { id: "shot-2", unitId: "unit-a" },
    ],
};

describe("Film ContentUnit Host adapter", () => {
    test("复用 Host position 排序并保留未知 kind 与 parentId", () => {
        const units = projectFilmContentUnits(snapshot);

        assert.deepEqual(units.map((unit) => unit.hostUnitId), ["unit-a", "unit-c", "unit-b"]);
        assert.equal(units[2].kind, "unknown");
        assert.equal(units[2].hostKind, "legacy-kind");
        assert.equal(units[2].parentId, "unit-a");
        assert.equal(units.every((unit) => unit.states === null), true);
    });

    test("只绑定匹配项目的最高 sidecar 版本且不把 Host status 冒充六轴状态", () => {
        const extensions = [
            extension("unit-b", 1, "special", freshDraft),
            extension("unit-b", 2, "extra", { ...freshDraft, creative_stage: "locked", review_state: "pending", stale_state: "stale" }),
            extension("unit-b", 3, "film", freshDraft, "other-project"),
            { broken: true },
        ];

        const unit = projectFilmContentUnits(snapshot, extensions).find((item) => item.hostUnitId === "unit-b")!;
        assert.equal(unit.kind, "extra");
        assert.equal(unit.extension?.ref.version, 2);
        assert.deepEqual(unit.states, { ...freshDraft, creative_stage: "locked", review_state: "pending", stale_state: "stale" });
        assert.equal(unit.hostStatus, "ready");
    });

    test("CanvasUnitLink 去重并唯一选择 production role 作为默认生产画布", () => {
        const unit = projectFilmContentUnits(snapshot).find((item) => item.hostUnitId === "unit-b")!;

        assert.deepEqual(unit.canvasIds, ["canvas-production", "canvas-story"]);
        assert.deepEqual(unit.productionCanvas, {
            canvasId: "canvas-production",
            title: "生产画布",
            role: "production",
            href: "/canvas/canvas-production",
        });
    });
});

describe("Film 项目概览投影", () => {
    test("只统计 Host 与 sidecar 可证实事实", () => {
        const overview = projectFilmOverview(snapshot, [
            extension("unit-a", 1, "chapter", { ...freshDraft, creative_stage: "locked", review_state: "approved" }),
            extension("unit-b", 1, "extra", { ...freshDraft, review_state: "changes_requested", stale_state: "blocked" }),
        ]);

        assert.equal(overview.totalUnitCount, 3);
        assert.deepEqual(overview.kindCounts, [
            { kind: "chapter", label: "章", count: 1 },
            { kind: "episode", label: "集", count: 1 },
            { kind: "extra", label: "番外", count: 1 },
        ]);
        assert.equal(overview.linkedCanvasUnitCount, 1);
        assert.equal(overview.shotCoveredUnitCount, 1);
        assert.equal(overview.formalStateUnitCount, 2);
        assert.equal(overview.creativeLockedUnitCount, 1);
        assert.equal(overview.reviewAttentionUnitCount, 1);
        assert.equal(overview.blockedUnitCount, 1);
    });

    test("缺少 Film sidecar 时明确标为未接入", () => {
        const overview = projectFilmOverview(snapshot);
        assert.equal(overview.hasFormalStateData, false);
        assert.equal(overview.formalStateUnitCount, 0);
    });
});

describe("film.dynamic_content_units flag", () => {
    test("默认关闭且只接受显式开启值", () => {
        assert.equal(isFilmDynamicContentUnitsEnabled({}), false);
        assert.equal(isFilmDynamicContentUnitsEnabled({ VITE_FILM_DYNAMIC_CONTENT_UNITS: "true" }), true);
        assert.equal(parseFilmFeatureFlag(" ON "), true);
        assert.equal(parseFilmFeatureFlag("false"), false);
        assert.equal(parseFilmFeatureFlag(undefined), false);
    });
});

function extension(
    hostUnitId: string,
    version: number,
    kind: FilmContentUnitExtension["unit_kind"],
    states: FilmFormalStateAxes,
    hostProjectId = "project-1",
): FilmContentUnitExtension {
    return {
        ref: {
            film_entity_id: `00000000-0000-4000-8000-${String(version).padStart(12, "0")}`,
            entity_type: "ContentUnitExtension",
            version,
            content_hash: String(version).repeat(64),
        },
        host: { host_project_id: hostProjectId, host_unit_id: hostUnitId },
        states,
        unit_kind: kind,
    };
}
