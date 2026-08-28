import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditRecord = {
  timestamp: string;
  correlation_id: string;
  action: string;
  grant_id: string | null;
  project_id: string | null;
  outcome: "ALLOW" | "DENY" | "ERROR";
  output_hash?: string;
  code?: string;
};

export interface AuditSink { write(record: AuditRecord): Promise<void> }

export class MemoryAuditSink implements AuditSink {
  records: AuditRecord[] = [];
  async write(record: AuditRecord) { this.records.push(structuredClone(record)); }
}

export class JsonlAuditSink implements AuditSink {
  constructor(private readonly filePath: string) {}
  async write(record: AuditRecord) {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
}
