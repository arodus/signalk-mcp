import { z } from "zod";

// Collection names and resource IDs are single path segments, never URLs.
// Exclude control endpoints and prototype keys while preserving casing.
export const resourceCollectionSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
  .refine((name) => !["constructor", "prototype"].includes(name));
export const resourceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .refine((id) => !["constructor", "prototype"].includes(id));
export const standardResourceCollections = [
  "routes",
  "waypoints",
  "regions",
  "notes",
  "charts",
] as const;
export const isStandardResourceCollection = (name: string): boolean =>
  standardResourceCollections.some((value) => value === name);
