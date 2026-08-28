import assert from "node:assert/strict";
import test from "node:test";

import { buildWidgetModel } from "../src/widget-model.js";
import { WIDGETS } from "../src/widgets.js";
import { projectA, projects } from "./fixture.js";

test("ProjectOverviewWidget renders semantic project metrics", () => {
  const model = buildWidgetModel("project", { project_id: projectA, version: 3, state_hash: "a".repeat(64), data: projects[projectA] });
  assert.equal(model.headline, `Project ${projectA}`);
  assert.deepEqual(model.stats.map((item) => [item.label, item.value]), [["ContentUnits", "1"], ["Shots", "1"], ["Version", "3"]]);
});

test("ContentUnitProgressWidget renders formal state axes", () => {
  const unit = projects[projectA].content_units[0];
  const model = buildWidgetModel("content-unit", { uri: "filmos://unit", state_hash: "b".repeat(64), data: unit });
  assert.equal(model.headline, "ContentUnit unit-a");
  assert.deepEqual(model.stats.map((item) => item.value), ["reviewed", "passed", "fresh"]);
});

test("ShotReviewWidget renders review state and director bindings without an approval action", () => {
  const shot = projects[projectA].shots[0];
  const model = buildWidgetModel("shot", { uri: "filmos://shot", state_hash: "c".repeat(64), data: shot });
  assert.equal(model.headline, "Shot shot-a");
  assert.equal(model.stats.find((item) => item.label === "Director units")?.value, "0");
  assert.equal(JSON.stringify(model).includes("approve"), false);
});

test("widget resources use the official ext-apps bridge bundle and no handwritten wildcard initialization", () => {
  for (const widget of Object.values(WIDGETS)) {
    assert.ok(widget.html.includes("ui/initialize"));
    assert.equal(widget.html.includes("window.parent.postMessage"), false);
    assert.equal(widget.html.includes("'*'"), false);
    assert.ok(widget.html.includes("READ ONLY"));
  }
});
