import { canRead, GatewayError, type App, type Principal } from "./auth.js";
import { pathSchema } from "./config.js";
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function leaf(value: unknown): value is Record<string, unknown> {
  return record(value) && Object.hasOwn(value, "value");
}
function sourceOf(node: Record<string, unknown>): string {
  return typeof node.$source === "string" ? node.$source : "";
}
export function listPaths(
  app: App,
  principal: Principal,
  prefix: string,
  offset: number,
  limit: number,
) {
  const paths: string[] = [];
  let visited = 0;
  const walk = (node: unknown, path: string, depth: number) => {
    if (++visited > 20000 || depth > 32)
      throw new GatewayError("MODEL_SCAN_LIMIT");
    if (leaf(node)) {
      if (
        pathSchema.safeParse(path).success &&
        (!prefix || path === prefix || path.startsWith(prefix + ".")) &&
        canRead(app, principal, path, sourceOf(node))
      )
        paths.push(path);
      return;
    }
    if (!record(node)) return;
    for (const key of Object.keys(node)) {
      if (
        ["meta", "values", "__proto__", "prototype", "constructor"].includes(
          key,
        ) ||
        key.startsWith("$")
      )
        continue;
      const next = path ? `${path}.${key}` : key;
      if (
        !prefix ||
        next === prefix ||
        next.startsWith(prefix + ".") ||
        prefix.startsWith(next + ".")
      )
        walk(node[key], next, depth + 1);
    }
  };
  walk(app.getPath(app.selfContext), "", 0);
  paths.sort();
  return {
    context: "vessels.self",
    paths: paths.slice(offset, offset + limit),
    nextOffset: offset + limit < paths.length ? offset + limit : null,
  };
}
export function getValues(
  app: App,
  principal: Principal,
  paths: string[],
  staleAfterSeconds: number,
) {
  const now = Date.now();
  return {
    context: "vessels.self",
    observedAt: new Date(now).toISOString(),
    measurements: paths.map((path) => {
      const node = app.getSelfPath(path);
      // Missing and inaccessible paths are indistinguishable to prevent enumeration.
      if (!leaf(node) || !canRead(app, principal, path, sourceOf(node)))
        return { path, status: "unavailable" };
      const timestamp =
        typeof node.timestamp === "string" ? node.timestamp : null;
      const parsed = timestamp === null ? NaN : Date.parse(timestamp);
      const ageSeconds = Number.isFinite(parsed) ? (now - parsed) / 1000 : null;
      const meta = record(node.meta) ? node.meta : {};
      return {
        path,
        status:
          node.value === null || node.value === undefined ? "missing" : "ok",
        value: node.value ?? null,
        unit: typeof meta.units === "string" ? meta.units : null,
        timestamp,
        source: sourceOf(node) || null,
        ageSeconds,
        freshness:
          ageSeconds === null || ageSeconds < 0
            ? "unknown"
            : ageSeconds > staleAfterSeconds
              ? "stale"
              : "fresh",
        staleAfterSeconds,
        metadata: Object.fromEntries(
          ["description", "displayName", "longName"]
            .filter((key) => typeof meta[key] === "string")
            .map((key) => [key, meta[key]]),
        ),
      };
    }),
  };
}
