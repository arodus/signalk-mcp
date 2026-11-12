import { resourceCollectionSchema } from "../dist/capabilities/resource-schemas.js";
import { approvalSchema } from "../dist/capabilities/schemas.js";

const CONFIG_URL = "/plugins/signalk-mcp/config";
const CATALOGUE_URL = "/plugins/signalk-mcp/catalogue";
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
    if (url.startsWith(CATALOGUE_URL)) {
      const body = await response.json().catch(() => null);
      const code =
        typeof body?.error === "string" && /^[A-Z_]{1,80}$/.test(body.error)
          ? body.error
          : `HTTP ${response.status}`;
      throw new Error(code);
    }
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
      (review) =>
        !object(review) ||
        (review.kind === "put"
          ? review.context !== "vessels.self" ||
            typeof review.path !== "string" ||
            typeof review.source !== "string" ||
            !object(review.metadata) ||
            !object(review.inputSchema) ||
            "permission" in review
          : review.kind === "resource"
            ? !["POST", "PUT", "DELETE"].includes(review.method) ||
              !resourceCollectionSchema.safeParse(review.collection).success ||
              typeof review.provider !== "string" ||
              !review.provider ||
              review.path !==
                `/signalk/v2/api/resources/${review.collection}${review.method === "POST" ? "" : "/{id}"}` ||
              typeof review.description !== "string" ||
              !object(review.inputSchema) ||
              typeof review.contractHash !== "string" ||
              !/^[a-f0-9]{64}$/.test(review.contractHash) ||
              "permission" in review
            : review.kind === "api"
              ? !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(
                  review.method,
                ) ||
                ![
                  "course",
                  "weather",
                  "autopilot",
                  "radar",
                  "ble",
                  "tracks",
                  "sensors",
                ].includes(review.api) ||
                typeof review.operationId !== "string" ||
                typeof review.path !== "string" ||
                !review.path.startsWith("/signalk/v2/api/") ||
                typeof review.description !== "string" ||
                !object(review.inputSchema) ||
                typeof review.contractHash !== "string" ||
                !/^[a-f0-9]{64}$/.test(review.contractHash) ||
                "permission" in review
              : review.kind === "post" || review.kind === "plugin"
                ? (review.kind === "post"
                    ? review.method !== "POST"
                    : !["PUT", "PATCH", "DELETE"].includes(review.method)) ||
                  typeof review.pluginId !== "string" ||
                  review.pluginId === "signalk-mcp" ||
                  typeof review.operationId !== "string" ||
                  typeof review.path !== "string" ||
                  typeof review.description !== "string" ||
                  !object(review.inputSchema) ||
                  typeof review.contractHash !== "string" ||
                  !/^[a-f0-9]{64}$/.test(review.contractHash) ||
                  "permission" in review
                : "kind" in review || typeof review.pluginId !== "string"),
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

async function loadGroup(id, fetcher) {
  const group = await request(
    fetcher,
    `${CATALOGUE_URL}?id=${encodeURIComponent(id)}`,
  );
  if (
    !object(group) ||
    group.id !== id ||
    !Array.isArray(group.operations) ||
    group.operations.length > (id.startsWith("resource.") ? 384 : 128)
  )
    throw new Error("Invalid operation catalogue. Refresh and try again.");
  return group;
}

export async function loadEditorConfiguration(fetcher = nativeFetch) {
  const base = await loadConfiguration(fetcher);
  const catalogue = [];
  let catalogueError = "";
  try {
    const capabilities = [];
    let offset = 0;
    do {
      const page = await request(fetcher, `${CATALOGUE_URL}?offset=${offset}`);
      if (
        !object(page) ||
        !Array.isArray(page.capabilities) ||
        page.discovery !== "complete"
      )
        throw new Error(
          "Operation discovery is unavailable. Existing requests are shown below.",
        );
      capabilities.push(...page.capabilities);
      if (
        page.nextOffset !== null &&
        (!Number.isInteger(page.nextOffset) ||
          page.nextOffset <= offset ||
          page.nextOffset > 512)
      )
        throw new Error("Operation discovery exceeded its limit.");
      offset = page.nextOffset;
    } while (offset !== null);
    // Bound simultaneous metadata reads. Never invoke provider operations.
    const groups = capabilities.filter(
      (c) =>
        c.kind === "resource" ||
        c.kind === "plugin" ||
        (c.kind === "api" && c.id !== "api.resources"),
    );
    for (let index = 0; index < groups.length; index += 3) {
      catalogue.push(
        ...(await Promise.all(
          groups.slice(index, index + 3).map(async (c) => {
            if (
              ["disabled", "unsupported-namespace", "unavailable"].includes(
                c.availability,
              )
            )
              return {
                id: c.id,
                reason: c.reason ?? c.availability,
                operations: [],
              };
            try {
              return await loadGroup(c.id, fetcher);
            } catch (error) {
              return {
                id: c.id,
                reason: error.message,
                operations: [],
              };
            }
          }),
        )),
      );
    }
  } catch (error) {
    catalogueError = error.message;
  }
  return { ...base, catalogue, catalogueError };
}

export function reviewGroup(review) {
  return review.kind === "api"
    ? `api.${review.api}`
    : review.kind === "put"
      ? "native.put"
      : review.kind === "resource"
        ? `resource.${review.collection}`
        : `plugin.${review.pluginId}`;
}

export function isWrite(review) {
  return (
    review.kind === "put" ||
    (review.method !== undefined && review.method !== "GET")
  );
}

export function catalogueGroups(base, draft) {
  const seen = new Set();
  const groups = (base.catalogue ?? []).map((group) => ({
    ...group,
    rows: group.operations.map((operation, index) => {
      const keys = [operation.key, ...(operation.compatibleKeys ?? [])].filter(
        Boolean,
      );
      const key =
        keys.find((key) => draft.reviews[key]?.decision === "rejected") ??
        keys.find((key) => draft.reviews[key]?.decision === "approved") ??
        keys.find((key) => draft.reviews[key]) ??
        operation.key ??
        `unsupported:${group.id}:${index}`;
      keys.forEach((key) => seen.add(key));
      const item = draft.reviews[key] ??
        operation.review ?? {
          ...(group.id.startsWith("resource.")
            ? {
                kind: "resource",
                collection: operation.collection,
                provider: operation.provider,
              }
            : group.id.startsWith("api.")
              ? { kind: "api", api: group.id.slice(4) }
              : {
                  pluginId: group.id.slice(7),
                  ...(operation.method === "GET" ? {} : { kind: "plugin" }),
                }),
          operationId: operation.id,
          method: operation.method,
          path: operation.path,
          description: operation.description,
          inputSchema: operation.inputSchema,
        };
      return {
        key,
        item,
        operation,
        eligible: Boolean(operation.review),
        status:
          draft.reviews[key]?.decision ??
          (operation.review
            ? operation.enabled
              ? "manual"
              : "available"
            : operation.approvalRequired === false
              ? "native"
              : "unsupported"),
      };
    }),
  }));
  for (const [key, item] of Object.entries(draft.reviews)) {
    if (seen.has(key)) continue;
    const id = reviewGroup(item);
    let group = groups.find((group) => group.id === id);
    if (!group) {
      group = { id, operations: [], rows: [], reason: base.catalogueError };
      groups.push(group);
    }
    // Old plugin/API contracts remain visible but cannot be bulk-approved.
    const eligible = item.kind === "put";
    group.rows.push({
      key,
      item,
      eligible,
      status:
        !eligible && item.decision === "approved"
          ? group.reason
            ? "unavailable"
            : "invalidated"
          : item.decision,
      reason: eligible ? "" : unavailableReviewReason(item, group),
    });
  }
  return groups;
}

export function unavailableReviewReason(review, group) {
  if (group.reason)
    return `Discovery unavailable: ${group.reason}. The saved approval is retained; availability could not be checked.`;
  const operations =
    review.kind === "resource"
      ? group.operations.filter((op) => op.provider === review.provider)
      : group.operations;
  const current =
    operations.find(
      (operation) =>
        operation.id === review.operationId &&
        operation.method === (review.method ?? "GET"),
    ) ??
    operations.find(
      (operation) =>
        operation.path === review.path &&
        operation.method === (review.method ?? "GET"),
    );
  if (!current)
    return "Operation no longer advertised by this provider. The saved approval is retained.";
  if (!current.review)
    return `Operation is currently unsupported: ${current.reason ?? "unsupported contract"}.`;
  const changes = [];
  if (review.operationId && current.id !== review.operationId)
    changes.push("operation ID");
  if (current.path !== review.path) changes.push("endpoint path");
  if (current.description !== review.description)
    changes.push("documented meaning");
  if (
    (review.inputSchema && !same(review.inputSchema, current.inputSchema)) ||
    (review.schemaHash && review.schemaHash !== current.review.schemaHash)
  )
    changes.push("accepted inputs");
  if (changes.length)
    return `Approval invalidated: ${changes.join(", ")} changed. Review the current operation above.`;
  if (
    (review.kind === "post" || review.kind === "plugin") &&
    review.contractVersion !== 2
  )
    return "Legacy approval no longer matches. Its fingerprint included response fields; the old response details were not stored. Review the current operation once to use the new action-only binding.";
  return "Approval invalidated: security requirements, parameter documentation, or response status/transport/meaning changed. Review the current operation above.";
}

export function approveRows(draft, rows) {
  const reviews = { ...draft.reviews };
  for (const row of rows) {
    if (!row.eligible) continue;
    reviews[row.key] = { ...row.item, decision: "approved" };
  }
  if (Object.keys(reviews).length > 64)
    throw new Error(
      "This selection exceeds the 64 saved-review limit. Select fewer operations or remove obsolete reviews before saving.",
    );
  return { ...draft, reviews };
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
    const newlyPending =
      !base.reviews[key] &&
      current.reviews[key]?.decision === "pending" &&
      same(
        { ...current.reviews[key], decision: draft.reviews[key]?.decision },
        draft.reviews[key],
      );
    if (!same(base.reviews[key], current.reviews[key]) && !newlyPending)
      conflict();
    if (!draft.reviews[key]) {
      if (
        !base.reviews[key].kind &&
        current.installed.includes(base.reviews[key].pluginId)
      )
        throw new Error(
          "This plugin is installed again. Refresh before deleting its review.",
        );
      delete reviews[key];
    } else {
      reviews[key] = draft.reviews[key];
    }
  }
  if (Object.keys(reviews).length > 64)
    throw new Error(
      "The 64 saved-review limit has been reached. Remove obsolete reviews before saving.",
    );
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
  const groups = new Map();
  if (base.catalogue) {
    for (const [key, review] of Object.entries(draft.reviews)) {
      if (
        same(base.reviews[key], review) ||
        review.decision !== "approved" ||
        review.kind === "put"
      )
        continue;
      const id = reviewGroup(review);
      if (!groups.has(id)) groups.set(id, await loadGroup(id, fetcher));
      const latest = groups.get(id);
      if (
        latest.reason ||
        !latest.operations.some(
          (operation) =>
            (operation.key === key ||
              operation.compatibleKeys?.includes(key)) &&
            operation.review,
        )
      )
        throw new Error(
          `${review.method ?? "GET"} ${review.path}: selected operation changed or is unavailable. ${unavailableReviewReason(review, latest)} Refresh before approving it.`,
        );
    }
  }
  // Read configuration after metadata checks so requests/edits arriving during
  // discovery are included in the merge immediately before the native save.
  let saving = draft;
  if (base.catalogue) {
    const reviews = { ...draft.reviews };
    for (const group of base.catalogue)
      for (const operation of group.operations) {
        if (!operation.review) continue;
        for (const previous of operation.compatibleKeys ?? []) {
          const old = reviews[previous];
          if (!old) continue;
          // An exact legacy match supplies evidence for migration; never infer an
          // action binding from an unmatched hash or from inputs alone.
          if (!groups.has(group.id))
            groups.set(group.id, await loadGroup(group.id, fetcher));
          const fresh = groups.get(group.id);
          if (
            fresh.reason ||
            !fresh.operations.some(
              (op) =>
                op.key === operation.key &&
                op.compatibleKeys?.includes(previous),
            )
          )
            throw new Error(
              "A legacy operation changed during approval migration. Refresh before saving.",
            );
          const existing = reviews[operation.key];
          reviews[operation.key] = {
            ...operation.review,
            decision:
              old.decision === "rejected" || existing?.decision === "rejected"
                ? "rejected"
                : (existing?.decision ?? old.decision),
          };
          delete reviews[previous];
        }
      }
    saving = { ...draft, reviews };
  }
  const current = await loadConfiguration(fetcher);
  const options = mergeChanges(base, saving, current);
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
    ...(base.catalogue
      ? { catalogue: base.catalogue, catalogueError: base.catalogueError }
      : {}),
    options: saved,
    reviews: options.configuration.readRequests,
    settings: {
      localTlsServerName: options.configuration.localTlsServerName ?? "",
      staleAfterSeconds: options.configuration.staleAfterSeconds ?? 300,
      pluginOperations: options.configuration.pluginOperations ?? [],
    },
  };
}
