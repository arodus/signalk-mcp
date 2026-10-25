import { createHash } from "node:crypto";
import { boundedJson } from "../json.js";
import { z } from "zod";
import {
  JsonSchemaCompiler,
  SchemaError,
  resolveSchema as resolve,
} from "./json-schema.js";
import { GatewayError, type Principal } from "../auth.js";
import { record } from "../data.js";
import {
  operationIdSchema,
  pluginRouteSchema,
  type Approval,
} from "./schemas.js";

import {
  nativeApiPath,
  nativeApis,
  nativeRouteAllowed,
  type NativeApi,
} from "./native-api.js";

export interface DiscoveredOperation {
  api?: NativeApi;
  id: string;
  method: string;
  path: string;
  description: string;
  enabled: boolean;
  reason: string | null;
  permission: string;
  inputSchema?: object;
  schemaIssue?: { location: string; keyword: string };
  contractHash?: string;
  input?: z.ZodObject<z.ZodRawShape>;
  parameters?: { name: string; location: "path" | "query" }[];
}
// Bind only this endpoint, including referenced schemas and documented meaning.
// Other endpoints, document versions and property order do not invalidate it.
function resolvedContract(
  document: unknown,
  value: unknown,
  depth = 0,
  budget = { remaining: 4096 },
): unknown {
  if (depth > 32 || --budget.remaining < 0)
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
function inputs(
  document: unknown,
  item: Record<string, unknown>,
  operation: Record<string, unknown>,
  path: string,
  method: string,
) {
  const mutation = ["post", "put", "patch", "delete"].includes(method);
  const compiler = new JsonSchemaCompiler(document);
  if (!mutation && operation.requestBody !== undefined)
    throw new GatewayError("UNSUPPORTED_SCHEMA");
  const shape: Record<string, z.ZodType> = Object.create(null);
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
      (mutation &&
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
    let value = compiler.parse(
      parameter.schema,
      `parameters.${name}.schema`,
      true,
    );
    if (location === "path") {
      if (parameter.required !== true || !path.includes(`{${name}}`))
        throw new GatewayError("UNSUPPORTED_PARAMETER");
      value = value.refine(
        (v) => /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,511}$/.test(String(v)),
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
  if (mutation && operation.requestBody !== undefined) {
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
      throw new SchemaError("requestBody", "application/json-content");
    const media = request.content["application/json"];
    if (
      Object.keys(media).some(
        (key) => !["schema", "example", "examples"].includes(key),
      )
    )
      throw new GatewayError("UNSUPPORTED_SCHEMA");
    const bodyInput = compiler.parse(
      media.schema,
      "requestBody.content.application/json.schema",
    );
    shape.body = request.required === true ? bodyInput : bodyInput.optional();
  }
  const input = z.object(shape).strict();
  return { input, parameters, inputSchema: compiler.json(input) };
}

export function discoverOperations(
  document: unknown,
  pluginId: string,
  approvals: Approval[],
  principal: Principal,
  nativeApi?: NativeApi,
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
  for (const [documentPath, raw] of paths) {
    const path = nativeApi
      ? (nativeApiPath(nativeApi, documentPath) ?? documentPath)
      : documentPath;
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
        (pluginRouteSchema.safeParse(path).success ||
          (nativeApi && documentPath === "/"))
          ? `${method}.${(nativeApi
              ? path.startsWith(nativeApis[nativeApi].base)
                ? path.slice(nativeApis[nativeApi].base.length) || "/root"
                : path
              : pluginId.startsWith("@") &&
                  path.startsWith(`/plugins/${pluginId}/`)
                ? path.slice(`/plugins/${pluginId}`.length)
                : path
            )
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
        ...(nativeApi ? { api: nativeApi } : {}),
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
          method !== "get"
            ? "readwrite"
            : (approval?.permission ?? "unclassified"),
      };
      if (!["get", "post", "put", "patch", "delete"].includes(method))
        entry.reason = "METHOD_NOT_READONLY";
      else if (
        method !== "get" &&
        /(?:^|\/)(?:(?:[A-Za-z0-9_]+-)?(?:_?config|configuration|settings))(?:\/|$)/i.test(
          path,
        )
      )
        entry.reason = "UNSUPPORTED_ROUTE";
      else if (
        (nativeApi
          ? !nativeRouteAllowed(nativeApi, method.toUpperCase(), path)
          : !path.startsWith(`/plugins/${pluginId}/`) &&
            /^\/(?:plugins|signalk|skServer)(?:\/|$)/.test(path)) ||
        !pluginRouteSchema.safeParse(path).success ||
        raw.$ref !== undefined
      )
        entry.reason = "UNSUPPORTED_ROUTE";
      else {
        try {
          if (record(operation.responses)) {
            if (
              nativeApi &&
              (Object.hasOwn(operation.responses, "101") ||
                /websocket|event.stream/i.test(String(operation.summary)))
            )
              throw new GatewayError("UNSUPPORTED_RESPONSE");
            const success = Object.entries(operation.responses).filter(
              ([status]) =>
                /^2(?:[0-9]{2}|XX)$/.test(status) ||
                (nativeApi && status === "default"),
            );
            if (
              success.length &&
              success.every(([, rawResponse]) => {
                const response = resolve(document, rawResponse);
                return (
                  record(response.content) &&
                  Object.keys(response.content).length > 0 &&
                  !Object.keys(response.content).some((type) =>
                    /^application\/(?:[\w.-]+\+)?json$/.test(type),
                  )
                );
              })
            )
              throw new GatewayError("UNSUPPORTED_RESPONSE");
          }
          const parsed = inputs(document, raw, operation, path, method);
          entry.inputSchema = parsed.inputSchema;
          entry.input = parsed.input;
          entry.parameters = parsed.parameters;
          if (method !== "get" || nativeApi) {
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
                    operation: nativeApi
                      ? {
                          ...operation,
                          // Outputs are forwarded, not schema-validated. Bind their
                          // transport and meaning without compiling response models.
                          responses: record(operation.responses)
                            ? Object.fromEntries(
                                Object.entries(operation.responses).map(
                                  ([status, response]) => {
                                    const resolved = resolve(
                                      document,
                                      response,
                                    );
                                    return [
                                      status,
                                      {
                                        description:
                                          resolved.description ?? null,
                                        mediaTypes: record(resolved.content)
                                          ? Object.keys(resolved.content).sort()
                                          : [],
                                      },
                                    ];
                                  },
                                ),
                              )
                            : null,
                        }
                      : operation,
                  }),
                  32768,
                ),
              )
              .digest("hex");
          }
          if (!nativeApi && approval && method === "get") {
            entry.enabled =
              approval.permission === "readonly" ||
              principal.permissions === "admin";
            entry.reason = entry.enabled ? null : "PERMISSION_DENIED";
          }
        } catch (error) {
          entry.reason =
            error instanceof GatewayError ? error.code : "UNSUPPORTED_SCHEMA";
          if (error instanceof SchemaError)
            entry.schemaIssue = {
              location: error.location,
              keyword: error.keyword,
            };
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
    ...(["POST", "PUT", "PATCH", "DELETE"].includes(operation.method)
      ? { executionTool: "execute_mutation" }
      : {}),
    path: operation.path,
    description: operation.description,
    permission: operation.permission,
    enabled: operation.enabled,
    reason: operation.reason,
    ...(operation.schemaIssue ? { schemaIssue: operation.schemaIssue } : {}),
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
  const route =
    operation.api || path.startsWith(`/plugins/${pluginId}/`)
      ? path
      : `/plugins/${pluginId}${path}`;
  return `${route}${query.size ? "?" + query.toString() : ""}`;
}
