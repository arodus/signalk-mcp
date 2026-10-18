import { z } from "zod";
import { pathSchema } from "../paths.js";
export const pluginIdSchema = z
  .string()
  .max(128)
  .regex(/^(?:@[a-z0-9_-]+\/)?[a-z0-9][a-z0-9._-]*$/)
  .refine((id) => !id.split("/").some((part) => part === "." || part === ".."));
export const operationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);
export const routeSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^\/(?:[A-Za-z0-9_-]+|\{[A-Za-z][A-Za-z0-9_]*\})(?:\/(?:[A-Za-z0-9_-]+|\{[A-Za-z][A-Za-z0-9_]*\}))*\/?$/,
  );
export const approvalSchema = z
  .object({
    pluginId: pluginIdSchema,
    operationId: operationIdSchema,
    method: z.literal("GET"),
    path: routeSchema,
    readOnly: z.literal(true),
    permission: z.enum(["readonly", "admin"]).default("readonly"),
  })
  .strict();
export type Approval = z.infer<typeof approvalSchema>;
export const pathsInput = z
  .object({
    prefix: pathSchema.optional(),
    offset: z.number().int().min(0).max(20000).default(0),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();
export const valuesInput = z
  .object({ paths: z.array(pathSchema).min(1).max(64) })
  .strict();
export const stateInput = z.object({}).strict();
export const notificationsInput = z
  .object({
    offset: z.number().int().min(0).max(20000).default(0),
    limit: z.number().int().min(1).max(64).default(32),
  })
  .strict();
// Signal K 2.33's HTTP parser strips hyphens from history expressions. Reject
// unsupported spellings rather than silently querying a different path/source.
const historyPath = pathSchema.refine((path) => /^[a-z0-9_.]+$/i.test(path));
export const historyInput = z
  .object({
    paths: z
      .array(
        z
          .object({
            path: historyPath,
            source: z
              .string()
              .min(1)
              .max(128)
              .regex(/^[a-z0-9_.:]+$/i)
              .optional(),
            method: z
              .enum(["average", "min", "max", "first", "last"])
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    duration: z.number().int().min(1).max(604800).optional(),
    resolution: z.number().int().min(1).max(86400).optional(),
    provider: pluginIdSchema.optional(),
  })
  .strict();
export type HistoryInput = z.infer<typeof historyInput>;
