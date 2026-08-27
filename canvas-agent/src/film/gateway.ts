import crypto from "node:crypto";

import { canonicalize } from "json-canonicalize";

import type { FilmAgentAuditRecord, FilmAgentAuditSink, FilmAgentAuditOutcome } from "./audit.js";
import {
    filmContractPrimitives,
    isFilmToolName,
    parseFilmToolInput,
    type FilmActorKind,
    type FilmCommand,
    type FilmToolName,
    type FilmWriteGuards,
} from "./contracts.js";

type JsonRecord = Record<string, unknown>;
type CanvasObservation = { revision: number; stateHash: string };
type GatewayIdentity = { actorKind: FilmActorKind; actorId: string; mode?: "agent" | "human_only" };

export interface FilmCoreTransport {
    getProjectContext(hostProjectId: string, signal?: AbortSignal): Promise<unknown>;
    getEntity(filmEntityId: string, signal?: AbortSignal): Promise<unknown>;
    getAuditEvents(input: { targetId?: string; limit?: number }, signal?: AbortSignal): Promise<unknown>;
    previewCommand(command: FilmCommand, signal?: AbortSignal): Promise<unknown>;
    applyCommand(command: FilmCommand, signal?: AbortSignal): Promise<unknown>;
}

export interface FilmCanvasObservationSource {
    current(signal?: AbortSignal): Promise<CanvasObservation>;
}

export type FilmAgentGatewayOptions = {
    identity: GatewayIdentity;
    transport: FilmCoreTransport;
    canvas: FilmCanvasObservationSource;
    audit: FilmAgentAuditSink;
    now?: () => Date;
    randomUUID?: () => string;
    receiptTtlMs?: number;
};

type ReadReceipt = {
    id: string;
    kind: "project" | "entity";
    key: string;
    version: number | null;
    contentHash: string;
    canvas: CanvasObservation;
    expiresAt: number;
};

type PreviewReceipt = {
    id: string;
    commandHash: string;
    guardsHash: string;
    readReceipt: string;
    expiresAt: number;
    consumed: boolean;
};

export class FilmAgentGatewayError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = "FilmAgentGatewayError";
    }
}

export class FilmAgentGateway {
    private readonly reads = new Map<string, ReadReceipt>();
    private readonly previews = new Map<string, PreviewReceipt>();
    private readonly identity: Required<GatewayIdentity>;
    private readonly now: () => Date;
    private readonly randomUUID: () => string;
    private readonly receiptTtlMs: number;

    constructor(private readonly options: FilmAgentGatewayOptions) {
        const actorId = options.identity.actorId.trim();
        if (!actorId) throw new Error("Film Agent actorId is required");
        this.identity = { ...options.identity, actorId, mode: options.identity.mode ?? "agent" };
        if (this.identity.mode === "human_only" && this.identity.actorKind !== "human") {
            throw new Error("human_only mode requires actorKind=human");
        }
        if (this.identity.mode === "agent" && this.identity.actorKind === "human") {
            throw new Error("agent mode cannot impersonate actorKind=human");
        }
        this.now = options.now ?? (() => new Date());
        this.randomUUID = options.randomUUID ?? crypto.randomUUID;
        this.receiptTtlMs = options.receiptTtlMs ?? 10 * 60 * 1_000;
    }

    async callTool(name: unknown, rawInput: unknown, signal?: AbortSignal) {
        if (!isFilmToolName(name)) throw new FilmAgentGatewayError("unknown_tool", `未知 Film 工具：${String(name)}`);
        const input = parseFilmToolInput(name, rawInput) as JsonRecord;
        if (name === "film_project_get_context") return this.readProjectContext(input.host_project_id as string, signal);
        if (name === "film_entity_get") return this.readEntity(input.film_entity_id as string, signal);
        if (name === "film_audit_events_get") return this.readAuditEvents(input, signal);
        if (name === "film_command_preview") return this.preview(input, signal);
        return this.apply(input, signal);
    }

    private async readProjectContext(hostProjectId: string, signal?: AbortSignal) {
        const canvas = await this.observeCanvas(signal);
        const data = await this.options.transport.getProjectContext(hostProjectId, signal);
        const receipt = this.rememberRead("project", hostProjectId, null, hashJson(data), canvas);
        const audit = await this.appendAudit({
            toolName: "film_project_get_context",
            action: "film.project.context.read",
            hostProjectId,
            outcome: "read",
            readReceipt: receipt.id,
            canvas,
        });
        return { data, observation: publicReadReceipt(receipt), agent_audit: audit };
    }

    private async readEntity(filmEntityId: string, signal?: AbortSignal) {
        const canvas = await this.observeCanvas(signal);
        const data = await this.options.transport.getEntity(filmEntityId, signal);
        const identity = parseCoreEntityIdentity(data);
        if (identity.id !== filmEntityId) throw new FilmAgentGatewayError("core_identity_mismatch", "Film Core 返回了错误的实体 ID");
        const receipt = this.rememberRead("entity", identity.id, identity.version, identity.contentHash, canvas);
        const audit = await this.appendAudit({
            toolName: "film_entity_get",
            action: "film.entity.read",
            targetId: identity.id,
            outcome: "read",
            readReceipt: receipt.id,
            canvas,
        });
        return { data, observation: publicReadReceipt(receipt), agent_audit: audit };
    }

    private async readAuditEvents(input: JsonRecord, signal?: AbortSignal) {
        const targetId = typeof input.target_id === "string" ? input.target_id : undefined;
        const data = await this.options.transport.getAuditEvents({
            ...(targetId ? { targetId } : {}),
            ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
        }, signal);
        const audit = await this.appendAudit({
            toolName: "film_audit_events_get",
            action: "film.audit.read",
            targetId: targetId ?? null,
            outcome: "read",
        });
        return { data, agent_audit: audit };
    }

    private async preview(input: JsonRecord, signal?: AbortSignal) {
        const rawCommand = input.command as FilmCommand;
        let command: FilmCommand = { ...rawCommand, actor_kind: this.identity.actorKind };
        const guards = input.guards as FilmWriteGuards;
        try {
            command = normalizeActor(rawCommand, this.identity.actorKind);
            this.assertPermission(command, undefined, false);
            const canvas = await this.observeAndMatchCanvas(guards, signal);
            const read = this.requireRead(command, guards);
            const data = await this.options.transport.previewCommand(command, signal);
            assertPreviewResult(data, command.expected_version);
            const receipt: PreviewReceipt = {
                id: this.randomUUID(),
                commandHash: hashJson(command),
                guardsHash: hashJson(guards),
                readReceipt: read.id,
                expiresAt: this.now().getTime() + this.receiptTtlMs,
                consumed: false,
            };
            this.previews.set(receipt.id, receipt);
            const audit = await this.appendAudit({
                toolName: "film_command_preview",
                action: "film.command.preview",
                command,
                guards,
                outcome: "previewed",
                readReceipt: read.id,
                previewReceipt: receipt.id,
                canvas,
            });
            return { data, preview_receipt: receipt.id, expires_at: new Date(receipt.expiresAt).toISOString(), agent_audit: audit };
        } catch (error) {
            await this.appendDeniedOrFailed("film_command_preview", command, guards, error);
            throw error;
        }
    }

    private async apply(input: JsonRecord, signal?: AbortSignal) {
        const rawCommand = input.command as FilmCommand;
        let command: FilmCommand = { ...rawCommand, actor_kind: this.identity.actorKind };
        const guards = input.guards as FilmWriteGuards;
        const previewReceiptId = input.preview_receipt as string;
        const humanConfirmation = input.human_confirmation as JsonRecord | undefined;
        let dispatched = false;
        try {
            command = normalizeActor(rawCommand, this.identity.actorKind);
            this.assertPermission(command, humanConfirmation, true);
            const canvas = await this.observeAndMatchCanvas(guards, signal);
            const read = this.requireRead(command, guards);
            const preview = this.requirePreview(previewReceiptId, command, guards, read.id);
            await this.refreshReadBoundary(read, guards, signal);
            preview.consumed = true;
            await this.appendAudit({
                toolName: "film_command_apply",
                action: "film.command.apply.dispatch",
                command,
                guards,
                outcome: "dispatched",
                readReceipt: read.id,
                previewReceipt: preview.id,
                canvas,
            });
            dispatched = true;
            const data = await this.options.transport.applyCommand(command, signal);
            const coreAuditEventId = assertApplyResult(data, command, this.identity.actorKind);
            const audit = await this.appendAudit({
                toolName: "film_command_apply",
                action: "film.command.apply",
                command,
                guards,
                outcome: "applied",
                readReceipt: read.id,
                previewReceipt: preview.id,
                coreAuditEventId,
                canvas,
            });
            return { data, agent_audit: audit };
        } catch (error) {
            await this.appendDeniedOrFailed("film_command_apply", command, guards, error, previewReceiptId, dispatched);
            throw error;
        }
    }

    private rememberRead(kind: ReadReceipt["kind"], key: string, version: number | null, contentHash: string, canvas: CanvasObservation) {
        const receipt: ReadReceipt = {
            id: this.randomUUID(),
            kind,
            key,
            version,
            contentHash,
            canvas,
            expiresAt: this.now().getTime() + this.receiptTtlMs,
        };
        this.reads.set(receipt.id, receipt);
        return receipt;
    }

    private requireRead(command: FilmCommand, guards: FilmWriteGuards) {
        const receipt = this.reads.get(guards.read_receipt);
        if (!receipt || receipt.expiresAt <= this.now().getTime()) {
            throw new FilmAgentGatewayError("read_required", "正式命令前必须重新读取 Film 上下文或实体");
        }
        if (receipt.contentHash !== guards.expected_content_hash) {
            throw new FilmAgentGatewayError("content_hash_mismatch", "expected_content_hash 与已读取事实不一致");
        }
        if (receipt.canvas.revision !== guards.expected_canvas_revision || receipt.canvas.stateHash !== guards.expected_canvas_state_hash) {
            throw new FilmAgentGatewayError("read_canvas_guard_mismatch", "写入守卫未绑定到原始读取时的画布状态");
        }
        if (command.target_id) {
            if (receipt.kind !== "entity" || receipt.key !== command.target_id || receipt.version !== command.expected_version) {
                throw new FilmAgentGatewayError("version_guard_mismatch", "target_id/expected_version 与已读取实体不一致");
            }
        } else {
            const hostProjectId = commandHostProjectId(command);
            if (command.expected_version !== 0 || receipt.kind !== "project" || !hostProjectId || receipt.key !== hostProjectId) {
                throw new FilmAgentGatewayError("create_guard_mismatch", "创建命令必须绑定同一 Host Project 的上下文读取且 expected_version=0");
            }
        }
        return receipt;
    }

    private requirePreview(id: string, command: FilmCommand, guards: FilmWriteGuards, readReceipt: string) {
        const receipt = this.previews.get(id);
        if (!receipt || receipt.expiresAt <= this.now().getTime()) {
            throw new FilmAgentGatewayError("preview_required", "正式 Apply 前必须重新执行 Film Command Preview");
        }
        if (receipt.consumed) throw new FilmAgentGatewayError("preview_consumed", "Preview 收据已消费，禁止重复 Apply");
        if (receipt.commandHash !== hashJson(command) || receipt.guardsHash !== hashJson(guards) || receipt.readReceipt !== readReceipt) {
            throw new FilmAgentGatewayError("preview_mismatch", "Apply 命令或并发守卫与 Preview 不一致");
        }
        return receipt;
    }

    private async refreshReadBoundary(receipt: ReadReceipt, guards: FilmWriteGuards, signal?: AbortSignal) {
        if (receipt.kind === "entity") {
            const identity = parseCoreEntityIdentity(await this.options.transport.getEntity(receipt.key, signal));
            if (identity.id !== receipt.key || identity.version !== receipt.version || identity.contentHash !== guards.expected_content_hash) {
                throw new FilmAgentGatewayError("film_state_changed", "Film 实体已变化，请重新读取并 Preview");
            }
            return;
        }
        const context = await this.options.transport.getProjectContext(receipt.key, signal);
        if (hashJson(context) !== guards.expected_content_hash) {
            throw new FilmAgentGatewayError("film_context_changed", "Film 项目上下文已变化，请重新读取并 Preview");
        }
    }

    private assertPermission(command: FilmCommand, humanConfirmation: JsonRecord | undefined, formalApply: boolean) {
        const commandType = command.command_type.toLowerCase();
        if (/^(provider|generation)[._-]/.test(commandType)) {
            throw new FilmAgentGatewayError("provider_boundary", "Film Agent Gateway 不执行 Provider 调用或外部生成");
        }
        const forbidden = detectsAgentApprovalOrLock(commandType, command.payload);
        if (this.identity.mode === "agent" && forbidden) {
            throw new FilmAgentGatewayError("human_authority_required", "Agent 不能自批 Approved 或 Locked/Script Lock");
        }
        if (this.identity.mode === "human_only" && formalApply && forbidden && !humanConfirmation) {
            throw new FilmAgentGatewayError("human_confirmation_required", "Human Only 模式执行批准或锁定时必须提供显式人工确认");
        }
    }

    private async observeCanvas(signal?: AbortSignal) {
        const observed = await this.options.canvas.current(signal);
        if (!Number.isInteger(observed.revision) || observed.revision < 0 || !/^[a-f0-9]{16,64}$/.test(observed.stateHash)) {
            throw new FilmAgentGatewayError("invalid_canvas_observation", "当前画布 revision/stateHash 无效");
        }
        return observed;
    }

    private async observeAndMatchCanvas(guards: FilmWriteGuards, signal?: AbortSignal) {
        const observed = await this.observeCanvas(signal);
        if (observed.revision !== guards.expected_canvas_revision) {
            throw new FilmAgentGatewayError("canvas_revision_conflict", "画布 revision 已变化，请重新读取");
        }
        if (observed.stateHash !== guards.expected_canvas_state_hash) {
            throw new FilmAgentGatewayError("canvas_hash_conflict", "画布 stateHash 已变化，请重新读取");
        }
        return observed;
    }

    private async appendDeniedOrFailed(
        toolName: "film_command_preview" | "film_command_apply",
        command: FilmCommand,
        guards: FilmWriteGuards,
        error: unknown,
        previewReceipt?: string,
        dispatched = false,
    ) {
        const code = error instanceof FilmAgentGatewayError ? error.code : dispatched ? "apply_result_unknown" : "gateway_failure";
        await this.appendAudit({
            toolName,
            action: toolName === "film_command_apply" ? "film.command.apply" : "film.command.preview",
            command,
            guards,
            outcome: dispatched ? "failed" : "denied",
            permissionDecision: dispatched ? "allow" : "deny",
            readReceipt: guards.read_receipt,
            previewReceipt: previewReceipt ?? null,
            errorCode: code,
        });
    }

    private async appendAudit(input: {
        toolName: FilmToolName;
        action: string;
        targetId?: string | null;
        hostProjectId?: string | null;
        command?: FilmCommand;
        guards?: FilmWriteGuards;
        outcome: FilmAgentAuditOutcome;
        permissionDecision?: "allow" | "deny";
        readReceipt?: string | null;
        previewReceipt?: string | null;
        coreAuditEventId?: string | null;
        errorCode?: string | null;
        canvas?: CanvasObservation;
    }) {
        const record: FilmAgentAuditRecord = {
            event_id: this.randomUUID(),
            actor_kind: this.identity.actorKind,
            actor_id: this.identity.actorId,
            tool_name: input.toolName,
            action: input.action,
            target_id: input.targetId ?? input.command?.target_id ?? null,
            host_project_id: input.hostProjectId ?? (input.command ? commandHostProjectId(input.command) : null),
            command_type: input.command?.command_type ?? null,
            outcome: input.outcome,
            permission_decision: input.permissionDecision ?? "allow",
            expected_version: input.command?.expected_version ?? null,
            expected_content_hash: input.guards?.expected_content_hash ?? null,
            expected_canvas_revision: input.guards?.expected_canvas_revision ?? input.canvas?.revision ?? null,
            expected_canvas_state_hash: input.guards?.expected_canvas_state_hash ?? input.canvas?.stateHash ?? null,
            read_receipt: input.readReceipt ?? null,
            preview_receipt: input.previewReceipt ?? null,
            core_audit_event_id: input.coreAuditEventId ?? null,
            error_code: input.errorCode ?? null,
            recorded_at: this.now().toISOString(),
        };
        await this.options.audit.append(record);
        return record;
    }
}

function normalizeActor(command: FilmCommand, actorKind: FilmActorKind): FilmCommand {
    if (command.actor_kind && command.actor_kind !== actorKind) {
        throw new FilmAgentGatewayError("actor_spoofing", `命令 actor_kind 必须为 ${actorKind}`);
    }
    return { ...command, actor_kind: actorKind };
}

function publicReadReceipt(receipt: ReadReceipt) {
    return {
        read_receipt: receipt.id,
        observed_kind: receipt.kind,
        observed_key: receipt.key,
        expected_version: receipt.version,
        expected_content_hash: receipt.contentHash,
        expected_canvas_revision: receipt.canvas.revision,
        expected_canvas_state_hash: receipt.canvas.stateHash,
        expires_at: new Date(receipt.expiresAt).toISOString(),
    };
}

function parseCoreEntityIdentity(value: unknown) {
    const source = asRecord(value, "Film Core entity");
    const ref = asRecord(source.ref, "Film Core entity.ref");
    const id = filmContractPrimitives.uuid4Schema.parse(ref.film_entity_id);
    const version = zodInteger(ref.version, "Film Core entity.ref.version", 1);
    const contentHash = filmContractPrimitives.contentHashSchema.parse(ref.content_hash);
    return { id, version, contentHash };
}

function assertPreviewResult(value: unknown, expectedVersion: number) {
    const source = asRecord(value, "Film Core preview result");
    if (source.mode !== "preview" || source.current_version !== expectedVersion) {
        throw new FilmAgentGatewayError("invalid_preview_result", "Film Core Preview 未确认 expected_version");
    }
}

function assertApplyResult(value: unknown, command: FilmCommand, actorKind: FilmActorKind) {
    const source = asRecord(value, "Film Core apply result");
    if (source.mode !== "applied") throw new FilmAgentGatewayError("invalid_apply_result", "Film Core 未返回 applied 状态");
    const entity = parseCoreEntityIdentity(source.entity);
    if (command.target_id && entity.id !== command.target_id) throw new FilmAgentGatewayError("core_identity_mismatch", "Apply 返回了错误实体");
    if (entity.version !== command.expected_version + 1) throw new FilmAgentGatewayError("core_version_mismatch", "Apply 返回版本不符合 expected_version + 1");
    const audit = asRecord(source.audit_event, "Film Core audit_event");
    const eventId = filmContractPrimitives.uuid4Schema.parse(audit.event_id);
    const targetId = filmContractPrimitives.uuid4Schema.parse(audit.target_id);
    if (targetId !== entity.id || audit.actor_kind !== actorKind || typeof audit.action !== "string" || !audit.action || !isDateTime(audit.recorded_at)) {
        throw new FilmAgentGatewayError("invalid_core_audit", "Film Core Apply 未返回完整且匹配的审计事件");
    }
    return eventId;
}

function commandHostProjectId(command: FilmCommand) {
    const host = command.payload.host;
    if (!host || typeof host !== "object" || Array.isArray(host)) return null;
    const value = (host as JsonRecord).host_project_id;
    return typeof value === "string" && value ? value : null;
}

function detectsAgentApprovalOrLock(commandType: string, payload: unknown): boolean {
    if (/(^|[._-])(approve|approved|approval|lock|locked|scriptlock|script_lock)([._-]|$)/.test(commandType)) return true;
    return walk(payload, (key, value) => {
        const normalized = key.toLowerCase();
        if (normalized === "review_state" && value === "approved") return true;
        if ((normalized === "lock_state" || normalized === "creative_stage") && value === "locked") return true;
        return ["approved", "is_approved", "script_locked", "is_locked"].includes(normalized) && value === true;
    });
}

function walk(value: unknown, predicate: (key: string, value: unknown) => boolean): boolean {
    if (Array.isArray(value)) return value.some((item) => walk(item, predicate));
    if (!value || typeof value !== "object") return false;
    return Object.entries(value as JsonRecord).some(([key, item]) => predicate(key, item) || walk(item, predicate));
}

function asRecord(value: unknown, label: string): JsonRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new FilmAgentGatewayError("invalid_core_response", `${label} is invalid`);
    }
    return value as JsonRecord;
}

function zodInteger(value: unknown, label: string, minimum: number) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
        throw new FilmAgentGatewayError("invalid_core_response", `${label} is invalid`);
    }
    return value;
}

function isDateTime(value: unknown) {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hashJson(value: unknown) {
    return crypto.createHash("sha256").update(canonicalize(value)).digest("hex");
}
