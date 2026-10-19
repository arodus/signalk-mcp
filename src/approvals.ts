import { createHash } from "node:crypto";
import { z } from "zod";
import { GatewayError, type Principal } from "./auth.js";
import {
  pluginIdSchema,
  operationIdSchema,
  routeSchema,
} from "./capabilities/schemas.js";
import type { DiscoveredOperation } from "./capabilities/openapi.js";
import { pathSchema } from "./paths.js";
import type { PutTarget } from "./put-types.js";
import { boundedJson } from "./json.js";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const readReviewSchema = z
  .object({
    pluginId: pluginIdSchema.refine((id) => id !== "signalk-mcp"),
    operationId: operationIdSchema,
    path: routeSchema,
    schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
    description: z.string().max(256),
    decision: z.enum(["pending", "approved", "rejected"]).default("pending"),
    permission: z.enum(["readonly", "admin"]).default("readonly"),
  })
  .strict();
type ReadReview = z.infer<typeof readReviewSchema>;

// PUT approvals bind provider metadata and value constraints, so key order must
// not change their identity. Keep the legacy GET digest unchanged.
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 24) throw new Error("Invalid review metadata");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (
    value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalJson(item, depth + 1)}`,
      )
      .join(",")}}`;
  throw new Error("Invalid review metadata");
}
function putBinding(metadata: unknown, inputSchema: unknown): string {
  boundedJson([metadata, inputSchema], 32768, "METADATA_LIMIT");
  const json = canonicalJson([metadata, inputSchema]);
  if (Buffer.byteLength(json, "utf8") > 32768)
    throw new Error("Excessive review metadata");
  return createHash("sha256").update(json).digest("hex");
}
const putReviewSchema = z
  .object({
    kind: z.literal("put"),
    context: z.literal("vessels.self"),
    path: pathSchema,
    source: z
      .string()
      .min(1)
      .max(256)
      .refine((source) => !/[\s*?[\]\p{Cc}]/u.test(source)),
    metadata: z.record(z.unknown()),
    inputSchema: z.record(z.unknown()),
    schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["pending", "approved", "rejected"]).default("pending"),
  })
  .strict()
  .refine((review) => {
    try {
      return (
        review.schemaHash === putBinding(review.metadata, review.inputSchema)
      );
    } catch {
      return false;
    }
  }, "Invalid PUT metadata or schema binding");
export type PutReview = z.infer<typeof putReviewSchema>;
const postReviewSchema = z
  .object({
    kind: z.literal("post"),
    pluginId: pluginIdSchema.refine((id) => id !== "signalk-mcp"),
    operationId: operationIdSchema,
    method: z.literal("POST"),
    path: routeSchema,
    description: z.string().max(4096),
    inputSchema: z.record(z.unknown()),
    contractHash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["pending", "approved", "rejected"]).default("pending"),
  })
  .strict()
  .refine((review) => {
    try {
      boundedJson(review.inputSchema, 32768);
      return true;
    } catch {
      return false;
    }
  });
export const reviewSchema = z.union([
  readReviewSchema,
  putReviewSchema,
  postReviewSchema,
]);
export type Review = z.infer<typeof reviewSchema>;
export function reviewKey(review: Review): string {
  if ("kind" in review && review.kind === "post")
    return digest([
      "POST",
      review.pluginId,
      review.operationId,
      review.path,
      review.contractHash,
      review.description,
      canonicalJson(review.inputSchema),
    ]);
  if ("kind" in review && review.kind === "put")
    return digest([
      "PUT",
      review.context,
      review.path,
      review.source,
      review.schemaHash,
    ]);
  return digest([
    review.pluginId,
    review.operationId,
    "GET",
    review.path,
    review.schemaHash,
    review.description,
  ]);
}
export const reviewsSchema = z
  .record(z.string().regex(/^[a-f0-9]{64}$/), reviewSchema)
  .refine(
    (reviews) =>
      Object.keys(reviews).length <= 64 &&
      Object.entries(reviews).every(
        ([key, review]) => key === reviewKey(review),
      ),
    "Invalid or excessive operation reviews",
  );
function candidate(
  pluginId: string,
  operation: DiscoveredOperation,
): ReadReview | z.infer<typeof postReviewSchema> {
  if (operation.method === "POST" && operation.input && operation.inputSchema)
    return postReviewSchema.parse({
      kind: "post",
      method: "POST",
      pluginId,
      operationId: operation.id,
      path: operation.path,
      description: operation.description,
      inputSchema: operation.inputSchema,
      contractHash: operation.contractHash,
      decision: "pending",
    });
  if (
    operation.method !== "GET" ||
    !operation.input ||
    !operation.inputSchema ||
    !routeSchema.safeParse(operation.path).success
  )
    throw new GatewayError("OPERATION_DISABLED", 403);
  return readReviewSchema.parse({
    pluginId,
    operationId: operation.id,
    path: operation.path,
    schemaHash: digest(operation.inputSchema),
    description: operation.description,
    decision: "pending",
    permission: "readonly",
  });
}

export function putReview(target: PutTarget): PutReview {
  try {
    const schemaHash = putBinding(target.metadata, target.inputSchema);
    return putReviewSchema.parse({
      kind: "put",
      context: target.context,
      path: target.path,
      source: target.source,
      metadata: structuredClone(target.metadata),
      inputSchema: structuredClone(target.inputSchema),
      schemaHash,
      decision: "pending",
    });
  } catch {
    throw new GatewayError("OPERATION_DISABLED", 403);
  }
}

// Administrative review metadata only: no arguments, tokens or provider values.
// Pending requests stay in memory until the admin saves the native settings form.
export class ApprovalRequests {
  private reviews: Record<string, Review> = {};
  reset(reviews: Record<string, Review> = {}) {
    this.reviews = structuredClone(reviews);
  }
  request(pluginId: string, operation: DiscoveredOperation): never {
    if (operation.reason !== "NOT_ALLOWLISTED")
      throw new GatewayError("OPERATION_DISABLED", 403);
    return this.enqueue(candidate(pluginId, operation));
  }
  requestPut(target: PutTarget): never {
    return this.enqueue(putReview(target));
  }
  private enqueue(review: Review): never {
    const key = reviewKey(review);
    if (!this.reviews[key]) {
      if (Object.keys(this.reviews).length >= 64)
        throw new GatewayError("APPROVAL_QUEUE_FULL", 429);
      this.reviews[key] = review;
    }
    throw new GatewayError(
      this.reviews[key].decision === "rejected"
        ? "APPROVAL_REJECTED"
        : "APPROVAL_PENDING",
      403,
    );
  }
  schema() {
    return {
      type: "object",
      title: "Operation requests",
      additionalProperties: false,
      description:
        "Refresh this page after a blocked MCP request. Review each GET, POST or exact native PUT target, select Accept or Reject, then Save Configuration. PUTs can change vessel state; check the source, meaning and value constraints. Signal K permissions still apply. Unsaved requests are lost when the plugin restarts. Up to 64 requests are retained.",
      properties: Object.fromEntries(
        Object.entries(this.reviews).map(([key, review]) => [
          key,
          {
            type: "object",
            title:
              "kind" in review && review.kind === "put"
                ? `Native PUT: ${review.path}`
                : `${review.pluginId}: ${review.operationId}`,
            description:
              "kind" in review && review.kind === "put"
                ? `PUT ${review.context}:${review.path} — source ${review.source}. Metadata: ${canonicalJson(review.metadata)}. Value constraints: ${canonicalJson(review.inputSchema)}`
                : `${"kind" in review ? "POST" : "GET"} ${review.path}${review.description ? ` — ${review.description}` : ""}${"kind" in review ? `; input ${canonicalJson(review.inputSchema)}` : ""}`,
            default: structuredClone(review),
            additionalProperties: false,
            required: Object.keys(review),
            properties: {
              ...Object.fromEntries(
                Object.entries(review)
                  .filter(([field]) => field !== "decision")
                  .map(([field, value]) => [
                    field,
                    {
                      type: typeof value === "object" ? "object" : "string",
                      const: structuredClone(value),
                      default: structuredClone(value),
                      readOnly: true,
                    },
                  ]),
              ),
              decision: {
                type: "string",
                title: "Decision",
                default: review.decision,
                oneOf: [
                  { const: "pending", title: "Pending review" },
                  { const: "approved", title: "Accept" },
                  { const: "rejected", title: "Reject" },
                ],
              },
            },
          },
        ]),
      ),
    };
  }
  uiSchema() {
    return Object.fromEntries(
      Object.entries(this.reviews).map(([key, review]) => [
        key,
        Object.fromEntries(
          Object.keys(review)
            .filter((field) => field !== "decision")
            .map((field) => [
              field,
              { "ui:widget": "hidden", "ui:options": { label: false } },
            ]),
        ),
      ]),
    );
  }
}
export function applyReviews(
  operations: DiscoveredOperation[],
  pluginId: string,
  reviews: Record<string, Review>,
  principal: Principal,
): DiscoveredOperation[] {
  for (const operation of operations) {
    if (
      ![null, "NOT_ALLOWLISTED", "PERMISSION_DENIED"].includes(operation.reason)
    )
      continue;
    const review = reviews[reviewKey(candidate(pluginId, operation))];
    if (!review || ("kind" in review && review.kind !== "post")) continue;
    if ("kind" in review) {
      operation.permission = "readwrite";
      operation.enabled =
        review.decision === "approved" &&
        ["readwrite", "admin"].includes(principal.permissions);
      operation.reason =
        review.decision === "rejected"
          ? "APPROVAL_REJECTED"
          : review.decision !== "approved"
            ? "NOT_ALLOWLISTED"
            : operation.enabled
              ? null
              : "PERMISSION_DENIED";
      continue;
    }
    if (review.decision === "rejected") {
      operation.enabled = false;
      operation.reason = "APPROVAL_REJECTED";
    } else if (review.decision === "approved") {
      // When both approval forms exist, keep the stricter requirement.
      operation.permission =
        operation.permission === "admin" ? "admin" : review.permission;
      operation.enabled =
        operation.permission === "readonly" ||
        principal.permissions === "admin";
      operation.reason = operation.enabled ? null : "PERMISSION_DENIED";
    }
  }
  return operations;
}

export function applyPutReview(
  target: PutTarget,
  reviews: Record<string, Review>,
  principal: Principal,
): {
  enabled: boolean;
  reason: string | null;
} {
  const key = reviewKey(putReview(target));
  const parsed = putReviewSchema.safeParse(reviews[key]);
  if (!parsed.success || reviewKey(parsed.data) !== key)
    return {
      enabled: false,
      reason: "NOT_ALLOWLISTED",
    };
  const review = parsed.data;
  if (review.decision === "rejected")
    return {
      enabled: false,
      reason: "APPROVAL_REJECTED",
    };
  if (review.decision !== "approved")
    return {
      enabled: false,
      reason: "NOT_ALLOWLISTED",
    };
  const enabled = ["readwrite", "admin"].includes(principal.permissions);
  return {
    enabled,
    reason: enabled ? null : "PERMISSION_DENIED",
  };
}
