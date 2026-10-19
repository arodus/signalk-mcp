import { createHash } from "node:crypto";
import { z } from "zod";
import { GatewayError, type Principal } from "./auth.js";
import {
  pluginIdSchema,
  operationIdSchema,
  routeSchema,
} from "./capabilities/schemas.js";
import type { DiscoveredOperation } from "./capabilities/openapi.js";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const reviewSchema = z
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
export type Review = z.infer<typeof reviewSchema>;
export function reviewKey(review: Review): string {
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
    "Invalid or excessive plugin read reviews",
  );
function candidate(pluginId: string, operation: DiscoveredOperation): Review {
  if (
    operation.method !== "GET" ||
    !operation.input ||
    !operation.inputSchema ||
    !routeSchema.safeParse(operation.path).success
  )
    throw new GatewayError("OPERATION_DISABLED", 403);
  return reviewSchema.parse({
    pluginId,
    operationId: operation.id,
    path: operation.path,
    schemaHash: digest(operation.inputSchema),
    description: operation.description,
    decision: "pending",
    permission: "readonly",
  });
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
    const review = candidate(pluginId, operation);
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
      title: "Plugin read requests",
      additionalProperties: false,
      description:
        "Refresh this page after a blocked MCP request. Review each endpoint, select Approve or Reject, then Save Configuration. Approve only reads without side effects. Unsaved requests are lost when the plugin restarts. Up to 64 requests are retained.",
      properties: Object.fromEntries(
        Object.entries(this.reviews).map(([key, review]) => [
          key,
          {
            type: "object",
            title: `${review.pluginId}: ${review.operationId}`,
            description: `GET ${review.path}${review.description ? ` — ${review.description}` : ""}`,
            default: structuredClone(review),
            additionalProperties: false,
            required: [
              "pluginId",
              "operationId",
              "path",
              "schemaHash",
              "description",
              "decision",
              "permission",
            ],
            properties: {
              ...Object.fromEntries(
                [
                  "pluginId",
                  "operationId",
                  "path",
                  "schemaHash",
                  "description",
                ].map((field) => [
                  field,
                  {
                    type: "string",
                    const: review[field as keyof Review],
                    default: review[field as keyof Review],
                  },
                ]),
              ),
              decision: {
                type: "string",
                title: "Decision",
                default: review.decision,
                oneOf: [
                  { const: "pending", title: "Pending review" },
                  { const: "approved", title: "Approve — confirmed read-only" },
                  { const: "rejected", title: "Reject" },
                ],
              },
              permission: {
                type: "string",
                title: "Who may use this read",
                default: review.permission,
                oneOf: [
                  {
                    const: "readonly",
                    title: "Readers (Signal K permissions still apply)",
                  },
                  { const: "admin", title: "Administrators only" },
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
      Object.keys(this.reviews).map((key) => [
        key,
        Object.fromEntries(
          ["pluginId", "operationId", "path", "schemaHash", "description"].map(
            (field) => [
              field,
              { "ui:widget": "hidden", "ui:options": { label: false } },
            ],
          ),
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
    if (!review) continue;
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
