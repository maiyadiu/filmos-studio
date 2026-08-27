import { z } from "zod";

const uuid4Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "must be a lowercase UUIDv4",
  );
const contentHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase SHA-256");
const canvasStateHashSchema = z
  .string()
  .regex(/^[0-9a-f]{16,64}$/, "must be a lowercase state hash");
const opaqueHostIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !/[\\/]/.test(value) && !/^(?:~|file:|https?:|[a-zA-Z]:)/.test(value),
    "must be an opaque Host id, not a path or public URL",
  );

export const filmActorKindSchema = z.enum([
  "human",
  "codex",
  "deepseek",
  "claude",
  "local_model",
  "system",
]);
export type FilmActorKind = z.infer<typeof filmActorKindSchema>;

export const filmCommandSchema = z.discriminatedUnion("command_type", [
  z
    .object({
      command_type: z.literal("entity.create"),
      target_id: z.null(),
      expected_version: z.literal(0),
      actor_kind: filmActorKindSchema.optional(),
      payload: z.record(z.unknown()),
    })
    .strict(),
  z
    .object({
      command_type: z.literal("entity.set_states"),
      target_id: uuid4Schema,
      expected_version: z.number().int().min(1),
      actor_kind: filmActorKindSchema.optional(),
      payload: z.record(z.unknown()),
    })
    .strict(),
]);
export type FilmCommand = z.infer<typeof filmCommandSchema>;

export const filmWriteGuardsSchema = z
  .object({
    read_receipt: uuid4Schema,
    expected_content_hash: contentHashSchema,
    expected_canvas_revision: z.number().int().nonnegative(),
    expected_canvas_state_hash: canvasStateHashSchema,
  })
  .strict();
export type FilmWriteGuards = z.infer<typeof filmWriteGuardsSchema>;

const humanConfirmationSchema = z
  .object({
    confirmed_by: z.string().trim().min(1).max(256),
    confirmed_at: z.string().datetime(),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const filmToolNames = [
  "film_project_get_context",
  "film_entity_get",
  "film_audit_events_get",
  "film_command_preview",
  "film_command_apply",
] as const;
export type FilmToolName = (typeof filmToolNames)[number];

export const filmToolInputSchemas = {
  film_project_get_context: z
    .object({ host_project_id: opaqueHostIdSchema })
    .strict(),
  film_entity_get: z.object({ film_entity_id: uuid4Schema }).strict(),
  film_audit_events_get: z
    .object({
      target_id: uuid4Schema.optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  film_command_preview: z
    .object({
      command: filmCommandSchema,
      guards: filmWriteGuardsSchema,
    })
    .strict(),
  film_command_apply: z
    .object({
      command: filmCommandSchema,
      guards: filmWriteGuardsSchema,
      preview_receipt: uuid4Schema,
      human_confirmation: humanConfirmationSchema.optional(),
    })
    .strict(),
} satisfies Record<FilmToolName, z.AnyZodObject>;

export const filmToolDescriptions: Record<FilmToolName, string> = {
  film_project_get_context:
    "读取 Film Core 项目上下文并签发短期只读收据；任何后续创建命令必须引用该收据。",
  film_entity_get:
    "读取单个 Film 实体、version 与 content_hash，并签发短期只读收据；禁止从记忆猜测正式状态。",
  film_audit_events_get:
    "只读查询 Film Core 审计事件，不修改项目、画布或 Provider 状态。",
  film_command_preview:
    "只读预演 Film Command。必须绑定已读取收据、expected_version/content_hash 和当前画布 revision/stateHash；不会正式写入。",
  film_command_apply:
    "正式应用已经 Preview 的 Film Command。必须复用未消费的 Preview 收据并重新校验 Film 与画布并发守卫；Agent 不得自批 Approved 或 Script Lock。",
};

export const filmToolAnnotations: Record<
  FilmToolName,
  {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  }
> = {
  film_project_get_context: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  film_entity_get: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  film_audit_events_get: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  film_command_preview: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  film_command_apply: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export function isFilmToolName(value: unknown): value is FilmToolName {
  return (
    typeof value === "string" && filmToolNames.includes(value as FilmToolName)
  );
}

export function parseFilmToolInput(name: FilmToolName, input: unknown) {
  return filmToolInputSchemas[name].parse(input ?? {});
}

export const filmContractPrimitives = {
  uuid4Schema,
  contentHashSchema,
  canvasStateHashSchema,
};
