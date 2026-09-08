import { z } from "zod";

// Build-time contract generation must not load the session store or Runtime.
const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceReadInputSchema = z.object({ path: z.string().min(1).max(300), startLine: z.number().int().min(1).max(100_000).default(1), lineCount: z.number().int().min(1).max(240).default(160), expectedHash: hash.optional() }).strict();
export const sourcePatchInputSchema = z.object({
    requestId, path: z.string().min(1).max(300), expectedHash: hash,
    oldText: z.string().min(1).max(32_768), newText: z.string().max(32_768),
}).strict();
export const sourceTaskInputSchema = z.object({ requestId, purpose: z.string().trim().min(1).max(1000), files: z.array(z.object({ path: z.string().min(1).max(300), expectedHash: hash }).strict()).min(1).max(5) }).strict();
export const sourceToolSchemas = {
    source_get_task: z.object({}).strict(),
    source_read_file: sourceReadInputSchema,
    source_prepare_patch: sourcePatchInputSchema,
    source_apply_patch: z.object({ requestId }).strict(),
} as const;
