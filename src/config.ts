import { z } from "zod";
import { approvalSchema } from "./capabilities/schemas.js";
export { pathSchema } from "./paths.js";
export const configSchema = z
  .object({
    allowedHosts: z
      .array(
        z
          .string()
          .min(1)
          .max(255)
          .refine((host) => /^[a-zA-Z0-9.:[\]-]+$/.test(host)),
      )
      .min(1)
      .max(32),
    allowedOrigins: z
      .array(
        z
          .string()
          .url()
          .refine(
            (value) =>
              new URL(value).origin === value && /^https?:/.test(value),
          ),
      )
      .max(32)
      .default([]),
    pluginOperations: z.array(approvalSchema).max(64).default([]),
    staleAfterSeconds: z.number().int().min(1).max(86400).default(300),
  })
  .strict()
  .refine((config) => {
    const keys = config.pluginOperations.map(
      (operation) => `${operation.pluginId}:${operation.operationId}`,
    );
    return (
      new Set(keys).size === keys.length &&
      config.pluginOperations.every(
        (operation) => operation.pluginId !== "signalk-mcp",
      )
    );
  }, "Duplicate or recursive plugin operation approval");
export type Config = z.infer<typeof configSchema>;
export const schema = {
  type: "object",
  required: ["allowedHosts"],
  properties: {
    allowedHosts: {
      type: "array",
      title: "Allowed incoming hosts (including port)",
      minItems: 1,
      items: { type: "string" },
    },
    allowedOrigins: {
      type: "array",
      title: "Allowed browser origins (empty rejects all Origin headers)",
      default: [],
      items: { type: "string" },
    },
    pluginOperations: {
      type: "array",
      title: "Reviewed read-only plugin operations",
      default: [],
      maxItems: 64,
      items: {
        type: "object",
        required: ["pluginId", "operationId", "method", "path", "readOnly"],
        properties: {
          pluginId: { type: "string" },
          operationId: { type: "string" },
          method: { type: "string", enum: ["GET"] },
          path: { type: "string" },
          readOnly: { type: "boolean", const: true },
          permission: {
            type: "string",
            enum: ["readonly", "admin"],
            default: "readonly",
          },
        },
      },
    },
    staleAfterSeconds: {
      type: "integer",
      title: "Age after which measurements are stale",
      default: 300,
      minimum: 1,
      maximum: 86400,
    },
  },
};
