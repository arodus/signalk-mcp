import { createHash } from "node:crypto";
import { boundedJson } from "../json.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { GatewayError, type Principal } from "../auth.js";
import { record } from "../data.js";
import { operationIdSchema, routeSchema, type Approval } from "./schemas.js";

export interface DiscoveredOperation {
  id: string;
  method: string;
  path: string;
  description: string;
  enabled: boolean;
  reason: string | null;
  permission: string;
  inputSchema?: object;
  contractHash?: string;
  input?: z.ZodObject<z.ZodRawShape>;
  parameters?: { name: string; location: "path" | "query" }[];
}
function resolve(document: unknown, value: unknown): Record<string, unknown> {
  let current = value;
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth++) {
    if (!record(current)) throw new GatewayError("UNSUPPORTED_SCHEMA");
    if (!Object.hasOwn(current, "$ref")) return current;
    const ref = current.$ref;
    if (
      Object.keys(current).length !== 1 ||
      typeof ref !== "string" ||
      !ref.startsWith("#/components/") ||
      seen.has(ref)
    )
      throw new GatewayError("UNSUPPORTED_REFERENCE");
    seen.add(ref);
    current = document;
    for (const encoded of ref.slice(2).split("/")) {
      const part = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
      if (
        !record(current) ||
        !Object.hasOwn(current, part) ||
        ["__proto__", "constructor", "prototype"].includes(part)
      )
        throw new GatewayError("UNSUPPORTED_REFERENCE");
      current = current[part];
    }
  }
  throw new GatewayError("UNSUPPORTED_REFERENCE");
}
// Bind only this endpoint, including referenced schemas and documented meaning.
// Other endpoints, document versions and property order do not invalidate it.
function resolvedContract(
  document: unknown,
  value: unknown,
  depth = 0,
  budget = { remaining: 2048 },
): unknown {
  if (depth > 16 || --budget.remaining < 0)
    throw new GatewayError("UNSUPPORTED_SCHEMA");
  if (Array.isArray(value))
    return value.map((item) =>
      resolvedContract(document, item, depth + 1, budget),
    );
  if (!record(value)) return value;
  const resolved = resolve(document, value);
  return Object.fromEntries(
    Object.entries(resolved)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [
        key,
        resolvedContract(
          document,
          key === "required" &&
            Array.isArray(item) &&
            item.every((value) => typeof value === "string")
            ? [...item].sort()
            : item,
          depth + 1,
          budget,
        ),
      ]),
  );
}
function primitive(schema: Record<string, unknown>): z.ZodTypeAny {
  const allowed = new Set([
    "type",
    "enum",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "description",
    "title",
    "default",
  ]);
  if (Object.keys(schema).some((key) => !allowed.has(key)))
    throw new GatewayError("UNSUPPORTED_SCHEMA");
  let value: z.ZodTypeAny;
  if (schema.type === "string") {
    const min = schema.minLength ?? 0,
      max = schema.maxLength ?? 256;
    if (
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      (min as number) < 0 ||
      (max as number) < (min as number) ||
      (max as number) > 512
    )
      throw new GatewayError("UNSUPPORTED_SCHEMA");
    value = z
      .string()
      .min(min as number)
      .max(max as number);
  } else if (schema.type === "integer" || schema.type === "number") {
    const min = schema.minimum ?? -1e12,
      max = schema.maximum ?? 1e12;
    if (
      typeof min !== "number" ||
      typeof max !== "number" ||
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      min > max
    )
      throw new GatewayError("UNSUPPORTED_SCHEMA");
    let number = z
      .number()
      .finite()
      .min(Math.max(-1e12, min))
      .max(Math.min(1e12, max));
    if (schema.type === "integer") number = number.int();
    value = number;
  } else if (schema.type === "boolean") value = z.boolean();
  else throw new GatewayError("UNSUPPORTED_SCHEMA");
  if (schema.enum !== undefined) {
    if (
      !Array.isArray(schema.enum) ||
      schema.enum.length < 1 ||
      schema.enum.length > 32 ||
      schema.enum.some((item) => !value.safeParse(item).success)
    )
      throw new GatewayError("UNSUPPORTED_SCHEMA");
    const choices = schema.enum as (string | number | boolean)[];
    const literals = choices.map((choice) => z.literal(choice));
    value =
      literals.length === 1
        ? literals[0]!
        : z.union(
            literals as [
              z.ZodLiteral<string | number | boolean>,
              z.ZodLiteral<string | number | boolean>,
              ...z.ZodLiteral<string | number | boolean>[],
            ],
          );
  }
  // Defaults are descriptive only: omit absent optional parameters and let the
  // provider choose its default, rather than silently changing request behavior.
  return value;
}
function inputs(
  document: unknown,
  item: Record<string, unknown>,
  operation: Record<string, unknown>,
  path: string,
  method: string,
) {
  if (method !== "post" && operation.requestBody !== undefined)
    throw new GatewayError("UNSUPPORTED_SCHEMA");
  const shape: z.ZodRawShape = Object.create(null);
  const parameters: { name: string; location: "path" | "query" }[] = [];
  const merged = new Map<string, Record<string, unknown>>();
  for (const entries of [item.parameters, operation.parameters]) {
    if (entries === undefined) continue;
    if (!Array.isArray(entries) || entries.length > 32)
      throw new GatewayError("UNSUPPORTED_SCHEMA");
    const own = new Set<string>();
    for (const entry of entries) {
      const parameter = resolve(document, entry);
      const key = `${parameter.in}:${parameter.name}`;
      if (own.has(key)) throw new GatewayError("UNSUPPORTED_SCHEMA");
      own.add(key);
      merged.set(key, parameter);
    }
  }
  if (merged.size > 32) throw new GatewayError("UNSUPPORTED_SCHEMA");
  for (const parameter of merged.values()) {
    const { name, in: location } = parameter;
    if (
      typeof name !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ||
      /token|secret|password|authorization|cookie|url|uri|host|endpoint/i.test(
        name,
      ) ||
      ["constructor", "prototype"].includes(name) ||
      Object.hasOwn(shape, name) ||
      (method === "post" &&
        (name === "body" || /command|script|file|config/i.test(name))) ||
      (location !== "path" && location !== "query")
    )
      throw new GatewayError("UNSUPPORTED_PARAMETER");
    if (
      parameter.allowReserved === true ||
      parameter.content !== undefined ||
      (parameter.style !== undefined &&
        parameter.style !== (location === "path" ? "simple" : "form"))
    )
      throw new GatewayError("UNSUPPORTED_PARAMETER");
    let value = primitive(resolve(document, parameter.schema));
    if (location === "path") {
      if (parameter.required !== true || !path.includes(`{${name}}`))
        throw new GatewayError("UNSUPPORTED_PARAMETER");
      value = value.refine(
        (v) => /^[A-Za-z0-9_-]+$/.test(String(v)),
        "Invalid path parameter",
      );
    }
    if (parameter.required !== true) value = value.optional();
    shape[name] = value;
    parameters.push({ name, location });
  }
  for (const match of path.matchAll(/\{([^}]+)\}/g))
    if (!parameters.some((p) => p.location === "path" && p.name === match[1]))
      throw new GatewayError("UNSUPPORTED_PARAMETER");
  if (method === "post" && operation.requestBody !== undefined) {
    if (Object.hasOwn(shape, "body"))
      throw new GatewayError("UNSUPPORTED_SCHEMA");
    const request = resolve(document, operation.requestBody);
    if (
      Object.keys(request).some(
        (key) => !["required", "description", "content"].includes(key),
      ) ||
      (request.required !== undefined &&
        typeof request.required !== "boolean") ||
      !record(request.content) ||
      Object.keys(request.content).length !== 1 ||
      !record(request.content["application/json"])
    )
      throw new GatewayError("UNSUPPORTED_SCHEMA");
    const media = request.content["application/json"];
    if (
      Object.keys(media).some(
        (key) => !["schema", "example", "examples"].includes(key),
      )
    )
      throw new GatewayError("UNSUPPORTED_SCHEMA");
    const schema = resolve(document, media.schema);
    if (
      schema.type !== "object" ||
      !record(schema.properties) ||
      Object.keys(schema).some(
        (key) =>
          ![
            "type",
            "properties",
            "required",
            "additionalProperties",
            "description",
            "title",
          ].includes(key),
      ) ||
      (schema.additionalProperties !== undefined &&
        schema.additionalProperties !== false) ||
      Object.keys(schema.properties).length > 32
    )
      throw new GatewayError("UNSUPPORTED_SCHEMA");
    const required = schema.required ?? [];
    if (
      !Array.isArray(required) ||
      new Set(required).size !== required.length ||
      required.some(
        (key) =>
          typeof key !== "string" ||
          !Object.hasOwn(schema.properties as object, key),
      )
    )
      throw new GatewayError("UNSUPPORTED_SCHEMA");
    const body: z.ZodRawShape = Object.create(null);
    for (const [name, raw] of Object.entries(schema.properties)) {
      if (
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ||
        /token|secret|password|authorization|cookie|url|uri|host|endpoint|command|script|file|config/i.test(
          name,
        ) ||
        ["constructor", "prototype"].includes(name)
      )
        throw new GatewayError("UNSUPPORTED_PARAMETER");
      const value = primitive(resolve(document, raw));
      body[name] = required.includes(name) ? value : value.optional();
    }
    const bodyInput = z.object(body).strict();
    shape.body = request.required === true ? bodyInput : bodyInput.optional();
  }
  return { input: z.object(shape).strict(), parameters };
}

export function discoverOperations(
  document: unknown,
  pluginId: string,
  approvals: Approval[],
  principal: Principal,
): DiscoveredOperation[] {
  if (
    !record(document) ||
    typeof document.openapi !== "string" ||
    !/^3\.[01]\./.test(document.openapi) ||
    !record(document.paths)
  )
    throw new GatewayError("UNSUPPORTED_OPENAPI");
  const result: DiscoveredOperation[] = [];
  const paths = Object.entries(document.paths);
  if (paths.length > 128) throw new GatewayError("DISCOVERY_LIMIT");
  for (const [path, raw] of paths) {
    if (!record(raw)) continue;
    for (const method of [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "head",
      "options",
      "trace",
    ]) {
      const operation = raw[method];
      if (!record(operation)) continue;
      // OpenAPI operationId is optional. Use a stable route-derived name only
      // when absent, never to repair an invalid published ID. Exact method/path
      // approval still applies; collisions are disabled below, not guessed away.
      const id =
        operation.operationId === undefined &&
        routeSchema.safeParse(path).success
          ? `${method}.${path
              .replace(/^\//, "")
              .replace(/\/$/, "")
              .replace(/\{([^}]+)\}/g, "by-$1")
              .replaceAll("/", ".")}`
          : operation.operationId;
      if (!operationIdSchema.safeParse(id).success) continue;
      if (result.length >= 128) throw new GatewayError("DISCOVERY_LIMIT");
      const approval = approvals.find(
        (a) =>
          a.pluginId === pluginId &&
          a.operationId === id &&
          a.path === path &&
          a.method === method.toUpperCase(),
      );
      const entry: DiscoveredOperation = {
        id: id as string,
        method: method.toUpperCase(),
        path,
        description:
          typeof operation.summary === "string"
            ? operation.summary.slice(0, 256)
            : "",
        enabled: false,
        reason: "NOT_ALLOWLISTED",
        permission:
          method === "post"
            ? "readwrite"
            : (approval?.permission ?? "unclassified"),
      };
      if (!["get", "post"].includes(method))
        entry.reason = "METHOD_NOT_READONLY";
      else if (
        method === "post" &&
        /(?:^|\/)(?:config|configuration|settings)(?:\/|$)/i.test(path)
      )
        entry.reason = "UNSUPPORTED_ROUTE";
      else if (!routeSchema.safeParse(path).success || raw.$ref !== undefined)
        entry.reason = "UNSUPPORTED_ROUTE";
      else {
        try {
          const parsed = inputs(document, raw, operation, path, method);
          entry.inputSchema = zodToJsonSchema(parsed.input, {
            $refStrategy: "none",
          });
          entry.input = parsed.input;
          entry.parameters = parsed.parameters;
          if (method === "post") {
            entry.inputSchema = resolvedContract(
              document,
              entry.inputSchema,
            ) as object;
            entry.description = [operation.summary, operation.description]
              .filter((v) => typeof v === "string")
              .join("\n");
            if (entry.description.length > 4096)
              throw new GatewayError("UNSUPPORTED_SCHEMA");
            entry.contractHash = createHash("sha256")
              .update(
                boundedJson(
                  resolvedContract(document, {
                    parameters: raw.parameters ?? [],
                    pathSummary: raw.summary ?? null,
                    pathDescription: raw.description ?? null,
                    security: operation.security ?? document.security ?? null,
                    operation,
                  }),
                  32768,
                ),
              )
              .digest("hex");
          }
          if (approval && method === "get") {
            entry.enabled =
              approval.permission === "readonly" ||
              principal.permissions === "admin";
            entry.reason = entry.enabled ? null : "PERMISSION_DENIED";
          }
        } catch (error) {
          entry.reason =
            error instanceof GatewayError ? error.code : "UNSUPPORTED_SCHEMA";
        }
      }
      result.push(entry);
    }
  }
  for (const entry of result)
    if (result.filter((other) => other.id === entry.id).length !== 1) {
      entry.enabled = false;
      entry.reason = "AMBIGUOUS_OPERATION_ID";
    }
  return result;
}
export function operationDescription(operation: DiscoveredOperation) {
  return {
    id: operation.id,
    method: operation.method,
    readOnly: operation.method === "GET",
    ...(operation.method === "POST"
      ? { executionTool: "execute_mutation" }
      : {}),
    path: operation.path,
    description: operation.description,
    permission: operation.permission,
    enabled: operation.enabled,
    reason: operation.reason,
    inputSchema: operation.inputSchema ?? null,
  };
}
export function operationRoute(
  pluginId: string,
  operation: DiscoveredOperation,
  args: unknown,
): string {
  if (!operation.enabled || !operation.input)
    throw new GatewayError("OPERATION_DISABLED", 403);
  const parsed = operation.input.safeParse(args);
  if (!parsed.success) throw new GatewayError("INVALID_ARGUMENTS");
  let path = operation.path;
  const query = new URLSearchParams();
  for (const parameter of operation.parameters ?? []) {
    const value = parsed.data[parameter.name];
    if (value === undefined) continue;
    if (parameter.location === "path")
      path = path.replaceAll(
        `{${parameter.name}}`,
        encodeURIComponent(String(value)),
      );
    else query.set(parameter.name, String(value));
  }
  return `/plugins/${pluginId}${path}${query.size ? "?" + query.toString() : ""}`;
}
