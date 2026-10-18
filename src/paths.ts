import { z } from "zod";
export const pathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/)
  .refine(
    (path) =>
      !path
        .split(".")
        .some((part) =>
          ["__proto__", "prototype", "constructor"].includes(part),
        ),
    "Invalid path",
  );
