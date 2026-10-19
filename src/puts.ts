import { z } from "zod";
import { canPut, GatewayError, type App, type Principal } from "./auth.js";
import {
  applyPutReview,
  putReview,
  reviewKey,
  type ApprovalRequests,
} from "./approvals.js";
import type { Config } from "./config.js";
import { record } from "./data.js";
import { boundedJson } from "./json.js";
import { pathSchema } from "./paths.js";
import type { LocalActions, PutTarget } from "./put-types.js";
import { NativeActionHttpError } from "./capabilities/http.js";

const sourceSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((source) => !/[\s*?[\]\p{Cc}]/u.test(source));
const uuidSchema = z.string().uuid();
const putPathSchema = pathSchema.refine(
  (path) => !path.split(".").includes("meta"),
  "Metadata writes are not native action targets",
);

// JSON only, with limits before serialization. No toJSON hooks, non-finite
// numbers, custom objects or implicit undefined -> null conversions.
function jsonValue(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let count = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++count > 4096 || current.depth > 16) return false;
    const item = current.value;
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      continue;
    }
    if (typeof item === "string") {
      if (Buffer.byteLength(item) > 32 * 1024) return false;
      continue;
    }
    if (typeof item !== "object" || seen.has(item)) return false;
    if (
      !Array.isArray(item) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      return false;
    seen.add(item);
    const values = Array.isArray(item) ? item : Object.values(item);
    if (values.length > 1024) return false;
    for (const child of values)
      pending.push({ value: child, depth: current.depth + 1 });
  }
  try {
    boundedJson(value, 60 * 1024, "INPUT_LIMIT");
    return true;
  } catch {
    return false;
  }
}

export const putPathsInput = z
  .object({
    source: sourceSchema,
    prefix: putPathSchema.optional(),
    offset: z.number().int().min(0).max(20000).default(0),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .strict();
export const describePutInput = z
  .object({ path: putPathSchema, source: sourceSchema })
  .strict();
export const putInput = describePutInput
  .extend({
    value: z.unknown().refine(jsonValue, "Bounded JSON value required"),
  })
  .strict();
export const putStatusInput = z.object({ requestId: uuidSchema }).strict();

const jsonTypes = [
  "null",
  "boolean",
  "number",
  "integer",
  "string",
  "array",
  "object",
];
const schemaFields = [
  "type",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "required",
  "properties",
  "items",
  "additionalProperties",
  "description",
  "title",
];

function supportedSchema(schema: Record<string, unknown>, depth = 0): boolean {
  if (
    depth > 16 ||
    Object.keys(schema).some((key) => !schemaFields.includes(key))
  )
    return false;
  if (
    schema.type !== undefined &&
    (typeof schema.type !== "string" || !jsonTypes.includes(schema.type))
  )
    return false;
  if (
    schema.description !== undefined &&
    typeof schema.description !== "string"
  )
    return false;
  if (schema.title !== undefined && typeof schema.title !== "string")
    return false;
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) ||
      schema.enum.length === 0 ||
      schema.enum.length > 128 ||
      !jsonValue(schema.enum))
  )
    return false;
  if (Object.hasOwn(schema, "const") && !jsonValue(schema.const)) return false;
  for (const key of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
  ])
    if (
      schema[key] !== undefined &&
      (typeof schema[key] !== "number" || !Number.isFinite(schema[key]))
    )
      return false;
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"])
    if (
      schema[key] !== undefined &&
      (!Number.isInteger(schema[key]) ||
        Number(schema[key]) < 0 ||
        Number(schema[key]) > 32768)
    )
      return false;
  for (const [min, max] of [
    ["minimum", "maximum"],
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
  ] as const)
    if (
      typeof schema[min] === "number" &&
      typeof schema[max] === "number" &&
      schema[min] > schema[max]
    )
      return false;
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.length > 128 ||
      schema.required.some((key) => typeof key !== "string") ||
      new Set(schema.required).size !== schema.required.length)
  )
    return false;
  if (
    schema.properties !== undefined &&
    (!record(schema.properties) ||
      Object.keys(schema.properties).length > 128 ||
      Object.values(schema.properties).some(
        (child) => !record(child) || !supportedSchema(child, depth + 1),
      ))
  )
    return false;
  if (
    schema.items !== undefined &&
    (!record(schema.items) || !supportedSchema(schema.items, depth + 1))
  )
    return false;
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  )
    return false;
  if (
    schema.additionalProperties === false &&
    Array.isArray(schema.required) &&
    schema.required.some(
      (key) =>
        !record(schema.properties) || !Object.hasOwn(schema.properties, key),
    )
  )
    return false;
  return true;
}

// Only explicitly declared schema constraints are used. Units, current values,
// displayScale and zones are never converted into type/range assumptions.
function valueSchema(metadata: Record<string, unknown>) {
  const explicit = Object.hasOwn(metadata, "schema");
  if (explicit && !record(metadata.schema))
    return { schema: {}, available: false, supported: false };
  const declared = explicit
    ? (metadata.schema as Record<string, unknown>)
    : metadata;
  const schema = Object.fromEntries(
    (explicit ? Object.keys(declared) : schemaFields)
      .filter((key) => Object.hasOwn(declared, key))
      .map((key) => [key, declared[key]]),
  );
  const available =
    typeof schema.type === "string" && jsonTypes.includes(schema.type);
  // Native enum entries may be {id,name} display descriptors, rather than
  // literal JSON Schema values. Keep those unchanged in metadata and let the
  // handler validate them; do not invent a converted schema.
  if (
    !explicit &&
    Array.isArray(schema.enum) &&
    schema.enum.some((item) => record(item))
  )
    delete schema.enum;
  return { schema, available, supported: supportedSchema(schema) };
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]))
    );
  if (record(left) && record(right))
    return (
      Object.keys(left).length === Object.keys(right).length &&
      Object.entries(left).every(
        ([key, item]) =>
          Object.hasOwn(right, key) && sameJson(item, right[key]),
      )
    );
  return false;
}

function matchesSchema(
  value: unknown,
  schema: Record<string, unknown>,
  depth = 0,
): boolean {
  if (depth > 16) return false;
  if (typeof schema.type === "string" && jsonTypes.includes(schema.type)) {
    const actual =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (schema.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) return false;
    } else if (schema.type !== actual) return false;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => sameJson(item, value))
  )
    return false;
  if (Object.hasOwn(schema, "const") && !sameJson(schema.const, value))
    return false;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      return false;
    if (typeof schema.maximum === "number" && value > schema.maximum)
      return false;
    if (
      typeof schema.exclusiveMinimum === "number" &&
      value <= schema.exclusiveMinimum
    )
      return false;
    if (
      typeof schema.exclusiveMaximum === "number" &&
      value >= schema.exclusiveMaximum
    )
      return false;
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength)
      return false;
    if (typeof schema.maxLength === "number" && length > schema.maxLength)
      return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      return false;
    if (
      record(schema.items) &&
      !value.every((item) =>
        matchesSchema(item, schema.items as Record<string, unknown>, depth + 1),
      )
    )
      return false;
  }
  if (record(value)) {
    if (
      Array.isArray(schema.required) &&
      schema.required.some(
        (key) => typeof key === "string" && !Object.hasOwn(value, key),
      )
    )
      return false;
    const properties = record(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(value)) {
      if (record(properties[key])) {
        if (!matchesSchema(child, properties[key], depth + 1)) return false;
      } else if (schema.additionalProperties === false) return false;
    }
  }
  return true;
}

interface ActionContext {
  authorize(): Principal;
  config: Config;
  requests?: ApprovalRequests;
  http: LocalActions;
}
interface Correlation {
  principal: string;
  target: PutTarget;
  expiresAt: number;
  inFlight: boolean;
  requestId?: string;
}
const sourceVerification = "native-handler-on-dispatch";

export class NativePuts {
  private readonly correlations = new Map<symbol, Correlation>();
  private readonly metadataPaths = new Set<string>();
  private discoveryTruncated = false;
  constructor(private readonly app: App) {}

  reset() {
    this.correlations.clear();
    this.metadataPaths.clear();
    this.discoveryTruncated = false;
  }

  private remember(path: string) {
    if (!putPathSchema.safeParse(path).success || this.metadataPaths.has(path))
      return;
    if (this.metadataPaths.size >= 2048) this.discoveryTruncated = true;
    else this.metadataPaths.add(path);
  }

  // Native registration metadata is not necessarily present in the data model.
  // Observe public input deltas without retaining source/value/token content.
  observeDelta(delta: unknown) {
    if (
      !record(delta) ||
      (delta.context !== undefined &&
        delta.context !== "vessels.self" &&
        delta.context !== this.app.selfContext) ||
      !Array.isArray(delta.updates)
    )
      return;
    if (delta.updates.length > 256) this.discoveryTruncated = true;
    let visited = 0;
    for (const update of delta.updates.slice(0, 256)) {
      if (!record(update) || !Array.isArray(update.meta)) continue;
      for (const meta of update.meta) {
        if (++visited > 2048) {
          this.discoveryTruncated = true;
          return;
        }
        if (record(meta) && typeof meta.path === "string")
          this.remember(meta.path);
      }
    }
  }

  private target(
    principal: Principal,
    path: string,
    source: string,
  ): PutTarget {
    if (!canPut(this.app, principal, path, source))
      throw new GatewayError("PERMISSION_DENIED", 403);
    if (typeof this.app.getMetadata !== "function")
      throw new GatewayError("SIGNALK_METADATA_UNAVAILABLE", 503);
    const metadata: unknown = this.app.getMetadata(`vessels.self.${path}`);
    if (!record(metadata) || metadata.supportsPut !== true)
      throw new GatewayError("PUT_UNAVAILABLE", 404);
    const copy = JSON.parse(
      boundedJson(metadata, 32 * 1024, "METADATA_LIMIT"),
    ) as Record<string, unknown>;
    this.remember(path);
    return {
      context: "vessels.self",
      path,
      source,
      metadata: copy,
      inputSchema: valueSchema(copy).schema,
    };
  }

  list(authorize: () => Principal, args: unknown) {
    const input = putPathsInput.parse(args);
    const principal = authorize();
    if (!["readwrite", "admin"].includes(principal.permissions))
      throw new GatewayError("PERMISSION_DENIED", 403);
    if (typeof this.app.getMetadata !== "function")
      throw new GatewayError("SIGNALK_METADATA_UNAVAILABLE", 503);
    const paths = new Set<string>();
    let visited = 0;
    const prefix = input.prefix ?? "";
    const walk = (node: unknown, path: string, depth: number) => {
      if (++visited > 20000 || depth > 32)
        throw new GatewayError("MODEL_SCAN_LIMIT");
      if (!record(node)) return;
      if (
        pathSchema.safeParse(path).success &&
        !path.split(".").includes("meta") &&
        (!prefix || path === prefix || path.startsWith(prefix + ".")) &&
        canPut(this.app, principal, path, input.source)
      ) {
        const metadata: unknown = this.app.getMetadata(`vessels.self.${path}`);
        if (record(metadata) && metadata.supportsPut === true) paths.add(path);
      }
      for (const key of Object.keys(node)) {
        if (
          [
            "value",
            "meta",
            "values",
            "timestamp",
            "__proto__",
            "prototype",
            "constructor",
          ].includes(key) ||
          key.startsWith("$")
        )
          continue;
        const next = path ? `${path}.${key}` : key;
        if (
          !prefix ||
          next === prefix ||
          next.startsWith(prefix + ".") ||
          prefix.startsWith(next + ".")
        )
          walk(node[key], next, depth + 1);
      }
    };
    walk(this.app.getPath(this.app.selfContext), "", 0);
    for (const path of this.metadataPaths) {
      if (
        (!prefix || path === prefix || path.startsWith(prefix + ".")) &&
        canPut(this.app, principal, path, input.source)
      ) {
        const metadata: unknown = this.app.getMetadata(`vessels.self.${path}`);
        if (record(metadata) && metadata.supportsPut === true) paths.add(path);
      }
    }
    authorize();
    const sorted = [...paths].sort();
    return {
      context: "vessels.self",
      source: input.source,
      paths: sorted.slice(input.offset, input.offset + input.limit),
      nextOffset:
        input.offset + input.limit < sorted.length
          ? input.offset + input.limit
          : null,
      sourceVerification,
      discoveryCoverage: "model-and-observed-metadata",
      historicalMetadataOnlyPaths: "explicit-describe-required",
      metadataPathLimit: 2048,
      discoveryTruncated: this.discoveryTruncated,
    };
  }

  describe(authorize: () => Principal, args: unknown) {
    const input = describePutInput.parse(args);
    const target = this.target(authorize(), input.path, input.source);
    const schema = valueSchema(target.metadata);
    return {
      ...target,
      schemaStatus: !schema.supported
        ? "unsupported"
        : schema.available
          ? "available"
          : "unspecified",
      nativeHandlerValidation: true,
      sourceVerification,
    };
  }

  private approved(
    context: ActionContext,
    target: PutTarget,
    principal: Principal,
    queue: boolean,
  ) {
    const review = applyPutReview(
      target,
      context.config.readRequests,
      principal,
    );
    if (review.enabled) return;
    if (queue && review.reason === "NOT_ALLOWLISTED" && context.requests)
      context.requests.requestPut(target);
    throw new GatewayError(review.reason ?? "OPERATION_DISABLED", 403);
  }

  private reserve(
    target: PutTarget,
    principal: Principal,
  ): [symbol, Correlation] {
    const now = Date.now();
    for (const [key, entry] of this.correlations)
      if (!entry.inFlight && entry.expiresAt <= now)
        this.correlations.delete(key);
    if (this.correlations.size >= 128)
      throw new GatewayError("PUT_REQUEST_CAPACITY", 429);
    const key = Symbol();
    const entry: Correlation = {
      principal: principal.identifier,
      target,
      expiresAt: now + 3600000,
      inFlight: true,
    };
    this.correlations.set(key, entry);
    return [key, entry];
  }

  private nativeReply(
    value: unknown,
    principal: string,
    expectedId?: string,
  ): Record<string, unknown> {
    if (
      !record(value) ||
      !uuidSchema.safeParse(value.requestId).success ||
      value.user !== principal ||
      (expectedId !== undefined && value.requestId !== expectedId) ||
      value.href !== `/signalk/v1/requests/${value.requestId}` ||
      typeof value.state !== "string" ||
      !["PENDING", "COMPLETED", "FAILED"].includes(value.state) ||
      !Number.isInteger(value.statusCode) ||
      Number(value.statusCode) < 100 ||
      Number(value.statusCode) > 599 ||
      (value.action !== undefined &&
        (!record(value.action) || value.action.href !== value.href))
    )
      throw new GatewayError("INVALID_NATIVE_PUT_REPLY");
    boundedJson(value, 224 * 1024);
    return value;
  }

  private unknown(
    entry: Correlation,
    code = "NATIVE_PUT_OUTCOME_UNKNOWN",
    httpStatus?: number,
  ) {
    return {
      context: entry.target.context,
      path: entry.target.path,
      source: entry.target.source,
      submitted: true,
      outcome: "unknown",
      retrySafe: false,
      code,
      ...(entry.requestId ? { requestId: entry.requestId } : {}),
      ...(httpStatus === undefined ? {} : { httpStatus }),
    };
  }

  async execute(context: ActionContext, args: unknown) {
    const input = putInput.parse(args);
    // Refresh identity immediately before approval, capacity reservation and
    // native dispatch. No value or bearer token is retained in correlation.
    const principal = context.authorize();
    const target = this.target(principal, input.path, input.source);
    if (!valueSchema(target.metadata).supported)
      throw new GatewayError("UNSUPPORTED_PUT_SCHEMA");
    if (!matchesSchema(input.value, target.inputSchema))
      throw new GatewayError("INVALID_PUT_VALUE");
    this.approved(context, target, principal, true);
    const [key, entry] = this.reserve(target, principal);
    try {
      const raw = await context.http.put(
        `/signalk/v1/api/vessels/self/${input.path.split(".").join("/")}`,
        { value: input.value, source: input.source },
      );
      const reply = this.nativeReply(raw, entry.principal);
      const requestId = reply.requestId as string;
      if (
        [...this.correlations.values()].some(
          (other) => other !== entry && other.requestId === requestId,
        )
      )
        return this.unknown(entry);
      entry.requestId = requestId;
      // A response cannot restore a correlation cleared by plugin stop/reset.
      if (!this.correlations.has(key)) return this.unknown(entry);
      try {
        const current = context.authorize();
        if (current.identifier !== entry.principal)
          throw new GatewayError("PERMISSION_DENIED", 403);
        const latest = this.target(current, input.path, input.source);
        if (!this.sameTarget(entry.target, latest))
          throw new GatewayError("PUT_TARGET_CHANGED");
        this.approved(context, latest, current, false);
      } catch {
        return this.unknown(entry, "AUTHORIZATION_CHANGED_AFTER_SUBMISSION");
      }
      return {
        context: target.context,
        path: target.path,
        source: target.source,
        submitted: true,
        outcome: reply.state === "PENDING" ? "pending" : "completed",
        retrySafe: false,
        requestId,
        reply,
      };
    } catch (error) {
      return this.unknown(
        entry,
        error instanceof NativeActionHttpError
          ? "NATIVE_PUT_HTTP_ERROR"
          : "NATIVE_PUT_OUTCOME_UNKNOWN",
        error instanceof NativeActionHttpError ? error.httpStatus : undefined,
      );
    } finally {
      entry.inFlight = false;
    }
  }

  async status(context: ActionContext, args: unknown) {
    const input = putStatusInput.parse(args);
    const principal = context.authorize();
    const entry = [...this.correlations.values()].find(
      (candidate) =>
        candidate.requestId === input.requestId &&
        candidate.principal === principal.identifier &&
        candidate.expiresAt > Date.now(),
    );
    if (!entry) throw new GatewayError("PUT_REQUEST_UNAVAILABLE", 404);
    const before = this.target(
      principal,
      entry.target.path,
      entry.target.source,
    );
    if (!this.sameTarget(entry.target, before))
      throw new GatewayError("PUT_REQUEST_UNAVAILABLE", 404);
    this.approved(context, before, principal, false);
    const raw = await context.http.getRequest(input.requestId);
    const current = context.authorize();
    if (
      current.identifier !== entry.principal ||
      entry.expiresAt <= Date.now() ||
      ![...this.correlations.values()].includes(entry)
    )
      throw new GatewayError("PUT_REQUEST_UNAVAILABLE", 404);
    const latest = this.target(current, entry.target.path, entry.target.source);
    if (!this.sameTarget(entry.target, latest))
      throw new GatewayError("PUT_REQUEST_UNAVAILABLE", 404);
    this.approved(context, latest, current, false);
    const reply = this.nativeReply(raw, entry.principal, input.requestId);
    return {
      context: entry.target.context,
      path: entry.target.path,
      source: entry.target.source,
      submitted: true,
      outcome: reply.state === "PENDING" ? "pending" : "completed",
      retrySafe: false,
      requestId: input.requestId,
      reply,
    };
  }

  private sameTarget(left: PutTarget, right: PutTarget): boolean {
    return reviewKey(putReview(left)) === reviewKey(putReview(right));
  }
}
