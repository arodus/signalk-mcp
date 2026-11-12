import { z } from "zod";
import { pathSchema } from "./paths.js";

// Wildcards are approval selectors only. Commands still require an exact path.
// A literal root prevents a single rule from covering every telemetry namespace.
export const putPatternSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((pattern) => {
    const parts = pattern.split(".");
    return (
      parts.length > 1 &&
      pathSchema.safeParse(parts[0]).success &&
      parts.every(
        (part, index) =>
          part === "*" ||
          (part === "**" && index === parts.length - 1) ||
          (pathSchema.safeParse(part).success &&
            !part.includes(".") &&
            part !== "meta"),
      ) &&
      parts.some((part) => part === "*" || part === "**")
    );
  }, "Use a literal root, * for one segment, or trailing ** for descendants");
export const putRuleSchema = z
  .object({
    kind: z.literal("put-rule"),
    context: z.literal("vessels.self"),
    path: putPatternSchema,
    decision: z.enum(["pending", "approved", "rejected"]).default("pending"),
  })
  .strict();
export const putRuleMeaning =
  "Approves matching paths now and in the future, even if their settings change. Signal K permissions and current value limits still apply.";
export function matchesPutPattern(pattern: string, path: string): boolean {
  if (
    !putPatternSchema.safeParse(pattern).success ||
    !pathSchema.safeParse(path).success ||
    path.split(".").includes("meta")
  )
    return false;
  const wanted = pattern.split(".");
  const actual = path.split(".");
  for (let i = 0; i < wanted.length; i++) {
    if (wanted[i] === "**") return actual.length > i;
    if (
      actual[i] === undefined ||
      (wanted[i] !== "*" && wanted[i] !== actual[i])
    )
      return false;
  }
  return actual.length === wanted.length;
}
