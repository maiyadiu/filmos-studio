import { execFile } from "node:child_process";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ReviewWorkspace = { workspacePath: string; branch: string; baseCommit: string };

export class ReviewWorktreeManager {
    private readonly sourceRepository: string;
    private readonly worktreeRoot: string;
    private readonly allowedRoot: string;

    constructor(
        sourceRepository: string,
        worktreeRoot: string,
        allowedRoot: string,
    ) {
        for (const value of [sourceRepository, worktreeRoot, allowedRoot]) if (!isAbsolute(value) || resolve(value) === sep) throw new Error("REVIEW_WORKTREE_ABSOLUTE_NON_ROOT_REQUIRED");
        const declaredAllowedRoot = resolve(allowedRoot);
        assertWithin(resolve(sourceRepository), declaredAllowedRoot);
        assertWithin(resolve(worktreeRoot), declaredAllowedRoot);
        this.allowedRoot = realpathSync(declaredAllowedRoot);
        this.sourceRepository = realpathSync(join(this.allowedRoot, relative(declaredAllowedRoot, resolve(sourceRepository))));
        this.worktreeRoot = join(this.allowedRoot, relative(declaredAllowedRoot, resolve(worktreeRoot)));
    }

    static fromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
        const source = String(environment.FILMOS_REVIEW_SOURCE_REPOSITORY || "").trim();
        const root = String(environment.FILMOS_REVIEW_WORKTREE_ROOT || "").trim();
        if (!source || !root) return undefined;
        const acceptanceRoot = String(environment.FILMOS_REVIEW_ACCEPTANCE_ALLOWED_ROOT || "").trim();
        let allowed = join(homedir(), "Library", "Application Support", "FilmOS Studio");
        if (acceptanceRoot) {
            const temporaryRoot = resolve(tmpdir());
            const declaredAcceptanceRoot = resolve(acceptanceRoot);
            assertWithin(declaredAcceptanceRoot, temporaryRoot);
            realpathSync(declaredAcceptanceRoot);
            allowed = declaredAcceptanceRoot;
        }
        return new ReviewWorktreeManager(source, root, allowed);
    }

    async prepare(issueId: string, baseCommit: string): Promise<ReviewWorkspace> {
        if (!/^FILMOS-(?:ISSUE|ARCH)-[A-Za-z0-9-]{1,120}$/.test(issueId)) throw new Error("INVALID_REVIEW_ISSUE_ID");
        if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new Error("INVALID_REVIEW_BASE_COMMIT");
        const source = realpathSync(this.sourceRepository);
        assertWithin(source, resolve(this.allowedRoot));
        if (!statSync(source).isDirectory() || (await git(source, ["rev-parse", "--is-inside-work-tree"])) !== "true") throw new Error("REVIEW_SOURCE_REPOSITORY_INVALID");
        mkdirSync(this.worktreeRoot, { recursive: true, mode: 0o700 });
        const slug = issueId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 96);
        const workspacePath = resolve(this.worktreeRoot, slug);
        assertWithin(workspacePath, resolve(this.allowedRoot));
        const branch = `codex/review-${slug}`;
        if (await isGitWorktree(workspacePath)) {
            const existingBranch = await git(workspacePath, ["branch", "--show-current"]);
            if (existingBranch !== branch) throw new Error("REVIEW_WORKTREE_BRANCH_MISMATCH");
        } else {
            const branchExists = await gitExit(source, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
            const args = branchExists === 0
                ? ["worktree", "add", workspacePath, branch]
                : ["worktree", "add", "-b", branch, workspacePath, baseCommit];
            await git(source, args);
        }
        if (await gitExit(workspacePath, ["merge-base", "--is-ancestor", baseCommit, "HEAD"]) !== 0) throw new Error("REVIEW_WORKTREE_BASE_NOT_ANCESTOR");
        const top = realpathSync(await git(workspacePath, ["rev-parse", "--show-toplevel"]));
        if (top !== realpathSync(workspacePath)) throw new Error("REVIEW_WORKTREE_TOPLEVEL_MISMATCH");
        return { workspacePath: top, branch, baseCommit };
    }
}

async function isGitWorktree(path: string) {
    try { return (await git(path, ["rev-parse", "--is-inside-work-tree"])) === "true"; }
    catch { return false; }
}

async function git(cwd: string, args: string[]) {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
}

async function gitExit(cwd: string, args: string[]) {
    try { await git(cwd, args); return 0; }
    catch (error) { return Number((error as { code?: number }).code ?? 1); }
}

function assertWithin(value: string, root: string) {
    const child = resolve(value);
    const parent = resolve(root);
    const tail = relative(parent, child);
    if (!tail || tail.startsWith(`..${sep}`) || tail === ".." || isAbsolute(tail)) throw new Error("REVIEW_WORKTREE_OUTSIDE_APPLICATION_SUPPORT");
}
