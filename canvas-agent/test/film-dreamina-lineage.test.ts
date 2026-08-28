import assert from "node:assert/strict";
import test from "node:test";

import {
  FilmDreaminaLineageError,
  projectDreaminaTaskLineage,
  type FilmDreaminaLineageInput,
} from "../src/film/dreamina-lineage.js";

const PACKAGE_ID = "00000000-0000-4000-8000-000000000001";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function fixture(
  overrides: Partial<FilmDreaminaLineageInput> = {},
): FilmDreaminaLineageInput {
  return {
    enabled: true,
    evidenceMode: "fixture",
    hostProjectId: "host-project-golden-b",
    generationPackage: {
      filmEntityId: PACKAGE_ID,
      expectedVersion: 1,
      expectedContentHash: HASH_A,
      inputHash: HASH_B,
      providerId: "dreamina_cli",
      submissionState: "NOT_SUBMITTED",
    },
    task: {
      taskId: "dreamina-task-golden-b",
      clientOperationId: "dreamina-operation-golden-b",
      provider: "dreamina-cli",
      lifecycle: "TERMINAL",
      terminalOutcome: "SUCCEEDED",
      syncState: "SYNC_OK",
      resultState: "READY",
      projectId: "host-project-golden-b",
      requestHash: HASH_B,
      providerTaskId: "provider-task-golden-b",
      officialStatus: "completed",
      lastObservedAt: "2026-08-28T10:00:00Z",
      version: 3,
      outputs: [
        {
          outputIndex: 0,
          mediaType: "image",
          providerArtifactRef: "dreamina-provider-artifact:golden-b:0",
          materializedAssetId: "host-asset-golden-b-0",
        },
      ],
    },
    ...overrides,
  };
}

function expectCode(call: () => unknown, code: string) {
  assert.throws(
    call,
    (error: unknown) =>
      error instanceof FilmDreaminaLineageError && error.code === code,
  );
}

test("Dreamina Film lineage is disabled by default", () => {
  expectCode(
    () => projectDreaminaTaskLineage(fixture({ enabled: undefined })),
    "dreamina_lineage_disabled",
  );
});

test("projects a ready scoped snapshot without submitting or approving", () => {
  const projected = projectDreaminaTaskLineage(fixture());
  assert.equal(projected.authority, "projection_only");
  assert.equal(projected.formalApply, false);
  assert.equal(projected.externalExecutionPerformedByProjector, false);
  assert.equal(projected.candidateOnly, true);
  assert.equal(projected.nextAction, "MANUAL_IMPORT_REVIEW_REQUIRED");
  assert.equal(projected.requestHash, HASH_B);
  assert.deepEqual(projected.outputs, [
    {
      outputIndex: 0,
      mediaType: "image",
      providerArtifactRef: "dreamina-provider-artifact:golden-b:0",
      materializedHostAssetId: "host-asset-golden-b-0",
    },
  ]);
});

test("rejects unscoped or cross-project snapshots", () => {
  expectCode(
    () =>
      projectDreaminaTaskLineage(
        fixture({ task: { ...fixture().task, projectId: undefined } }),
      ),
    "project_scope_mismatch",
  );
  expectCode(
    () =>
      projectDreaminaTaskLineage(
        fixture({
          task: { ...fixture().task, projectId: "host-project-other" },
        }),
      ),
    "project_scope_mismatch",
  );
});

test("rejects request drift, uncertain sync, and non-ready results", () => {
  expectCode(
    () =>
      projectDreaminaTaskLineage(
        fixture({ task: { ...fixture().task, requestHash: HASH_A } }),
      ),
    "request_hash_conflict",
  );
  expectCode(
    () =>
      projectDreaminaTaskLineage(
        fixture({ task: { ...fixture().task, syncState: "SYNC_CONFLICT" } }),
      ),
    "task_not_ready",
  );
  expectCode(
    () =>
      projectDreaminaTaskLineage(
        fixture({
          task: { ...fixture().task, resultState: "PENDING_MATERIALIZATION" },
        }),
      ),
    "task_not_ready",
  );
});

test("rejects duplicate outputs and unsafe provider references", () => {
  const task = fixture().task;
  expectCode(
    () =>
      projectDreaminaTaskLineage(
        fixture({
          task: { ...task, outputs: [task.outputs[0]!, task.outputs[0]!] },
        }),
      ),
    "output_index_duplicate",
  );
  expectCode(
    () =>
      projectDreaminaTaskLineage(
        fixture({
          task: {
            ...task,
            outputs: [
              {
                ...task.outputs[0]!,
                providerArtifactRef: "https://provider.example/output.png",
              },
            ],
          },
        }),
      ),
    "opaque_id_required",
  );
});
