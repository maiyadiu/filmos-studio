import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyBudgetLedgerEvent,
  AccountScopedCatalogCache,
  canonicalSignedMicrounitsDelta,
  canonicalUnsignedMicrounits,
  createBudgetLedgerEvent,
  createCatalogValidationReceipt,
  compilePrompt,
  createAuthorizedGenerationSubmission,
  createProviderInputAuthorizationSnapshot,
  createGenerationRouteSnapshot,
  createInlineDescriptorReceipt,
  createPseudonymousBindingRef,
  createRedactionReceipt,
  decideLocalConfigMigration,
  exactSelectedDescriptors,
  hashEnvelope,
  resolveExactBrainBinding,
  verifyGenerationRouteSnapshot,
  verifyRedactedProjection,
  assertExecutionGuards,
  assertProjectGenerationLock,
  assertProjectGenerationPolicy,
  hashProjectGenerationLock,
  hashProjectGenerationPolicy,
} from "../dist/index.js";

const at = "2026-08-30T00:00:00.000Z";
const later = "2026-08-30T00:05:00.000Z";
const validUntil = "2026-08-30T01:00:00.000Z";
const account = "filmos_acct_11111111-1111-4111-8111-111111111111";
const instance = "filmos_instance_22222222-2222-4222-8222-222222222222";

test("canonical microunit lexical form rejects floats, plus, exponent, negative zero and leading zero", () => {
  for (const value of ["0", "1", "999999999999999999999"]) assert.equal(canonicalUnsignedMicrounits(value), value);
  for (const value of ["0", "1", "-1"]) assert.equal(canonicalSignedMicrounitsDelta(value), value);
  for (const value of ["00", "01", "+1", "-1", "-0", "1.0", "1e6", " 1"]) assert.throws(() => canonicalUnsignedMicrounits(value));
  for (const value of ["00", "01", "+1", "-0", "-01", "1.0", "1e6", " 1"]) assert.throws(() => canonicalSignedMicrounitsDelta(value));
});

test("brain binding is exact and does not fall back across profiles", () => {
  const base = { schemaVersion: 1, entityVersion: 1, contentHash: "h", createdAt: at, updatedAt: at, enabled: true, requiredCapabilities: ["text", "tool_calling"], transport: "model_api", authMode: "api_key", billingMode: "metered_api", interactionSurface: "native_stream", allowApiFallback: false };
  const bindings = [
    { ...base, profileId: "openai.api", channelId: "openai-primary", modelId: "gpt-exact" },
    { ...base, profileId: "deepseek.api", channelId: "deepseek-primary", modelId: "deepseek-exact" },
  ];
  assert.deepEqual(resolveExactBrainBinding({ profileId: "deepseek.api", bindings }), { profileId: "deepseek.api", channelId: "deepseek-primary", modelId: "deepseek-exact", transport: "model_api", billingMode: "metered_api" });
  assert.throws(() => resolveExactBrainBinding({ profileId: "anthropic.api", bindings }), /NEEDS_CONFIGURATION/);
});

function catalog() {
  return {
    schemaVersion: 1, snapshotId: "catalog-1", contentHash: "catalog-hash", observedAt: at,
    engineId: "dreamina_cli", connectionId: "dreamina-local", authScope: "account",
    accountBindingRef: account, connectionInstanceRef: instance, catalogRevision: "r1", catalogValidUntil: validUntil,
    evidence: { source: "runtime_discovery", runtimeVersion: "1.2.3", sourceLocatorId: "opaque-source", observedAt: at },
    models: [{ schemaVersion: 1, engineId: "dreamina_cli", connectionId: "dreamina-local", modelId: "dreamina_cli::image-v1", providerModelId: "image-v1", displayName: "Image V1", capability: "image", operations: ["text_to_image"], parameterSchema: { type: "object" }, constraints: {}, billing: { mode: "credits", estimateAvailable: true, currencyOrUnit: "credits" }, availability: "available", descriptorHash: "descriptor-hash", parameterSchemaHash: "schema-hash" }],
    workflows: [], skills: [],
  };
}

test("descriptor exact selection and catalog validation bind one immutable blob", async () => {
  const source = catalog();
  const selected = exactSelectedDescriptors(source, [{ descriptorKind: "model", descriptorId: "dreamina_cli::image-v1" }]);
  assert.throws(() => exactSelectedDescriptors(source, [{ descriptorKind: "model", descriptorId: "Image V1" }]), /NOT_FOUND/);
  const receipt = await createInlineDescriptorReceipt({ descriptorReceiptId: "descriptor-receipt-1", selected, catalog: source, createdAt: at });
  const route = await routeFor(receipt);
  const validation = await createCatalogValidationReceipt({ id: "catalog-validation-1", descriptorReceipt: receipt, route, catalog: source, validationMode: "runtime_revalidation", validatedAt: at, submitNotAfter: later });
  assert.equal(validation.result, "valid");
  assert.equal(validation.selectedDescriptorRefs[0].descriptorId, "dreamina_cli::image-v1");
  await assert.rejects(createCatalogValidationReceipt({ id: "bad", descriptorReceipt: receipt, route, catalog: { ...source, accountBindingRef: createPseudonymousBindingRef("acct") }, validationMode: "runtime_revalidation", validatedAt: at, submitNotAfter: later }), /BINDING_MISMATCH/);
});

async function routeFor(receipt) {
  return createGenerationRouteSnapshot({ schemaVersion: 1, routeSnapshotId: "route-1", generationAttemptId: "attempt-1", engineId: receipt.engineId, connectionId: receipt.connectionId, accountBindingRef: receipt.accountBindingRef, connectionInstanceRef: receipt.connectionInstanceRef, capability: "image", taskKind: "text_to_image", descriptorReceiptId: receipt.descriptorReceiptId, descriptorReceiptContentHash: receipt.contentHash, descriptorSemanticHash: receipt.descriptorSemanticHash, modelId: "dreamina_cli::image-v1", normalizedParameters: { width: 1024, height: 1024 }, parameterHash: "parameter-hash", references: [], referenceHash: "reference-hash", promptDraftVersion: 1, promptDraftContentHash: "prompt-hash", compiledPromptSemanticHash: "compiled-semantic", compiledPromptTextHash: "compiled-text", compilerVersion: "compiler-v1", templateVersion: "template-v1", userConfigRevision: "config-r1", projectPolicyVersion: 1, projectPolicyHash: "policy-hash", nodeDraftVersion: 1, selectionSource: "explicit_task", resolvedAt: at, createdAt: at });
}

test("semantic hash is stable while envelope hash detects metadata tampering", async () => {
  const selected = exactSelectedDescriptors(catalog(), [{ descriptorKind: "model", descriptorId: "dreamina_cli::image-v1" }]);
  const receipt = await createInlineDescriptorReceipt({ descriptorReceiptId: "descriptor-receipt-1", selected, catalog: catalog(), createdAt: at });
  const route = await routeFor(receipt);
  await verifyGenerationRouteSnapshot(route);
  await assert.rejects(verifyGenerationRouteSnapshot({ ...route, createdAt: later }), /TAMPERED/);
  const moved = await routeFor({ ...receipt, descriptorReceiptId: "new-envelope-id" });
  assert.equal(moved.routeContentHash, route.routeContentHash);
  assert.notEqual(moved.contentHash, route.contentHash);
});

test("redaction receipt binds separate source and redacted hashes without alias mapping", async () => {
  const result = await createRedactionReceipt({ redactionReceiptId: "redaction-1", sourceObjectType: "BudgetLedger", sourceContentHash: "source-hash", redactedObjectType: "BudgetLedgerProjection", redactedProjection: { accountBindingRef: "pkg-A1" }, aliasScopeId: "scope-1", redactionPolicyVersion: "v1", redactedFieldPaths: ["accountBindingRef"], sourceCommit: "a".repeat(40), sourceRunId: "run-1", sourceArtifactId: "artifact-1", createdAt: at });
  assert.notEqual(result.receipt.sourceContentHash, result.redactedProjection.redactedContentHash);
  await verifyRedactedProjection(result.redactedProjection);
  await assert.rejects(verifyRedactedProjection({ ...result.redactedProjection, accountBindingRef: "pkg-A2" }), /TAMPERED/);
  await assert.rejects(createRedactionReceipt({ redactionReceiptId: "bad", sourceObjectType: "x", sourceContentHash: "h", redactedObjectType: "y", redactedProjection: { aliasMapping: {} }, aliasScopeId: "s", redactionPolicyVersion: "v1", redactedFieldPaths: [], sourceCommit: "a", sourceRunId: "r", sourceArtifactId: "a", createdAt: at }), /ALIAS_MAPPING_FORBIDDEN/);
});

test("budget events close rotation and revocation and never allow negative totals", async () => {
  const ledger = { schemaVersion: 1, entityVersion: 1, contentHash: "ledger-hash", createdAt: at, updatedAt: at, ledgerId: "ledger-1", grantId: "grant-1", projectId: "project-1", engineId: "dreamina_cli", accountBindingRef: account, connectionInstanceRef: instance, costUnit: "credits", reservedTasks: 0, reservedCostMicrounits: "0", consumedTasks: 0, consumedCostMicrounits: "0", openReservationIds: [], lastEventSequence: 0, status: "active" };
  const reserved = await createBudgetLedgerEvent({ schemaVersion: 1, eventId: "event-1", ledgerId: ledger.ledgerId, grantId: ledger.grantId, accountBindingRef: account, connectionInstanceRef: instance, sequence: 1, eventType: "reserved", reservationId: "reservation-1", generationAttemptId: "attempt-1", costUnit: "credits", effects: { reservedTasksDelta: 1, reservedCostMicrounitsDelta: "1000000", consumedTasksDelta: 0, consumedCostMicrounitsDelta: "0" }, reasonCode: "authorized", occurredAt: at, idempotencyKey: "idem-1", createdAt: at });
  const next = await applyBudgetLedgerEvent(ledger, reserved);
  assert.equal(next.reservedCostMicrounits, "1000000");
  const rotated = await createBudgetLedgerEvent({ schemaVersion: 1, eventId: "event-2", ledgerId: ledger.ledgerId, grantId: ledger.grantId, accountBindingRef: account, connectionInstanceRef: instance, sequence: 2, eventType: "binding_rotated", bindingTransition: { previousAccountBindingRef: account, previousConnectionInstanceRef: instance, nextConnectionInstanceRef: createPseudonymousBindingRef("instance") }, costUnit: "credits", effects: { reservedTasksDelta: 0, reservedCostMicrounitsDelta: "0", consumedTasksDelta: 0, consumedCostMicrounitsDelta: "0" }, reasonCode: "account_changed", occurredAt: later, idempotencyKey: "idem-2", createdAt: later });
  assert.equal((await applyBudgetLedgerEvent(next, rotated)).status, "binding_rotated");
  await assert.rejects(createBudgetLedgerEvent({ ...rotated, eventId: "bad", eventType: "revoked", effects: { ...rotated.effects, reservedCostMicrounitsDelta: "-1" } }), /EFFECTS_MUST_BE_ZERO/);
});

test("no-login migration auto-migrates only unique reversible mappings", () => {
  assert.equal(decideLocalConfigMigration({ sourceExists: true, targetExists: false, uniqueMapping: true }).result, "MIGRATED_AUTOMATICALLY");
  assert.equal(decideLocalConfigMigration({ sourceExists: true, targetExists: false, uniqueMapping: false }).result, "SKIPPED_NEEDS_CONFIGURATION");
  assert.equal(decideLocalConfigMigration({ sourceExists: true, targetExists: true, uniqueMapping: true, equivalent: false }).result, "BLOCKED_MIGRATION_CONFLICT");
});

test("catalog cache is bounded, account scoped, expires and purges on account switch", () => {
  const cache = new AccountScopedCatalogCache(2);
  const first = catalog();
  cache.put(first);
  assert.equal(cache.get(first, at)?.snapshotId, "catalog-1");
  assert.equal(cache.get(first, "2026-08-30T02:00:00.000Z"), undefined);
  cache.put(first);
  cache.put({ ...first, snapshotId: "catalog-2", connectionId: "other", contentHash: "other-hash" });
  cache.purgeConnection(first.connectionId);
  assert.equal(cache.get(first, at), undefined);
  assert.equal(cache.size, 1);
});

test("prompt compiler versions final text and refuses unsupported stale intent", async () => {
  const intent = { subject: ["hero"], identityLocks: ["same face"], action: ["walks"], environment: ["street"], sceneLayout: [], camera: ["wide shot"], lens: [], composition: [], lighting: [], color: [], continuity: [], negativeConstraints: ["no watermark"], deliveryRequirements: ["9:16"] };
  const receipt = await compilePrompt({ id: "prompt-receipt-1", intent, engineId: "dreamina_cli", modelId: "dreamina_cli::image-v1", taskKind: "text_to_image", templateVersion: "tpl-v1", compilerVersion: "compiler-v1", parameterSchema: { type: "object" }, supportsNegativePrompt: false, createdAt: at });
  assert.match(receipt.text, /hero/);
  assert.equal(receipt.negativeText, undefined);
  assert.notEqual(receipt.compiledPromptSemanticHash, receipt.contentHash);
});

test("provider authorization requires broker evidence and authorized submission binds guards", async () => {
  const authorization = await createProviderInputAuthorizationSnapshot({ schemaVersion: 1, authorizationSnapshotId: "auth-1", routeSnapshotId: "route-1", routeSnapshotContentHash: "route-envelope", routeContentHash: "route-semantic", engineId: "dreamina_cli", connectionId: "dreamina-local", accountBindingRef: account, connectionInstanceRef: instance, grants: [{ bindingId: "binding-1", assetVersionId: "asset-version-1", assetVersionContentHash: "asset-hash", permission: "provider_local_read", destinationScope: "filmos_destination_1", authorizedAt: at }], authorizationEvidence: { confirmationId: "confirmation-1", brokerGrantId: "grant-1", brokerGrantContentHash: "grant-hash", brokerDecisionReceiptId: "decision-1", brokerDecisionReceiptContentHash: "decision-hash", toolRequestId: "request-1", authorizedByActorRef: "actor-1", confirmedAt: at }, createdAt: at });
  const guards = { primaryTarget: { guardKind: "canvas_state", canvasId: "canvas-1", nodeId: "node-1", expectedRevision: 3, expectedStateHash: "canvas-hash" }, promptDraft: { guardKind: "versioned_entity", entityType: "prompt_draft", entityId: "prompt-1", expectedVersion: 1, expectedContentHash: "prompt-hash" }, projectPolicy: { guardKind: "versioned_entity", entityType: "project_generation_policy", entityId: "policy-1", expectedVersion: 1, expectedContentHash: "policy-hash" }, engineConnection: { guardKind: "versioned_entity", entityType: "generation_engine_connection", entityId: "connection-1", expectedVersion: 1, expectedContentHash: "connection-hash" }, dependencies: [] };
  const authorized = await createAuthorizedGenerationSubmission({ schemaVersion: 1, authorizedSubmissionId: "authorized-1", generationAttemptId: "attempt-1", routeSnapshotId: "route-1", routeSnapshotContentHash: "route-envelope", routeContentHash: "route-semantic", descriptorReceiptId: "descriptor-1", descriptorReceiptContentHash: "descriptor-envelope", catalogValidationReceiptId: "validation-1", catalogValidationReceiptContentHash: "validation-envelope", catalogValidationSemanticHash: "validation-semantic", catalogValidationSubmitNotAfter: later, providerInputAuthorizationSnapshotId: authorization.authorizationSnapshotId, providerInputAuthorizationContentHash: authorization.contentHash, authorizationScopeHash: authorization.authorizationScopeHash, proposalId: "proposal-1", proposalHash: "proposal-hash", confirmationId: "confirmation-1", brokerGrantId: "grant-1", brokerGrantContentHash: "grant-hash", brokerDecisionReceiptId: "decision-1", brokerDecisionReceiptContentHash: "decision-hash", confirmedByActorRef: "actor-1", confirmedAt: at, accountBindingRef: account, connectionInstanceRef: instance, executionGuards: guards, providerOperation: "image.generate", createdAt: at });
  assert.notEqual(authorized.authorizedSubmissionSemanticHash, authorized.contentHash);
  assert.match(authorized.idempotencyKey, /^[0-9a-f]{64}$/);
  const current = new Map([["canvas_state:canvas-1:node-1", { version: 3, contentHash: "canvas-hash" }], ["versioned_entity:prompt_draft:prompt-1", { version: 1, contentHash: "prompt-hash" }], ["versioned_entity:project_generation_policy:policy-1", { version: 1, contentHash: "policy-hash" }], ["versioned_entity:generation_engine_connection:connection-1", { version: 1, contentHash: "connection-hash" }]]);
  assert.doesNotThrow(() => assertExecutionGuards(current, guards));
  current.set("canvas_state:canvas-1:node-1", { version: 4, contentHash: "changed" });
  assert.throws(() => assertExecutionGuards(current, guards), /STALE/);
});

test("project policy and strict model lock fail closed without silent engine or model upgrades", async () => {
  const selected = exactSelectedDescriptors(catalog(), [{ descriptorKind: "model", descriptorId: "dreamina_cli::image-v1" }]);
  const receipt = await createInlineDescriptorReceipt({ descriptorReceiptId: "descriptor-receipt-lock", selected, catalog: catalog(), createdAt: at });
  const route = await routeFor(receipt);
  const policyBase = { schemaVersion: 1, entityVersion: 1, createdAt: at, updatedAt: at, projectId: "project-1", allowedEngineIds: ["dreamina_cli"], defaultRoutes: { text_to_image: { engineId: "dreamina_cli", connectionId: "dreamina-local", modelId: "dreamina_cli::image-v1" } }, externalProjectBindings: {}, uploadPolicy: { allowProviderUpload: false, requirePerSubmitPreview: true } };
  const policy = { ...policyBase, contentHash: await hashProjectGenerationPolicy(policyBase) };
  assert.doesNotThrow(() => assertProjectGenerationPolicy(policy, route));
  assert.throws(() => assertProjectGenerationPolicy(policy, { ...route, engineId: "flova_cli" }), /NOT_ALLOWED/);
  const lockBase = { schemaVersion: 1, entityVersion: 1, createdAt: at, updatedAt: at, projectId: "project-1", taskLocks: { text_to_image: { engineId: "dreamina_cli", connectionId: "dreamina-local", modelId: "dreamina_cli::image-v1", providerModelId: "image-v1", modelVersion: "1", modelDescriptorHash: "descriptor-hash", catalogRevision: "r1", enforcement: "strict" } } };
  const lock = { ...lockBase, contentHash: await hashProjectGenerationLock(lockBase) };
  assert.deepEqual(assertProjectGenerationLock(lock, "text_to_image", route, receipt.payload.selectedDescriptors.map(({ descriptor, ...ref }) => ref), { providerModelId: "image-v1", modelVersion: "1", catalogRevision: "r1" }), { enforcement: "strict", warnings: [] });
  assert.throws(() => assertProjectGenerationLock(lock, "text_to_image", { ...route, modelId: "dreamina_cli::image-v2" }, receipt.payload.selectedDescriptors.map(({ descriptor, ...ref }) => ref), { providerModelId: "image-v2", modelVersion: "2", catalogRevision: "r2" }), /LOCKED_MODEL_UNAVAILABLE/);
});
