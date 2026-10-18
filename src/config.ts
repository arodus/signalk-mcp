import { z } from "zod";
import { isIP } from "node:net";
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
  }, "Duplicate or recursive plugin operation approval");
export type Config = z.infer<typeof configSchema>;
export const schema = {
  type: "object",
  required: ["allowedHosts"],
  properties: {
    allowedHosts: {
      type: "array",
      title: "Allowed hosts",
      minItems: 1,
      items: { type: "string", title: "Host and port" },
    },
    allowedOrigins: {
      type: "array",
      title: "Allowed browser origins",
      default: [],
      items: { type: "string", title: "Browser origin" },
    },
    pluginOperations: {
      type: "array",
      title: "Approved plugin reads",
      default: [],
      maxItems: 64,
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
      title: "Signal K certificate name (optional)",
      description:
        "For Signal K’s own HTTPS listener: the DNS name on its certificate. Leave blank to verify the connection’s IP address.",
      maxLength: 253,
    },
    staleAfterSeconds: {
      type: "integer",
      title: "Stale after (seconds)",
      description:
        "Mark measurements older than this as stale. Values are forwarded unchanged.",
      default: 300,
      minimum: 1,
      maximum: 86400,
    },
  },
};

export const uiSchema = {
  allowedHosts: {
    "ui:help":
      "Addresses clients use to reach this endpoint, including the port. Example: localhost:3000.",
  },
  allowedOrigins: {
    "ui:help":
      "Web origins allowed to connect, including the scheme and port. Leave empty if no browser client is used.",
  },
  pluginOperations: {
    "ui:help":
      "Add only plugin endpoints you have reviewed as read-only. Leave empty to disable plugin reads.",
  },
};
