import { z } from "zod";
import { GatewayError, type Principal } from "../auth.js";
import { record } from "../data.js";
import { boundedJson } from "../json.js";
import type { LocalGet } from "./http.js";
import { pluginIdSchema } from "./schemas.js";

const root = "/signalk/v2/api/resources";
const standardCollections = [
  "routes",
  "waypoints",
  "regions",
  "notes",
  "charts",
] as const;
const collection = z.enum([...standardCollections, "logentries"]);
const collectionName = z
  .string()
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
  .refine((name) => !["constructor", "prototype"].includes(name));
const resourceId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .refine((id) => !["constructor", "prototype"].includes(id));
const date = z.string().date();
const datetime = z.string().datetime({ offset: true });
const longitude = z.number().finite().min(-180).max(180);
const latitude = z.number().finite().min(-90).max(90);
const bbox = z.tuple([longitude, latitude, longitude, latitude]);
const filter = z.string().max(256);
const provider = pluginIdSchema.optional();
export const resourceProvidersInput = z
  .object({ collection: collectionName })
  .strict();
export const resourceInput = z
  .object({ collection, id: resourceId, provider })
  .strict();
export const resourcesInput = z
  .object({
    collection: z.enum(standardCollections),
    provider,
    limit: z.number().int().min(1).max(500).optional(),
    bbox: bbox.optional(),
    distance: z.number().int().min(100).max(20000000).optional(),
    position: z.tuple([longitude, latitude]).optional(),
    zoom: z.number().int().min(1).max(30).optional(),
    href: z
      .string()
      .max(256)
      .regex(
        /^\/resources\/(?:routes|waypoints|regions|notes|charts)\/[A-Za-z0-9][A-Za-z0-9_-]*$/,
      )
      .optional(),
  })
  .strict();
export const logentriesInput = z
  .object({
    provider,
    date: date.optional(),
    from: datetime.optional(),
    to: datetime.optional(),
    limit: z.number().int().min(1).max(500).optional(),
    bbox: bbox.optional(),
    category: filter.optional(),
    origin: filter.optional(),
    author: filter.optional(),
  })
  .strict();
export const logentryDatesInput = z
  .object({
    provider,
    date: date.optional(),
    from: datetime.optional(),
    to: datetime.optional(),
  })
  .strict();

type Authorize = () => Principal;
async function read(authorize: Authorize, get: LocalGet, path: string) {
  const principal = authorize();
  const result = await get(path);
  const after = authorize();
  if (after.identifier !== principal.identifier)
    throw new GatewayError("PERMISSION_DENIED", 403);
  boundedJson(result, 224 * 1024, "OUTPUT_LIMIT");
  return result;
}

export async function listResourceCollections(
  authorize: Authorize,
  get: LocalGet,
) {
  const data = await read(authorize, get, root);
  if (
    !record(data) ||
    Object.keys(data).length > 64 ||
    Object.entries(data).some(
      ([name, value]) =>
        !collectionName.safeParse(name).success ||
        !record(value) ||
        typeof value.description !== "string" ||
        value.description.length > 1024,
    )
  )
    throw new GatewayError("INVALID_RESOURCE_COLLECTIONS");
  return {
    collections: data,
    supportedCollections: Object.keys(data).filter(
      (name) => collection.safeParse(name).success,
    ),
  };
}
export async function listResourceProviders(
  authorize: Authorize,
  get: LocalGet,
  name: string,
) {
  const { collections } = await listResourceCollections(authorize, get);
  if (!Object.hasOwn(collections, name))
    throw new GatewayError("RESOURCE_COLLECTION_UNAVAILABLE");
  const providers = await read(authorize, get, `${root}/${name}/_providers`);
  if (
    !Array.isArray(providers) ||
    providers.length > 64 ||
    new Set(providers).size !== providers.length ||
    providers.some((id) => !pluginIdSchema.safeParse(id).success)
  )
    throw new GatewayError("INVALID_RESOURCE_PROVIDERS");
  return { collection: name, providers: providers as string[] };
}
async function selectProvider(
  authorize: Authorize,
  get: LocalGet,
  name: string,
  requested?: string,
) {
  const { providers } = await listResourceProviders(authorize, get, name);
  if (requested && providers.includes(requested)) return requested;
  if (requested || providers.length === 0)
    throw new GatewayError("RESOURCE_PROVIDER_UNAVAILABLE");
  if (providers.length !== 1)
    throw new GatewayError("RESOURCE_PROVIDER_REQUIRED");
  return providers[0]!;
}
async function fetchResource(
  authorize: Authorize,
  get: LocalGet,
  name: string,
  requested: string | undefined,
  query: URLSearchParams,
  id?: string,
) {
  const selected = await selectProvider(authorize, get, name, requested);
  query.set("provider", selected);
  const data = await read(
    authorize,
    get,
    `${root}/${name}${id === undefined ? "" : `/${id}`}?${query}`,
  );
  if (!record(data)) throw new GatewayError("INVALID_RESOURCE_RESPONSE");
  return { collection: name, provider: selected, data };
}
function checkCollection(data: Record<string, unknown>, limit = 500) {
  if (Object.keys(data).length > limit)
    throw new GatewayError("RESOURCE_RESULT_LIMIT");
  if (
    Object.entries(data).some(
      ([id, value]) => !resourceId.safeParse(id).success || !record(value),
    )
  )
    throw new GatewayError("INVALID_RESOURCE_RESPONSE");
}
export async function getResource(
  authorize: Authorize,
  get: LocalGet,
  input: z.infer<typeof resourceInput>,
) {
  if (
    input.collection === "logentries" &&
    !z.string().uuid().safeParse(input.id).success
  )
    throw new GatewayError("INVALID_ARGUMENTS");
  return fetchResource(
    authorize,
    get,
    input.collection,
    input.provider,
    new URLSearchParams(),
    input.id,
  );
}
export async function listResources(
  authorize: Authorize,
  get: LocalGet,
  input: z.infer<typeof resourcesInput>,
) {
  const { collection: name, provider: selected, ...filters } = input;
  if (
    (name === "charts" &&
      Object.values(filters).some((v) => v !== undefined)) ||
    (name !== "notes" && filters.href !== undefined) ||
    (filters.position !== undefined && filters.distance === undefined)
  )
    throw new GatewayError("INVALID_ARGUMENTS");
  const query = new URLSearchParams();
  // The native collection route JSON-parses query parameters. Arrays must be
  // JSON, not the comma-separated form shown in its OpenAPI examples.
  for (const [key, value] of Object.entries(filters))
    if (value !== undefined)
      query.set(key, typeof value === "string" ? value : JSON.stringify(value));
  if (name !== "charts") query.set("limit", String(input.limit ?? 100));
  const result = await fetchResource(authorize, get, name, selected, query);
  checkCollection(result.data, name === "charts" ? 500 : (input.limit ?? 100));
  return result;
}
function checkWindow(
  input: { date?: string; from?: string; to?: string },
  days: number,
) {
  if (
    (input.date !== undefined &&
      (input.from !== undefined || input.to !== undefined)) ||
    (input.from === undefined) !== (input.to === undefined)
  )
    throw new GatewayError("INVALID_ARGUMENTS");
  if (input.from !== undefined && input.to !== undefined) {
    const span = Date.parse(input.to) - Date.parse(input.from);
    if (span < 0 || span > days * 86400000)
      throw new GatewayError("RESOURCE_QUERY_LIMIT");
  }
}
export async function listLogentries(
  authorize: Authorize,
  get: LocalGet,
  input: z.infer<typeof logentriesInput>,
) {
  checkWindow(input, 31);
  if (
    input.date === undefined &&
    input.from === undefined &&
    input.limit === undefined
  )
    throw new GatewayError("INVALID_ARGUMENTS");
  const { provider: selected, ...filters } = input;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value !== undefined)
      // Logbook accepts bbox as comma-separated coordinates. Quote strings
      // that JSON.parse could reinterpret (e.g. author="123" or "null").
      query.set(
        key,
        typeof value === "string" ? JSON.stringify(value) : String(value),
      );
  const result = await fetchResource(
    authorize,
    get,
    "logentries",
    selected,
    query,
  );
  checkCollection(result.data, input.limit ?? 500);
  if (
    Object.keys(result.data).some(
      (id) => !z.string().uuid().safeParse(id).success,
    )
  )
    throw new GatewayError("INVALID_RESOURCE_RESPONSE");
  return result;
}
export async function listLogentryDates(
  authorize: Authorize,
  get: LocalGet,
  input: z.infer<typeof logentryDatesInput>,
) {
  checkWindow(input, 366);
  const { provider: selected, ...filters } = input;
  const query = new URLSearchParams({ dates: "true" });
  for (const [key, value] of Object.entries(filters))
    if (value !== undefined) query.set(key, JSON.stringify(value));
  const result = await fetchResource(
    authorize,
    get,
    "logentries",
    selected,
    query,
  );
  if (Object.keys(result.data).length > 2000)
    throw new GatewayError("RESOURCE_RESULT_LIMIT");
  if (
    Object.entries(result.data).some(
      ([day, value]) =>
        !date.safeParse(day).success ||
        !record(value) ||
        !Number.isSafeInteger(value.count) ||
        (value.count as number) < 0,
    )
  )
    throw new GatewayError("INVALID_RESOURCE_RESPONSE");
  return result;
}
