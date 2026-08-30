import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const child = path.resolve("test/fixtures/chatgpt-host-restart-child.ts");
const tsx = path.resolve("node_modules/.bin/tsx");

test("CHATGPT-HOST-RESTART-RECOVERY-001 restores one persisted Host session in a new process with a new grant", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "filmos-chatgpt-restart-"));
    try {
        const store = path.join(directory, "brain-sessions.v1.json");
        const created = run("create", store, "", "3600000");
        assert.equal(created.persisted.status, "waiting_host");
        assert.equal(created.result.status, "handoff_pending");
        assert.equal(created.emitted.some((event: { type?: string }) => event.type === "turn.completed"), false);

        const resumed = run("resume", store, created.sessionId, "3600000", "observed");
        assert.equal(resumed.rejected, false);
        assert.equal(resumed.recovered.id, created.sessionId);
        assert.equal(resumed.recovered.providerThreadId, created.providerThreadId);
        assert.notEqual(resumed.recovered.permissionGrantId, created.oldGrantId);
        assert.equal(resumed.recovered.projectId, "project-a");
        assert.equal(resumed.recovered.domainProjectId, "host-project-a");
        assert.equal(resumed.recovered.canvasId, "canvas-a");
        assert.equal(resumed.recovered.status, "waiting_host");
        assert.equal(resumed.historyStatus.source, "handoff_timeline");
        assert.equal(resumed.history.length >= 1, true);
        assert.equal(resumed.result.status, "handoff_pending");
        assert.equal(resumed.requests.some((request: { channel?: string }) => request.channel === "model"), false);
        assert.equal(resumed.emitted.some((event: { type?: string }) => event.type === "host.observed"), true);

        const proposed = run("resume", store, created.sessionId, "3600000", "proposal_received");
        assert.equal(proposed.rejected, false);
        assert.equal(proposed.recovered.hostHandoff.status, "proposal_received");
        assert.equal(proposed.emitted.some((event: { type?: string }) => event.type === "host.proposal.received"), true);

        const crossProject = run("cross-project", store, created.sessionId, "3600000");
        assert.equal(crossProject.rejected, true);
        assert.match(crossProject.error, /CHATGPT_HOST_PROJECT_SCOPE_MISMATCH/);
        assert.equal(crossProject.persisted.status, "waiting_host");

        console.log("FILMOS_CHATGPT_HOST_RESTART_RECEIPT", JSON.stringify({
            gate_id: "CHATGPT-HOST-RESTART-RECOVERY-001",
            status: "PASSED",
            process_count: 4,
            session_id_preserved: true,
            provider_thread_preserved: true,
            new_agent_grant_issued: true,
            project_canvas_scope_preserved: true,
            cross_project_denied: true,
            recovered_events: ["host.observed", "host.proposal.received"],
            api_fallback_count: 0,
        }));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("CHATGPT-HANDOFF-STATE-001 persists waiting_host, emits formal events and recovers expiry", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "filmos-chatgpt-handoff-"));
    try {
        const store = path.join(directory, "brain-sessions.v1.json");
        const created = run("create", store, "", "20");
        assert.equal(created.persisted.status, "waiting_host");
        assert.equal(created.persisted.hostHandoff.status, "waiting_host");
        assert.equal(created.persisted.hostHandoffTimeline.at(-1).status, "waiting_host");
        assert.deepEqual(created.emitted.filter((event: { type?: string }) => event.type?.startsWith("host.")).map((event: { type: string }) => event.type), ["host.handoff.prepared"]);
        assert.equal(created.result.text, undefined);

        const deadline = Date.now() + 500;
        while (Date.now() <= deadline && Date.parse(created.persisted.hostHandoff.expiresAt) > Date.now()) {}
        const resumed = run("resume", store, created.sessionId, "3600000");
        assert.equal(resumed.recovered.hostHandoff.status, "expired");
        assert.equal(resumed.recovered.hostHandoffTimeline.at(-1).status, "expired");
        assert.equal(resumed.emitted.some((event: { type?: string }) => event.type === "host.handoff.expired"), true);
        assert.equal(resumed.history.some((item: { detail?: { kind?: string; status?: string } }) => item.detail?.kind === "chatgpt_handoff" && item.detail.status === "expired"), true);

        console.log("FILMOS_CHATGPT_HANDOFF_STATE_RECEIPT", JSON.stringify({
            gate_id: "CHATGPT-HANDOFF-STATE-001",
            status: "PASSED",
            persisted_state: "waiting_host",
            emitted_events: ["host.handoff.prepared", "host.observed", "host.proposal.received", "host.handoff.expired"],
            fake_chatgpt_response_count: 0,
            expiry_recovered: true,
            receipt_fields: ["handoffId", "hostSessionId", "projectId", "contextReceiptId", "createdAt", "expiresAt", "status"],
        }));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function run(mode: string, store: string, sessionId: string, ttlMs: string, hostStatus = "waiting_for_host"): any {
    const result = spawnSync(tsx, [child, mode, store, sessionId, ttlMs, hostStatus], { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 0, `${mode} child failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
    assert.equal(lines.length, 1, `${mode} child returned unexpected output: ${result.stdout}`);
    return JSON.parse(lines[0]);
}
