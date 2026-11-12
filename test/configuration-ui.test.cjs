const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  reviewKey,
  putReview,
  resourceReview,
} = require("../dist/approvals.js");
const { configSchema } = require("../dist/config.js");
const clone = (value) => globalThis.structuredClone(value);
const ui = () => import("../ui/configuration.mjs");
const review = {
  pluginId: "fixture",
  operationId: "read",
  path: "/read",
  description: "Example",
  schemaHash: "a".repeat(64),
  decision: "pending",
  permission: "readonly",
};
const key = reviewKey(review);
const put = putReview({
  context: "vessels.self",
  path: "steering.autopilot.target.headingTrue",
  metadata: { description: "Desired heading", units: "rad" },
  inputSchema: { type: "number", minimum: 0, maximum: 6.28 },
});
const putKey = reviewKey(put);
function inventory(reviews = { [key]: review }, installed = true) {
  return [
    {
      id: "signalk-mcp",
      data: {
        enabled: true,
        enableLogging: true,
        configuration: {
          readRequests: clone(reviews),
          pluginOperations: [],
          staleAfterSeconds: 300,
        },
      },
      schema: {
        properties: {
          readRequests: {
            properties: Object.fromEntries(
              Object.entries(reviews).map(([id, value]) => [
                id,
                { default: clone(value) },
              ]),
            ),
          },
        },
      },
    },
    ...(installed ? [{ id: "fixture", data: { enabled: false } }] : []),
  ];
}
const response = (value, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => clone(value),
});
const snapshot = async (list = inventory()) =>
  (await ui()).loadConfiguration(async () => response(list));
const draftOf = (base) =>
  clone({ reviews: base.reviews, settings: base.settings });

test("first configuration saves without edits and preserves the host enable and logging flags", async () => {
  const { loadConfiguration, saveConfiguration } = await ui();
  for (const options of [
    undefined,
    {},
    { enabled: false, configuration: null, enableLogging: true },
    { enabled: true, configuration: {}, enableDebug: true },
  ]) {
    const plugins = inventory({});
    plugins[0].data = options;
    let saved;
    const fetcher = async (url, request) => {
      if (url === "/plugins") return response(plugins);
      if (request.method === "POST") {
        saved = JSON.parse(request.body);
        return response("saved");
      }
      return response(saved);
    };
    const base = await loadConfiguration(fetcher);
    const result = await saveConfiguration(base, draftOf(base), fetcher);
    assert.deepEqual(saved, {
      ...(options ?? { enabled: false }),
      configuration: { readRequests: {} },
    });
    assert.deepEqual(result.settings, {
      localTlsServerName: "",
      staleAfterSeconds: 300,
      pluginOperations: [],
    });
    assert.equal(configSchema.safeParse(saved.configuration).success, true);
  }
});

test("table saves only intended edits and preserves new requests, settings and host flags", async () => {
  const { saveConfiguration } = await ui();
  const base = await snapshot();
  const draft = draftOf(base);
  draft.reviews[key].decision = "approved";
  const newer = inventory();
  newer[0].data.enableDebug = true;
  newer[0].data.configuration.staleAfterSeconds = 600;
  const next = { ...review, operationId: "newRead" };
  const nextKey = reviewKey(next);
  newer[0].schema.properties.readRequests.properties[nextKey] = {
    default: next,
  };
  const calls = [];
  let saved;
  const result = await saveConfiguration(base, draft, async (url, options) => {
    calls.push([url, options.method ?? "GET"]);
    assert.equal(options.credentials, "same-origin");
    if (url === "/plugins") return response(newer);
    if (options.method === "POST") {
      saved = JSON.parse(options.body);
      return response("saved");
    }
    return response(saved);
  });
  assert.deepEqual(calls, [
    ["/plugins", "GET"],
    ["/plugins/signalk-mcp/config", "POST"],
    ["/plugins/signalk-mcp/config", "GET"],
  ]);
  assert.equal(saved.enabled, true);
  assert.equal(saved.enableLogging, true);
  assert.equal(saved.enableDebug, true);
  assert.equal(saved.configuration.staleAfterSeconds, 600);
  assert.equal(result.reviews[key].decision, "approved");
  assert.equal(result.reviews[nextKey].decision, "pending");
  assert.equal(configSchema.safeParse(saved.configuration).success, true);
});

test("rejected rows stay editable; deletion requires confirmed absence including a recheck at save", async () => {
  const { mergeChanges } = await ui();
  const rejected = { ...review, decision: "rejected" };
  const base = await snapshot(inventory({ [key]: rejected }, false));
  const draft = draftOf(base);
  draft.reviews[key].decision = "approved";
  assert.equal(
    mergeChanges(base, draft, base).configuration.readRequests[key].decision,
    "approved",
  );
  delete draft.reviews[key];
  assert.deepEqual(
    mergeChanges(base, draft, base).configuration.readRequests,
    {},
  );
  const reinstalled = await snapshot(inventory({ [key]: rejected }, true));
  assert.throws(
    () => mergeChanges(base, draft, reinstalled),
    /installed again/,
  );
  assert.ok(
    reinstalled.installed.includes("fixture"),
    "Disabled plugins must count as installed",
  );
});

test("concurrent decisions/settings and unavailable inventory cannot cause silent overwrites", async () => {
  const { mergeChanges, loadConfiguration } = await ui();
  const base = await snapshot();
  const draft = draftOf(base);
  draft.reviews[key].decision = "approved";
  const current = clone(base);
  current.reviews[key].decision = "rejected";
  assert.throws(() => mergeChanges(base, draft, current), /another session/);
  const settings = draftOf(base);
  settings.settings.staleAfterSeconds = 100;
  current.settings.staleAfterSeconds = 600;
  assert.throws(() => mergeChanges(base, settings, current), /another session/);
  for (const list of [null, [], [{}], [{ id: "signalk-mcp" }]])
    await assert.rejects(
      loadConfiguration(async () => response(list)),
      /unavailable/,
    );
});

test("denied and unconfirmed saves are errors and leave the draft available", async () => {
  const { saveConfiguration } = await ui();
  const base = await snapshot();
  const draft = draftOf(base);
  draft.reviews[key].decision = "approved";
  for (const status of [401, 403, 500]) {
    await assert.rejects(
      saveConfiguration(base, draft, async (url) =>
        url === "/plugins" ? response(inventory()) : response({}, status),
      ),
      /administrator|could not/,
    );
    assert.equal(base.reviews[key].decision, "pending");
    assert.equal(draft.reviews[key].decision, "approved");
  }
  await assert.rejects(
    saveConfiguration(base, draft, async (url) =>
      url === "/plugins"
        ? response(inventory())
        : response({ configuration: {} }),
    ),
    /could not be confirmed/,
  );
});

test("connection and manual approval edits retain native configuration constraints", async () => {
  const { validateSettings, mergeChanges } = await ui();
  const base = await snapshot();
  for (const value of [0, 1.5, 86401, ""])
    assert.throws(
      () => validateSettings({ ...base.settings, staleAfterSeconds: value }),
      /whole number/,
    );
  for (const value of [
    "127.0.0.1",
    "https://boat.example",
    "boat.example:3000",
    "/cert.pem",
  ])
    assert.throws(
      () => validateSettings({ ...base.settings, localTlsServerName: value }),
      /hostname/,
    );
  const manual = {
    pluginId: "fixture",
    operationId: "read",
    path: "/read",
    method: "GET",
    readOnly: true,
    permission: "admin",
  };
  validateSettings({ ...base.settings, pluginOperations: [manual] });
  assert.throws(
    () =>
      validateSettings({
        ...base.settings,
        pluginOperations: [manual, manual],
      }),
    /unique/,
  );
  assert.throws(
    () =>
      validateSettings({
        ...base.settings,
        pluginOperations: [{ ...manual, method: "POST" }],
      }),
    /GET/,
  );
  const draft = draftOf(base);
  draft.settings.localTlsServerName = "boat.example";
  draft.settings.pluginOperations = [manual];
  assert.equal(
    configSchema.safeParse(mergeChanges(base, draft, base).configuration)
      .success,
    true,
  );
});

test("GET and PUT decisions save together through native configuration while concurrent requests survive", async () => {
  const { saveConfiguration } = await ui();
  const mixed = { [key]: review, [putKey]: put };
  const base = await snapshot(inventory(mixed));
  const draft = draftOf(base);
  draft.reviews[key].decision = "rejected";
  draft.reviews[putKey].decision = "approved";
  const next = { ...put, path: "steering.autopilot.target.headingMagnetic" };
  const nextKey = reviewKey(next);
  const current = inventory(mixed);
  current[0].schema.properties.readRequests.properties[nextKey] = {
    default: next,
  };
  let saved;
  const calls = [];
  const result = await saveConfiguration(base, draft, async (url, options) => {
    calls.push([url, options.method ?? "GET"]);
    if (url === "/plugins") return response(current);
    if (options.method === "POST") {
      saved = JSON.parse(options.body);
      return response("saved");
    }
    return response(saved);
  });
  assert.deepEqual(calls, [
    ["/plugins", "GET"],
    ["/plugins/signalk-mcp/config", "POST"],
    ["/plugins/signalk-mcp/config", "GET"],
  ]);
  assert.equal(result.reviews[key].decision, "rejected");
  assert.equal(result.reviews[putKey].decision, "approved");
  assert.equal(Object.hasOwn(result.reviews[putKey], "permission"), false);
  assert.equal(result.reviews[nextKey].decision, "pending");
  assert.equal(configSchema.safeParse(saved.configuration).success, true);
  assert.equal(base.reviews[putKey].decision, "pending");
});

test("native PUT reviews can be revoked without plugin absence and concurrent edits still conflict", async () => {
  const { mergeChanges } = await ui();
  const accepted = { ...put, decision: "approved" };
  const base = await snapshot(inventory({ [key]: review, [putKey]: accepted }));
  const draft = draftOf(base);
  delete draft.reviews[putKey];
  const merged = mergeChanges(base, draft, base);
  assert.deepEqual(merged.configuration.readRequests, { [key]: review });
  const changed = clone(base);
  changed.reviews[putKey].decision = "rejected";
  assert.throws(() => mergeChanges(base, draft, changed), /another session/);
  const rejected = draftOf(base);
  rejected.reviews[putKey].decision = "rejected";
  assert.equal(
    mergeChanges(base, rejected, base).configuration.readRequests[putKey]
      .decision,
    "rejected",
  );
});

test("invalid PUT metadata or gateway permission policy cannot enter the approval table", async () => {
  for (const changes of [
    { permission: "readonly" },
    { permission: "readwrite" },
    { permission: "admin" },
    { context: "vessels.other" },
    { metadata: [] },
    { inputSchema: null },
    { kind: "post" },
  ])
    await assert.rejects(
      snapshot(inventory({ [putKey]: { ...put, ...changes } })),
      /invalid/,
    );
});

test("POST reviews load, save decisions and can be revoked while provider remains installed", async () => {
  const { ApprovalRequests } = require("../dist/approvals.js");
  const { discoverOperations } = require("../dist/capabilities/openapi.js");
  const requests = new ApprovalRequests();
  const op = discoverOperations(
    {
      openapi: "3.0.3",
      paths: {
        "/snooze": {
          post: { operationId: "snooze", summary: "Synthetic action" },
        },
      },
    },
    "fixture",
    [],
    { permissions: "readwrite" },
  )[0];
  assert.throws(() => requests.request("fixture", op), /APPROVAL_PENDING/);
  const [postKey, entry] = Object.entries(requests.schema().properties)[0];
  const postReviews = { [postKey]: entry.default };
  const api = await ui();
  const base = await api.loadConfiguration(async () =>
    response(inventory(postReviews)),
  );
  const draft = clone(base);
  draft.reviews[postKey].decision = "approved";
  const merged = api.mergeChanges(base, draft, base);
  assert.equal(merged.configuration.readRequests[postKey].decision, "approved");
  assert.equal(configSchema.safeParse(merged.configuration).success, true);
  delete draft.reviews[postKey];
  assert.deepEqual(
    api.mergeChanges(base, draft, base).configuration.readRequests,
    {},
  );
});

test("custom resource write decisions save with existing approvals and preserve concurrent requests", async () => {
  const { saveConfiguration, mergeChanges } = await ui();
  const resource = resourceReview({
    collection: "wiringDevices",
    provider: "logbook-fixture",
    method: "PUT",
    path: "/signalk/v2/api/resources/wiringDevices/{id}",
    description: "Create or replace one log entry",
    inputSchema: { type: "object", required: ["id", "body"] },
  });
  const resourceKey = reviewKey(resource);
  const mixed = { [key]: review, [putKey]: put, [resourceKey]: resource };
  const base = await snapshot(inventory(mixed));
  const draft = draftOf(base);
  draft.reviews[resourceKey].decision = "approved";
  const next = resourceReview({ ...resource, provider: "second-provider" });
  const nextKey = reviewKey(next);
  const concurrent = inventory({ ...mixed, [nextKey]: next });
  let saved;
  const calls = [];
  const result = await saveConfiguration(base, draft, async (url, options) => {
    calls.push([url, options.method ?? "GET"]);
    if (url === "/plugins") return response(concurrent);
    if (options.method === "POST") {
      saved = JSON.parse(options.body);
      return response("saved");
    }
    return response(saved);
  });
  assert.deepEqual(calls, [
    ["/plugins", "GET"],
    ["/plugins/signalk-mcp/config", "POST"],
    ["/plugins/signalk-mcp/config", "GET"],
  ]);
  assert.equal(result.reviews[resourceKey].decision, "approved");
  assert.equal(result.reviews[nextKey].decision, "pending");
  assert.deepEqual(result.reviews[key], review);
  assert.deepEqual(result.reviews[putKey], put);
  assert.equal(configSchema.safeParse(saved.configuration).success, true);
  const remove = draftOf(result);
  delete remove.reviews[resourceKey];
  assert.equal(
    Object.hasOwn(
      mergeChanges(result, remove, result).configuration.readRequests,
      resourceKey,
    ),
    false,
  );
  const changed = clone(base);
  changed.reviews[resourceKey].decision = "rejected";
  assert.throws(() => mergeChanges(base, draft, changed), /another session/);
});

test("resource review table refuses unsupported routes, methods and gateway permission policy", async () => {
  const resource = resourceReview({
    collection: "logentries",
    provider: "logbook-fixture",
    method: "POST",
    path: "/signalk/v2/api/resources/logentries",
    description: "Create one log entry",
    inputSchema: { type: "object" },
  });
  const resourceKey = reviewKey(resource);
  for (const changes of [
    { method: "GET" },
    { collection: "configuration" },
    { provider: "" },
    { provider: undefined },
    { path: "/signalk/v2/api/resources/logentries/_providers/_default" },
    { inputSchema: null },
    { contractHash: "invalid" },
    { permission: "admin" },
    { kind: "unknown" },
  ])
    await assert.rejects(
      snapshot(inventory({ [resourceKey]: { ...resource, ...changes } })),
      /invalid/,
    );
});

test("plugin PUT, PATCH and DELETE reviews save and revoke independently through native config", async () => {
  const { ApprovalRequests } = require("../dist/approvals.js");
  const requests = new ApprovalRequests();
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    assert.throws(
      () =>
        requests.request("fixture", {
          id: "item",
          method,
          path: "/items/{id}",
          description: "Synthetic item change",
          input: require("zod").z.object({}).strict(),
          inputSchema: { type: "object", additionalProperties: false },
          contractHash: "f".repeat(64),
          reason: "NOT_ALLOWLISTED",
        }),
      /APPROVAL_PENDING/,
    );
  }
  const reviews = Object.fromEntries(
    Object.entries(requests.schema().properties).map(([id, schema]) => [
      id,
      schema.default,
    ]),
  );
  const base = await snapshot(inventory(reviews));
  const draft = draftOf(base);
  const keys = Object.keys(reviews);
  draft.reviews[keys[0]].decision = "approved";
  draft.reviews[keys[1]].decision = "rejected";
  let saved;
  const result = await (
    await ui()
  ).saveConfiguration(base, draft, async (url, options = {}) => {
    if (url === "/plugins") return response(inventory(reviews));
    if (options.method === "POST") {
      saved = JSON.parse(options.body);
      return response("saved");
    }
    return response(saved);
  });
  assert.equal(result.reviews[keys[0]].decision, "approved");
  assert.equal(result.reviews[keys[1]].decision, "rejected");
  assert.equal(result.reviews[keys[2]].decision, "pending");
  assert.equal(configSchema.safeParse(saved.configuration).success, true);
  const remove = draftOf(result);
  delete remove.reviews[keys[0]];
  const merged = (await ui()).mergeChanges(result, remove, result);
  assert.equal(
    Object.hasOwn(merged.configuration.readRequests, keys[0]),
    false,
  );
  const changed = clone(result);
  changed.reviews[keys[0]].decision = "rejected";
  const { mergeChanges } = await ui();
  assert.throws(() => mergeChanges(result, remove, changed), /another session/);
  for (const changes of [
    { method: "POST" },
    { method: "GET" },
    { method: "TRACE" },
    { kind: "put" },
    { permission: "admin" },
    { contractHash: "invalid" },
    { pluginId: "signalk-mcp" },
  ])
    await assert.rejects(
      snapshot(
        inventory({
          [keys[0]]: { ...reviews[keys[0]], ...changes },
        }),
      ),
      /metadata is invalid/,
    );
});

test("native API read and write reviews retain contracts through save and revoke", async () => {
  const { ApprovalRequests } = require("../dist/approvals.js");
  const { discoverOperations } = require("../dist/capabilities/openapi.js");
  const queue = new ApprovalRequests();
  const operations = discoverOperations(
    require("./fixtures/native-openapi/autopilot.json"),
    "autopilot",
    [],
    { identifier: "writer", permissions: "readwrite" },
    "autopilot",
  );
  for (const name of ["get.by-id.state", "post.by-id.engage"])
    assert.throws(
      () =>
        queue.request(
          "autopilot",
          operations.find((o) => o.id === name),
        ),
      /APPROVAL_PENDING/,
    );
  const reviews = Object.fromEntries(
    Object.entries(queue.schema().properties).map(([k, v]) => [k, v.default]),
  );
  const base = await snapshot(inventory(reviews));
  assert.equal(Object.keys(base.reviews).length, 2);
  const draft = draftOf(base);
  for (const value of Object.values(draft.reviews)) value.decision = "approved";
  const merged = (await ui()).mergeChanges(base, draft, base);
  assert.equal(configSchema.safeParse(merged.configuration).success, true);
  for (const [id, review] of Object.entries(reviews))
    assert.deepEqual(merged.configuration.readRequests[id], {
      ...review,
      decision: "approved",
    });
  draft.reviews = {};
  assert.deepEqual(
    (await ui()).mergeChanges(base, draft, base).configuration.readRequests,
    {},
  );
});

function catalogueFixture() {
  const { discoverOperations } = require("../dist/capabilities/openapi.js");
  const { operationReview } = require("../dist/approvals.js");
  const document = {
    openapi: "3.0.3",
    paths: {
      "/read": { get: { operationId: "read" } },
      "/write": { post: { operationId: "write", summary: "Change fixture" } },
      "/settings": { put: { operationId: "unsafe" } },
    },
  };
  const operations = discoverOperations(document, "fixture", [], {
    permissions: "admin",
  }).map((o) => {
    const review =
      o.reason === "NOT_ALLOWLISTED" ? operationReview("fixture", o) : null;
    return {
      id: o.id,
      method: o.method,
      path: o.path,
      description: o.description,
      enabled: o.enabled,
      reason: o.reason,
      inputSchema: o.inputSchema,
      key: review && reviewKey(review),
      review,
    };
  });
  return { id: "plugin.fixture", reason: null, operations };
}

test("catalogue loads before requests; bulk reads and writes stage only current supported contracts for one native save", async () => {
  const {
    loadEditorConfiguration,
    catalogueGroups,
    approveRows,
    isWrite,
    saveConfiguration,
  } = await ui();
  const catalogue = catalogueFixture();
  const list = inventory({});
  let saved;
  let writes = 0;
  const fetcher = async (url, options) => {
    if (url === "/plugins") return response(list);
    if (url.includes("?offset="))
      return response({
        discovery: "complete",
        nextOffset: null,
        capabilities: [
          {
            id: "plugin.fixture",
            kind: "plugin",
            availability: "inspect-required",
          },
        ],
      });
    if (url.includes("?id=")) return response(catalogue);
    if (options.method === "POST") {
      writes++;
      saved = JSON.parse(options.body);
      return response("saved");
    }
    return response(saved);
  };
  const base = await loadEditorConfiguration(fetcher);
  assert.deepEqual(base.reviews, {});
  let draft = draftOf(base);
  const rows = catalogueGroups(base, draft)[0].rows;
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.eligible).length, 2);
  draft = approveRows(
    draft,
    rows.filter((r) => !isWrite(r.item)),
  );
  assert.equal(Object.keys(draft.reviews).length, 1);
  draft = approveRows(
    draft,
    rows.filter((r) => isWrite(r.item)),
  );
  assert.equal(Object.keys(draft.reviews).length, 2);
  assert.equal(writes, 0);
  assert.deepEqual(base.reviews, {});
  await saveConfiguration(base, draft, fetcher);
  assert.equal(writes, 1);
  assert.equal(configSchema.safeParse(saved.configuration).success, true);
  assert.equal(
    Object.values(saved.configuration.readRequests).every(
      (r) => r.decision === "approved",
    ),
    true,
  );
  assert.equal(catalogue.operations[0].review.decision, "pending");
});

test("catalogue save rejects changed, removed or disabled contracts before writing", async () => {
  const { saveConfiguration, approveRows, catalogueGroups } = await ui();
  const base = await snapshot(inventory({}));
  base.catalogue = [catalogueFixture()];
  const draft = approveRows(
    draftOf(base),
    catalogueGroups(base, draftOf(base))[0].rows,
  );
  for (const latest of [
    { ...catalogueFixture(), operations: [] },
    { ...catalogueFixture(), reason: "PLUGIN_DISABLED" },
    {
      ...catalogueFixture(),
      operations: catalogueFixture().operations.map((o) => ({
        ...o,
        key: "changed",
      })),
    },
  ]) {
    let writes = 0;
    await assert.rejects(
      saveConfiguration(base, draft, async (url, options) => {
        if (options.method === "POST") writes++;
        return response(url === "/plugins" ? inventory({}) : latest);
      }),
      /changed or is unavailable/,
    );
    assert.equal(writes, 0);
  }
});

test("catalogue bulk selection preserves stricter reviews beyond 64 saved entries", async () => {
  const { approveRows, catalogueGroups, mergeChanges } = await ui();
  const group = catalogueFixture();
  const operation = group.operations.find((o) => o.method === "GET");
  const stored = {
    ...operation.review,
    decision: "rejected",
    permission: "admin",
  };
  const base = await snapshot(inventory({ [operation.key]: stored }));
  base.catalogue = [group];
  const draft = approveRows(
    draftOf(base),
    catalogueGroups(base, draftOf(base))[0].rows,
  );
  assert.equal(draft.reviews[operation.key].permission, "admin");
  assert.equal(draft.reviews[operation.key].decision, "approved");
  const full = draftOf(base);
  for (let i = 0; i < 63; i++) full.reviews[`existing-${i}`] = clone(stored);
  const expanded = approveRows(full, catalogueGroups(base, full)[0].rows);
  assert.ok(Object.keys(expanded.reviews).length > 64);
  assert.equal(Object.keys(full.reviews).length, 64);
  const fresh = await snapshot(inventory({}));
  const pending = await snapshot(
    inventory({ [operation.key]: operation.review }),
  );
  const selected = draftOf(fresh);
  selected.reviews[operation.key] = {
    ...operation.review,
    decision: "approved",
  };
  assert.equal(
    mergeChanges(fresh, selected, pending).configuration.readRequests[
      operation.key
    ].decision,
    "approved",
  );
  pending.reviews[operation.key].decision = "rejected";
  assert.throws(
    () => mergeChanges(fresh, selected, pending),
    /another session/,
  );
});

test("catalogue reports partial discovery and disabled groups without hiding usable operations", async () => {
  const { loadEditorConfiguration, catalogueGroups } = await ui();
  const calls = [];
  const base = await loadEditorConfiguration(async (url) => {
    calls.push(url);
    if (url === "/plugins") return response(inventory({}));
    if (url.includes("?offset="))
      return response({
        discovery: "complete",
        nextOffset: null,
        capabilities: [
          {
            id: "plugin.fixture",
            kind: "plugin",
            availability: "inspect-required",
          },
          {
            id: "plugin.missing-document",
            kind: "plugin",
            availability: "inspect-required",
          },
          { id: "plugin.disabled", kind: "plugin", availability: "disabled" },
          {
            id: "api.unknown",
            kind: "api",
            availability: "unsupported-namespace",
          },
        ],
      });
    return url.endsWith("plugin.fixture")
      ? response(catalogueFixture())
      : response({}, 404);
  });
  const groups = catalogueGroups(base, draftOf(base));
  assert.equal(groups.length, 4);
  assert.equal(groups[0].rows.filter((row) => row.eligible).length, 2);
  assert.equal(groups[1].reason, "HTTP 404");
  assert.equal(groups[2].reason, "disabled");
  assert.equal(groups[3].reason, "unsupported-namespace");
  assert.equal(
    calls.some(
      (url) =>
        url.includes("?id=plugin.disabled") || url.includes("?id=api.unknown"),
    ),
    false,
  );
  assert.deepEqual(base.reviews, {});
});

test("catalogue save preserves requests arriving during contract revalidation", async () => {
  const { saveConfiguration, approveRows, catalogueGroups } = await ui();
  const base = await snapshot(inventory({}));
  base.catalogue = [catalogueFixture()];
  const draft = approveRows(
    draftOf(base),
    catalogueGroups(base, draftOf(base))[0].rows,
  );
  let revalidated = false;
  let saved;
  await saveConfiguration(base, draft, async (url, options) => {
    if (url.includes("?id=")) {
      revalidated = true;
      return response(catalogueFixture());
    }
    if (url === "/plugins") {
      assert.equal(revalidated, true);
      return response(inventory({ [putKey]: put }));
    }
    if (options.method === "POST") {
      saved = JSON.parse(options.body);
      return response("saved");
    }
    return response(saved);
  });
  assert.deepEqual(saved.configuration.readRequests[putKey], put);
  assert.equal(Object.keys(saved.configuration.readRequests).length, 3);
});

test("explicit save upgrades only verified legacy contracts, preserves rejection and detects concurrent edits", async () => {
  const { saveConfiguration, catalogueGroups } = await ui();
  const catalogue = catalogueFixture();
  const op = catalogue.operations.find((o) => o.method === "POST");
  const old = {
    ...op.review,
    contractHash: "b".repeat(64),
    decision: "approved",
  };
  delete old.contractVersion;
  const oldKey = reviewKey(old);
  op.compatibleKeys = [oldKey];
  for (const decision of ["approved", "rejected"]) {
    old.decision = decision;
    const base = await snapshot(inventory({ [oldKey]: old }));
    base.catalogue = [catalogue];
    assert.equal(catalogueGroups(base, draftOf(base))[0].rows.length, 3);
    let saved;
    const fetcher = async (url, options) => {
      if (url.includes("?id=")) return response(catalogue);
      if (url === "/plugins") return response(inventory({ [oldKey]: old }));
      if (options.method === "POST") {
        saved = JSON.parse(options.body);
        return response("saved");
      }
      return response(saved);
    };
    await saveConfiguration(base, draftOf(base), fetcher);
    assert.equal(saved.configuration.readRequests[oldKey], undefined);
    assert.equal(saved.configuration.readRequests[op.key].decision, decision);
    assert.equal(saved.configuration.readRequests[op.key].contractVersion, 2);
    assert.ok(configSchema.safeParse(saved.configuration).success);
    await assert.rejects(
      saveConfiguration(base, draftOf(base), async (url) => {
        if (url.includes("?id=")) return response(catalogue);
        return response(
          inventory({ [oldKey]: { ...old, decision: "pending" } }),
        );
      }),
      /another session/,
    );
    await assert.rejects(
      saveConfiguration(base, draftOf(base), async () =>
        response({ ...catalogue, operations: [] }),
      ),
      /legacy operation changed/,
    );
  }
});

test("catalogue distinguishes invalidation, missing operations, failed discovery and unknown legacy differences", async () => {
  const { unavailableReviewReason, catalogueGroups } = await ui();
  const catalogue = catalogueFixture();
  const op = catalogue.operations.find((o) => o.method === "POST");
  const saved = {
    ...op.review,
    inputSchema: { type: "object" },
    description: "Old meaning",
  };
  assert.match(
    unavailableReviewReason(saved, catalogue),
    /documented meaning, accepted inputs changed/,
  );
  assert.match(
    unavailableReviewReason(saved, { operations: [], reason: "HTTP 503" }),
    /Discovery unavailable: HTTP 503/,
  );
  assert.match(
    unavailableReviewReason(saved, { operations: [] }),
    /no longer advertised/,
  );
  const read = catalogue.operations.find((o) => o.method === "GET");
  assert.match(
    unavailableReviewReason(
      { ...read.review, schemaHash: "a".repeat(64) },
      catalogue,
    ),
    /accepted inputs changed/,
  );
  const legacy = { ...op.review };
  delete legacy.contractVersion;
  assert.match(
    unavailableReviewReason(legacy, catalogue),
    /old response details were not stored/,
  );
  const base = await snapshot(inventory({ [reviewKey(legacy)]: legacy }));
  base.catalogue = [catalogue];
  const stale = catalogueGroups(base, draftOf(base))[0].rows.find(
    (r) => r.key === reviewKey(legacy),
  );
  assert.equal(stale.eligible, false);
  const draft = draftOf(base);
  draft.reviews[reviewKey(legacy)].decision = "approved";
  assert.equal(
    catalogueGroups(base, draft)[0].rows.at(-1).status,
    "invalidated",
  );
  base.catalogue = [];
  base.catalogueError = "Discovery failed: HTTP 503";
  const unavailable = catalogueGroups(base, draft)[0].rows[0];
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.reason, /Discovery failed: HTTP 503/);
});

test("resource reads need no approval and resource writes are revalidated per provider at save", async () => {
  const { catalogueGroups, approveRows, saveConfiguration } = await ui();
  const review = resourceReview({
    collection: "routes",
    provider: "example",
    method: "PUT",
    path: "/signalk/v2/api/resources/routes/{id}",
    description: "Replace route",
    inputSchema: { type: "object" },
  });
  const op = {
    id: "put_resource",
    method: "PUT",
    key: reviewKey(review),
    review,
    provider: "example",
    collection: "routes",
    path: review.path,
  };
  const group = {
    id: "resource.routes",
    operations: [
      {
        id: "list_resources",
        method: "GET",
        approvalRequired: false,
        review: null,
        provider: "example",
        collection: "routes",
      },
      op,
    ],
  };
  const base = await snapshot(inventory({}));
  base.catalogue = [group];
  const rows = catalogueGroups(base, draftOf(base))[0].rows;
  assert.equal(rows[0].status, "native");
  assert.equal(rows[0].eligible, false);
  const draft = approveRows(draftOf(base), rows);
  assert.equal(Object.keys(draft.reviews).length, 1);
  await assert.rejects(
    saveConfiguration(base, draft, async () =>
      response({
        ...group,
        operations: [
          {
            ...op,
            key: null,
            review: null,
            reason: "RESOURCE_PUT_PROVIDER_AMBIGUOUS",
          },
        ],
      }),
    ),
    /RESOURCE_PUT_PROVIDER_AMBIGUOUS/,
  );
});

test("telemetry preview stages exact paths and standing rules in their own group and revalidates before saving", async () => {
  const {
    previewTelemetryPut,
    catalogueGroups,
    approveRows,
    saveConfiguration,
  } = await ui();
  for (const review of [
    put,
    {
      kind: "put-rule",
      context: "vessels.self",
      path: "electrical.switches.**",
      decision: "pending",
    },
  ]) {
    const key = reviewKey(review);
    const operation = { path: review.path, key, review };
    const group = { id: "native.put", operations: [operation] };
    let saved;
    let writes = 0;
    const fetcher = async (url, options) => {
      if (url.includes("?id=native.put&path=")) {
        assert.ok(url.endsWith(encodeURIComponent(review.path)));
        return response(group);
      }
      if (url === "/plugins") return response(inventory({}));
      if (options.method === "POST") {
        writes++;
        saved = JSON.parse(options.body);
        return response("saved");
      }
      return response(saved);
    };
    assert.deepEqual(
      await previewTelemetryPut(review.path, fetcher),
      operation,
    );
    const base = await snapshot(inventory({}));
    base.catalogue = [];
    const draft = approveRows(draftOf(base), [
      { key, item: review, eligible: true },
    ]);
    assert.equal(catalogueGroups(base, draft)[0].id, "native.put");
    assert.equal(writes, 0);
    await saveConfiguration(base, draft, fetcher);
    assert.equal(writes, 1);
    assert.ok(configSchema.safeParse(saved.configuration).success);
    await assert.rejects(
      saveConfiguration(base, draft, async () =>
        response({
          id: "native.put",
          operations: [{ ...operation, key: "changed" }],
        }),
      ),
      /contract changed/,
    );
  }
});

test("UI migration preserves saved telemetry decisions and saves source-free approvals without reapproval", async () => {
  const { loadConfiguration, saveConfiguration } = await ui();
  const a = { ...put, source: "old-a", decision: "approved" };
  const b = { ...put, source: "old-b", decision: "rejected" };
  const migrated = { ...put, decision: "rejected" };
  const list = inventory({ [putKey]: migrated });
  list[0].data.configuration.readRequests = {
    [reviewKey(a)]: a,
    [reviewKey(b)]: b,
  };
  const base = await loadConfiguration(async () => response(list));
  assert.deepEqual(base.reviews, { [putKey]: migrated });
  let saved;
  await saveConfiguration(base, draftOf(base), async (url, options) => {
    if (url === "/plugins") return response(list);
    if (options.method === "POST") {
      saved = JSON.parse(options.body);
      return response("saved");
    }
    return response(saved);
  });
  assert.deepEqual(saved.configuration.readRequests, { [putKey]: migrated });
});

test("one save persists more than 64 reviews and advanced manual approvals", async () => {
  const { approveRows, saveConfiguration } = await ui();
  const base = await snapshot(inventory({}));
  const rows = Array.from({ length: 150 }, (_, i) => {
    const item = { ...review, operationId: `read-${i}`, path: `/read-${i}` };
    return { key: reviewKey(item), item, eligible: true };
  });
  const draft = approveRows(draftOf(base), rows);
  draft.reviews[rows[0].key].decision = "rejected";
  draft.settings.pluginOperations = Array.from({ length: 100 }, (_, i) => ({
    pluginId: "fixture",
    operationId: `manual-${i}`,
    method: "GET",
    path: `/manual-${i}`,
    readOnly: true,
    permission: "readonly",
  }));
  let saved;
  let writes = 0;
  const result = await saveConfiguration(base, draft, async (url, options) => {
    if (url === "/plugins") return response(inventory({}));
    if (options.method === "POST") {
      writes++;
      saved = JSON.parse(options.body);
      assert.equal(configSchema.safeParse(saved.configuration).success, true);
      return response("saved");
    }
    return response(saved);
  });
  assert.equal(writes, 1);
  assert.equal(Object.keys(result.reviews).length, 150);
  assert.equal(result.reviews[rows[0].key].decision, "rejected");
  assert.equal(result.settings.pluginOperations.length, 100);
  const { schema } = require("../dist/config.js");
  assert.equal(schema.properties.pluginOperations.maxItems, undefined);
});

const legacyRead = {
  pluginId: "fixture",
  operationId: "read",
  method: "GET",
  path: "/read",
  readOnly: true,
  permission: "admin",
};
async function manualCatalogue(reviews = {}, catalogue = catalogueFixture()) {
  const list = inventory(reviews);
  list[0].data.configuration.pluginOperations = [clone(legacyRead)];
  const base = await snapshot(list);
  base.catalogue = [catalogue];
  return base;
}

test("legacy read grants appear accepted in the catalogue without changing storage or admin restrictions", async () => {
  const { catalogueGroups, saveConfiguration, approveRows } = await ui();
  const base = await manualCatalogue();
  let draft = draftOf(base);
  const row = catalogueGroups(base, draft)[0].rows.find(
    (r) => r.item.operationId === "read",
  );
  assert.equal(row.status, "approved");
  assert.equal(row.item.permission, "admin");
  assert.deepEqual(row.manual, legacyRead);
  assert.deepEqual(draft.reviews, {});
  let saved;
  const fetcher = async (url, options) => {
    if (url === "/plugins") {
      const list = inventory(base.reviews);
      list[0].data.configuration.pluginOperations = [clone(legacyRead)];
      return response(list);
    }
    if (url.includes("?id=")) return response(catalogueFixture());
    if (options.method === "POST") {
      saved = JSON.parse(options.body);
      return response("saved");
    }
    return response(saved);
  };
  await saveConfiguration(base, draft, fetcher);
  assert.deepEqual(saved.configuration.pluginOperations, [legacyRead]);
  assert.deepEqual(saved.configuration.readRequests, {});
  draft = approveRows(draft, [row]);
  draft.reviews[row.key].decision = "rejected";
  const rejectedBase = await manualCatalogue(draft.reviews);
  const rejected = catalogueGroups(
    rejectedBase,
    draftOf(rejectedBase),
  )[0].rows.find((r) => r.key === row.key);
  assert.equal(rejected.status, "rejected");
  const accepted = approveRows(draftOf(rejectedBase), [rejected]);
  assert.equal(accepted.reviews[row.key].permission, "admin");
  const pending = await manualCatalogue({
    [row.key]: { ...row.item, decision: "pending" },
  });
  assert.equal(
    catalogueGroups(pending, draftOf(pending))[0].rows.find(
      (r) => r.key === row.key,
    ).status,
    "approved",
  );
});

test("removing a legacy catalogue row revokes both grants and detects concurrent edits", async () => {
  const { catalogueGroups, removeApprovalRow, mergeChanges } = await ui();
  const read = catalogueFixture().operations.find((op) => op.method === "GET");
  const base = await manualCatalogue({
    [read.key]: { ...read.review, decision: "approved" },
  });
  const row = catalogueGroups(base, draftOf(base))[0].rows.find(
    (r) => r.key === read.key,
  );
  const draft = removeApprovalRow(draftOf(base), row);
  const merged = mergeChanges(base, draft, base);
  assert.deepEqual(merged.configuration.pluginOperations, []);
  assert.deepEqual(merged.configuration.readRequests, {});
  assert.equal(configSchema.safeParse(merged.configuration).success, true);
  // The catalogue must not keep showing the old server's enabled state after removal.
  base.catalogue[0].operations[0].enabled = true;
  assert.equal(
    catalogueGroups(base, draft)[0].rows.find((r) => r.key === read.key).status,
    "available",
  );
  const concurrent = clone(base);
  concurrent.settings.pluginOperations[0].permission = "readonly";
  assert.throws(
    () => mergeChanges(base, draft, concurrent),
    /changed in another session/,
  );
  const manualOnly = await manualCatalogue();
  const manualRow = catalogueGroups(manualOnly, draftOf(manualOnly))[0].rows[0];
  const removed = removeApprovalRow(draftOf(manualOnly), manualRow);
  const newReview = clone(manualOnly);
  newReview.reviews[read.key] = { ...read.review, decision: "approved" };
  assert.throws(
    () => mergeChanges(manualOnly, removed, newReview),
    /changed in another session/,
  );
});

test("unavailable legacy grants stay visible and removable without approving a changed route", async () => {
  const { catalogueGroups, removeApprovalRow, mergeChanges } = await ui();
  for (const catalogue of [
    { id: "plugin.fixture", reason: "PLUGIN_DISABLED", operations: [] },
    {
      ...catalogueFixture(),
      operations: catalogueFixture().operations.map((op) => ({
        ...op,
        path: "/changed",
      })),
    },
    {
      ...catalogueFixture(),
      operations: catalogueFixture().operations.map((op) => ({
        ...op,
        review: null,
        key: null,
        reason: "UNSUPPORTED_SCHEMA",
      })),
    },
  ]) {
    const base = await manualCatalogue({}, catalogue);
    const rows = catalogueGroups(base, draftOf(base))[0].rows;
    const saved = rows.filter((r) => r.manual);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].eligible, false);
    assert.notEqual(saved[0].status, "approved");
    assert.equal(
      rows.some((r) => r.item.path === "/changed" && r.status === "approved"),
      false,
    );
    const next = removeApprovalRow(draftOf(base), saved[0]);
    assert.deepEqual(
      mergeChanges(base, next, base).configuration.pluginOperations,
      [],
    );
  }
  const base = await manualCatalogue();
  base.catalogue = [];
  base.installed = ["signalk-mcp"];
  base.catalogueError = "Discovery failed";
  const rows = catalogueGroups(base, draftOf(base));
  assert.equal(rows[0].rows[0].item.path, "/read");
  assert.equal(rows[0].rows[0].status, "unavailable");
});
