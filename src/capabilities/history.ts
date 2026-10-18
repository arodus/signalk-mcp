import { canRead, GatewayError, type App, type Principal } from "../auth.js";
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
  const from = Date.parse(input.from),
    to = Date.parse(input.to);
  if (
    from >= to ||
    to - from > 7 * 86400000 ||
    Math.ceil((to - from) / (input.resolution * 1000)) > 2000
  )
    throw new GatewayError("HISTORY_QUERY_LIMIT");
  const unique = new Set(
    input.paths.map((item) => `${item.path}|${item.source}`),
  );
  if (unique.size !== input.paths.length)
    throw new GatewayError("INVALID_ARGUMENTS");
  const check = () => {
    const principal = authorize();
    if (
      input.paths.some(
        (item) => !canRead(app, principal, item.path, item.source),
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
    from: input.from,
    to: input.to,
    resolution: String(input.resolution),
    provider: provider.id,
    paths: input.paths
      .map((item) => `${item.path}:${item.method}|${item.source}`)
      .join(","),
  });
  const response = await get(`/signalk/v2/api/history/values?${query}`);
  check();
  if (
    !record(response) ||
    !["vessels.self", app.selfContext].includes(response.context as string) ||
    !record(response.range) ||
    typeof response.range.from !== "string" ||
    typeof response.range.to !== "string" ||
    Date.parse(response.range.from) !== from ||
    Date.parse(response.range.to) !== to ||
    !Array.isArray(response.values) ||
    response.values.length !== input.paths.length ||
    !Array.isArray(response.data) ||
    response.data.length > 2000
  )
    throw new GatewayError("INVALID_HISTORY_RESPONSE");
  const columns = new Set<string>();
  const values = response.values.map((value) => {
    if (!record(value)) throw new GatewayError("INVALID_HISTORY_RESPONSE");
    const requested = input.paths.find(
      (item) =>
        item.path === value.path &&
        item.source === value.$source &&
        item.method === value.method,
    );
    if (!requested) throw new GatewayError("HISTORY_PROVENANCE_MISMATCH");
    const key = `${requested.path}|${requested.source}`;
    if (columns.has(key)) throw new GatewayError("INVALID_HISTORY_RESPONSE");
    columns.add(key);
    // Metadata does not derive units from numeric magnitude or from the model's
    // currently selected source. Standard path metadata is source-independent.
    const meta = app.getMetadata(`vessels.self.${requested.path}`);
    return {
      path: requested.path,
      source: requested.source,
      method: requested.method,
      unit: meta?.units ?? null,
    };
  });
  const data = response.data.map((row) => {
    if (
      !Array.isArray(row) ||
      row.length !== values.length + 1 ||
      typeof row[0] !== "string" ||
      !Number.isFinite(Date.parse(row[0])) ||
      Date.parse(row[0]) < from ||
      Date.parse(row[0]) > to
    )
      throw new GatewayError("INVALID_HISTORY_RESPONSE");
    return row;
  });
  return {
    context: "vessels.self",
    provider: provider.id,
    range: { from: input.from, to: input.to },
    resolutionSeconds: input.resolution,
    values,
    data,
    provenance: "Signal K History API; explicit source per column",
  };
}
