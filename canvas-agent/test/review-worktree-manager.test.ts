import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ReviewWorktreeManager } from "../src/brains/review-worktree-manager.js";

test("creates and reuses an isolated review branch from the frozen commit", async () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), "filmos-review-worktree-"));
    const source = join(allowedRoot, "source");
    const worktreeRoot = join(allowedRoot, "worktrees");
    mkdirSync(source);
    git(source, "init");
    git(source, "config", "user.name", "FilmOS Test");
    git(source, "config", "user.email", "filmos-test@example.invalid");
    writeFileSync(join(source, "README.md"), "frozen base\n", "utf8");
    git(source, "add", "README.md");
    git(source, "commit", "-m", "test: frozen base");
    const baseCommit = git(source, "rev-parse", "HEAD");

    const manager = new ReviewWorktreeManager(source, worktreeRoot, allowedRoot);
    const first = await manager.prepare("FILMOS-ISSUE-runtime-roundtrip", baseCommit);
    assert.equal(first.branch, "codex/review-filmos-issue-runtime-roundtrip");
    assert.equal(first.baseCommit, baseCommit);
    assert.equal(git(first.workspacePath, "rev-parse", "HEAD"), baseCommit);
    assert.equal(git(first.workspacePath, "branch", "--show-current"), first.branch);
    assert.equal(realpathSync(first.workspacePath), first.workspacePath);

    writeFileSync(join(first.workspacePath, "change.txt"), "candidate work\n", "utf8");
    git(first.workspacePath, "add", "change.txt");
    git(first.workspacePath, "commit", "-m", "fix: candidate work");
    const second = await manager.prepare("FILMOS-ISSUE-runtime-roundtrip", baseCommit);
    assert.equal(second.workspacePath, first.workspacePath);
    assert.equal(git(second.workspacePath, "rev-parse", "HEAD"), git(first.workspacePath, "rev-parse", "HEAD"));
});

test("rejects the Application Support root itself as a source or worktree", () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), "filmos-review-boundary-"));
    assert.throws(
        () => new ReviewWorktreeManager(allowedRoot, join(allowedRoot, "worktrees"), allowedRoot),
        /REVIEW_WORKTREE_OUTSIDE_APPLICATION_SUPPORT/,
    );
});

function git(cwd: string, ...args: string[]) {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
