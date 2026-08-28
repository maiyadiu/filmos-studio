import type { DreaminaGenerationTaskContract } from "../dreamina-task-contract.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export type FilmDreaminaLineageInput = {
  enabled?: boolean;
  evidenceMode: "fixture" | "observed_runtime";
  hostProjectId: string;
  generationPackage: {
    filmEntityId: string;
    expectedVersion: number;
    expectedContentHash: string;
    inputHash: string;
    providerId: "dreamina_cli";
    submissionState: "NOT_SUBMITTED";
  };
  task: DreaminaGenerationTaskContract;
};

export type FilmDreaminaOutputLineage = {
  outputIndex: number;
  mediaType: "image" | "video" | "audio";
  providerArtifactRef: string;
  materializedHostAssetId?: string;
};

export type FilmDreaminaLineageProjection = {
  authority: "projection_only";
  formalApply: false;
  externalExecutionPerformedByProjector: false;
  candidateOnly: true;
  evidenceMode: FilmDreaminaLineageInput["evidenceMode"];
  providerId: "dreamina_cli";
  generationPackageId: string;
  generationPackageVersion: number;
  generationPackageContentHash: string;
  requestHash: string;
  hostProjectId: string;
  taskId: string;
  providerTaskId: string;
  taskVersion: number;
  observedAt: string;
  resultState: "READY";
  outputs: FilmDreaminaOutputLineage[];
  nextAction: "MANUAL_IMPORT_REVIEW_REQUIRED";
};

export class FilmDreaminaLineageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FilmDreaminaLineageError";
  }
}

export function projectDreaminaTaskLineage(
  input: FilmDreaminaLineageInput,
): FilmDreaminaLineageProjection {
  if (input.enabled !== true) {
    throw new FilmDreaminaLineageError(
      "dreamina_lineage_disabled",
      "Film Dreamina lineage projection is disabled by default",
    );
  }
  requireOpaqueId(input.hostProjectId, "hostProjectId");
  const pkg = input.generationPackage;
  requireUuid4(pkg.filmEntityId, "generationPackage.filmEntityId");
  requirePositiveVersion(
    pkg.expectedVersion,
    "generationPackage.expectedVersion",
  );
  requireHash(pkg.expectedContentHash, "generationPackage.expectedContentHash");
  requireHash(pkg.inputHash, "generationPackage.inputHash");
  if (pkg.providerId !== "dreamina_cli") {
    throw new FilmDreaminaLineageError(
      "provider_mismatch",
      "GenerationPackage is not bound to dreamina_cli",
    );
  }
  if (pkg.submissionState !== "NOT_SUBMITTED") {
    throw new FilmDreaminaLineageError(
      "package_submission_state_invalid",
      "Film lineage can only start from the audited NOT_SUBMITTED package",
    );
  }

  const task = input.task;
  requireOpaqueId(task.taskId, "task.taskId");
  requireOpaqueId(task.clientOperationId, "task.clientOperationId");
  requirePositiveVersion(task.version, "task.version");
  requireHash(task.requestHash, "task.requestHash");
  if (task.provider !== "dreamina-cli") {
    throw new FilmDreaminaLineageError(
      "task_provider_mismatch",
      "Task provider must be dreamina-cli",
    );
  }
  if (task.requestHash !== pkg.inputHash) {
    throw new FilmDreaminaLineageError(
      "request_hash_conflict",
      "Dreamina request hash does not match the locked GenerationPackage input hash",
    );
  }
  if (!task.projectId || task.projectId !== input.hostProjectId) {
    throw new FilmDreaminaLineageError(
      "project_scope_mismatch",
      "Dreamina task must carry the same explicit Host Project scope",
    );
  }
  if (
    task.lifecycle !== "TERMINAL" ||
    task.terminalOutcome !== "SUCCEEDED" ||
    task.syncState !== "SYNC_OK" ||
    task.resultState !== "READY"
  ) {
    throw new FilmDreaminaLineageError(
      "task_not_ready",
      "Only a synchronized terminal success with READY outputs can enter manual import review",
    );
  }
  if (!task.providerTaskId) {
    throw new FilmDreaminaLineageError(
      "provider_task_id_missing",
      "A successful Dreamina task requires a providerTaskId",
    );
  }
  requireOpaqueId(task.providerTaskId, "task.providerTaskId");
  if (
    !task.lastObservedAt ||
    !Number.isFinite(Date.parse(task.lastObservedAt))
  ) {
    throw new FilmDreaminaLineageError(
      "observation_time_missing",
      "A successful Dreamina task requires a valid lastObservedAt timestamp",
    );
  }
  if (task.outputs.length === 0) {
    throw new FilmDreaminaLineageError(
      "outputs_missing",
      "A successful Dreamina task requires at least one output",
    );
  }
  const indexes = new Set<number>();
  const outputs = task.outputs.map((output) => {
    if (!Number.isSafeInteger(output.outputIndex) || output.outputIndex < 0) {
      throw new FilmDreaminaLineageError(
        "output_index_invalid",
        "Dreamina outputIndex must be a non-negative integer",
      );
    }
    if (indexes.has(output.outputIndex)) {
      throw new FilmDreaminaLineageError(
        "output_index_duplicate",
        "Dreamina outputIndex must be unique",
      );
    }
    indexes.add(output.outputIndex);
    if (!output.providerArtifactRef) {
      throw new FilmDreaminaLineageError(
        "provider_artifact_ref_missing",
        "READY Dreamina output requires a providerArtifactRef",
      );
    }
    requireOpaqueId(output.providerArtifactRef, "output.providerArtifactRef");
    if (output.materializedAssetId) {
      requireOpaqueId(output.materializedAssetId, "output.materializedAssetId");
    }
    return {
      outputIndex: output.outputIndex,
      mediaType: output.mediaType,
      providerArtifactRef: output.providerArtifactRef,
      ...(output.materializedAssetId
        ? { materializedHostAssetId: output.materializedAssetId }
        : {}),
    };
  });

  return {
    authority: "projection_only",
    formalApply: false,
    externalExecutionPerformedByProjector: false,
    candidateOnly: true,
    evidenceMode: input.evidenceMode,
    providerId: "dreamina_cli",
    generationPackageId: pkg.filmEntityId,
    generationPackageVersion: pkg.expectedVersion,
    generationPackageContentHash: pkg.expectedContentHash,
    requestHash: pkg.inputHash,
    hostProjectId: input.hostProjectId,
    taskId: task.taskId,
    providerTaskId: task.providerTaskId,
    taskVersion: task.version,
    observedAt: task.lastObservedAt,
    resultState: "READY",
    outputs,
    nextAction: "MANUAL_IMPORT_REVIEW_REQUIRED",
  };
}

function requireUuid4(value: string, field: string) {
  if (!UUID_V4.test(value)) {
    throw new FilmDreaminaLineageError(
      "film_uuid_v4_required",
      `${field} must be a Film Core UUIDv4`,
    );
  }
}

function requireHash(value: string, field: string) {
  if (!SHA_256.test(value)) {
    throw new FilmDreaminaLineageError(
      "sha256_required",
      `${field} must be a lowercase SHA-256`,
    );
  }
}

function requireOpaqueId(value: string, field: string) {
  if (!OPAQUE_ID.test(value)) {
    throw new FilmDreaminaLineageError(
      "opaque_id_required",
      `${field} must be an opaque ID, not a path or URL`,
    );
  }
}

function requirePositiveVersion(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FilmDreaminaLineageError(
      "version_invalid",
      `${field} must be a positive integer`,
    );
  }
}
