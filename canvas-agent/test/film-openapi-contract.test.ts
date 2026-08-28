import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  filmActorKindSchema,
  filmCommandSchema,
  filmToolInputSchemas,
  filmToolNames,
} from "../src/film/contracts.js";
import {
  filmActorKindsFromOpenApi,
  filmCommandTypesFromOpenApi,
  filmMcpOpenApiContract,
  filmToolNamesFromOpenApi,
} from "../src/film/generated/openapi-contract.js";

const canvasAgentRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const openApiPath = path.resolve(canvasAgentRoot, "../film-contracts/openapi.json");
const syncScript = path.resolve(
  canvasAgentRoot,
  "scripts/sync-film-openapi.mjs",
);

test("generated Film MCP contract is current with the authoritative OpenAPI", () => {
  execFileSync(process.execPath, [syncScript, "--check"], {
    cwd: canvasAgentRoot,
    stdio: "pipe",
  });
  assert.deepEqual(filmToolNames, filmToolNamesFromOpenApi);
  assert.deepEqual(Object.keys(filmToolInputSchemas), [...filmToolNames]);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(filmMcpOpenApiContract.tools).map(([name, value]) => [
        name,
        value.operation_id,
      ]),
    ),
    {
      film_project_get_context: "filmProjectContextGet",
      film_entity_get: "filmEntityGet",
      film_audit_events_get: "filmAuditEventsGet",
      film_command_preview: "filmCommandPreview",
      film_command_apply: "filmCommandApply",
    },
  );
  assert.equal(
    Object.values(filmMcpOpenApiContract.tools).every(
      (operation) => operation.implementation_state === "implemented",
    ),
    true,
  );
});

test("ActorKind and implemented command types come from the generated OpenAPI projection", () => {
  assert.deepEqual(filmActorKindSchema.options, [...filmActorKindsFromOpenApi]);
  for (const actorKind of filmActorKindsFromOpenApi) {
    assert.equal(filmActorKindSchema.parse(actorKind), actorKind);
  }
  assert.equal(filmActorKindSchema.safeParse("provider").success, false);
  assert.deepEqual(filmCommandTypesFromOpenApi, [
    "entity.create",
    "entity.set_states",
  ]);
  assert.equal(
    filmCommandSchema.safeParse({
      command_type: filmCommandTypesFromOpenApi[0],
      target_id: null,
      expected_version: 0,
      actor_kind: "codex",
      payload: {},
    }).success,
    true,
  );
  assert.equal(
    filmCommandSchema.safeParse({
      command_type: filmCommandTypesFromOpenApi[1],
      target_id: "11111111-1111-4111-8111-111111111111",
      expected_version: 1,
      actor_kind: "codex",
      payload: {},
    }).success,
    true,
  );
  assert.equal(
    filmCommandSchema.safeParse({
      command_type: "provider.submit",
      target_id: null,
      expected_version: 0,
      payload: {},
    }).success,
    false,
  );
});

test("MCP parameter schemas are equal to or stricter than the mapped OpenAPI parameters", () => {
  const projectOperation =
    filmMcpOpenApiContract.tools.film_project_get_context;
  assert.deepEqual(projectOperation.parameters, [
    {
      mcp_name: "host_project_id",
      openapi_name: "hostProjectId",
      in: "path",
      required: true,
      schema: { type: "string" },
    },
  ]);
  assert.equal(
    filmToolInputSchemas.film_project_get_context.safeParse({
      host_project_id: "host-project-opaque-1",
    }).success,
    true,
  );
  assert.equal(
    filmToolInputSchemas.film_project_get_context.safeParse({
      host_project_id: "/tmp/project.json",
    }).success,
    false,
    "MCP deliberately tightens the OpenAPI string to an opaque Host id",
  );
  assert.equal(
    filmToolInputSchemas.film_entity_get.safeParse({
      film_entity_id: "not-a-uuid",
    }).success,
    false,
  );
  assert.equal(
    filmToolInputSchemas.film_audit_events_get.safeParse({ limit: 1 }).success,
    true,
  );
  assert.equal(
    filmToolInputSchemas.film_audit_events_get.safeParse({ limit: 501 })
      .success,
    false,
  );
});

test("the sync gate fails closed when a required operation mapping drifts", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "filmos-openapi-gate-"),
  );
  try {
    const drifted = JSON.parse(fs.readFileSync(openApiPath, "utf8"));
    drifted.paths["/commands/apply"].post.operationId =
      "filmCommandApplyDrifted";
    const driftedPath = path.join(temporaryRoot, "openapi.json");
    fs.writeFileSync(driftedPath, JSON.stringify(drifted));
    assert.throws(
      () =>
        execFileSync(process.execPath, [syncScript, "--check"], {
          cwd: canvasAgentRoot,
          env: { ...process.env, FILMOS_OPENAPI_PATH: driftedPath },
          stdio: "pipe",
        }),
      /Command failed/,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
