import assert from "node:assert/strict";
import test from "node:test";

import { ReviewCodexCoordinator, type ReviewBusCoordinatorPort } from "../src/brains/review-codex-coordinator.js";

function coordinatorOutput(prompt: string, value: Record<string, unknown>) {
    const attempt = /Coordination attempt: (review-attempt-[0-9a-f-]{36})/.exec(prompt)?.[1];
    assert.ok(attempt);
    return JSON.stringify({ coordination_attempt_id: attempt, ...value });
}

function fixture(state: string, full: Record<string, unknown>, output: Record<string, unknown>) {
    const posts: Array<{ action: string; body: Record<string, unknown> }> = [];
    const bus: ReviewBusCoordinatorPort = {
        async pendingAll() { return [{ issue_id: "FILMOS-ISSUE-test", project_id: "project-1", state, coordination_key: `key-${state}` }]; },
        async pending(projectId) { return projectId === "project-1" ? [{ issue_id: "FILMOS-ISSUE-test", project_id: "project-1", state, coordination_key: `key-${state}` }] : []; },
        async fullContext() { return { state, ...full }; },
        async coordinationResult() { throw new Error("NO_STORED_RESULT"); },
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
            return coordinatorOutput(prompt, output);
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
    assert.deepEqual(value.posts.map((item) => item.action), ["codex-coordination", "codex-coordination/result", "assessments/codex"]);
    assert.deepEqual(value.posts[2].body, assessment);
    assert.equal(value.ensuredWorkspace(), "/tmp/filmos-review-worktree");
});

test("CHANGES_REQUIRED writes FindingResponses, advances the round, then submits Candidate B", async () => {
    const response = { finding_id: "finding-1", disposition: "FIXED_WITH_EVIDENCE", evidence: ["test.log"] };
    const candidate = { candidate_id: "candidate-B" };
    const value = fixture("CHANGES_REQUIRED", { lane: "core", consensus_record: { contentHash: "c" }, issue_task_package: { contentHash: "t" }, findings: [{ finding_id: "finding-1" }] }, { finding_responses: [response], candidate });
    await value.coordinator.tick();
    assert.deepEqual(value.posts.map((item) => item.action), ["codex-coordination", "codex-coordination/result", "finding-responses", "rounds/next", "candidates"]);
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
        async coordinationResult() { throw new Error("NO_STORED_RESULT"); },
        async post(_issueId, action, body) { posts.push({ action, body }); return {}; },
    };
    let runs = 0;
    const coordinator = new ReviewCodexCoordinator(bus, {
        async ensure() { return { id: "brain-session-global" } as any; },
        async run(_sessionId, prompt) {
            runs += 1;
            return coordinatorOutput(prompt, { reproduced: true, root_cause: "global issue", call_chain: ["feedback"], files: ["web/feedback.tsx"], minimal_change: ["repair"], regression_risk: "low", tests: ["test"], rollback: ["revert"] });
        },
    }, {
        async prepare(_issueId, baseCommit) { return { workspacePath: "/tmp/filmos-review-global", branch: "codex/review-filmos-issue-global", baseCommit }; },
    }, () => ({ projectId: "project-1", canvasId: "canvas-1" }));
    await coordinator.tick();
    await coordinator.tick();
    assert.equal(runs, 1);
    assert.deepEqual(posts.map((item) => item.action), ["codex-coordination", "codex-coordination/result", "assessments/codex"]);
});

test("project feedback is coordinated without an active canvas", async () => {
    const posts: Array<{ action: string; body: Record<string, unknown> }> = [];
    let ensuredCanvasId = "";
    const bus: ReviewBusCoordinatorPort = {
        async pendingAll() { return [{ issue_id: "FILMOS-ISSUE-background", project_id: "project-background", state: "EVIDENCE_FROZEN", coordination_key: "background-key" }]; },
        async pending() { return []; },
        async fullContext() { return { base_commit: "a".repeat(40), state: "EVIDENCE_FROZEN", evidence: { local_items: [{ kind: "logs" }] } }; },
        async coordinationResult() { throw new Error("NO_STORED_RESULT"); },
        async post(_issueId, action, body) { posts.push({ action, body }); return {}; },
    };
    const coordinator = new ReviewCodexCoordinator(bus, {
        async ensure(input) { ensuredCanvasId = input.canvasId; return { id: "brain-session-background" } as any; },
        async run(_sessionId, prompt) { return coordinatorOutput(prompt, { reproduced: true, root_cause: "background issue", call_chain: ["feedback"], files: ["web/feedback.tsx"], minimal_change: ["repair"], regression_risk: "low", tests: ["test"], rollback: ["revert"] }); },
    }, {
        async prepare(_issueId, baseCommit) { return { workspacePath: "/tmp/filmos-review-background", branch: "codex/review-background", baseCommit }; },
    }, () => ({}));

    await coordinator.tick();

    assert.equal(ensuredCanvasId, "review-project-background");
    assert.deepEqual(posts.map((item) => item.action), ["codex-coordination", "codex-coordination/result", "assessments/codex"]);
});

test("session recovery failure is written back instead of leaving stale coordination state", async () => {
    const posts: Array<{ action: string; body: Record<string, unknown> }> = [];
    const bus: ReviewBusCoordinatorPort = {
        async pendingAll() { return [{ issue_id: "FILMOS-ISSUE-recovery", project_id: "project-1", state: "EVIDENCE_FROZEN", coordination_key: "recovery-key" }]; },
        async pending() { return []; },
        async fullContext() { return { base_commit: "a".repeat(40), state: "EVIDENCE_FROZEN" }; },
        async coordinationResult() { throw new Error("NO_STORED_RESULT"); },
        async post(_issueId, action, body) { posts.push({ action, body }); return {}; },
    };
    const coordinator = new ReviewCodexCoordinator(bus, {
        async ensure() { throw new Error("CODEX_ROLLOUT_UNAVAILABLE"); },
        async run() { throw new Error("MUST_NOT_RUN"); },
    }, {
        async prepare(_issueId, baseCommit) { return { workspacePath: "/tmp/filmos-review-recovery", branch: "codex/review-recovery", baseCommit }; },
    }, () => ({}));

    await assert.rejects(() => coordinator.tick(), /CODEX_ROLLOUT_UNAVAILABLE/);

    assert.equal(posts.length, 1);
    assert.equal(posts[0].action, "codex-coordination");
    assert.equal(posts[0].body.status, "FAILED");
    assert.equal(posts[0].body.last_error_code, "CODEX_ROLLOUT_UNAVAILABLE");
    assert.equal(posts[0].body.retry_count, 1);
    assert.match(String(posts[0].body.next_retry_at), /^\d{4}-/);
});

test("a failed new subscription turn retains the newly persisted attempt identity", async () => {
    const posts: Array<{ action: string; body: Record<string, unknown> }> = [];
    const issue = {
        issue_id: "FILMOS-ISSUE-new-attempt",
        project_id: "project-1",
        state: "EVIDENCE_FROZEN",
        coordination_key: "9".repeat(64),
    };
    const bus: ReviewBusCoordinatorPort = {
        async pendingAll() { return [issue]; },
        async pending() { return [issue]; },
        async fullContext() { return { base_commit: "a".repeat(40), state: issue.state }; },
        async coordinationResult() { throw new Error("NO_STORED_RESULT"); },
        async post(_issueId, action, body) { posts.push({ action, body }); return {}; },
    };
    const coordinator = new ReviewCodexCoordinator(bus, {
        async ensure() { return { id: "brain-session-new-attempt" } as any; },
        async run() { throw new Error("CODEX_TURN_ERROR"); },
    }, {
        async prepare(_issueId, baseCommit) { return { workspacePath: "/tmp/filmos-review-new-attempt", branch: "codex/review-new-attempt", baseCommit }; },
    }, () => ({}));

    await assert.rejects(() => coordinator.tick(), /CODEX_TURN_ERROR/);

    assert.deepEqual(posts.map((item) => item.action), ["codex-coordination", "codex-coordination"]);
    const running = posts[0].body;
    const failed = posts[1].body;
    assert.match(String(running.attempt_id), /^review-attempt-[0-9a-f-]{36}$/);
    assert.equal(failed.attempt_id, running.attempt_id);
    assert.equal(failed.session_id, "brain-session-new-attempt");
    assert.equal(failed.last_action, "LOCAL_ASSESSMENT");
    assert.equal(failed.status, "FAILED");
});

test("consensus work is prioritized and one long subscription turn cannot drain the whole queue", async () => {
    const handled: string[] = [];
    const issues = [
        { issue_id: "FILMOS-ISSUE-evidence-1", project_id: "project-1", state: "EVIDENCE_REQUIRED", coordination_key: "evidence-1" },
        { issue_id: "FILMOS-ISSUE-consensus", project_id: "project-1", state: "CONSENSUS_PROPOSED", coordination_key: "consensus" },
        { issue_id: "FILMOS-ISSUE-evidence-2", project_id: "project-1", state: "EVIDENCE_REQUIRED", coordination_key: "evidence-2" },
    ];
    const bus: ReviewBusCoordinatorPort = {
        async pendingAll() { return issues; },
        async pending() { return issues; },
        async fullContext(issueId) { return { issue_id: issueId, base_commit: "a".repeat(40), state: issues.find((item) => item.issue_id === issueId)?.state, consensus_proposal: { contentHash: "proposal" } }; },
        async coordinationResult() { throw new Error("NO_STORED_RESULT"); },
        async post(issueId, action) { handled.push(`${issueId}:${action}`); return {}; },
    };
    const coordinator = new ReviewCodexCoordinator(bus, {
        async ensure() { return { id: "brain-session-priority" } as any; },
        async run(_sessionId, prompt) { return coordinatorOutput(prompt, { proposal_content_hash: "proposal", position: "ACCEPTED", requested_changes: [] }); },
    }, {
        async prepare(issueId, baseCommit) { return { workspacePath: `/tmp/${issueId}`, branch: `codex/${issueId}`, baseCommit }; },
    }, () => ({}));

    await coordinator.tick();

    assert.deepEqual(handled.map((item) => item.split(":").slice(0, 2).join(":")), [
        "FILMOS-ISSUE-consensus:codex-coordination",
        "FILMOS-ISSUE-consensus:codex-coordination/result",
        "FILMOS-ISSUE-consensus:consensus/responses/codex",
    ]);
});

test("restart replays a persisted result without consuming another subscription turn", async () => {
    const attemptId = "review-attempt-11111111-1111-4111-8111-111111111111";
    const assessment = { coordination_attempt_id: attemptId, reproduced: true, root_cause: "persisted", call_chain: ["ui"], files: ["web/a.ts"], minimal_change: ["fix"], regression_risk: "low", tests: ["test"], rollback: ["revert"] };
    const posts: string[] = [];
    const issue = {
        issue_id: "FILMOS-ISSUE-persisted",
        project_id: "project-1",
        state: "EVIDENCE_FROZEN",
        coordination_key: "a".repeat(64),
        codex_coordination: { status: "RESULT_READY", session_id: "session-1", last_action: "LOCAL_ASSESSMENT", last_error_code: null, coordination_key: "a".repeat(64), attempt_id: attemptId, retry_count: 0, next_retry_at: null, stop_reason: null, result_available: true },
    };
    const bus: ReviewBusCoordinatorPort = {
        async pendingAll() { return [issue]; }, async pending() { return [issue]; },
        async fullContext() { return { state: issue.state }; },
        async coordinationResult() { return { action: "LOCAL_ASSESSMENT", result: assessment }; },
        async post(_issueId, action) { posts.push(action); return {}; },
    };
    const coordinator = new ReviewCodexCoordinator(bus, {
        async ensure() { throw new Error("MUST_NOT_CREATE_SESSION"); },
        async run() { throw new Error("MUST_NOT_CONSUME_TURN"); },
    }, { async prepare() { throw new Error("MUST_NOT_CREATE_WORKTREE"); } }, () => ({}));

    await coordinator.tick();

    assert.deepEqual(posts, ["assessments/codex"]);
});

test("restart recovers an in-flight completed assistant result before applying it", async () => {
    const attemptId = "review-attempt-22222222-2222-4222-8222-222222222222";
    const posts: string[] = [];
    let runs = 0;
    const issue = {
        issue_id: "FILMOS-ISSUE-in-flight",
        project_id: "project-1",
        state: "EVIDENCE_FROZEN",
        coordination_key: "b".repeat(64),
        codex_coordination: { status: "RUNNING", session_id: "session-2", last_action: "LOCAL_ASSESSMENT", last_error_code: null, coordination_key: "b".repeat(64), attempt_id: attemptId, retry_count: 0, next_retry_at: null, stop_reason: null, result_available: false },
    };
    const bus: ReviewBusCoordinatorPort = {
        async pendingAll() { return [issue]; }, async pending() { return [issue]; },
        async fullContext() { return { state: issue.state }; },
        async coordinationResult() { throw new Error("NO_STORED_RESULT"); },
        async post(_issueId, action) { posts.push(action); return {}; },
    };
    const coordinator = new ReviewCodexCoordinator(bus, {
        async ensure() { throw new Error("MUST_NOT_CREATE_SESSION"); },
        async run() { runs += 1; throw new Error("MUST_NOT_CONSUME_TURN"); },
        async recover(_sessionId, requestedAttempt) {
            assert.equal(requestedAttempt, attemptId);
            return JSON.stringify({ coordination_attempt_id: attemptId, reproduced: true, root_cause: "recovered", call_chain: ["ui"], files: ["web/a.ts"], minimal_change: ["fix"], regression_risk: "low", tests: ["test"], rollback: ["revert"] });
        },
    }, { async prepare() { throw new Error("MUST_NOT_CREATE_WORKTREE"); } }, () => ({}));

    await coordinator.tick();

    assert.equal(runs, 0);
    assert.deepEqual(posts, ["codex-coordination/result", "assessments/codex"]);
});

test("stable terminal coordination key survives restart while a changed key resumes", async () => {
    let pendingIssue: any = {
        issue_id: "FILMOS-ISSUE-keyed", project_id: "project-1", state: "EVIDENCE_FROZEN", coordination_key: "c".repeat(64),
        codex_coordination: { status: "WAITING_EXTERNAL", session_id: null, last_action: "wait", last_error_code: null, coordination_key: "c".repeat(64), attempt_id: null, retry_count: 0, next_retry_at: null, stop_reason: null, result_available: false },
    };
    let runs = 0;
    const posts: string[] = [];
    const bus: ReviewBusCoordinatorPort = {
        async pendingAll() { return [pendingIssue]; }, async pending() { return [pendingIssue]; },
        async fullContext() { return { state: pendingIssue.state, base_commit: "a".repeat(40) }; },
        async coordinationResult() { throw new Error("NO_STORED_RESULT"); },
        async post(_issueId, action) { posts.push(action); return {}; },
    };
    const driver = {
        async ensure() { return { id: "session-keyed" } as any; },
        async run(_sessionId: string, prompt: string) { runs += 1; return coordinatorOutput(prompt, { reproduced: true, root_cause: "changed key", call_chain: ["ui"], files: ["web/a.ts"], minimal_change: ["fix"], regression_risk: "low", tests: ["test"], rollback: ["revert"] }); },
    };
    const make = () => new ReviewCodexCoordinator(bus, driver, { async prepare(_issueId, baseCommit) { return { workspacePath: "/tmp/keyed", branch: "codex/keyed", baseCommit }; } }, () => ({}));

    await make().tick();
    assert.equal(runs, 0);
    pendingIssue = { ...pendingIssue, coordination_key: "d".repeat(64) };
    await make().tick();
    assert.equal(runs, 1);
    assert.deepEqual(posts, ["codex-coordination", "codex-coordination/result", "assessments/codex"]);
});

test("Architecture coordinator advances deterministic states without a model turn", async () => {
    const posts: string[] = [];
    const issues = [
        { issue_id: "FILMOS-ARCH-requirement", project_id: "project-1", lane: "architecture", state: "REQUIREMENT_DELTA_FROZEN", coordination_key: "2".repeat(64) },
        { issue_id: "FILMOS-ARCH-evidence", project_id: "project-1", lane: "architecture", state: "ARCHITECTURE_EVIDENCE_FROZEN", coordination_key: "e".repeat(64) },
        { issue_id: "FILMOS-ARCH-accepted", project_id: "project-1", lane: "architecture", state: "ARCHITECTURE_OPTION_ACCEPTED", coordination_key: "f".repeat(64) },
        { issue_id: "FILMOS-ARCH-task", project_id: "project-1", lane: "architecture", state: "TASK_PACKAGE_FROZEN", coordination_key: "1".repeat(64) },
    ];
    const bus: ReviewBusCoordinatorPort = {
        async pendingAll() { return issues.splice(0, 1); }, async pending() { return []; },
        async fullContext(issueId) {
            if (issueId !== "FILMOS-ARCH-requirement") throw new Error("MUST_NOT_READ_FULL_CONTEXT");
            return { base_commit: "a".repeat(40), evidence: { manifest: { sourceCommit: "a".repeat(40) }, local_items: [{ kind: "source" }] } };
        },
        async coordinationResult() { throw new Error("NO_STORED_RESULT"); },
        async post(issueId, action) { posts.push(`${issueId}:${action}`); return {}; },
    };
    const coordinator = new ReviewCodexCoordinator(bus, { async ensure() { throw new Error("MUST_NOT_CREATE_SESSION"); }, async run() { throw new Error("MUST_NOT_RUN"); } }, { async prepare() { throw new Error("MUST_NOT_PREPARE"); } }, () => ({}));

    await coordinator.tick(); await coordinator.tick(); await coordinator.tick(); await coordinator.tick();

    assert.deepEqual(posts, [
        "FILMOS-ARCH-requirement:evidence/freeze",
        "FILMOS-ARCH-evidence:architecture/assessments/begin",
        "FILMOS-ARCH-accepted:architecture/consensus/propose",
        "FILMOS-ARCH-task:architecture/implementation/start",
    ]);
});
