import fs from "node:fs/promises";
import path from "node:path";

import type { FilmActorKind, FilmToolName } from "./contracts.js";

export type FilmAgentAuditOutcome = "read" | "previewed" | "dispatched" | "applied" | "denied" | "failed";

export type FilmAgentAuditRecord = {
    event_id: string;
    actor_kind: FilmActorKind;
    actor_id: string;
    tool_name: FilmToolName;
    action: string;
    target_id: string | null;
    host_project_id: string | null;
    command_type: string | null;
    outcome: FilmAgentAuditOutcome;
    permission_decision: "allow" | "deny";
    expected_version: number | null;
    expected_content_hash: string | null;
    expected_canvas_revision: number | null;
    expected_canvas_state_hash: string | null;
    read_receipt: string | null;
    preview_receipt: string | null;
    core_audit_event_id: string | null;
    error_code: string | null;
    recorded_at: string;
};

export interface FilmAgentAuditSink {
    append(record: FilmAgentAuditRecord): Promise<void>;
}

export class MemoryFilmAgentAuditSink implements FilmAgentAuditSink {
    readonly records: FilmAgentAuditRecord[] = [];

    async append(record: FilmAgentAuditRecord) {
        this.records.push(structuredClone(record));
    }
}

export class JsonlFilmAgentAuditSink implements FilmAgentAuditSink {
    constructor(private readonly filePath: string) {}

    async append(record: FilmAgentAuditRecord) {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
        await fs.chmod(this.filePath, 0o600);
    }
}
