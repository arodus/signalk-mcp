const { test } = require("node:test");
const assert = require("node:assert/strict");
const { authenticate, canRead } = require("../dist/auth.js");
const { getValues, listPaths } = require("../dist/data.js");
const { createMcpServer } = require("../dist/mcp.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

function fixture() {
  const principal = { identifier: "reader", permissions: "readonly" };
  const app = {
    selfContext: "vessels.fixture",
    securityStrategy: {
      isDummy: () => false,
      authorizeWS: (connection) => {
        connection.skIsAuthenticated = true;
        connection.skPrincipal = principal;
      },
      checkACL: (id, context, path, source, operation) =>
        id === "reader" &&
        context === "vessels.self" &&
        path.startsWith("navigation.") &&
        source === "fixture" &&
        operation === "read",
    },
    getSelfPath: () => ({ value: 0, $source: "fixture" }),
    getPath: () => ({
      navigation: { speed: { value: 0, $source: "fixture" } },
      electrical: { secret: { value: "hidden", $source: "fixture" } },
    }),
  };
  return { app, principal };
}

test("security-disabled, missing hooks and unverified identities fail closed", () => {
  for (const app of [
    {},
    { securityStrategy: { isDummy: () => true } },
    { securityStrategy: { isDummy: () => false } },
  ]) {
    assert.throws(
      () => authenticate(app, "Bearer token"),
      /SIGNALK_SECURITY_UNAVAILABLE/,
    );
  }
  const { app, principal } = fixture();
  for (const bearer of [undefined, "", "JWT token", "Bearer a b"])
    assert.throws(() => authenticate(app, bearer), /BEARER_TOKEN_REQUIRED/);
  principal.permissions = "unknown";
  assert.throws(() => authenticate(app, "Bearer token"), /PERMISSION_DENIED/);
  assert.equal(canRead(app, principal, "navigation.speed", "fixture"), false);
  principal.permissions = "readonly";
  principal.identifier = "AUTO";
  assert.throws(() => authenticate(app, "Bearer token"), /PERMISSION_DENIED/);
  app.securityStrategy.authorizeWS = (connection) => {
    connection.skPrincipal = principal;
  };
  assert.throws(() => authenticate(app, "Bearer token"), /PERMISSION_DENIED/);
});

test("changed security hooks cannot turn unknown state into authorization", () => {
  for (const hook of ["isDummy", "authorizeWS", "checkACL"]) {
    for (const value of [undefined, null, true, {}]) {
      const { app } = fixture();
      app.securityStrategy[hook] = value;
      assert.throws(
        () => authenticate(app, "Bearer token"),
        /SIGNALK_SECURITY_UNAVAILABLE/,
      );
    }
  }
  for (const value of [undefined, null, 0, "", "false", true]) {
    const { app } = fixture();
    app.securityStrategy.isDummy = () => value;
    assert.throws(
      () => authenticate(app, "Bearer token"),
      /SIGNALK_SECURITY_UNAVAILABLE/,
    );
  }
});

test("principal snapshots validate identity shape and do not copy private fields", () => {
  const { app, principal } = fixture();
  for (const identifier of [undefined, null, 1, {}, [], "", "AUTO"]) {
    principal.identifier = identifier;
    assert.throws(() => authenticate(app, "Bearer token"), /PERMISSION_DENIED/);
  }
  principal.identifier = "reader";
  principal.internal = "must not enter the gateway principal";
  const result = authenticate(app, "Bearer token");
  assert.deepEqual(result, { identifier: "reader", permissions: "readonly" });
  assert.equal(Object.isFrozen(result), true);
  principal.permissions = "admin";
  assert.equal(result.permissions, "readonly");
});

test("only a literal native ACL grant permits a measurement read", () => {
  const { app, principal } = fixture();
  for (const decision of [
    undefined,
    null,
    0,
    1,
    "true",
    {},
    Promise.resolve(true),
    false,
  ]) {
    app.securityStrategy.checkACL = () => decision;
    assert.equal(canRead(app, principal, "navigation.speed", "fixture"), false);
  }
  app.securityStrategy.checkACL = () => {
    throw new Error("ACL unavailable");
  };
  assert.throws(
    () => canRead(app, principal, "navigation.speed", "fixture"),
    /ACL unavailable/,
  );
  app.securityStrategy.checkACL = () => true;
  assert.equal(canRead(app, principal, "navigation.speed", "fixture"), true);
});

test("unknown and future timestamps are not reported as fresh; no alternate source data leaks", () => {
  const { app, principal } = fixture();
  assert.equal(
    getValues(app, principal, ["navigation.speed"], 300).measurements[0]
      .freshness,
    "unknown",
  );
  app.getSelfPath = () => ({
    value: false,
    timestamp: new Date(Date.now() + 60000).toISOString(),
    $source: "fixture",
    values: { secret: { value: "hidden" } },
  });
  const result = getValues(app, principal, ["navigation.speed"], 300)
    .measurements[0];
  assert.equal(result.value, false);
  assert.equal(result.freshness, "unknown");
  assert.equal(result.values, undefined);
  assert.deepEqual(listPaths(app, principal, "", 0, 1).paths, [
    "navigation.speed",
  ]);
});

test("tool calls reauthorize, apply output limits and sanitize internal failures", async (t) => {
  const { app, principal } = fixture();
  let running = true;
  const server = createMcpServer(
    app,
    "Bearer token",
    { staleAfterSeconds: 300 },
    () => running,
  );
  const client = new Client({ name: "security-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = () =>
    client.callTool({
      name: "get_values",
      arguments: { paths: ["navigation.speed"] },
    });
  principal.permissions = "unknown";
  assert.equal((await call()).content[0].text, "PERMISSION_DENIED");
  principal.permissions = "readonly";
  app.getSelfPath = () => ({
    value: "x".repeat(256 * 1024),
    $source: "fixture",
  });
  assert.equal((await call()).content[0].text, "OUTPUT_LIMIT");
  app.getSelfPath = () => {
    throw new Error("sensitive internal configuration");
  };
  assert.equal((await call()).content[0].text, "DATA_ACCESS_FAILED");
  running = false;
  assert.equal((await call()).content[0].text, "PLUGIN_STOPPED");
});

test("oversized and deeply nested models stop discovery and recover on a valid model", () => {
  const { app, principal } = fixture();
  const valid = app.getPath;
  app.getPath = () => ({
    navigation: Object.fromEntries(
      Array.from({ length: 20001 }, (_, i) => [
        `n${i}`,
        { value: 0, $source: "fixture" },
      ]),
    ),
  });
  assert.throws(
    () => listPaths(app, principal, "", 0, 100),
    /MODEL_SCAN_LIMIT/,
  );
  let deep = { value: 0, $source: "fixture" };
  for (let i = 0; i < 34; i++) deep = { child: deep };
  app.getPath = () => ({ navigation: deep });
  assert.throws(
    () => listPaths(app, principal, "", 0, 100),
    /MODEL_SCAN_LIMIT/,
  );
  app.getPath = valid;
  assert.deepEqual(listPaths(app, principal, "", 0, 100).paths, [
    "navigation.speed",
  ]);
});

test("bounded serialization preserves JSON spelling and exact UTF-8 byte boundaries", () => {
  const { boundedJson } = require("../dist/json.js");
  const { Buffer } = require("node:buffer");
  const shared = { value: "shared" };
  const sparse = Array(2);
  sparse[1] = 1;
  const cases = [
    null,
    true,
    false,
    0,
    -0,
    1.5,
    NaN,
    Infinity,
    "",
    'é🚤\u0000\n"\\',
    "\ud800",
    {},
    [],
    {
      "": { "": "empty keys" },
      optional: undefined,
      array: [undefined, null, ...sparse],
      sparse,
      same: [shared, shared],
    },
    {
      date: new Date("2026-10-18T00:00:00Z"),
      custom: { toJSON: () => ({ value: false }) },
    },
    { number: Object(1), string: Object("test"), boolean: Object(false) },
  ];
  for (const value of cases) {
    const expected = JSON.stringify(value);
    const size = Buffer.byteLength(expected);
    assert.equal(boundedJson(value, size), expected);
    assert.throws(() => boundedJson(value, size - 1), /OUTPUT_LIMIT/);
  }
  assert.throws(
    () => boundedJson({ body: "x".repeat(1000) }, 64, "REQUEST_TOO_LARGE", 413),
    (error) => error.code === "REQUEST_TOO_LARGE" && error.status === 413,
  );
  if (typeof JSON.rawJSON === "function")
    assert.throws(
      () =>
        boundedJson(
          { raw: JSON.rawJSON(JSON.stringify("x".repeat(1024))) },
          64,
        ),
      /OUTPUT_LIMIT/,
    );
  const circular = {};
  circular.self = circular;
  assert.throws(() => boundedJson(circular, 1024), /circular/i);
});

test("oversized results stop traversal before later values are serialized", () => {
  const { boundedJson } = require("../dist/json.js");
  let visited = false;
  const large = {
    value: "x".repeat(1024 * 1024),
    later: {
      toJSON() {
        visited = true;
        return "must not be reached";
      },
    },
  };
  assert.throws(() => boundedJson(large, 256 * 1024), /OUTPUT_LIMIT/);
  assert.equal(visited, false);
  const repeated = {
    values: Array(64).fill("x".repeat(8192)),
    later: {
      toJSON() {
        visited = true;
        return 0;
      },
    },
  };
  assert.throws(() => boundedJson(repeated, 256 * 1024), /OUTPUT_LIMIT/);
  assert.equal(visited, false);
});

test("browser origins follow the host CORS decision and malformed origins fail closed", () => {
  const { validateOrigin } = require("../dist/origin.js");
  validateOrigin(undefined, undefined);
  validateOrigin("https://client.example", "https://client.example");
  validateOrigin("https://client.example", "*");
  for (const allowed of [
    undefined,
    "https://other.example",
    ["https://client.example"],
  ])
    assert.throws(
      () => validateOrigin("https://client.example", allowed),
      /ORIGIN_DENIED/,
    );
  for (const origin of [
    "",
    "null",
    "file:///tmp/client",
    "https://client.example/",
    "https://user@client.example",
    "https://client.example/path",
    "https://client.example https://other.example",
  ])
    for (const allowed of [origin, "*"])
      assert.throws(() => validateOrigin(origin, allowed), /ORIGIN_DENIED/);
});

test("configuration retires only the old network lists without losing existing approvals", () => {
  const { configSchema, schema } = require("../dist/config.js");
  const config = {
    pluginOperations: [
      {
        pluginId: "fixture",
        operationId: "read",
        method: "GET",
        path: "/read",
        readOnly: true,
      },
    ],
    localTlsServerName: "boat.example",
    staleAfterSeconds: 600,
  };
  assert.deepEqual(
    configSchema.parse({
      allowedHosts: ["old:3000"],
      allowedOrigins: ["https://old.example"],
      ...config,
    }),
    configSchema.parse(config),
  );
  assert.equal(configSchema.safeParse({}).success, true);
  assert.equal(configSchema.safeParse({ unrecognized: true }).success, false);
  assert.equal(
    configSchema.safeParse({ ...config, staleAfterSeconds: 0 }).success,
    false,
  );
  assert.equal("allowedHosts" in schema.properties, false);
  assert.equal("allowedOrigins" in schema.properties, false);
});

test("mutation tools declare side effects, preserve uncertain outcomes and reject input extras", async (t) => {
  const { app, principal } = fixture();
  let calls = 0;
  const puts = {
    async execute() {
      calls++;
      principal.permissions = "unknown";
      return { submitted: true, outcome: "unknown", retrySafe: false };
    },
  };
  const server = createMcpServer(
    app,
    "Bearer token",
    { staleAfterSeconds: 300, pluginOperations: [], readRequests: {} },
    () => true,
    undefined,
    {},
    puts,
    {},
  );
  const client = new Client({ name: "mutation-boundary-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 14);
  for (const name of ["put_value", "execute_mutation"]) {
    const tool = tools.find((item) => item.name === name);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.equal(
    tools.find((tool) => tool.name === "execute_capability").annotations
      .readOnlyHint,
    true,
  );
  const args = {
    path: "electrical.switches.fixture.state",
    source: "fixture",
    value: false,
  };
  for (const extra of [{ context: "vessels.other" }, { requestId: "extra" }]) {
    const rejected = await client.callTool({
      name: "put_value",
      arguments: { ...args, ...extra },
    });
    assert.equal(rejected.isError, true);
    assert.equal(calls, 0);
  }
  const pluginPost = await client.callTool({
    name: "execute_mutation",
    arguments: { id: "plugin.fixture", operation: "post", arguments: {} },
  });
  assert.equal(pluginPost.content[0].text, "PERMISSION_DENIED");
  assert.equal(calls, 0);
  const result = await client.callTool({ name: "put_value", arguments: args });
  assert.equal(calls, 1);
  assert.deepEqual(result.structuredContent, {
    submitted: true,
    outcome: "unknown",
    retrySafe: false,
  });
  assert.equal(result.isError, undefined);
  const read = await client.callTool({
    name: "get_values",
    arguments: { paths: ["navigation.speed"] },
  });
  assert.equal(read.content[0].text, "PERMISSION_DENIED");
});
