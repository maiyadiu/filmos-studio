import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { sha256, safeHexEqual } from "./canonical.js";

export type ProjectGrant = {
  grant_id: string;
  project_id: string;
  subject_id: string;
  token_hash: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  scopes: readonly ["project:read", "proposal:export"];
};

export type IssuedGrant = { token: string; grant: ProjectGrant };

export interface ProjectGrantStore {
  issue(projectId: string, subjectId: string, ttlMs?: number): Promise<IssuedGrant>;
  authorize(token: string, now?: Date): Promise<ProjectGrant>;
  revoke(grantId: string, now?: Date): Promise<void>;
}

export class MemoryProjectGrantStore implements ProjectGrantStore {
  protected grants = new Map<string, ProjectGrant>();

  async issue(projectId: string, subjectId: string, ttlMs = 15 * 60_000): Promise<IssuedGrant> {
    if (!projectId.trim() || !subjectId.trim()) throw new Error("project_id and subject_id are required");
    if (ttlMs < 60_000 || ttlMs > 60 * 60_000) throw new Error("grant TTL must be between 1 and 60 minutes");
    const token = `fg_${randomBytes(32).toString("base64url")}`;
    const now = new Date();
    const grant: ProjectGrant = {
      grant_id: randomUUID(),
      project_id: projectId,
      subject_id: subjectId,
      token_hash: sha256(token),
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMs).toISOString(),
      revoked_at: null,
      scopes: ["project:read", "proposal:export"],
    };
    this.grants.set(grant.grant_id, grant);
    await this.afterChange();
    return { token, grant: structuredClone(grant) };
  }

  async authorize(token: string, now = new Date()): Promise<ProjectGrant> {
    const hash = sha256(token);
    const grant = [...this.grants.values()].find((candidate) => safeHexEqual(candidate.token_hash, hash));
    if (!grant) throw new GrantError("UNAUTHORIZED", "Project Grant is missing or invalid");
    if (grant.revoked_at) throw new GrantError("GRANT_REVOKED", "Project Grant was revoked");
    if (new Date(grant.expires_at).getTime() <= now.getTime()) throw new GrantError("GRANT_EXPIRED", "Project Grant expired");
    return structuredClone(grant);
  }

  async revoke(grantId: string, now = new Date()): Promise<void> {
    const grant = this.grants.get(grantId);
    if (!grant) throw new GrantError("GRANT_NOT_FOUND", "Project Grant does not exist");
    this.grants.set(grantId, { ...grant, revoked_at: now.toISOString() });
    await this.afterChange();
  }

  protected async afterChange(): Promise<void> {}
}

export class JsonProjectGrantStore extends MemoryProjectGrantStore {
  private constructor(private readonly filePath: string) {
    super();
  }

  static async open(filePath: string): Promise<JsonProjectGrantStore> {
    const store = new JsonProjectGrantStore(filePath);
    try {
      const values = JSON.parse(await readFile(filePath, "utf8")) as ProjectGrant[];
      for (const grant of values) store.grants.set(grant.grant_id, grant);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }

  protected override async afterChange(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify([...this.grants.values()], null, 2)}\n`, { mode: 0o600 });
  }
}

export class GrantError extends Error {
  constructor(public readonly code: "UNAUTHORIZED" | "GRANT_REVOKED" | "GRANT_EXPIRED" | "GRANT_NOT_FOUND", message: string) {
    super(message);
  }
}
