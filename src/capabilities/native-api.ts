import { z } from "zod";

// Verified native namespace metadata, not per-API execution adapters. Never use
// OpenAPI servers URLs as destinations or admit arbitrary advertised namespaces.
export const nativeApis = {
  course: { base: "/signalk/v2/api/vessels/self/navigation", root: "/course" },
  weather: { base: "/signalk/v2/api/weather", root: "" },
  autopilot: { base: "/signalk/v2/api/vessels/self/autopilots", root: "" },
  radar: { base: "/signalk/v2/api/vessels/self/radars", root: "" },
  ble: { base: "/signalk/v2/api/vessels/self/ble", root: "" },
  tracks: { base: "/signalk/v2/api/tracks", root: "" },
  sensors: { base: "/signalk/v2/api/vessels/self/sensors", root: "" },
} as const;
export const nativeApiSchema = z.enum([
  "course",
  "weather",
  "autopilot",
  "radar",
  "ble",
  "tracks",
  "sensors",
]);
export type NativeApi = z.infer<typeof nativeApiSchema>;
export function nativeApiPath(api: NativeApi, path: string): string | null {
  const { base, root } = nativeApis[api];
  const scope = base + root;
  const full = path.startsWith("/signalk/") ? path : base + path;
  if (full !== scope && !full.startsWith(scope + "/")) return null;
  if (
    !/^\/(?:[A-Za-z0-9_-]+|\{[A-Za-z][A-Za-z0-9_]*\})(?:\/(?:[A-Za-z0-9_-]+|\{[A-Za-z][A-Za-z0-9_]*\}))*\/?$/.test(
      full,
    )
  )
    return null;
  return full.replace(/\/$/, "");
}
export function nativeRouteAllowed(
  api: NativeApi,
  method: string,
  path: string,
): boolean {
  if (nativeApiPath(api, path) !== path) return false;
  if (method === "GET") return true;
  // Configuration changes and telemetry ingestion are outside gateway scope.
  return (
    !/(?:^|\/)(?:_?config|configuration|settings|_providers|gateway)(?:\/|$)/i.test(
      path,
    ) && api !== "sensors"
  );
}
// Runtime route check includes decoded parameter values, so encoding cannot
// escape the reviewed API namespace or turn a parameter into configuration.
export function isNativeApiRoute(method: string, route: string): boolean {
  const path = route.split("?", 1)[0]!;
  if (/[\r\n\\#]/.test(route)) return false;
  let decoded: string;
  try {
    decoded = path
      .split("/")
      .map((segment) => {
        const value = decodeURIComponent(segment);
        if (value && !/^[A-Za-z0-9_-][A-Za-z0-9_.:+-]*$/.test(value))
          throw new Error();
        return value;
      })
      .join("/");
  } catch {
    return false;
  }
  return nativeApiSchema.options.some((api) => {
    const scope = nativeApis[api].base + nativeApis[api].root;
    return (
      (decoded === scope || decoded.startsWith(scope + "/")) &&
      (method === "GET" ||
        (api !== "sensors" &&
          !/(?:^|\/)(?:_?config|configuration|settings|_providers|gateway)(?:\/|$)/i.test(
            decoded,
          )))
    );
  });
}
