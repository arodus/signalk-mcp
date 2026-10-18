const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  discoverOperations,
  operationRoute,
} = require("../dist/capabilities/openapi.js");
const { CapabilityRegistry } = require("../dist/capabilities/registry.js");
const { configSchema } = require("../dist/config.js");
const { localGet } = require("../dist/capabilities/http.js");
const principal = { identifier: "reader", permissions: "readonly" };
const approval = {
  pluginId: "example",
  operationId: "read",
  method: "GET",
  path: "/reading/{id}",
  readOnly: true,
  permission: "readonly",
};
function spec() {
  return {
    openapi: "3.0.3",
    paths: {
      "/reading/{id}": {
        get: {
          operationId: "read",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
        },
      },
    },
  };
}

test("OpenAPI schema subset rejects references, ambiguity and unsupported constraints", () => {
  const cases = [
    (schema) => {
      schema.$ref = "https://example.invalid/schema";
    },
    (schema) => {
      schema.pattern = "(a+)+$";
    },
    (schema) => {
      schema.type = "object";
    },
    (schema) => {
      schema.oneOf = [{ type: "string" }];
    },
    (schema) => {
      schema.maxLength = 100000;
    },
  ];
  for (const change of cases) {
    const document = spec();
    change(document.paths["/reading/{id}"].get.parameters[0].schema);
    assert.equal(
      discoverOperations(document, "example", [approval], principal)[0].enabled,
      false,
    );
  }
  const document = spec();
  document.paths["/duplicate"] = { get: { operationId: "read" } };
  for (const operation of discoverOperations(
    document,
    "example",
    [approval],
    principal,
  ))
    assert.equal(operation.reason, "AMBIGUOUS_OPERATION_ID");
  const circular = spec();
  circular.components = {
    schemas: { loop: { $ref: "#/components/schemas/loop" } },
  };
  circular.paths["/reading/{id}"].get.parameters[0].schema = {
    $ref: "#/components/schemas/loop",
  };
  assert.equal(
    discoverOperations(circular, "example", [approval], principal)[0].reason,
    "UNSUPPORTED_REFERENCE",
  );
});

test("OpenAPI approval binds method, path and permission; params cannot escape route or become credentials", () => {
  const document = spec();
  for (const changed of [
    { ...approval, path: "/other" },
    { ...approval, method: "POST" },
    { ...approval, permission: "admin" },
  ])
    assert.equal(
      discoverOperations(document, "example", [changed], principal)[0].enabled,
      false,
    );
  const operation = discoverOperations(
    document,
    "example",
    [approval],
    principal,
  )[0];
  for (const id of [
    "..",
    "../admin",
    "x?token=y",
    "%2fadmin",
    "x\\admin",
    "x#fragment",
  ])
    assert.throws(
      () => operationRoute("example", operation, { id }),
      /INVALID_ARGUMENTS/,
    );
  assert.equal(
    operationRoute("example", operation, { id: "house" }),
    "/plugins/example/reading/house",
  );
  for (const name of ["token", "url", "authorization", "constructor"]) {
    const altered = spec();
    altered.paths["/reading/{id}"].get.parameters.push({
      name,
      in: "query",
      schema: { type: "string" },
    });
    assert.equal(
      discoverOperations(altered, "example", [approval], principal)[0].reason,
      "UNSUPPORTED_PARAMETER",
    );
  }
  assert.equal(
    configSchema.safeParse({
      pluginOperations: [approval, approval],
    }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({
      pluginOperations: [{ ...approval, method: "POST" }],
    }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({
      pluginOperations: [{ ...approval, readOnly: false }],
    }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({
      pluginOperations: [{ ...approval, pluginId: "signalk-mcp" }],
    }).success,
    false,
  );
});

function registryFixture() {
  const user = { ...principal };
  const app = {
    selfContext: "vessels.fixture",
    securityStrategy: {
      isDummy: () => false,
      authorizeWS: (connection) => {
        connection.skIsAuthenticated = true;
        connection.skPrincipal = user;
      },
      checkACL: (_id, _context, path) => path === "notifications.allowed",
    },
    getSelfPath: (path) => ({
      value: { state: "alarm", message: path },
      $source: "fixture",
    }),
    getPath: () => ({
      notifications: { allowed: { value: 1 }, denied: { value: 2 } },
    }),
    getFeatures: async () => ({
      apis: ["history", "autopilot"],
      plugins: [
        { id: "example", enabled: true },
        { id: "disabled", enabled: false },
      ],
    }),
  };
  const config = { staleAfterSeconds: 300, pluginOperations: [approval] };
  return { user, app, config };
}
test("oversized feature discovery fails closed and recovers with bounded input", async () => {
  const { app, config } = registryFixture();
  const valid = app.getFeatures;
  const registry = new CapabilityRegistry(
    app,
    "Bearer token",
    config,
    () => true,
  );
  for (const features of [
    {
      apis: [],
      plugins: Array.from({ length: 257 }, (_, i) => ({
        id: `p${i}`,
        enabled: true,
      })),
    },
    { apis: Array.from({ length: 65 }, (_, i) => `api${i}`), plugins: [] },
  ]) {
    app.getFeatures = async () => features;
    const result = await registry.list();
    assert.equal(result.discovery, "INVALID_FEATURES");
    assert.equal(result.capabilities.length, 3);
    await assert.rejects(
      registry.describe("plugin.example"),
      /INVALID_FEATURES/,
    );
  }
  app.getFeatures = valid;
  assert.ok(
    (await registry.list()).capabilities.some(
      (entry) => entry.id === "plugin.example",
    ),
  );
});
test("partial discovery stays truthful and does not break core capabilities", async () => {
  const { app, config } = registryFixture();
  let gets = 0;
  const registry = new CapabilityRegistry(
    app,
    "Bearer token",
    config,
    () => true,
    async () => {
      gets++;
      throw new Error("sensitive upstream details");
    },
  );
  assert.equal(
    (await registry.describe("plugin.disabled")).reason,
    "PLUGIN_DISABLED",
  );
  assert.equal(gets, 0);
  assert.equal(
    (await registry.describe("plugin.example")).reason,
    "DISCOVERY_UNAVAILABLE",
  );
  assert.equal(
    (await registry.describe("api.autopilot")).reason,
    "ADAPTER_REQUIRED",
  );
  await assert.rejects(
    registry.execute("api.autopilot", "engage", {}),
    /CAPABILITY_NOT_FOUND/,
  );
  app.getFeatures = async () => {
    throw new Error("sensitive discovery failure");
  };
  const listed = await registry.list();
  assert.equal(listed.discovery, "DISCOVERY_UNAVAILABLE");
  assert.equal(listed.capabilities.length, 3);
  const notifications = await registry.execute(
    "signalk.notifications",
    "list",
    {},
  );
  assert.deepEqual(
    notifications.measurements.map((value) => value.path),
    ["notifications.allowed"],
  );
});

test("permission revocation during an asynchronous provider response discards its result", async () => {
  const { user, app, config } = registryFixture();
  const registry = new CapabilityRegistry(
    app,
    "Bearer token",
    config,
    () => true,
    async (path) => {
      if (path.startsWith("/skServer/")) return spec();
      user.permissions = "unknown";
      return { private: "must not escape" };
    },
  );
  await assert.rejects(
    registry.execute("plugin.example", "read", { id: "house" }),
    /PERMISSION_DENIED/,
  );
});

test("local HTTP transport bounds JSON and refuses alternate routes and redirects", async (t) => {
  const http = require("node:http");
  const received = [];
  const server = http.createServer((req, res) => {
    received.push(req.url);
    if (req.url.endsWith("/redirect")) {
      res.writeHead(302, { Location: "http://example.invalid/steal" });
      res.end();
    } else if (req.url.endsWith("/large")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify("x".repeat(256 * 1024)));
    } else if (req.url.endsWith("/invalid")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not json");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method,
          hasCookie: !!req.headers.cookie,
          hasBearer: req.headers.authorization === "Bearer fixture",
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const get = localGet(
    {
      socket: { localAddress: "127.0.0.1", localPort: server.address().port },
      headers: { host: "example.invalid" },
    },
    "Bearer fixture",
    new AbortController().signal,
  );
  assert.deepEqual(await get("/plugins/example/read"), {
    method: "GET",
    hasCookie: false,
    hasBearer: true,
  });
  await assert.rejects(
    get("http://example.invalid/steal"),
    /INVALID_LOCAL_ROUTE/,
  );
  await assert.rejects(get("/skServer/security"), /INVALID_LOCAL_ROUTE/);
  await assert.rejects(get("/plugins/example/redirect"), /UPSTREAM_HTTP_ERROR/);
  await assert.rejects(get("/plugins/example/large"), /OUTPUT_LIMIT/);
  await assert.rejects(
    get("/plugins/example/invalid"),
    /UPSTREAM_INVALID_JSON/,
  );
  assert.equal((await get("/signalk/v2/api/notifications")).method, "GET");
  for (const route of [
    "/signalk/v2/api/notifications/silenceAll",
    "/signalk/v2/api/notifications/id/acknowledge",
    "/signalk/v2/api/notifications?url=other",
  ])
    await assert.rejects(get(route), /INVALID_LOCAL_ROUTE/);
  assert.equal(received.length, 5);
});

test("invalid approval configuration reports field guidance without leaking input", () => {
  const errors = [];
  const plugin = require("../dist/index.js")({
    setPluginError: (message) => errors.push(message),
  });
  plugin.start({
    pluginOperations: [
      { ...approval, method: "POST", operationId: "synthetic-private-value" },
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /pluginOperations/);
  assert.match(errors[0], /reviewed GET/);
  assert.doesNotMatch(errors[0], /synthetic-private-value/);
});

test("optional OpenAPI IDs use route names but never bypass exact approval or collision checks", () => {
  const document = spec();
  delete document.paths["/reading/{id}"].get.operationId;
  const routeApproval = { ...approval, operationId: "get.reading.by-id" };
  const read = discoverOperations(
    document,
    "example",
    [routeApproval],
    principal,
  )[0];
  assert.equal(read.id, "get.reading.by-id");
  assert.equal(read.enabled, true);
  assert.equal(
    discoverOperations(document, "example", [approval], principal)[0].enabled,
    false,
  );
  assert.equal(
    discoverOperations(document, "example", [], principal)[0].reason,
    "NOT_ALLOWLISTED",
  );
  document.paths["/reading/by-id"] = { get: {} };
  for (const operation of discoverOperations(
    document,
    "example",
    [routeApproval],
    principal,
  ))
    assert.equal(operation.reason, "AMBIGUOUS_OPERATION_ID");
  delete document.paths["/reading/by-id"];
  document.paths["/other"] = { get: { operationId: "get.reading.by-id" } };
  for (const operation of discoverOperations(
    document,
    "example",
    [routeApproval],
    principal,
  ))
    assert.equal(operation.reason, "AMBIGUOUS_OPERATION_ID");
  delete document.paths["/other"];
  document.paths["/reading/{id}"].post = {};
  assert.equal(
    discoverOperations(document, "example", [routeApproval], principal)[1]
      .reason,
    "METHOD_NOT_READONLY",
  );
  for (const invalid of [null, "", "bad/id", 42]) {
    document.paths["/reading/{id}"].get.operationId = invalid;
    assert.equal(
      discoverOperations(document, "example", [routeApproval], principal).some(
        (op) => op.method === "GET",
      ),
      false,
    );
  }
});

test("explicit 512-character string bounds remain enforced and larger schemas fail closed", () => {
  const document = spec();
  document.paths["/reading/{id}"].get.parameters.push({
    name: "cursor",
    in: "query",
    schema: { type: "string", maxLength: 512 },
  });
  const operation = discoverOperations(
    document,
    "example",
    [approval],
    principal,
  )[0];
  assert.equal(operation.enabled, true);
  assert.ok(
    operationRoute("example", operation, {
      id: "sample",
      cursor: "x".repeat(512),
    }).includes("cursor="),
  );
  assert.throws(
    () =>
      operationRoute("example", operation, {
        id: "sample",
        cursor: "x".repeat(513),
      }),
    /INVALID_ARGUMENTS/,
  );
  document.paths["/reading/{id}"].get.parameters[1].schema.maxLength = 513;
  assert.equal(
    discoverOperations(document, "example", [approval], principal)[0].reason,
    "UNSUPPORTED_SCHEMA",
  );
});

test("TLS verification names accept DNS names and reject destination syntax", () => {
  for (const name of [
    "",
    "https://boat.example",
    "boat.example:3443",
    "*.example",
    "127.0.0.1",
    "::1",
    "-boat.example",
    "boat..example",
    "a".repeat(64) + ".example",
  ])
    assert.equal(
      configSchema.safeParse({
        localTlsServerName: name,
      }).success,
      false,
      name,
    );
  for (const name of ["localhost", "boat.example", "Signal-K.example"])
    assert.equal(
      configSchema.safeParse({
        localTlsServerName: name,
      }).success,
      true,
      name,
    );
});
