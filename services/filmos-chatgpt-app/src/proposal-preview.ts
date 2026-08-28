import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { FilmOSProposalPackage } from "@filmos/tool-contracts";

import type { ProjectGrant } from "./grants.js";

const execFileAsync = promisify(execFile);

export type ProposalPreviewContext = { state_hash: string; versions: Record<string, number> };
export interface ProposalPreviewAdapter {
  preview(value: FilmOSProposalPackage, grant: ProjectGrant, context: ProposalPreviewContext): Promise<Record<string, unknown>>;
}

export class PythonProposalPreviewAdapter implements ProposalPreviewAdapter {
  constructor(private readonly options: { pythonExecutable: string; moduleRoot: string; signingSecret: string; receiptDirectory: string }) {}

  async preview(value: FilmOSProposalPackage, grant: ProjectGrant, context: ProposalPreviewContext): Promise<Record<string, unknown>> {
    const temp = await mkdtemp(resolve(tmpdir(), "filmos-proposal-preview-"));
    const proposalPath = resolve(temp, "handoff.filmosproposal");
    const receiptName = createHash("sha256").update(grant.project_id).digest("hex");
    const receiptPath = resolve(this.options.receiptDirectory, `${receiptName}.json`);
    try {
      await writeFile(proposalPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      const { stdout } = await execFileAsync(this.options.pythonExecutable, [
        "-m", "external_brains.chatgpt.cli", "preview", proposalPath,
        "--project-id", grant.project_id,
        "--state-hash", context.state_hash,
        "--versions-json", JSON.stringify(context.versions),
        "--receipt-file", receiptPath,
      ], {
        cwd: this.options.moduleRoot,
        env: { ...process.env, PYTHONPATH: this.options.moduleRoot, FILMOS_CHATGPT_PROPOSAL_SIGNING_SECRET: this.options.signingSecret },
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr;
      try {
        const rejection = JSON.parse(stderr ?? "") as { code?: string; message?: string };
        throw new ProposalPreviewError(rejection.code ?? "PROPOSAL_IMPORT_REJECTED", rejection.message ?? "Proposal preview rejected");
      } catch (parseError) {
        if (parseError instanceof ProposalPreviewError) throw parseError;
        throw new ProposalPreviewError("PROPOSAL_IMPORT_FAILED", "Film Core proposal preview process failed closed");
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}

export class ProposalPreviewError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
