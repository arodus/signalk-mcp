import { approvalSchema } from "../dist/capabilities/schemas.js";

const CONFIG_URL = "/plugins/signalk-mcp/config";
// Follow the Admin UI routing prefix (normally /skServer).
const nativeFetch = (url, options) =>
  fetch(`${globalThis.serverRoutesPrefix ?? ""}${url}`, options);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

async function request(fetcher, url, options = {}) {
  const response = await fetcher(url, {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    ...options,
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Sign in to Signal K as an administrator to manage these settings."
        : "Signal K could not load or save the configuration. Refresh and try again.",
    );
  }
  return response.json();
}

export async function loadConfiguration(fetcher = nativeFetch) {
  // Native Plugin Config inventory includes disabled plugins too.
  const plugins = await request(fetcher, "/plugins");
  if (
    !Array.isArray(plugins) ||
    plugins.some((p) => !object(p) || typeof p.id !== "string")
  )
    throw new Error(
      "Plugin inventory is unavailable. No changes can be saved.",
    );
  const plugin = plugins.find((p) => p.id === "signalk-mcp");
  const properties = plugin?.schema?.properties?.readRequests?.properties;
  if (!object(properties))
    throw new Error(
      "Plugin review metadata is unavailable. Refresh and try again.",
    );
  const options = plugin.data ?? { enabled: false, configuration: {} };
  const configuration = options.configuration ?? {};
  const reviews = Object.fromEntries(
    Object.entries(properties).map(([key, schema]) => [key, schema.default]),
  );
  // Saves can precede the host's asynchronous restart.
  Object.assign(reviews, configuration.readRequests ?? {});
  if (
    Object.values(reviews).some(
      (review) => !object(review) || typeof review.pluginId !== "string",
    )
  )
    throw new Error(
      "Plugin review metadata is invalid. No changes can be saved.",
    );
  return {
    options,
    reviews,
    installed: plugins.map((p) => p.id),
    settings: {
      localTlsServerName: configuration.localTlsServerName ?? "",
      staleAfterSeconds: configuration.staleAfterSeconds ?? 300,
      pluginOperations: configuration.pluginOperations ?? [],
    },
  };
}

export function validateSettings(settings) {
  const seconds = settings.staleAfterSeconds;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400)
    throw new Error(
      "Stale after must be a whole number from 1 to 86400 seconds.",
    );
  const hostname = settings.localTlsServerName;
  if (
    hostname &&
    (hostname.length > 253 ||
      /^(?:\d+\.){3}\d+$/.test(hostname) ||
      !hostname
        .split(".")
        .every((label) =>
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
        ))
  )
    throw new Error(
      "Enter a certificate hostname without a scheme, port, IP address or file path.",
    );
  const approvals = settings.pluginOperations;
  if (
    !Array.isArray(approvals) ||
    approvals.length > 64 ||
    approvals.some(
      (approval) =>
        !approvalSchema.safeParse(approval).success ||
        approval.pluginId === "signalk-mcp",
    ) ||
    new Set(
      approvals.map(
        (approval) => `${approval.pluginId}:${approval.operationId}`,
      ),
    ).size !== approvals.length
  )
    throw new Error(
      "Check manual approvals: unique plugin and operation IDs, a GET path and confirmed read-only behavior are required (maximum 64).",
    );
}

export function mergeChanges(base, draft, current) {
  validateSettings(draft.settings);
  const reviews = { ...current.reviews };
  const conflict = () => {
    throw new Error(
      "These settings changed in another session. Refresh before saving your changes.",
    );
  };
  for (const key of new Set([
    ...Object.keys(base.reviews),
    ...Object.keys(draft.reviews),
  ])) {
    if (same(base.reviews[key], draft.reviews[key])) continue;
    if (!same(base.reviews[key], current.reviews[key])) conflict();
    if (!draft.reviews[key]) {
      if (current.installed.includes(base.reviews[key].pluginId))
        throw new Error(
          "This plugin is installed again. Refresh before deleting its review.",
        );
      delete reviews[key];
    } else {
      reviews[key] = draft.reviews[key];
    }
  }
  const configuration = {
    ...current.options.configuration,
    readRequests: reviews,
  };
  for (const field of Object.keys(base.settings)) {
    if (same(base.settings[field], draft.settings[field])) continue;
    if (!same(base.settings[field], current.settings[field])) conflict();
    configuration[field] = draft.settings[field];
  }
  if (configuration.localTlsServerName === "")
    delete configuration.localTlsServerName;
  return { ...current.options, configuration };
}

export async function saveConfiguration(base, draft, fetcher = nativeFetch) {
  const current = await loadConfiguration(fetcher);
  const options = mergeChanges(base, draft, current);
  // Only Signal K's existing admin configuration route writes settings.
  await request(fetcher, CONFIG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  const saved = await request(fetcher, CONFIG_URL);
  if (!same(saved.configuration, options.configuration))
    throw new Error(
      "The saved configuration could not be confirmed. Refresh before making more changes.",
    );
  return {
    ...current,
    options: saved,
    reviews: options.configuration.readRequests,
    settings: {
      localTlsServerName: options.configuration.localTlsServerName ?? "",
      staleAfterSeconds: options.configuration.staleAfterSeconds ?? 300,
      pluginOperations: options.configuration.pluginOperations ?? [],
    },
  };
}
