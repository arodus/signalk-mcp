import {
  canRead,
  canReadAllSources,
  GatewayError,
  type App,
  type Principal,
} from "../auth.js";
import { record } from "../data.js";
import type { LocalGet } from "./http.js";
import { pluginIdSchema, type HistoryInput } from "./schemas.js";

export async function historyProviders(
  get: LocalGet,
): Promise<{ id: string; isDefault: boolean }[]> {
  const response = await get("/signalk/v2/api/history/_providers");
  if (!record(response) || Object.keys(response).length > 64)
    throw new GatewayError("INVALID_HISTORY_PROVIDERS");
  return Object.entries(response).map(([id, value]) => {
    if (
      !pluginIdSchema.safeParse(id).success ||
      !record(value) ||
      typeof value.isDefault !== "boolean"
    )
      throw new GatewayError("INVALID_HISTORY_PROVIDERS");
    return { id, isDefault: value.isDefault };
  });
}
export async function getHistory(
  app: App,
  authorize: () => Principal,
  get: LocalGet,
  input: HistoryInput,
) {
  const started = Date.now();
  const from = input.from === undefined ? undefined : Date.parse(input.from);
  const to = input.to === undefined ? undefined : Date.parse(input.to);
  const duration =
    input.duration === undefined ? undefined : input.duration * 1000;
  if (
    (from === undefined && duration === undefined) ||
    (from !== undefined && to !== undefined && duration !== undefined)
  )
    throw new GatewayError("INVALID_ARGUMENTS");
  // This arithmetic bounds the request, never transforms provider data.
  const span = duration ?? (to ?? started) - (from ?? started);
  if (
    span <= 0 ||
    span > 7 * 86400000 ||
    (input.resolution !== undefined &&
      Math.ceil(span / (input.resolution * 1000)) > 2000)
  )
    throw new GatewayError("HISTORY_QUERY_LIMIT");
  const unique = new Set(
    input.paths.map(
      (item) => `${item.path}:${method(item)}|${item.source ?? ""}`,
    ),
  );
  if (unique.size !== input.paths.length)
    throw new GatewayError("INVALID_ARGUMENTS");
  const check = () => {
    const principal = authorize();
    if (
      input.paths.some((item) =>
        item.source === undefined
          ? !canReadAllSources(app, principal, item.path)
          : !canRead(app, principal, item.path, item.source),
      )
    )
      throw new GatewayError("PERMISSION_DENIED", 403);
  };
  check();
  const providers = await historyProviders(get);
  const provider = input.provider
    ? providers.find((p) => p.id === input.provider)
    : providers.find((p) => p.isDefault);
  if (!provider) throw new GatewayError("HISTORY_UNAVAILABLE");
  check();
  const query = new URLSearchParams({
    context: "vessels.self",
    provider: provider.id,
    paths: input.paths
      .map(
        (item) =>
          `${item.path}${item.method === undefined ? "" : `:${item.method}`}${item.source === undefined ? "" : `|${item.source}`}`,
      )
      .join(","),
  });
  for (const key of ["from", "to", "duration", "resolution"] as const)
    if (input[key] !== undefined) query.set(key, String(input[key]));
  const response = await get(`/signalk/v2/api/history/values?${query}`);
  check();
  if (
    !record(response) ||
    !["vessels.self", app.selfContext].includes(response.context as string) ||
    !record(response.range) ||
    typeof response.range.from !== "string" ||
    typeof response.range.to !== "string" ||
    !Array.isArray(response.values) ||
    response.values.length !== input.paths.length ||
    !Array.isArray(response.data) ||
    response.data.length > 2000
  )
    throw new GatewayError("INVALID_HISTORY_RESPONSE");
  const resultFrom = Date.parse(response.range.from);
  const resultTo = Date.parse(response.range.to);
  if (
    !Number.isFinite(resultFrom) ||
    !Number.isFinite(resultTo) ||
    resultFrom >= resultTo ||
    resultTo - resultFrom > 7 * 86400000 ||
    (from !== undefined && resultFrom !== from) ||
    (to !== undefined && resultTo !== to) ||
    (duration !== undefined && resultTo - resultFrom !== duration) ||
    // Without an anchored end, the provider resolves 'now' during this call.
    (to === undefined &&
      (from === undefined || duration === undefined) &&
      (resultTo < started - 1000 || resultTo > Date.now() + 1000))
  )
    throw new GatewayError("INVALID_HISTORY_RESPONSE");
  if (response.values.some((value) => !record(value)))
    throw new GatewayError("INVALID_HISTORY_RESPONSE");
  // Validate the column multiset, matching explicit labels first. Unlabelled
  // columns need no inferred source: every requested filter was authorized and
  // the original response is forwarded without attributing columns to sources.
  const remaining = [...input.paths].sort(
    (a, b) => Number(a.source === undefined) - Number(b.source === undefined),
  );
  const columns = [...response.values].sort(
    (a, b) => Number(a.$source === undefined) - Number(b.$source === undefined),
  );
  for (const value of columns) {
    if (
      value.$source !== undefined &&
      (typeof value.$source !== "string" || !value.$source)
    )
      throw new GatewayError("HISTORY_PROVENANCE_MISMATCH");
    const index = remaining.findIndex(
      (item) =>
        item.path === value.path &&
        method(item) === value.method &&
        (value.$source === undefined ||
          item.source === undefined ||
          item.source === value.$source),
    );
    if (index === -1) throw new GatewayError("HISTORY_PROVENANCE_MISMATCH");
    remaining.splice(index, 1);
  }
  for (const row of response.data) {
    if (
      !Array.isArray(row) ||
      row.length !== response.values.length + 1 ||
      typeof row[0] !== "string" ||
      !Number.isFinite(Date.parse(row[0]))
    )
      throw new GatewayError("INVALID_HISTORY_RESPONSE");
  }
  // Providers may label buckets before `from`. Preserve their timestamps,
  // metadata, nulls and values; do not add units or synthesize source fields.
  return response;
}

function method(item: HistoryInput["paths"][number]): string {
  return (
    item.method ?? (item.path === "navigation.position" ? "first" : "average")
  );
}
