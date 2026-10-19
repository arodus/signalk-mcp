const { test } = require("node:test");
const assert = require("node:assert/strict");
const { reviewKey, putReview } = require("../dist/approvals.js");
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
  source: "fixture.autopilot",
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
  const next = { ...put, source: "fixture.new" };
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
    { source: undefined },
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
