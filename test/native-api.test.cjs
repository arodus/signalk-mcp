const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  discoverOperations,
  operationRoute,
} = require("../dist/capabilities/openapi.js");
const {
  nativeApiSchema,
  isNativeApiRoute,
} = require("../dist/capabilities/native-api.js");
const {
  ApprovalRequests,
  applyReviews,
  reviewKey,
} = require("../dist/approvals.js");
const { configSchema } = require("../dist/config.js");
const { CapabilityRegistry } = require("../dist/capabilities/registry.js");
const { JsonSchemaCompiler } = require("../dist/capabilities/json-schema.js");
const principal = { identifier: "writer", permissions: "readwrite" };
function documentFor(api) {
  return globalThis.structuredClone(
    require(`./fixtures/native-openapi/${api}.json`),
  );
}
function discover(api, document = documentFor(api)) {
  return discoverOperations(document, api, [], principal, api);
}
function approve(api, operation, decision = "approved") {
  const queue = new ApprovalRequests();
  assert.throws(() => queue.request(api, operation), /APPROVAL_PENDING/);
  const review = Object.values(queue.schema().properties)[0].default;
  assert.equal(review.kind, "api");
  assert.equal("body" in review, false);
  review.decision = decision;
  return { [reviewKey(review)]: review };
}
test("all seven pinned native documents use shared schema discovery and exact namespaces", () => {
  const expected = {
    course: [15, 11],
    weather: [7, 6],
    autopilot: [23, 22],
    radar: [10, 10],
    ble: [14, 7],
    tracks: [3, 3],
    sensors: [3, 1],
  };
  for (const api of nativeApiSchema.options) {
    const operations = discover(api);
    assert.deepEqual(
      [
        operations.length,
        operations.filter((o) => o.reason === "NOT_ALLOWLISTED").length,
      ],
      expected[api],
      api,
    );
    for (const operation of operations.filter(
      (o) => o.reason === "NOT_ALLOWLISTED",
    )) {
      const reviews = approve(api, operation);
      assert.equal(
        configSchema.safeParse({ readRequests: reviews }).success,
        true,
        operation.id,
      );
      assert.equal(
        applyReviews([operation], api, reviews, principal)[0].enabled,
        true,
      );
      assert.ok(operation.path.startsWith("/signalk/v2/api/"));
    }
  }
});
test("native approvals bind namespace, method, input and meaning independently of plugin reviews", () => {
  const op = discover("autopilot").find((o) => o.id === "post.by-id.engage");
  const reviews = approve("autopilot", op);
  assert.equal(
    applyReviews([op], "autopilot", reviews, principal)[0].enabled,
    true,
  );
  for (const changed of [
    { ...op, api: "radar", path: op.path.replace("/autopilots/", "/radars/") },
    { ...op, method: "DELETE" },
    { ...op, path: op.path + "/other" },
    { ...op, description: "new meaning" },
    { ...op, inputSchema: { type: "object" } },
  ]) {
    changed.enabled = false;
    changed.reason = "NOT_ALLOWLISTED";
    assert.equal(
      applyReviews([changed], "autopilot", reviews, principal)[0].enabled,
      false,
    );
  }
  const fresh = () => discover("autopilot").find((o) => o.id === op.id);
  assert.equal(
    applyReviews(
      [fresh()],
      "autopilot",
      approve("autopilot", fresh(), "rejected"),
      principal,
    )[0].reason,
    "APPROVAL_REJECTED",
  );
  assert.equal(
    applyReviews([fresh()], "autopilot", reviews, {
      identifier: "reader",
      permissions: "readonly",
    })[0].reason,
    "PERMISSION_DENIED",
  );
  const plugin = discoverOperations(
    { openapi: "3.0.0", paths: { "/x": { post: { operationId: op.id } } } },
    "autopilot",
    [],
    principal,
  )[0];
  assert.equal(
    applyReviews([plugin], "autopilot", reviews, principal)[0].enabled,
    false,
  );
  const updated = documentFor("autopilot");
  updated.info.version = "999";
  assert.equal(
    discover("autopilot", updated).find((o) => o.id === op.id).contractHash,
    op.contractHash,
  );
});
test("native routes ignore server URLs and reject escapes, configuration writes and streams", () => {
  const d = documentFor("autopilot");
  d.servers = [{ url: "https://evil.invalid/" }];
  const op = discover("autopilot", d).find((o) => o.id === "post.by-id.engage");
  applyReviews([op], "autopilot", approve("autopilot", op), principal);
  assert.equal(
    operationRoute("autopilot", op, { id: "pilot" }),
    "/signalk/v2/api/vessels/self/autopilots/pilot/engage",
  );
  for (const id of ["../x", "a/b", "a?x", "%2e%2e", "https://evil"])
    assert.throws(
      () => operationRoute("autopilot", op, { id }),
      /INVALID_ARGUMENTS/,
    );
  for (const route of [
    "/signalk/v2/api/vessels/self/autopilots/%2e%2e/engage",
    "/signalk/v2/api/vessels/self/autopilots/a%2fb/engage",
    "/signalk/v2/api/security/users",
    "/signalk/v2/api/weather/_providers/_default/x",
    "/signalk/v2/api/vessels/self/sensors/gnss",
  ])
    assert.equal(isNativeApiRoute("POST", route), false, route);
  const cross = {
    openapi: "3.0.0",
    paths: { "/signalk/v2/api/resources/notes": { get: {} } },
  };
  assert.equal(discover("weather", cross)[0].reason, "UNSUPPORTED_ROUTE");
  assert.equal(
    discover("ble").find((o) => o.id === "get.advertisements").reason,
    "UNSUPPORTED_RESPONSE",
  );
  assert.equal(
    discover("ble").find((o) => o.id === "put.settings").reason,
    "UNSUPPORTED_ROUTE",
  );
});
test("shared numeric aliases, scalar unions, durations and safe literal patterns retain validation", () => {
  const compiler = new JsonSchemaCompiler({});
  const numeric = compiler.parse(
    { type: "number", min: -90, max: 90 },
    "latitude",
    true,
  );
  assert.equal(numeric.safeParse(91).success, false);
  assert.throws(
    () => compiler.parse({ type: "number", min: 1, minimum: 2 }, "x"),
    /UNSUPPORTED_SCHEMA/,
  );
  const duration = compiler.parse(
    {
      oneOf: [
        { type: "integer", minimum: 1 },
        { type: "string", format: "duration" },
      ],
    },
    "duration",
    true,
  );
  for (const value of [60, "PT1H", "P1DT2H"])
    assert.equal(duration.safeParse(value).success, true);
  for (const value of [0, {}, "P", "PT", "-PT1H"])
    assert.equal(duration.safeParse(value).success, false);
  const date = compiler.parse(
    { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
    "date",
    true,
  );
  assert.equal(date.safeParse("2026-10-22").success, true);
  assert.equal(date.safeParse("2026X10X22").success, false);
  assert.throws(
    () => compiler.parse({ type: "string", pattern: "^(a+)+$" }, "x"),
    /UNSUPPORTED_SCHEMA/,
  );
});
test("native registry execution shares approvals and preserves caller authorization across requests", async () => {
  const user = { ...principal };
  let advertised = true;
  const seen = [];
  const app = {
    securityStrategy: {
      isDummy: () => false,
      checkACL: () => false,
      authorizeWS: (c) => {
        c.skIsAuthenticated = true;
        c.skPrincipal = user;
      },
    },
    getFeatures: async () => ({
      apis: advertised ? ["autopilot"] : [],
      plugins: [],
    }),
  };
  const config = {
    staleAfterSeconds: 300,
    pluginOperations: [],
    readRequests: {},
  };
  const queue = new ApprovalRequests();
  let afterRead = () => {};
  const get = async (path) => {
    seen.push(path);
    if (!path.startsWith("/skServer/")) afterRead();
    return path.startsWith("/skServer/")
      ? documentFor("autopilot")
      : { value: 0 };
  };
  let submissions = 0;
  const send = async () => {
    submissions++;
    throw new Error("disconnect");
  };
  const registry = new CapabilityRegistry(
    app,
    "Bearer fixture",
    config,
    () => true,
    get,
    queue,
    undefined,
    undefined,
    undefined,
    undefined,
    send,
  );
  const op = discover("autopilot").find((o) => o.id === "get.by-id.state");
  await assert.rejects(
    () => registry.execute("api.autopilot", op.id, { id: "pilot" }),
    /APPROVAL_PENDING/,
  );
  assert.ok(seen.every((p) => p.startsWith("/skServer/")));
  config.readRequests = approve("autopilot", op);
  assert.deepEqual(
    (await registry.execute("api.autopilot", op.id, { id: "pilot" })).data,
    { value: 0 },
  );
  assert.equal(seen.filter((p) => p.startsWith("/skServer/")).length, 1);
  afterRead = () => {
    user.identifier = "other";
  };
  await assert.rejects(
    registry.execute("api.autopilot", op.id, { id: "pilot" }),
    /PERMISSION_DENIED/,
  );
  user.identifier = principal.identifier;
  afterRead = () => {
    config.readRequests = {};
  };
  await assert.rejects(
    registry.execute("api.autopilot", op.id, { id: "pilot" }),
    /PERMISSION_DENIED/,
  );
  config.readRequests = approve("autopilot", op);
  afterRead = () => {};
  const mutation = discover("autopilot").find(
    (o) => o.id === "post.by-id.engage",
  );
  config.readRequests = {
    ...config.readRequests,
    ...approve("autopilot", mutation),
  };
  await assert.rejects(
    () => registry.execute("api.autopilot", mutation.id, { id: "pilot" }),
    /MUTATION_TOOL_REQUIRED/,
  );
  user.permissions = "readonly";
  await assert.rejects(
    () =>
      registry.executeMutation("api.autopilot", mutation.id, { id: "pilot" }),
    /PERMISSION_DENIED/,
  );
  user.permissions = "readwrite";
  const result = await registry.executeMutation("api.autopilot", mutation.id, {
    id: "pilot",
  });
  assert.equal(result.outcome, "unknown");
  assert.equal(result.retrySafe, false);
  assert.equal(submissions, 1);
  advertised = false;
  await assert.rejects(
    () => registry.execute("api.autopilot", op.id, { id: "pilot" }),
    /CAPABILITY_NOT_FOUND/,
  );
});

test("built-in document cache is shared, bounded by API names and reset with lifecycle", async () => {
  const { DiscoveryCache } = require("../dist/capabilities/discovery-cache.js");
  const cache = new DiscoveryCache();
  let reads = 0;
  const get = async () => {
    reads++;
    return documentFor("weather");
  };
  const [a, b] = await Promise.all([
    cache.nativeDocument("weather", get),
    cache.nativeDocument("weather", get),
  ]);
  assert.equal(a, b);
  await cache.nativeDocument("weather", get);
  assert.equal(reads, 1);
  cache.clear();
  await cache.nativeDocument("weather", get);
  assert.equal(reads, 2);
  cache.clear();
  await assert.rejects(
    cache.nativeDocument("weather", async () => {
      throw Error("cancelled");
    }),
    /cancelled/,
  );
  await cache.nativeDocument("weather", get);
  assert.equal(reads, 3);
  let reject;
  cache.clear();
  const previous = cache.nativeDocument(
    "weather",
    () =>
      new Promise((_, no) => {
        reject = no;
      }),
  );
  await Promise.resolve();
  cache.clear();
  await cache.nativeDocument("weather", get);
  reject(Error("old generation"));
  await assert.rejects(previous, /old generation/);
  await cache.nativeDocument("weather", get);
  assert.equal(reads, 4);
});
