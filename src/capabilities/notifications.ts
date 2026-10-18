import { isDeepStrictEqual } from "node:util";
import {
  canRead,
  canReadAllSources,
  GatewayError,
  type App,
  type Principal,
} from "../auth.js";
import { record } from "../data.js";
import { pathSchema } from "../paths.js";
import type { LocalGet } from "./http.js";

// The public v2 collection omits source metadata on supported servers. Never
// treat an empty source ACL check as permission for an unidentified source.
// Correlate the complete value against the native model only for authorization;
// the returned record is always the unmodified HTTP response record.
function visible(
  app: App,
  principal: Principal,
  entry: Record<string, unknown>,
) {
  const context =
    entry.context === "" || entry.context === app.selfContext
      ? "vessels.self"
      : (entry.context as string);
  if (
    !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9:_-]+$/.test(context) ||
    context
      .split(".")
      .some((part) => ["__proto__", "prototype", "constructor"].includes(part))
  )
    return false;
  const path = entry.path as string;
  if (canReadAllSources(app, principal, path, context)) return true;
  const node = app.getPath(
    `${context === "vessels.self" ? app.selfContext : context}.${path}`,
  );
  if (!record(node)) return false;
  const sources = new Set<string>();
  if (
    typeof node.$source === "string" &&
    node.$source &&
    isDeepStrictEqual(node.value, entry.value)
  )
    sources.add(node.$source);
  if (record(node.values)) {
    const values = Object.entries(node.values);
    if (values.length > 256) return false;
    for (const [source, value] of values)
      if (
        source &&
        record(value) &&
        isDeepStrictEqual(value.value, entry.value)
      )
        sources.add(source);
  }
  // Ambiguous identical values must be authorized for every matching source.
  return (
    sources.size > 0 &&
    [...sources].every((source) =>
      canRead(app, principal, path, source, context),
    )
  );
}

async function readRegistry(
  app: App,
  authorize: () => Principal,
  get: LocalGet,
) {
  authorize();
  const response = await get("/signalk/v2/api/notifications");
  const principal = authorize();
  if (!record(response) || Object.keys(response).length > 20000)
    throw new GatewayError("INVALID_NOTIFICATIONS_RESPONSE");
  const entries = Object.entries(response);
  for (const [id, entry] of entries) {
    if (
      !id ||
      id.length > 256 ||
      !record(entry) ||
      typeof entry.context !== "string" ||
      entry.context.length > 256 ||
      typeof entry.path !== "string" ||
      !entry.path.startsWith("notifications.") ||
      !pathSchema.safeParse(entry.path).success ||
      !record(entry.value)
    )
      throw new GatewayError("INVALID_NOTIFICATIONS_RESPONSE");
  }
  return entries
    .filter(([, entry]) =>
      visible(app, principal, entry as Record<string, unknown>),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function listNotifications(
  app: App,
  authorize: () => Principal,
  get: LocalGet,
  input: { offset: number; limit: number },
) {
  const entries = await readRegistry(app, authorize, get);
  return {
    registry: "v2",
    notifications: Object.fromEntries(
      entries.slice(input.offset, input.offset + input.limit),
    ),
    nextOffset:
      input.offset + input.limit < entries.length
        ? input.offset + input.limit
        : null,
  };
}

export async function getNotification(
  app: App,
  authorize: () => Principal,
  get: LocalGet,
  id: string,
) {
  // Use the collection for both operations: manager-disabled servers can use
  // non-UUID IDs and do not support GET /:id. No caller input enters the URL.
  const entry = (await readRegistry(app, authorize, get)).find(
    ([key]) => key === id,
  );
  if (!entry) throw new GatewayError("NOTIFICATION_UNAVAILABLE", 404);
  return { registry: "v2", id: entry[0], notification: entry[1] };
}
