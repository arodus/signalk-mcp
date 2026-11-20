import { z } from "zod";
import { authenticate, canRead, GatewayError, type App } from "./auth.js";
import type { Config } from "./config.js";
import { getValues, record } from "./data.js";
import { boundedJson } from "./json.js";
import { pathSchema } from "./paths.js";

export const executionInput = z
  .object({
    code: z
      .string()
      .min(1)
      .max(32 * 1024),
    paths: z.array(pathSchema).min(1).max(64),
  })
  .strict();

interface SandboxApi {
  runSandboxJob(
    request: {
      ownerPluginId: string;
      image: string;
      runnerPath: string;
      stdin: Uint8Array;
    },
    options: { signal: AbortSignal },
  ): Promise<unknown>;
}
// Experimental upstream shared bus; kept isolated from native gateway APIs.
function containerApi(): SandboxApi {
  const value = (
    globalThis as typeof globalThis & { __signalk_containerManager?: unknown }
  ).__signalk_containerManager;
  if (!record(value) || typeof value.runSandboxJob !== "function")
    throw new GatewayError("EXECUTION_UNAVAILABLE", 503);
  return value as unknown as SandboxApi;
}
const resultSchema = z.object({
  id: z.string().nullable(),
  status: z.enum([
    "completed",
    "failed",
    "deadline-exceeded",
    "output-limit",
    "isolation-unavailable",
    "cancelled",
    "runtime-error",
    "busy",
    "rate-limited",
  ]),
  exitCode: z.number().int().nullable(),
  oomKilled: z.boolean().nullable(),
  cleanup: z.enum(["not-created", "removed", "pending"]),
  output: z
    .instanceof(Uint8Array)
    .refine((value) => value.byteLength <= 256 * 1024),
});

export async function executeCode(
  app: App,
  bearer: string,
  config: Config,
  running: () => boolean,
  input: unknown,
  signal: AbortSignal,
) {
  if (
    !config.experimentalExecution?.enabled ||
    !config.experimentalExecution.image
  )
    throw new GatewayError("EXECUTION_DISABLED", 403);
  const args = executionInput.safeParse(input);
  if (!args.success) throw new GatewayError("INVALID_ARGUMENTS");
  const principal = authenticate(app, bearer);
  const authorize = () => {
    if (!running() || signal.aborted)
      throw new GatewayError("EXECUTION_CANCELLED");
    const current = authenticate(app, bearer);
    if (
      current.permissions !== "admin" ||
      current.identifier !== principal.identifier
    )
      throw new GatewayError("PERMISSION_DENIED", 403);
    return current;
  };
  authorize();
  const api = containerApi();
  const snapshot = getValues(
    app,
    principal,
    args.data.paths,
    config.staleAfterSeconds,
  );
  if (snapshot.measurements.some((value) => value.status === "unavailable"))
    throw new GatewayError("SNAPSHOT_UNAVAILABLE", 403);
  const recheck = () => {
    const current = authorize();
    for (const value of snapshot.measurements) {
      if (!canRead(app, current, value.path, value.source ?? ""))
        throw new GatewayError("PERMISSION_DENIED", 403);
    }
  };
  // Serialize now: the worker receives copies, never live model references.
  const stdin = Buffer.from(
    boundedJson(
      { version: 1, code: args.data.code, data: snapshot },
      1024 * 1024,
      "EXECUTION_INPUT_LIMIT",
    ),
  );
  recheck();
  let raw: unknown;
  try {
    raw = await api.runSandboxJob(
      {
        ownerPluginId: "signalk-mcp",
        image: config.experimentalExecution.image,
        runnerPath: "/usr/local/bin/signalk-mcp-worker",
        stdin,
      },
      { signal },
    );
  } catch {
    recheck();
    return {
      kind: "execution-result",
      outcome: "unknown",
      retrySafe: false,
      code: "EXECUTION_RESULT_UNAVAILABLE",
    };
  }
  recheck();
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success)
    return {
      kind: "execution-result",
      outcome: "unknown",
      retrySafe: false,
      code: "EXECUTION_RESULT_UNAVAILABLE",
    };
  const { output, ...result } = parsed.data;
  // Binary output is never trusted as protocol. Base64 preserves combined stream
  // bytes without JSON escaping expansion or interpreting worker claims.
  const response = {
    kind: "execution-result",
    retrySafe: false,
    ...result,
    outputEncoding: "base64",
    output: Buffer.from(output).toString("base64"),
  };
  boundedJson(response, 384 * 1024, "EXECUTION_OUTPUT_LIMIT");
  return response;
}
