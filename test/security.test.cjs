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
