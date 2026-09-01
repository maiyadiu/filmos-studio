import assert from "node:assert/strict";
import test from "node:test";

import { deriveBlockerReport } from "../src/data-source.js";

test("blocker report exposes the missing Film Project projection as a concrete P0", () => {
  const projectId = "project-live-a";
  const report = deriveBlockerReport({ host_project_id: projectId, film_project: null, content_units: [], shots: [] }, projectId);

  assert.equal(report.completeness, "DERIVED_FROM_PROJECT_CONTEXT");
  assert.equal(report.evaluation.status, "BLOCKED");
  assert.equal(report.project_scope.exact_match, true);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].code, "FILM_PROJECT_CONTEXT_NOT_PUBLISHED");
  assert.equal(report.items[0].severity, "P0");
  assert.equal(report.items[0].project_id, projectId);
  assert.equal(report.evidence.film_project_present, false);
});

test("blocker report is CLEAR only for an exact-project fresh context", () => {
  const projectId = "project-live-a";
  const report = deriveBlockerReport({
    host_project_id: projectId,
    film_project: {
      ref: { film_entity_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", entity_type: "film_project_extension" },
      states: { stale_state: "fresh", execution_state: "not_started" },
    },
    content_units: [],
    shots: [],
  }, projectId);

  assert.deepEqual(report.items, []);
  assert.equal(report.evaluation.status, "CLEAR");
  assert.equal(report.evidence.film_project_present, true);
});

test("blocker report rejects a historical context from another project", () => {
  assert.throws(
    () => deriveBlockerReport({ host_project_id: "historical-project", film_project: null, content_units: [], shots: [] }, "current-project"),
    (error: any) => error?.code === "project_scope_denied",
  );
});
