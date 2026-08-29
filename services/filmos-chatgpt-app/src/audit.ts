import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type AuditRecord = {
  event_id: string;
  recorded_at: string;
  correlation_id: string;
  action: string;
  grant_id?: string;
  project_id?: string;
  outcome: "ALLOW" | "DENY" | "ERROR";
  result_size: number;
  output_hash?: string;
  code?: string;
  challenge_id?: string;
  request_id?: string;
  tool_name?: string;
  timestamp?: string;
  result_hash?: string;
};

export type AuditInput = Omit<AuditRecord, "event_id" | "recorded_at"> & { event_id?: string; recorded_at?: string };

export function auditRecord(input: AuditInput): AuditRecord {
  return {
    ...input,
    event_id: input.event_id ?? randomUUID(),
    recorded_at: input.recorded_at ?? new Date().toISOString(),
  };
}

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
