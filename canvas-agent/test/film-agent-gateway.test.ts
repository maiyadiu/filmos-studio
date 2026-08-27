import assert from "node:assert/strict";
import test from "node:test";

import { MemoryFilmAgentAuditSink } from "../src/film/audit.js";
import { filmToolNames } from "../src/film/contracts.js";
import {
    FilmAgentGateway,
    FilmAgentGatewayError,
    type FilmCanvasObservationSource,
    type FilmCoreTransport,
} from "../src/film/gateway.js";
import { filmAgentGatewayEnabled, normalizeFilmCoreBaseUrl } from "../src/film/http.js";
import { registerFilmAgentMcp } from "../src/film/mcp.js";

const ENTITY_ID = "11111111-1111-4111-8111-111111111111";
const CORE_EVENT_ID = "22222222-2222-4222-8222-222222222222";
const HASH_V1 = "a".repeat(64);
const HASH_V2 = "b".repeat(64);
const CANVAS_HASH = "c".repeat(16);

const entityV1 = {
    ref: {
        film_entity_id: ENTITY_ID,
        entity_type: "film_project_extension",
        version: 1,
        content_hash: HASH_V1,
    },
    host: { host_project_id: "host-project-1" },
    states: {
        creative_stage: "draft",
        execution_state: "not_started",
        review_state: "not_reviewed",
        lock_state: "unlocked",
        delivery_state: "not_ready",
        stale_state: "fresh",
    },
};

const updateCommand = {
    command_type: "entity.set_states",
    target_id: ENTITY_ID,
    expected_version: 1,
    payload: {
        states: {
            ...entityV1.states,
            creative_stage: "authored",
        },
    },
};

class MockTransport implements FilmCoreTransport {
    previewCalls = 0;
    applyCalls = 0;
    entity = structuredClone(entityV1);

    async getProjectContext(hostProjectId: string) {
        return { host_project_id: hostProjectId, film_project: this.entity, content_units: [], shots: [], audit_event_count: 0 };
    }

    async getEntity() {
        return structuredClone(this.entity);
    }

    async getAuditEvents() {
        return [];
    }

    async previewCommand(command: typeof updateCommand & { actor_kind?: string }) {
        this.previewCalls += 1;
        return {
            mode: "preview",
            command_type: command.command_type,
            target_id: command.target_id,
            current_version: command.expected_version,
            resulting_version: command.expected_version + 1,
            content_hash: HASH_V2,
            changes: ["states"],
        };
    }

    async applyCommand(command: typeof updateCommand & { actor_kind?: string }) {
        this.applyCalls += 1;
        this.entity = {
            ...this.entity,
            ref: { ...this.entity.ref, version: 2, content_hash: HASH_V2 },
            states: structuredClone(command.payload.states),
        };
        return {
            mode: "applied",
            entity: structuredClone(this.entity),
            audit_event: {
                event_id: CORE_EVENT_ID,
                actor_kind: command.actor_kind,
                action: command.command_type,
                target_id: ENTITY_ID,
                recorded_at: "2026-08-28T08:00:00.000Z",
            },
        };
    }
}

class MockCanvas implements FilmCanvasObservationSource {
    observation = { revision: 7, stateHash: CANVAS_HASH };

    async current() {
        return { ...this.observation };
    }
}

function fixture() {
    const transport = new MockTransport();
    const canvas = new MockCanvas();
    const audit = new MemoryFilmAgentAuditSink();
    let uuidCounter = 100;
    const gateway = new FilmAgentGateway({
        identity: { actorKind: "codex", actorId: "codex-fixture" },
        transport,
        canvas,
        audit,
        now: () => new Date("2026-08-28T08:00:00.000Z"),
        randomUUID: () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, "0")}`,
    });
    return { gateway, transport, canvas, audit };
}

async function readEntity(gateway: FilmAgentGateway) {
    return await gateway.callTool("film_entity_get", { film_entity_id: ENTITY_ID }) as {
        observation: {
            read_receipt: string;
            expected_version: number;
            expected_content_hash: string;
            expected_canvas_revision: number;
            expected_canvas_state_hash: string;
        };
    };
}

function guardsFrom(read: Awaited<ReturnType<typeof readEntity>>) {
    return {
        read_receipt: read.observation.read_receipt,
        expected_content_hash: read.observation.expected_content_hash,
        expected_canvas_revision: read.observation.expected_canvas_revision,
        expected_canvas_state_hash: read.observation.expected_canvas_state_hash,
    };
}

test("Film Agent gateway is disabled by default and registers an isolated tool set only when enabled", () => {
    assert.equal(filmAgentGatewayEnabled({}), false);
    assert.equal(filmAgentGatewayEnabled({ FILMOS_AGENT_GATEWAY_ENABLED: "true" }), true);
    const names: string[] = [];
    const server = { registerTool(name: string) { names.push(name); } };
    const disabled = registerFilmAgentMcp(server as never, { url: "http://127.0.0.1:17371", token: "fixture" }, { env: {} });
    assert.deepEqual(disabled, { enabled: false, registered: [] });
    assert.deepEqual(names, []);

    const { gateway } = fixture();
    const enabled = registerFilmAgentMcp(server as never, { url: "http://127.0.0.1:17371", token: "fixture" }, { enabled: true, gateway });
    assert.deepEqual(enabled.registered, filmToolNames);
    assert.deepEqual(names, filmToolNames);
});

test("read -> preview -> apply binds Film version/hash and Canvas revision/hash", async () => {
    const { gateway, transport, audit } = fixture();
    const read = await readEntity(gateway);
    const guards = guardsFrom(read);
    assert.equal(read.observation.expected_version, 1);
    assert.equal(read.observation.expected_content_hash, HASH_V1);
    assert.equal(read.observation.expected_canvas_revision, 7);
    assert.equal(read.observation.expected_canvas_state_hash, CANVAS_HASH);

    const preview = await gateway.callTool("film_command_preview", { command: updateCommand, guards }) as { preview_receipt: string };
    assert.equal(transport.previewCalls, 1);
    assert.match(preview.preview_receipt, /^[0-9a-f-]{36}$/);

    const applied = await gateway.callTool("film_command_apply", {
        command: updateCommand,
        guards,
        preview_receipt: preview.preview_receipt,
    }) as { data: Record<string, unknown>; agent_audit: Record<string, unknown> };
    assert.equal(transport.applyCalls, 1);
    assert.equal(applied.data.mode, "applied");
    assert.equal(applied.agent_audit.core_audit_event_id, CORE_EVENT_ID);
    assert.equal(applied.agent_audit.actor_kind, "codex");
    assert.equal(applied.agent_audit.actor_id, "codex-fixture");
    assert.equal(applied.agent_audit.permission_decision, "allow");
    assert.equal(applied.agent_audit.expected_version, 1);
    assert.equal(applied.agent_audit.expected_content_hash, HASH_V1);
    assert.equal(applied.agent_audit.expected_canvas_revision, 7);
    assert.equal(applied.agent_audit.expected_canvas_state_hash, CANVAS_HASH);
    assert.equal(applied.agent_audit.preview_receipt, preview.preview_receipt);
    assert.equal(applied.agent_audit.recorded_at, "2026-08-28T08:00:00.000Z");
    assert.deepEqual(audit.records.map((record) => record.outcome), ["read", "previewed", "dispatched", "applied"]);

    await assert.rejects(
        gateway.callTool("film_command_apply", { command: updateCommand, guards, preview_receipt: preview.preview_receipt }),
        (error: unknown) => error instanceof FilmAgentGatewayError && error.code === "preview_consumed",
    );
    assert.equal(transport.applyCalls, 1, "one Preview receipt cannot dispatch twice");
});

test("Apply without a matching Preview receipt is rejected before Film Core write", async () => {
    const { gateway, transport } = fixture();
    const guards = guardsFrom(await readEntity(gateway));
    await assert.rejects(
        gateway.callTool("film_command_apply", {
            command: updateCommand,
            guards,
            preview_receipt: "99999999-9999-4999-8999-999999999999",
        }),
        (error: unknown) => error instanceof FilmAgentGatewayError && error.code === "preview_required",
    );
    assert.equal(transport.applyCalls, 0);
});

test("stale Canvas revision or stateHash blocks Apply after Preview", async () => {
    const { gateway, transport, canvas } = fixture();
    const guards = guardsFrom(await readEntity(gateway));
    const preview = await gateway.callTool("film_command_preview", { command: updateCommand, guards }) as { preview_receipt: string };
    canvas.observation = { revision: 8, stateHash: "d".repeat(16) };
    await assert.rejects(
        gateway.callTool("film_command_apply", { command: updateCommand, guards, preview_receipt: preview.preview_receipt }),
        (error: unknown) => error instanceof FilmAgentGatewayError && error.code === "canvas_revision_conflict",
    );
    assert.equal(transport.applyCalls, 0);
});

test("a Film entity hash/version change after Preview blocks Apply", async () => {
    const { gateway, transport } = fixture();
    const guards = guardsFrom(await readEntity(gateway));
    const preview = await gateway.callTool("film_command_preview", { command: updateCommand, guards }) as { preview_receipt: string };
    transport.entity = {
        ...transport.entity,
        ref: { ...transport.entity.ref, version: 2, content_hash: "e".repeat(64) },
    };
    await assert.rejects(
        gateway.callTool("film_command_apply", { command: updateCommand, guards, preview_receipt: preview.preview_receipt }),
        (error: unknown) => error instanceof FilmAgentGatewayError && error.code === "film_state_changed",
    );
    assert.equal(transport.applyCalls, 0);
});

test("Preview rejects missing formal guards before transport", async () => {
    const { gateway, transport } = fixture();
    await assert.rejects(gateway.callTool("film_command_preview", { command: updateCommand }));
    assert.equal(transport.previewCalls, 0);
});

test("non-human Agent cannot self-approve or lock a script and the denial is audited", async () => {
    const { gateway, transport, audit } = fixture();
    const guards = guardsFrom(await readEntity(gateway));
    const forbidden = {
        ...updateCommand,
        payload: {
            states: {
                ...entityV1.states,
                creative_stage: "locked",
                review_state: "approved",
                lock_state: "locked",
            },
        },
    };
    await assert.rejects(
        gateway.callTool("film_command_preview", { command: forbidden, guards }),
        (error: unknown) => error instanceof FilmAgentGatewayError && error.code === "human_authority_required",
    );
    assert.equal(transport.previewCalls, 0);
    assert.equal(audit.records.at(-1)?.outcome, "denied");
    assert.equal(audit.records.at(-1)?.permission_decision, "deny");
    assert.equal(audit.records.at(-1)?.error_code, "human_authority_required");
});

test("Human Only may preview a lock but Apply requires explicit human confirmation", async () => {
    const transport = new MockTransport();
    const canvas = new MockCanvas();
    const audit = new MemoryFilmAgentAuditSink();
    let uuidCounter = 300;
    const gateway = new FilmAgentGateway({
        identity: { actorKind: "human", actorId: "reviewer-fixture", mode: "human_only" },
        transport,
        canvas,
        audit,
        now: () => new Date("2026-08-28T08:00:00.000Z"),
        randomUUID: () => `00000000-0000-4000-8000-${String(uuidCounter++).padStart(12, "0")}`,
    });
    const guards = guardsFrom(await readEntity(gateway));
    const command = {
        ...updateCommand,
        payload: { states: { ...entityV1.states, creative_stage: "locked", review_state: "approved", lock_state: "locked" } },
    };
    const preview = await gateway.callTool("film_command_preview", { command, guards }) as { preview_receipt: string };
    await assert.rejects(
        gateway.callTool("film_command_apply", { command, guards, preview_receipt: preview.preview_receipt }),
        (error: unknown) => error instanceof FilmAgentGatewayError && error.code === "human_confirmation_required",
    );
    const result = await gateway.callTool("film_command_apply", {
        command,
        guards,
        preview_receipt: preview.preview_receipt,
        human_confirmation: {
            confirmed_by: "reviewer-fixture",
            confirmed_at: "2026-08-28T08:00:00.000Z",
            reason: "人工验收后锁定",
        },
    }) as { data: { mode: string } };
    assert.equal(result.data.mode, "applied");
    assert.equal(transport.applyCalls, 1);
});

test("Provider and generation commands remain outside Track 08", async () => {
    const { gateway, transport } = fixture();
    const guards = guardsFrom(await readEntity(gateway));
    await assert.rejects(
        gateway.callTool("film_command_preview", {
            command: { ...updateCommand, command_type: "provider.submit" },
            guards,
        }),
        (error: unknown) => error instanceof FilmAgentGatewayError && error.code === "provider_boundary",
    );
    assert.equal(transport.previewCalls, 0);
});

test("Film Core HTTP adapter accepts only an exact local sidecar URL", () => {
    assert.equal(normalizeFilmCoreBaseUrl("http://127.0.0.1:17471/film/"), "http://127.0.0.1:17471/film");
    assert.throws(() => normalizeFilmCoreBaseUrl("https://example.com/film"), /exact loopback/);
    assert.throws(() => normalizeFilmCoreBaseUrl("http://localhost:17471/film"), /exact loopback/);
    assert.throws(() => normalizeFilmCoreBaseUrl("http://127.0.0.1:17471/other"), /path must be \/film/);
});
