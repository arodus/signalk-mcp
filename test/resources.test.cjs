const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CapabilityRegistry } = require("../dist/capabilities/registry.js");
const { configSchema } = require("../dist/config.js");
const { localGet } = require("../dist/capabilities/http.js");
const { GatewayError } = require("../dist/auth.js");
const root = "/signalk/v2/api/resources";
const uuid = "00000000-0000-4000-8000-000000000001";
function fixture() {
  let allowed = true;
  let identity = "reader";
  const calls = [];
  const app = {
    securityStrategy: {
      isDummy: () => false,
      anyACLs: () => true,
      checkACL: () => false,
      authorizeWS: (connection) => {
        connection.skIsAuthenticated = allowed;
        connection.skPrincipal = {
          identifier: identity,
          permissions: "readonly",
        };
      },
    },
    getFeatures: () => ({ apis: ["resources", "weather"], plugins: [] }),
  };
  const state = {
    collections: Object.fromEntries(
      [
        "routes",
        "waypoints",
        "notes",
        "regions",
        "charts",
        "logentries",
        "custom",
      ].map((name) => [name, { description: name }]),
    ),
    providers: ["example"],
    data: {},
    after: () => {},
  };
  const registry = new CapabilityRegistry(
    app,
    "Bearer fixture",
    configSchema.parse({}),
    () => true,
    async (path) => {
      calls.push(path);
      if (path === root) return state.collections;
      if (path.endsWith("/_providers")) return state.providers;
      state.after();
      return state.data;
    },
  );
  const call = (operation, args = {}) =>
    registry.execute("api.resources", operation, args);
  return {
    registry,
    call,
    calls,
    state,
    revoke: () => {
      allowed = false;
    },
    changeIdentity: () => {
      identity = "other";
    },
  };
}

test("Resources replaces adapter-required discovery and retains unsupported API behavior", async () => {
  const { registry, call } = fixture();
  const listed = await registry.list();
  assert.equal(
    listed.capabilities.filter((c) => c.id === "api.resources").length,
    1,
  );
  assert.equal(
    listed.capabilities.find((c) => c.id === "api.resources").readOnly,
    false,
  );
  const description = await registry.describe("api.resources");
  assert.equal(description.available, true);
  assert.equal(description.operations.length, 10);
  assert.ok(
    description.operations
      .filter((o) => o.readOnly !== false)
      .every((o) => o.enabled && o.permission === "readonly"),
  );
  assert.equal(
    (await registry.describe("api.weather")).reason,
    "ADAPTER_REQUIRED",
  );
  const collections = await call("list_collections");
  assert.ok(Object.hasOwn(collections.collections, "custom"));
  assert.ok(!collections.supportedCollections.includes("custom"));
  await assert.rejects(
    call("get_resource", { collection: "custom", id: uuid }),
    /INVALID_ARGUMENTS/,
  );
  await assert.rejects(
    registry.executeMutation("api.resources", "unsupported", {}),
    /OPERATION_DISABLED/,
  );
  await assert.rejects(call("delete_resource", {}), /MUTATION_TOOL_REQUIRED/);
});

test("Resource reads follow native authorization even with telemetry ACLs and preserve provider payload", async () => {
  const { call, state, calls } = fixture();
  state.data = {
    [uuid]: {
      id: uuid,
      text: "entry",
      telemetry: [
        { path: "navigation.position", value: { latitude: 0, longitude: 0 } },
      ],
      unknown: null,
      link: "https://example.invalid/private",
    },
  };
  const result = await call("list_logentries", {
    limit: 20,
    author: "123",
    origin: "null",
    bbox: [170, -10, -170, 10],
  });
  assert.deepEqual(result.data, state.data);
  assert.equal(result.provider, "example");
  const query = new URL(`http://fixture${calls.at(-1)}`).searchParams;
  assert.equal(JSON.parse(query.get("author")), "123");
  assert.equal(JSON.parse(query.get("origin")), "null");
  assert.equal(query.get("bbox"), "170,-10,-170,10");
  assert.equal(calls.length, 3);
});

test("Standard resource filters preserve native JSON array contract and type restrictions", async () => {
  const { call, calls } = fixture();
  await call("list_resources", {
    collection: "waypoints",
    bbox: [1, 2, 3, 4],
    position: [2, 3],
    distance: 100,
    zoom: 8,
  });
  const query = new URL(`http://fixture${calls.at(-1)}`).searchParams;
  assert.equal(query.get("limit"), "100");
  assert.deepEqual(JSON.parse(query.get("bbox")), [1, 2, 3, 4]);
  assert.deepEqual(JSON.parse(query.get("position")), [2, 3]);
  await call("list_resources", { collection: "charts" });
  assert.equal(
    new URL(`http://fixture${calls.at(-1)}`).searchParams.has("limit"),
    false,
  );
  for (const args of [
    { collection: "charts", limit: 1 },
    { collection: "routes", href: `/resources/waypoints/${uuid}` },
    { collection: "notes", href: "https://evil.invalid" },
    { collection: "routes", position: [1, 2] },
    { collection: "routes", bbox: [0, -91, 1, 90] },
    { collection: "routes", filter: "anything" },
  ])
    await assert.rejects(call("list_resources", args), /INVALID_ARGUMENTS/);
});

test("Resource discovery and explicit provider selection fail closed", async () => {
  const { call, state, calls } = fixture();
  state.providers = ["example", "Other.Provider"];
  await assert.rejects(
    call("get_resource", { collection: "routes", id: uuid }),
    /RESOURCE_PROVIDER_REQUIRED/,
  );
  assert.ok(calls.every((path) => !path.includes("?")));
  await call("get_resource", {
    collection: "routes",
    id: uuid,
    provider: "Other.Provider",
  });
  assert.match(calls.at(-1), /provider=Other.Provider$/);
  await assert.rejects(
    call("get_resource", {
      collection: "routes",
      id: uuid,
      provider: "absent",
    }),
    /RESOURCE_PROVIDER_UNAVAILABLE/,
  );
  state.providers = [];
  await assert.rejects(
    call("list_resources", { collection: "routes" }),
    /RESOURCE_PROVIDER_UNAVAILABLE/,
  );
  delete state.collections.logentries;
  await assert.rejects(
    call("list_logentries", { limit: 1 }),
    /RESOURCE_COLLECTION_UNAVAILABLE/,
  );
  state.providers = ["example", "example"];
  await assert.rejects(
    call("list_resource_providers", { collection: "routes" }),
    /INVALID_RESOURCE_PROVIDERS/,
  );
});

test("Logbook query windows, UUIDs and inputs are bounded before discovery", async () => {
  const { call, calls } = fixture();
  for (const args of [
    {},
    { limit: 0 },
    { limit: 501 },
    { date: "2026-02-30" },
    { from: "2026-10-01T00:00:00Z" },
    { from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" },
    { from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" },
    {
      date: "2026-10-01",
      from: "2026-10-01T00:00:00Z",
      to: "2026-10-02T00:00:00Z",
    },
    { limit: 1, dates: true },
    { limit: 1, author: "x".repeat(257) },
  ])
    await assert.rejects(
      call("list_logentries", args),
      /INVALID_ARGUMENTS|RESOURCE_QUERY_LIMIT/,
    );
  for (const id of [
    "_providers",
    "../config",
    "a/b",
    "x?provider=evil",
    "%2e%2e",
    "bad-uuid",
  ])
    await assert.rejects(
      call("get_resource", { collection: "logentries", id }),
      /INVALID_ARGUMENTS/,
    );
  assert.equal(calls.length, 0);
});

test("Resource reads reauthorize after discovery and payload, rejecting revoked or switched identity", async () => {
  for (const change of ["revoke", "changeIdentity"]) {
    const f = fixture();
    f.state.after = f[change];
    await assert.rejects(
      f.call("get_resource", { collection: "routes", id: uuid }),
      /PERMISSION_DENIED/,
    );
  }
  const f = fixture();
  f.revoke();
  await assert.rejects(f.call("list_collections"), /PERMISSION_DENIED/);
  assert.equal(f.calls.length, 0);
});

test("Invalid, oversized and over-limit resource responses never become partial success", async () => {
  const f = fixture();
  for (const data of [[], null, { [uuid]: "bad" }, { "../bad": {} }]) {
    f.state.data = data;
    await assert.rejects(
      f.call("list_resources", { collection: "routes" }),
      /INVALID_RESOURCE_RESPONSE/,
    );
  }
  f.state.data = { one: {}, two: {} };
  await assert.rejects(
    f.call("list_resources", { collection: "routes", limit: 1 }),
    /RESOURCE_RESULT_LIMIT/,
  );
  f.state.data = { [uuid]: { text: "x".repeat(225 * 1024) } };
  await assert.rejects(f.call("list_logentries", { limit: 1 }), /OUTPUT_LIMIT/);
  f.state.data = { "2026-10-22": { count: 4, extra: null } };
  assert.deepEqual((await f.call("list_logentry_dates")).data, f.state.data);
  assert.equal(
    new URL(`http://fixture${f.calls.at(-1)}`).searchParams.get("dates"),
    "true",
  );
  for (const data of [
    { "2026-02-30": { count: 1 } },
    { "2026-10-22": { count: -1 } },
    { "2026-10-22": { count: 1.2 } },
  ]) {
    f.state.data = data;
    await assert.rejects(
      f.call("list_logentry_dates"),
      /INVALID_RESOURCE_RESPONSE/,
    );
  }
});

test("Missing resource endpoint is reported by description without inventing availability", async () => {
  const f = fixture();
  f.state.collections = [];
  const described = await f.registry.describe("api.resources");
  assert.equal(described.reason, "INVALID_RESOURCE_COLLECTIONS");
  assert.ok(described.operations.every((op) => !op.enabled));
});

test("Resources HTTP whitelist rejects alternate hosts, property traversal, configuration and tiles", async () => {
  const get = localGet(
    { socket: { localAddress: "127.0.0.1", localPort: 1 } },
    "Bearer synthetic",
    new AbortController().signal,
  );
  for (const path of [
    "https://evil.invalid/signalk/v2/api/resources",
    "//evil.invalid/resources",
    `${root}/charts/id/1/2/3`,
    `${root}/routes/id/name`,
    `${root}/routes/_providers/_default`,
    `${root}/routes/../config`,
    `${root}/routes/%2e%2e`,
    `${root}/routes#fragment`,
    `${root}\\settings`,
  ])
    await assert.rejects(
      get(path),
      (error) =>
        error instanceof GatewayError && error.code === "INVALID_LOCAL_ROUTE",
    );
});

const { ApprovalRequests, reviewKey } = require("../dist/approvals.js");
function mutationFixture() {
  const config = configSchema.parse({});
  const requests = new ApprovalRequests();
  const state = {
    permissions: "readwrite",
    providers: ["example"],
    calls: [],
    response: {
      status: 201,
      data: { state: "COMPLETED", statusCode: 201, id: uuid },
    },
    after: () => {},
    allowed: true,
    getHook: () => {},
  };
  const app = {
    securityStrategy: {
      isDummy: () => false,
      anyACLs: () => true,
      checkACL: () => false,
      authorizeWS: (c) => {
        c.skIsAuthenticated = state.allowed;
        c.skPrincipal = {
          identifier: "writer",
          permissions: state.permissions,
        };
      },
    },
  };
  const registry = new CapabilityRegistry(
    app,
    "Bearer synthetic",
    config,
    () => true,
    async (path) => {
      state.getHook(path);
      if (path === root)
        return Object.fromEntries(
          [
            "routes",
            "waypoints",
            "regions",
            "notes",
            "charts",
            "logentries",
          ].map((name) => [name, { description: name }]),
        );
      if (path.endsWith("/_providers")) return state.providers;
      throw new Error("unexpected GET");
    },
    requests,
    undefined,
    undefined,
    undefined,
    async (method, path, body) => {
      state.calls.push({ method, path, body });
      state.after();
      if (state.response instanceof Error) throw state.response;
      return state.response;
    },
  );
  const call = (operation, args) =>
    registry.executeMutation("api.resources", operation, args);
  const reviews = () =>
    Object.values(requests.schema().properties).map((p) => p.default);
  const approve = () => {
    for (const review of reviews())
      config.readRequests[reviewKey(review)] = {
        ...review,
        decision: "approved",
      };
  };
  return { config, requests, state, registry, call, reviews, approve };
}
const bodies = {
  routes: {
    name: "route",
    feature: {
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    },
  },
  waypoints: {
    name: "waypoint",
    feature: { geometry: { type: "Point", coordinates: [0, 0] } },
  },
  regions: {
    feature: {
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    },
  },
  notes: { title: "note", position: { latitude: 0, longitude: 0 } },
  charts: {
    name: "chart",
    type: "tilelayer",
    url: "https://example.invalid/{z}/{x}/{y}.png",
  },
  logentries: {
    text: "entry",
    enrich: false,
    telemetry: [{ path: "navigation.speedOverGround", value: 0 }],
    "x-fixture": { keep: null },
  },
};
test("Resource writes require separate saved reviews for collection, provider and method", async () => {
  const f = mutationFixture();
  const args = {
    collection: "logentries",
    provider: "example",
    body: bodies.logentries,
  };
  f.state.permissions = "readonly";
  await assert.rejects(f.call("create_resource", args), /PERMISSION_DENIED/);
  assert.equal(f.reviews().length, 0);
  f.state.permissions = "readwrite";
  await assert.rejects(f.call("create_resource", args), /APPROVAL_PENDING/);
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.reviews()[0].kind, "resource");
  assert.equal(JSON.stringify(f.reviews()).includes('"text":"entry"'), false);
  f.approve();
  const result = await f.call("create_resource", args);
  assert.equal(result.outcome, "responded");
  assert.equal(result.retrySafe, false);
  assert.deepEqual(f.state.calls[0].body, bodies.logentries);
  assert.equal(f.state.calls[0].path, `${root}/logentries?provider=example`);
  await assert.rejects(
    f.call("put_resource", { ...args, id: uuid }),
    /APPROVAL_PENDING/,
  );
  await assert.rejects(
    f.call("delete_resource", {
      collection: "logentries",
      provider: "example",
      id: uuid,
    }),
    /APPROVAL_PENDING/,
  );
  f.state.providers.push("other");
  await assert.rejects(
    f.call("create_resource", { ...args, provider: "other" }),
    /APPROVAL_PENDING/,
  );
  await assert.rejects(
    f.call("create_resource", {
      collection: "notes",
      provider: "example",
      body: bodies.notes,
    }),
    /APPROVAL_PENDING/,
  );
  const key = reviewKey(f.reviews()[0]);
  f.config.readRequests[key].decision = "rejected";
  await assert.rejects(f.call("create_resource", args), /APPROVAL_REJECTED/);
});

test("All supported resource body contracts preserve fields and validate before queueing", async () => {
  const f = mutationFixture();
  for (const [collection, body] of Object.entries(bodies)) {
    const args = { collection, provider: "example", body };
    await assert.rejects(f.call("create_resource", args), /APPROVAL_PENDING/);
    f.approve();
    await f.call("create_resource", args);
    assert.deepEqual(f.state.calls.at(-1).body, body);
  }
  const count = f.reviews().length;
  for (const [operation, args] of [
    [
      "create_resource",
      {
        collection: "logentries",
        provider: "example",
        body: { text: "entry", id: uuid },
      },
    ],
    [
      "create_resource",
      {
        collection: "charts",
        provider: "example",
        body: { ...bodies.charts, identifier: "existing-chart" },
      },
    ],
    [
      "create_resource",
      { collection: "waypoints", provider: "example", body: {} },
    ],
    [
      "create_resource",
      {
        collection: "logentries",
        provider: "example",
        body: { text: "entry", telemetry: [{ path: "navigation.position" }] },
      },
    ],
    [
      "create_resource",
      { collection: "logentries", provider: "example", body: { text: 42 } },
    ],
    [
      "put_resource",
      {
        collection: "logentries",
        provider: "example",
        id: uuid,
        body: { text: "entry", id: "00000000-0000-4000-8000-000000000002" },
      },
    ],
    [
      "delete_resource",
      { collection: "notes", provider: "example", id: "../settings" },
    ],
    [
      "delete_resource",
      { collection: "custom", provider: "example", id: uuid },
    ],
    [
      "delete_resource",
      { collection: "notes", provider: "example", id: uuid, body: {} },
    ],
  ])
    await assert.rejects(f.call(operation, args), /INVALID_ARGUMENTS/);
  await assert.rejects(
    f.call("create_resource", {
      collection: "notes",
      provider: "example",
      body: { extra: "x".repeat(50000) },
    }),
    /INPUT_LIMIT/,
  );
  assert.equal(f.reviews().length, count);
});

test("Resource upserts cannot cross a reviewed provider boundary", async () => {
  const f = mutationFixture();
  const args = {
    collection: "logentries",
    provider: "example",
    id: uuid,
    body: bodies.logentries,
  };
  await assert.rejects(f.call("put_resource", args), /APPROVAL_PENDING/);
  f.approve();
  f.state.providers.push("other");
  await assert.rejects(
    f.call("put_resource", args),
    /RESOURCE_PUT_PROVIDER_AMBIGUOUS/,
  );
  assert.equal(f.state.calls.length, 0);
  f.state.providers = ["example"];
  let reads = 0;
  f.state.getHook = (path) => {
    if (path.endsWith("/_providers") && ++reads === 2)
      f.state.providers.push("other");
  };
  await assert.rejects(
    f.call("put_resource", args),
    /RESOURCE_PUT_PROVIDER_AMBIGUOUS/,
  );
  assert.equal(f.state.calls.length, 0);
});

test("Resource mutation failures remain submitted unknown outcomes and are never retried", async () => {
  const f = mutationFixture();
  const args = { collection: "notes", provider: "example", body: bodies.notes };
  await assert.rejects(f.call("create_resource", args), /APPROVAL_PENDING/);
  f.approve();
  for (const error of [
    new GatewayError("RESOURCE_HTTP_ERROR", 403),
    new GatewayError("UPSTREAM_UNAVAILABLE", 503),
    new GatewayError("OUTPUT_LIMIT"),
  ]) {
    f.state.response = error;
    const before = f.state.calls.length;
    const result = await f.call("create_resource", args);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.submitted, true);
    assert.equal(result.retrySafe, false);
    assert.equal(result.data, undefined);
    assert.equal(f.state.calls.length, before + 1);
  }
  f.state.response = { status: 201, data: { secret: "must not return" } };
  f.state.after = () => {
    f.state.allowed = false;
  };
  const result = await f.call("create_resource", args);
  assert.equal(result.outcome, "unknown");
  assert.equal(result.data, undefined);
});
