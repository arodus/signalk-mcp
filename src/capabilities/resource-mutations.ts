import { z } from "zod";
import { timestampSchema, toJsonSchema, uuidSchema } from "../schema.js";
import { GatewayError, type Principal } from "../auth.js";
import {
  type ApprovalRequests,
  resourceReview,
  reviewKey,
} from "../approvals.js";
import type { Config } from "../config.js";
import { record } from "../data.js";
import { boundedJson } from "../json.js";
import { pathSchema } from "../paths.js";
import { listResourceProviders } from "./resources.js";
import { pluginIdSchema } from "./schemas.js";
import type {
  LocalGet,
  LocalResourceMutation,
  ResourceMethod,
} from "./http.js";

const collectionSchema = z.enum([
  "routes",
  "waypoints",
  "regions",
  "notes",
  "charts",
  "logentries",
]);
const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .refine((id) => !["constructor", "prototype"].includes(id));
export const describeResourceInput = z
  .object({ collection: collectionSchema, provider: pluginIdSchema })
  .strict();
export const createResourceInput = describeResourceInput
  .extend({ body: z.record(z.string(), z.unknown()) })
  .strict();
export const putResourceInput = createResourceInput
  .extend({ id: idSchema })
  .strict();
export const deleteResourceInput = describeResourceInput
  .extend({ id: idSchema })
  .strict();
const operations = {
  create_resource: { method: "POST", input: createResourceInput },
  put_resource: { method: "PUT", input: putResourceInput },
  delete_resource: { method: "DELETE", input: deleteResourceInput },
} as const;
export type ResourceOperation = keyof typeof operations;
export const isResourceMutation = (
  operation: string,
): operation is ResourceOperation => Object.hasOwn(operations, operation);
const text = z.string().max(16384);
const name = z.string().max(1024);
const timestamp = timestampSchema;
const coordinate = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
const polygon = z.array(z.array(coordinate).min(4).max(2000)).max(128);
const feature = (geometry: z.ZodType) =>
  z
    .object({
      geometry,
      properties: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough();
const common = { name: name.optional(), description: text.optional() };
const position = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    altitude: z.number().finite().optional(),
  })
  .passthrough();
const bodySchemas = {
  routes: z
    .object({
      ...common,
      distance: z.number().finite().nonnegative().optional(),
      feature: feature(
        z
          .object({
            type: z.literal("LineString"),
            coordinates: z.array(coordinate).min(2).max(2000),
          })
          .passthrough(),
      ),
    })
    .passthrough(),
  waypoints: z
    .object({
      ...common,
      type: name.optional(),
      feature: feature(
        z
          .object({ type: z.literal("Point"), coordinates: coordinate })
          .passthrough(),
      ),
    })
    .passthrough(),
  regions: z
    .object({
      ...common,
      feature: feature(
        z.union([
          z
            .object({ type: z.literal("Polygon"), coordinates: polygon })
            .passthrough(),
          z
            .object({
              type: z.literal("MultiPolygon"),
              coordinates: z.array(polygon).max(128),
            })
            .passthrough(),
        ]),
      ),
    })
    .passthrough(),
  notes: z
    .object({
      title: name.optional(),
      description: text.optional(),
      mimeType: name.optional(),
      url: text.optional(),
      properties: z.record(z.string(), z.unknown()).optional(),
      href: z
        .string()
        .max(256)
        .regex(/^\/resources\/\w+\/[0-9a-f-]{36}$/i)
        .optional(),
      position: position.optional(),
    })
    .passthrough(),
  charts: z
    .object({
      ...common,
      identifier: idSchema.optional(),
      url: text.optional(),
      layers: z.array(name).max(128).optional(),
      type: z.enum([
        "tilelayer",
        "tileJSON",
        "WMS",
        "WMTS",
        "mapstyleJSON",
        "S-57",
      ]),
      bounds: z
        .tuple([
          z.number().finite(),
          z.number().finite(),
          z.number().finite(),
          z.number().finite(),
        ])
        .optional(),
      format: z.enum(["jpg", "pbf", "png", "webp"]).optional(),
      minzoom: z.number().finite().min(0).max(30).optional(),
      maxzoom: z.number().finite().min(0).max(30).optional(),
      scale: z.number().finite().min(1).optional(),
    })
    .passthrough(),
  logentries: z
    .object({
      text,
      id: uuidSchema.optional(),
      datetime: timestamp.optional(),
      timestamp: timestamp.optional(),
      $source: name.optional(),
      author: name.optional(),
      origin: name.optional(),
      category: name.optional(),
      enrich: z.boolean().optional(),
      telemetry: z
        .array(
          z
            .object({
              path: pathSchema,
              value: z.union([
                z.null(),
                z.string(),
                z.number().finite(),
                z.boolean(),
                z.array(z.unknown()),
                z.record(z.string(), z.unknown()),
              ]),
              $source: name.optional(),
              timestamp: timestamp.optional(),
            })
            .passthrough(),
        )
        .max(256)
        .optional(),
    })
    .passthrough(),
};
function inputFor(
  collection: z.infer<typeof collectionSchema>,
  provider: string,
  operation: ResourceOperation,
) {
  const input = describeResourceInput.extend({
    collection: z.literal(collection),
    provider: z.literal(provider),
  });
  if (operation === "delete_resource") return input.extend({ id: idSchema });
  const withBody = input.extend({ body: bodySchemas[collection] });
  return operation === "put_resource"
    ? withBody.extend({ id: idSchema })
    : withBody;
}
function candidate(
  collection: z.infer<typeof collectionSchema>,
  provider: string,
  operation: ResourceOperation,
) {
  const method = operations[operation].method;
  const description = `${method} ${collection} using ${provider}. ${operation === "create_resource" ? "Create a resource with a server-generated ID; body.id and chart identifier are not accepted." : operation === "put_resource" ? "Create or replace the resource at the supplied ID; this is an upsert, not a partial patch. Requires a sole registered provider on supported Signal K versions." : "Delete the resource at the supplied ID."} ${collection === "logentries" && method !== "DELETE" ? "Logbook defaults, omitted-field preservation and optional enrichment belong to the provider. Unknown fields and supplied telemetry are forwarded unchanged." : "Native resource validation and provider behavior apply; extension fields are forwarded unchanged."}`;
  return resourceReview({
    collection,
    provider,
    method,
    path: `/signalk/v2/api/resources/${collection}${method === "POST" ? "" : "/{id}"}`,
    description,
    inputSchema: toJsonSchema(inputFor(collection, provider, operation)),
  });
}
function jsonInput(value: unknown, depth = 0): void {
  if (depth > 20) throw new GatewayError("INPUT_LIMIT");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    for (const item of value) jsonInput(item, depth + 1);
    return;
  }
  if (
    !record(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new GatewayError("INVALID_ARGUMENTS");
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw new GatewayError("INVALID_ARGUMENTS");
    jsonInput(item, depth + 1);
  }
}
export interface ResourceMutationContext {
  authorize: () => Principal;
  config: Config;
  get: LocalGet;
  requests?: ApprovalRequests;
  http?: LocalResourceMutation;
}
async function providerCheck(
  context: ResourceMutationContext,
  collection: string,
  provider: string,
  method?: ResourceMethod,
) {
  const { providers } = await listResourceProviders(
    context.authorize,
    context.get,
    collection,
  );
  if (!providers.includes(provider))
    throw new GatewayError("RESOURCE_PROVIDER_UNAVAILABLE");
  // Native PUT prefers any existing owner over ?provider. A single provider is
  // necessary to bind an upsert to the provider that the administrator reviewed.
  if (method === "PUT" && providers.length !== 1)
    throw new GatewayError("RESOURCE_PUT_PROVIDER_AMBIGUOUS");
}
export async function describeResource(
  context: ResourceMutationContext,
  args: z.infer<typeof describeResourceInput>,
) {
  const { providers } = await listResourceProviders(
    context.authorize,
    context.get,
    args.collection,
  );
  if (!providers.includes(args.provider))
    throw new GatewayError("RESOURCE_PROVIDER_UNAVAILABLE");
  const principal = context.authorize();
  return {
    collection: args.collection,
    provider: args.provider,
    operations: Object.keys(operations).map((operation) => {
      const target = candidate(
        args.collection,
        args.provider,
        operation as ResourceOperation,
      );
      const decision =
        context.config.readRequests[reviewKey(target)]?.decision ?? "pending";
      const reason =
        !context.http || !context.requests
          ? "RESOURCE_MUTATION_UNAVAILABLE"
          : !["readwrite", "admin"].includes(principal.permissions)
            ? "PERMISSION_DENIED"
            : target.method === "PUT" && providers.length !== 1
              ? "RESOURCE_PUT_PROVIDER_AMBIGUOUS"
              : decision === "approved"
                ? null
                : decision === "rejected"
                  ? "APPROVAL_REJECTED"
                  : "APPROVAL_REQUIRED";
      return {
        id: operation,
        method: target.method,
        readOnly: false,
        executionTool: "execute_mutation",
        enabled: reason === null,
        reason,
        decision,
        description: target.description,
        inputSchema: target.inputSchema,
      };
    }),
  };
}
export async function mutateResource(
  context: ResourceMutationContext,
  operation: ResourceOperation,
  args: unknown,
) {
  const writeIdentity = () => {
    const principal = context.authorize();
    if (!["readwrite", "admin"].includes(principal.permissions))
      throw new GatewayError("PERMISSION_DENIED", 403);
    return principal;
  };
  const principal = writeIdentity();
  const parsed = operations[operation].input.safeParse(args);
  if (!parsed.success) throw new GatewayError("INVALID_ARGUMENTS");
  const input = parsed.data;
  jsonInput(input);
  boundedJson(input, 48 * 1024, "INPUT_LIMIT");
  const { collection, provider } = input;
  const method = operations[operation].method;
  const id = "id" in input ? input.id : undefined;
  const body = "body" in input ? input.body : undefined;
  if (
    id !== undefined &&
    !(collection === "charts"
      ? /^[A-Za-z0-9_-]{8,128}$/.test(id)
      : collection === "logentries"
        ? z.string().uuid().safeParse(id).success
        : /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            id,
          ))
  )
    throw new GatewayError("INVALID_ARGUMENTS");
  if (body !== undefined) {
    if (
      !bodySchemas[collection].safeParse(body).success ||
      (operation === "create_resource" &&
        (Object.hasOwn(body, "id") ||
          (collection === "charts" && Object.hasOwn(body, "identifier")))) ||
      (id !== undefined &&
        ((body.id !== undefined && body.id !== id) ||
          (collection === "charts" &&
            body.identifier !== undefined &&
            body.identifier !== id))) ||
      (collection === "logentries" &&
        Array.isArray(body.telemetry) &&
        body.telemetry.some(
          (value) => !record(value) || !Object.hasOwn(value, "value"),
        ))
    )
      throw new GatewayError("INVALID_ARGUMENTS");
  }
  if (!context.requests || !context.http)
    throw new GatewayError("RESOURCE_MUTATION_UNAVAILABLE", 503);
  await providerCheck(context, collection, provider, method);
  const target = candidate(collection, provider, operation);
  const check = () => {
    if (writeIdentity().identifier !== principal.identifier)
      throw new GatewayError("PERMISSION_DENIED", 403);
    const decision = context.config.readRequests[reviewKey(target)]?.decision;
    if (decision === "rejected")
      throw new GatewayError("APPROVAL_REJECTED", 403);
    if (decision !== "approved") context.requests!.requestResource(target);
  };
  check();
  // Recheck registration and the saved review immediately before dispatch.
  await providerCheck(context, collection, provider, method);
  check();
  const path = `/signalk/v2/api/resources/${collection}${id === undefined ? "" : `/${id}`}?${new URLSearchParams({ provider })}`;
  const result = {
    capability: "api.resources",
    operation,
    collection,
    provider,
    submitted: true,
    retrySafe: false,
  };
  try {
    const response = await context.http(method, path, body);
    check();
    return {
      ...result,
      outcome: response.status === 202 ? "accepted" : "responded",
      statusCode: response.status,
      ...(response.data === undefined ? {} : { data: response.data }),
    };
  } catch (error) {
    return {
      ...result,
      outcome: "unknown",
      code:
        error instanceof GatewayError
          ? error.code
          : "RESOURCE_RESULT_UNAVAILABLE",
      ...(error instanceof GatewayError && error.code === "RESOURCE_HTTP_ERROR"
        ? { statusCode: error.status }
        : {}),
    };
  }
}
