import { z } from "zod";
import { isIP } from "node:net";
import { approvalSchema } from "./capabilities/schemas.js";
import { reviewsSchema } from "./approvals.js";
export { pathSchema } from "./paths.js";
export const configSchema = z.preprocess(
  (options) => {
    if (options && typeof options === "object" && !Array.isArray(options)) {
      // Retired plugin-local network lists must not prevent existing installs
      // from starting. All other unknown configuration keys remain invalid.
      const current = { ...options } as Record<string, unknown>;
      delete current.allowedHosts;
      delete current.allowedOrigins;
      return current;
    }
    return options;
  },
  z
    .object({
      pluginOperations: z.array(approvalSchema).default([]),
      readRequests: reviewsSchema.default({}),
      localTlsServerName: z
        .string()
        .max(253)
        .refine(
          (name) =>
            isIP(name) === 0 &&
            name
              .split(".")
              .every((label) =>
                /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
              ),
        )
        .optional(),
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
    }, "Duplicate or recursive plugin operation approval"),
);
export type Config = z.infer<typeof configSchema>;
export const schema = {
  type: "object",
  properties: {
    pluginOperations: {
      type: "array",
      title: "Existing plugin read approvals",
      default: [],
      items: {
        type: "object",
        required: ["pluginId", "operationId", "method", "path", "readOnly"],
        properties: {
          pluginId: { type: "string", title: "Plugin ID" },
          operationId: { type: "string", title: "Operation ID" },
          method: { type: "string", title: "HTTP method", enum: ["GET"] },
          path: { type: "string", title: "Endpoint path" },
          readOnly: {
            type: "boolean",
            title: "Confirmed read-only",
            const: true,
          },
          permission: {
            type: "string",
            title: "Required permission",
            enum: ["readonly", "admin"],
            default: "readonly",
          },
        },
      },
    },
    localTlsServerName: {
      type: "string",
      title: "HTTPS certificate hostname (optional)",
      description:
        "Usually leave this blank. If Signal K serves HTTPS directly, enter its certificate hostname, such as boat.example, without https:// or a port.",
      maxLength: 253,
    },
    staleAfterSeconds: {
      type: "integer",
      title: "Stale after (seconds)",
      description: "Mark data as outdated after this many seconds.",
      default: 300,
      minimum: 1,
      maximum: 86400,
    },
  },
};

// Retain legacy storage for compatibility; manage existing grants in the catalogue.
export const uiSchema = {
  pluginOperations: { "ui:widget": "hidden" },
};
