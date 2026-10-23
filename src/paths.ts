import { z } from "zod";
const boundedPath = z.string().min(1).max(256);
const safeSegments = (path: string) =>
  !path
    .split(".")
    .some((part) => ["__proto__", "prototype", "constructor"].includes(part));

export const pathSchema = boundedPath
  .regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/)
  .refine(safeSegments, "Invalid path");

// Native notification providers can include parentheses in sensor names.
// This schema is only for registry records; caller telemetry/PUT paths retain
// their existing contract. Registry paths never enter an upstream URL.
export const notificationPathSchema = boundedPath
  .regex(/^notifications\.[a-zA-Z0-9_()-]+(?:\.[a-zA-Z0-9_()-]+)*(?![\s\S])/)
  .refine(safeSegments, "Invalid path");
