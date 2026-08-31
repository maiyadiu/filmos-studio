import assert from "node:assert/strict";
import test from "node:test";

import { ReviewCodexCoordinator, type ReviewBusCoordinatorPort } from "../src/brains/review-codex-coordinator.js";

function fixture(state: string, full: Record<string, unknown>, output: Record<string, unknown>) {
    const posts: Array<{ action: string; body: Record<string, unknown> }> = [];
    const bus: ReviewBusCoordinatorPort = {
        async pendingAll() { return [{ issue_id: "FILMOS-ISSUE-test", project_id: "project-1", state, coordination_key: `key-${state}` }]; },
        async pending(projectId) { return projectId === "project-1" ? [{ issue_id: "FILMOS-ISSUE-test", project_id: "project-1", state, coordination_key: `key-${state}` }] : []; },
        async fullContext() { return { state, ...full }; },
        async post(_issueId, action, body) { posts.push({ action, body }); return {}; },
    };
    let runs = 0;
    let ensuredWorkspace = "";
    const coordinator = new ReviewCodexCoordinator(bus, {
        async ensure(input) { ensuredWorkspace = input.workspacePath; return { id: "brain-session-1" } as any; },
        async run(_sessionId, prompt) {
            runs += 1;
            assert.match(prompt, /codex app-server/);
            assert.match(prompt, /Do not perform paid generation/);
            assert.match(prompt, /isolated worktree/);
            assert.match(prompt, /codex\/review-filmos-issue-test/);
            return JSON.stringify(output);
        },
    }, {
        async prepare(issueId, baseCommit) {
            assert.equal(issueId, "FILMOS-ISSUE-test");
            return { workspacePath: "/tmp/filmos-review-worktree", branch: "codex/review-filmos-issue-test", baseCommit };
        },
    }, () => ({ projectId: "project-1", canvasId: "canvas-1" }));
    return { coordinator, posts, runs: () => runs, ensuredWorkspace: () => ensuredWorkspace };
}

test("EVIDENCE_FROZEN creates a real Codex subscription assessment writeback", async () => {
    const assessment = { reproduced: true, root_cause: "stale host", call_chain: ["ui", "host"], files: ["web/agent.tsx"], minimal_change: ["refresh"], regression_risk: "low", tests: ["host test"], rollback: ["revert"] };
    const value = fixture("EVIDENCE_FROZEN", { evidence: { local_items: [{ kind: "logs" }] } }, assessment);
    await value.coordinator.tick();
    assert.equal(value.runs(), 1);
    assert.deepEqual(value.posts.map((item) => item.action), ["codex-coordination", "assessments/codex"]);
    assert.deepEqual(value.posts[1].body, assessment);
    assert.equal(value.ensuredWorkspace(), "/tmp/filmos-review-worktree");
});

test("CHANGES_REQUIRED writes FindingResponses, advances the round, then submits Candidate B", async () => {
    const response = { finding_id: "finding-1", disposition: "FIXED_WITH_EVIDENCE", evidence: ["test.log"] };
    const candidate = { candidate_id: "candidate-B" };
    const value = fixture("CHANGES_REQUIRED", { lane: "core", consensus_record: { contentHash: "c" }, issue_task_package: { contentHash: "t" }, findings: [{ finding_id: "finding-1" }] }, { finding_responses: [response], candidate });
    await value.coordinator.tick();
    assert.deepEqual(value.posts.map((item) => item.action), ["codex-coordination", "finding-responses", "rounds/next", "candidates"]);
    assert.deepEqual(value.posts.at(-1)?.body, candidate);
});

test("OWNER_DECISION_REQUIRED stops before creating or resuming any Codex session", async () => {
    const value = fixture("OWNER_DECISION_REQUIRED", {}, {});
    await value.coordinator.tick();
    assert.equal(value.runs(), 0);
    assert.equal(value.posts[0].action, "codex-coordination");
    assert.equal(value.posts[0].body.status, "STOPPED_OWNER_GATE");
});

test("global governance feedback is discovered and coordinated once", async () => {
    const posts: Array<{ action: string; body: Record<string, unknown> }> = [];
    const bus: ReviewBusCoordinatorPort = {
        async pendingAll() { return [{ issue_id: "FILMOS-ISSUE-global", project_id: "filmos-governance-global", state: "EVIDENCE_FROZEN", coordination_key: "global-key" }]; },
        async pending(projectId) {
            return projectId === "filmos-governance-global"
                ? [{ issue_id: "FILMOS-ISSUE-global", project_id: projectId, state: "EVIDENCE_FROZEN", coordination_key: "global-key" }]
                : [];
        },
        async fullContext() { return { state: "EVIDENCE_FROZEN", evidence: { local_items: [{ kind: "logs" }] } }; },
        async post(_issueId, action, body) { posts.push({ action, body }); return {}; },
    };
    let runs = 0;
    const coordinator = new ReviewCodexCoordinator(bus, {
        async ensure() { return { id: "brain-session-global" } as any; },
        async run() {
            runs += 1;
            return JSON.stringify({ reproduced: true, root_cause: "global issue", call_chain: ["feedback"], files: ["web/feedback.tsx"], minimal_change: ["repair"], regression_risk: "low", tests: ["test"], rollback: ["revert"] });
        },
    }, {
        async prepare(_issueId, baseCommit) { return { workspacePath: "/tmp/filmos-review-global", branch: "codex/review-filmos-issue-global", baseCommit }; },
    }, () => ({ projectId: "project-1", canvasId: "canvas-1" }));
    await coordinator.tick();
    await coordinator.tick();
    assert.equal(runs, 1);
    assert.deepEqual(posts.map((item) => item.action), ["codex-coordination", "assessments/codex"]);
});

test("project feedback is coordinated without an active canvas", async () => {
    const posts: Array<{ action: string; body: Record<string, unknown> }> = [];
    let ensuredCanvasId = "";
    const bus: ReviewBusCoordinatorPort = {
        async pendingAll() { return [{ issue_id: "FILMOS-ISSUE-background", project_id: "project-background", state: "EVIDENCE_FROZEN", coordination_key: "background-key" }]; },
        async pending() { return []; },
        async fullContext() { return { base_commit: "a".repeat(40), state: "EVIDENCE_FROZEN", evidence: { local_items: [{ kind: "logs" }] } }; },
        async post(_issueId, action, body) { posts.push({ action, body }); return {}; },
    };
    const coordinator = new ReviewCodexCoordinator(bus, {
        async ensure(input) { ensuredCanvasId = input.canvasId; return { id: "brain-session-background" } as any; },
        async run() { return JSON.stringify({ reproduced: true, root_cause: "background issue", call_chain: ["feedback"], files: ["web/feedback.tsx"], minimal_change: ["repair"], regression_risk: "low", tests: ["test"], rollback: ["revert"] }); },
    }, {
        async prepare(_issueId, baseCommit) { return { workspacePath: "/tmp/filmos-review-background", branch: "codex/review-background", baseCommit }; },
    }, () => ({}));

    await coordinator.tick();

    assert.equal(ensuredCanvasId, "review-project-background");
    assert.deepEqual(posts.map((item) => item.action), ["codex-coordination", "assessments/codex"]);
});

test("session recovery failure is written back instead of leaving stale coordination state", async () => {
    const posts: Array<{ action: string; body: Record<string, unknown> }> = [];
    const bus: ReviewBusCoordinatorPort = {
        async pendingAll() { return [{ issue_id: "FILMOS-ISSUE-recovery", project_id: "project-1", state: "EVIDENCE_FROZEN", coordination_key: "recovery-key" }]; },
        async pending() { return []; },
        async fullContext() { return { base_commit: "a".repeat(40), state: "EVIDENCE_FROZEN" }; },
        async post(_issueId, action, body) { posts.push({ action, body }); return {}; },
    };
    const coordinator = new ReviewCodexCoordinator(bus, {
        async ensure() { throw new Error("CODEX_ROLLOUT_UNAVAILABLE"); },
        async run() { throw new Error("MUST_NOT_RUN"); },
    }, {
        async prepare(_issueId, baseCommit) { return { workspacePath: "/tmp/filmos-review-recovery", branch: "codex/review-recovery", baseCommit }; },
    }, () => ({}));

    await assert.rejects(() => coordinator.tick(), /CODEX_ROLLOUT_UNAVAILABLE/);

    assert.deepEqual(posts, [{
        action: "codex-coordination",
        body: { status: "FAILED", session_id: null, last_action: "EVIDENCE_FROZEN", last_error_code: "CODEX_ROLLOUT_UNAVAILABLE" },
    }]);
});
