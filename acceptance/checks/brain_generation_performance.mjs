#!/usr/bin/env node

import os from "node:os";
import process from "node:process";
import { performance } from "node:perf_hooks";

import {
  AccountScopedCatalogCache,
  resolveExactBrainBinding,
  selectBrainProfile,
} from "../../packages/filmos-generation-contracts/dist/index.js";

const WARM_SAMPLES = 20;
const COLD_SAMPLES = 5;
const MODEL_COUNT = 100;

const bindings = [
  {
    schemaVersion: 1,
    entityVersion: 1,
    profileId: "codex.subscription",
    transport: "codex_app_server",
    authMode: "chatgpt_managed",
    billingMode: "subscription",
    interactionSurface: "native_stream",
    enabled: true,
    requiredCapabilities: ["text", "tool_calling"],
    allowApiFallback: false,
    contentHash: "0".repeat(64),
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  },
  {
    schemaVersion: 1,
    entityVersion: 1,
    profileId: "deepseek.api",
    transport: "model_api",
    authMode: "api_key",
    billingMode: "metered_api",
    interactionSurface: "native_stream",
    enabled: true,
    requiredCapabilities: ["text", "tool_calling"],
    allowApiFallback: false,
    channelId: "channel-deepseek",
    modelId: "deepseek-chat",
    providerKind: "deepseek",
    protocol: "openai_chat_completions",
    modelCapabilityEvidence: {
      text: true,
      toolCalling: true,
      structuredOutput: true,
      evidenceSource: "performance-fixture",
      evidenceRevision: "v2.4",
    },
    contentHash: "1".repeat(64),
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  },
];

const models = Array.from({ length: MODEL_COUNT }, (_, index) => ({
  descriptorId: `model-${String(index).padStart(3, "0")}`,
  displayName: index % 7 === 0 ? `portrait native ${index}` : `model ${index}`,
  capability: index % 2 === 0 ? "image" : "video",
}));

const snapshot = {
  catalogSnapshotId: "catalog-performance",
  engineId: "dreamina_cli",
  connectionId: "dreamina-local",
  connectionInstanceRef: "instance-performance",
  sourceKind: "verified_static_version_bound",
  catalogVersion: "performance-v1",
  catalogObservedAt: "2026-08-30T00:00:00.000Z",
  catalogValidUntil: "2099-01-01T00:00:00.000Z",
  descriptors: models.map((model) => ({
    descriptorId: model.descriptorId,
    descriptorKind: "model",
    displayName: model.displayName,
    capability: model.capability,
    descriptorBlob: { descriptorId: model.descriptorId, capability: model.capability },
  })),
  semanticHash: "2".repeat(64),
  contentHash: "3".repeat(64),
};

function percentile(samples, value) {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((value / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(samples) {
  return {
    samples: samples.length,
    p50_ms: Number(percentile(samples, 50).toFixed(3)),
    p95_ms: Number(percentile(samples, 95).toFixed(3)),
    max_ms: Number(Math.max(...samples).toFixed(3)),
  };
}

function sample(iterations, operation) {
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    operation(index);
    values.push(performance.now() - started);
  }
  return values;
}

function coldCacheLookup() {
  const cache = new AccountScopedCatalogCache(16);
  cache.put(snapshot);
  return cache.get(snapshot, "2026-08-30T00:00:01.000Z");
}

function warmCacheLookup(cache) {
  return cache.get(snapshot, "2026-08-30T00:00:01.000Z");
}

function searchModels(query) {
  const normalized = query.trim().toLowerCase();
  return models.filter((model) => `${model.displayName}\0${model.descriptorId}`.toLowerCase().includes(normalized));
}

function composeCachedDraft(cache) {
  const catalog = warmCacheLookup(cache);
  const selected = catalog.descriptors.find((descriptor) => descriptor.descriptorId === "model-014");
  if (!selected) throw new Error("PERFORMANCE_DESCRIPTOR_MISSING");
  return Object.freeze({
    taskKind: selected.capability,
    engineId: catalog.engineId,
    connectionId: catalog.connectionId,
    descriptorId: selected.descriptorId,
    aspectRatio: "9:16",
    nativeSize: true,
    previewOnly: true,
  });
}

// Required warm-up is deliberately excluded from the samples.
selectBrainProfile({ explicitProfileId: "codex.subscription" });
resolveExactBrainBinding({ profileId: "deepseek.api", bindings });
searchModels("portrait");
const warmCache = new AccountScopedCatalogCache(16);
warmCache.put(snapshot);
warmCacheLookup(warmCache);
composeCachedDraft(warmCache);

const warm = {
  brain_selector: summarize(sample(WARM_SAMPLES, (index) => {
    const profileId = index % 2 ? "deepseek.api" : "codex.subscription";
    selectBrainProfile({ explicitProfileId: profileId });
    resolveExactBrainBinding({ profileId, bindings });
  })),
  cached_model_selector: summarize(sample(WARM_SAMPLES, () => warmCacheLookup(warmCache))),
  composer_cached_open: summarize(sample(WARM_SAMPLES, () => composeCachedDraft(warmCache))),
  model_search_100: summarize(sample(WARM_SAMPLES, () => searchModels("portrait"))),
};

const cold = {
  brain_selector: summarize(sample(COLD_SAMPLES, (index) => {
    const profileId = index % 2 ? "deepseek.api" : "codex.subscription";
    selectBrainProfile({ explicitProfileId: profileId });
    resolveExactBrainBinding({ profileId, bindings: structuredClone(bindings) });
  })),
  cached_model_selector: summarize(sample(COLD_SAMPLES, () => coldCacheLookup())),
  composer_cached_open: summarize(sample(COLD_SAMPLES, () => {
    const cache = new AccountScopedCatalogCache(16);
    cache.put(structuredClone(snapshot));
    return composeCachedDraft(cache);
  })),
  model_search_100: summarize(sample(COLD_SAMPLES, () => searchModels("portrait"))),
};

const targets = {
  brain_selector: 150,
  cached_model_selector: 200,
  composer_cached_open: 300,
  model_search_100: 200,
};

const gates = Object.fromEntries(Object.entries(targets).map(([key, target]) => [key, {
  target_warm_p95_ms: target,
  observed_warm_p95_ms: warm[key].p95_ms,
  status: warm[key].p95_ms <= target ? "PASSED" : "FAILED",
}]));
const status = Object.values(gates).every((gate) => gate.status === "PASSED") ? "PASSED" : "FAILED";

const payload = {
  schema_version: "1.0.0",
  golden_id: "BRAIN-GENERATION-PERFORMANCE-001",
  status,
  scope: "deterministic_local_selector_and_cached_composer_contract_runtime",
  exclusions: ["react_paint", "network", "catalog_refresh", "provider_latency"],
  environment: {
    hardware: `${os.arch()} ${os.cpus()[0]?.model || "unknown"}`,
    os: `${os.platform()} ${os.release()}`,
    app_build: "filmos-candidate-v2.4",
    commit: process.env.GITHUB_SHA || "CURRENT_HEAD_BOUND_BY_ACCEPTANCE_RECEIPT",
    dataset: "synthetic-non-sensitive-generation-catalog-v1",
    node_count: 1,
    catalog_size: MODEL_COUNT,
    cache_state: "warm_and_recreated_cold",
    warm_sample_count: WARM_SAMPLES,
    cold_sample_count: COLD_SAMPLES,
    node_version: process.version,
  },
  warm,
  cold,
  gates,
  external_cost_microunits: "0",
};

console.log(JSON.stringify(payload));
if (status !== "PASSED") process.exitCode = 1;
