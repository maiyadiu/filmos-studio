import { projectProductionCanvas } from "../../web/src/film/canvas/production-canvas";
import {
  FILM_PROMPT_KERNEL_FLAG,
  compilePromptDraft,
  sha256Text,
  type FilmHostBinding,
} from "../../web/src/film/prompt";
import {
  FilmProviderRegistry,
  importManualProviderResult,
  prepareSubmissionPackage,
} from "../../web/src/film/providers/provider-runtime";

export type GoldenFilmRef = {
  filmEntityId: string;
  entityType: string;
  version: number;
  contentHash: string;
};

export type GoldenALocalInput = {
  hostProjectId: string;
  hostUnitId: string;
  hostShotId: string;
  project: GoldenFilmRef;
  scriptVersion: GoldenFilmRef;
  directorUnit: GoldenFilmRef;
  shot: GoldenFilmRef;
  coverageLink: GoldenFilmRef;
  canvasRelation: GoldenFilmRef;
  promptDraft: GoldenFilmRef;
  generationPackage: GoldenFilmRef;
  generationAttempt: GoldenFilmRef;
  candidate: GoldenFilmRef;
  visualLock: GoldenFilmRef;
  assetVersion: GoldenFilmRef;
  outputRepresentation: GoldenFilmRef;
};

export type GoldenALocalReceipt = {
  prepared: true;
  persisted: false;
  reviewed: false;
  approved: false;
  externalProviderCalls: 0;
  prompt: {
    audit: "PASS";
    promptDraftId: string;
    promptHash: string;
    inputHash: string;
  };
  canvas: {
    nodeCount: number;
    edgeCount: number;
    sourceVersion: number;
    sourceHash: string;
  };
  package: {
    id: string;
    lifecycle: "prepared";
    externalSubmission: "not_submitted";
    inputHash: string;
  };
  candidate: {
    id: string;
    status: "candidate";
    reviewState: "pending";
    approvalState: "not_approved";
    contentHash: string;
  };
};

export async function runGoldenALocalChain(
  input: GoldenALocalInput,
): Promise<GoldenALocalReceipt> {
  const directorIrText =
    "人物在门口停步，右手握住门把，视线保持在室内目标；镜头不得越过既定轴线。";
  const visualLockText =
    "人物保持画面左侧，门与动作目标保持右侧；服装、道具与视线连续。";
  const templateContent =
    "将导演 IR、视觉锁与授权资产绑定编译为可人工执行的提示词，不补写未提供事实。";
  const directorHash = await sha256Text(directorIrText);
  const visualLockHash = await sha256Text(visualLockText);
  const templateHash = await sha256Text(templateContent);
  if (input.directorUnit.contentHash !== directorHash)
    throw new Error(
      "DirectorUnit content hash does not bind the local compiler input",
    );
  if (input.visualLock.contentHash !== visualLockHash)
    throw new Error(
      "VisualLock content hash does not bind the local compiler input",
    );

  const canvas = projectProductionCanvas({
    hostProjectId: input.hostProjectId,
    hostUnitId: input.hostUnitId,
    filmCoreVersion: input.coverageLink.version,
    contentHash: input.coverageLink.contentHash,
    entities: [
      {
        id: input.directorUnit.filmEntityId,
        kind: "director_unit",
        position: 0,
      },
      { id: input.shot.filmEntityId, kind: "shot", position: 0 },
      {
        id: input.coverageLink.filmEntityId,
        kind: "coverage_link",
        position: 0,
      },
    ],
    relations: [
      {
        id: input.canvasRelation.filmEntityId,
        fromEntityId: input.directorUnit.filmEntityId,
        toEntityId: input.shot.filmEntityId,
        kind: "coverage",
      },
    ],
  });

  const compiled = await compilePromptDraft({
    schemaVersion: "filmos.prompt-compiler-input.v0",
    feature: { key: FILM_PROMPT_KERNEL_FLAG, enabled: true },
    draft: {
      filmEntityId: input.promptDraft.filmEntityId,
      expectedVersion: input.promptDraft.version - 1,
      targetVersion: input.promptDraft.version,
    },
    scope: {
      project: binding(input.project, "project", input.hostProjectId),
      shot: binding(input.shot, "shot", input.hostShotId),
      directorUnit: binding(input.directorUnit, "unit", input.hostUnitId),
    },
    directorIrText,
    visualLock: {
      binding: binding(
        input.visualLock,
        "asset_version",
        "host-visual-lock-golden-a",
      ),
      lockText: visualLockText,
    },
    template: {
      hostPromptTemplateId: "host-prompt-template-golden-a",
      operation: "film.prompt.compile",
      version: 1,
      contentHash: templateHash,
      content: templateContent,
    },
    assets: [
      {
        binding: binding(
          input.assetVersion,
          "asset_version",
          "host-asset-version-golden-a",
        ),
        role: "character",
        priority: 100,
      },
    ],
    providerCapability: {
      profileId: "manual-video-v1",
      profileVersion: 1,
      providerKind: "manual_web",
      outputKind: "video",
      dialect: "plain_zh",
      supports: {
        referenceAssets: true,
        negativePrompt: true,
        deterministicSeed: false,
        cameraControl: true,
        audio: false,
      },
      requires: { aspectRatio: true, durationSeconds: true },
      limits: { maxPromptCharacters: 12_000, maxReferenceAssets: 4 },
    },
    providerParameters: {
      aspectRatio: "9:16",
      durationSeconds: 5,
      seed: null,
      negativePrompt: "身份漂移，轴线反转，道具错位",
    },
  });

  const registry = new FilmProviderRegistry({ enabled: true });
  const generationPackage = await prepareSubmissionPackage(registry, {
    submissionPackageId: input.generationPackage.filmEntityId,
    generationAttemptId: input.generationAttempt.filmEntityId,
    promptDraftId: compiled.promptDraft.ref.film_entity_id,
    hostProjectId: input.hostProjectId,
    target: {
      filmEntityId: input.shot.filmEntityId,
      expectedVersion: input.shot.version,
      expectedContentHash: input.shot.contentHash,
    },
    providerId: "manual_web",
    capabilityId: "video",
    promptText: compiled.promptDraft.prompt_text,
    parameters: { aspectRatio: "9:16", durationSeconds: 5 },
    references: [
      {
        filmReferenceId: input.assetVersion.filmEntityId,
        hostReferenceId: "host-asset-version-golden-a",
        referenceKind: "asset_version",
        contentHash: input.assetVersion.contentHash,
        authorization: {
          decision: "authorized_for_provider_input",
          evidenceId: "golden-a-local-authorization",
          scopeHash: input.assetVersion.contentHash,
        },
      },
    ],
    acceptanceChecklist: [
      "Identity remains stable",
      "Axis and prop interaction remain continuous",
    ],
    preparedAt: "2026-08-28T03:00:00.000Z",
  });

  const candidate = await importManualProviderResult(registry, {
    candidateId: input.candidate.filmEntityId,
    generationPackage,
    expectedTargetVersion: input.shot.version,
    expectedTargetContentHash: input.shot.contentHash,
    expectedInputHash: generationPackage.inputHash,
    providerTaskId: "golden-a-manual-task",
    receipt: {
      receiptId: "golden-a-manual-receipt",
      contentHash: input.outputRepresentation.contentHash,
      capturedAt: "2026-08-28T03:01:00.000Z",
    },
    manualSource: {
      sourceId: "golden-a-local-fixture",
      sourceKind: "local_runtime_export",
      importedBy: "golden-a-human-fixture",
      importedAt: "2026-08-28T03:02:00.000Z",
      authorizationEvidenceId: "golden-a-import-authorization",
    },
    outputs: [
      {
        filmRepresentationId: input.outputRepresentation.filmEntityId,
        hostResourceId: "host-resource-golden-a",
        outputKind: "video",
        contentHash: input.outputRepresentation.contentHash,
        mimeType: "video/mp4",
        bytes: 1024,
      },
    ],
  });

  return {
    prepared: true,
    persisted: false,
    reviewed: false,
    approved: false,
    externalProviderCalls: 0,
    prompt: {
      audit: compiled.audit.status,
      promptDraftId: compiled.promptDraft.ref.film_entity_id,
      promptHash: compiled.hashes.prompt_hash,
      inputHash: compiled.hashes.input_hash,
    },
    canvas: {
      nodeCount: canvas.nodes.length,
      edgeCount: canvas.edges.length,
      sourceVersion: canvas.source.filmCoreVersion,
      sourceHash: canvas.source.contentHash,
    },
    package: {
      id: generationPackage.ref.filmEntityId,
      lifecycle: generationPackage.lifecycle,
      externalSubmission: generationPackage.externalSubmission,
      inputHash: generationPackage.inputHash,
    },
    candidate: {
      id: candidate.ref.filmEntityId,
      status: candidate.status,
      reviewState: candidate.reviewState,
      approvalState: candidate.approvalState,
      contentHash: candidate.ref.contentHash,
    },
  };
}

export async function goldenALocalFixture(): Promise<GoldenALocalInput> {
  const directorText =
    "人物在门口停步，右手握住门把，视线保持在室内目标；镜头不得越过既定轴线。";
  const visualLockText =
    "人物保持画面左侧，门与动作目标保持右侧；服装、道具与视线连续。";
  const hashes = {
    project: "a".repeat(64),
    script: "b".repeat(64),
    director: await sha256Text(directorText),
    shot: "c".repeat(64),
    coverage: "d".repeat(64),
    prompt: "e".repeat(64),
    package: "f".repeat(64),
    attempt: "1".repeat(64),
    candidate: "2".repeat(64),
    visualLock: await sha256Text(visualLockText),
    asset: "3".repeat(64),
    output: "4".repeat(64),
    relation: "5".repeat(64),
  };
  return {
    hostProjectId: "host-project-golden-a",
    hostUnitId: "host-unit-golden-a",
    hostShotId: "host-shot-golden-a",
    project: ref(1, "film_project", 1, hashes.project),
    scriptVersion: ref(2, "script_version", 1, hashes.script),
    directorUnit: ref(3, "director_unit", 1, hashes.director),
    shot: ref(4, "shot", 1, hashes.shot),
    coverageLink: ref(5, "coverage_link", 1, hashes.coverage),
    canvasRelation: ref(6, "canvas_relation", 1, hashes.relation),
    promptDraft: ref(7, "prompt_draft", 1, hashes.prompt),
    generationPackage: ref(8, "generation_package", 1, hashes.package),
    generationAttempt: ref(9, "generation_attempt", 1, hashes.attempt),
    candidate: ref(10, "candidate", 1, hashes.candidate),
    visualLock: ref(11, "visual_lock", 1, hashes.visualLock),
    assetVersion: ref(12, "asset_version", 1, hashes.asset),
    outputRepresentation: ref(13, "representation", 1, hashes.output),
  };
}

function binding(
  reference: GoldenFilmRef,
  kind: FilmHostBinding["hostReferences"][number]["kind"],
  id: string,
): FilmHostBinding {
  return { ...reference, hostReferences: [{ kind, id }] };
}

function ref(
  index: number,
  entityType: string,
  version: number,
  contentHash: string,
): GoldenFilmRef {
  return {
    filmEntityId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    entityType,
    version,
    contentHash,
  };
}

if (import.meta.main) {
  const input = process.argv.includes("--fixture")
    ? await goldenALocalFixture()
    : (JSON.parse(await Bun.stdin.text()) as GoldenALocalInput);
  const result = await runGoldenALocalChain(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
