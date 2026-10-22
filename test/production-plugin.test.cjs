const { loadedPlugin } = require("./native-server.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { createRequire } = require("node:module");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

const pluginId = "signalk-alert-center";
const capability = `plugin.${pluginId}`;
const approval = {
  pluginId,
  operationId: "get.definitions",
  method: "GET",
  path: "/definitions",
  readOnly: true,
  permission: "admin",
};
const serverRequire = createRequire(
  process.env.MCP_TEST_SERVER_DIR
    ? path.join(path.resolve(process.env.MCP_TEST_SERVER_DIR), "package.json")
    : require.resolve("signalk-server/package.json"),
);

async function start(t, installed = true) {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const host = `127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "signalk-mcp-production-plugin-"),
  );
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.mkdirSync(path.join(dir, "plugin-config-data"));
  const packageRoot = path.dirname(require.resolve(`${pluginId}/package.json`));
  assert.equal(require(`${pluginId}/package.json`).version, "0.4.1");
  fs.symlinkSync(
    process.env.MCP_TEST_PLUGIN_DIR || path.resolve(__dirname, ".."),
    path.join(dir, "node_modules/signalk-mcp"),
    "dir",
  );
  if (installed)
    fs.symlinkSync(
      packageRoot,
      path.join(dir, "node_modules", pluginId),
      "dir",
    );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "mcp-production-plugin-test",
      version: "1.0.0",
      dependencies: {
        "signalk-mcp": "0.1.0",
        ...(installed ? { [pluginId]: "0.4.1" } : {}),
      },
    }),
  );
  const configuration = { pluginOperations: [approval] };
  const providerConfig = {
    notifiers: [],
    defaults: { soundEnabled: false, speechEnabled: false, notifiers: [] },
    connectivity: { enabled: false },
    retention: { enabled: false },
  };
  for (const [id, config] of [
    ["signalk-mcp", configuration],
    ...(installed ? [[pluginId, providerConfig]] : []),
  ]) {
    fs.writeFileSync(
      path.join(dir, "plugin-config-data", `${id}.json`),
      JSON.stringify({ enabled: true, configuration: config }),
    );
  }
  process.env.SIGNALK_NODE_CONFIG_DIR = dir;
  process.env.SIGNALK_DISABLE_SERVER_UPDATES = "true";
  process.env.HTTP_RATE_LIMITS = "api=1000,loginStatus=1000,login=1000";
  process.env.NODE_ENV = "test";
  const secret = crypto.randomBytes(32).toString("hex");
  const token = (id) =>
    serverRequire("jsonwebtoken").sign({ device: id }, secret, {
      expiresIn: "5m",
    });
  const Server = serverRequire("./");
  const server = new Server({
    config: {
      settings: {
        port,
        mdns: false,
        enforceDataTimeouts: false,
        pipedProviders: [],
        interfaces: { plugins: true, "nmea-tcp": false, tcp: false },
        security: { strategy: "./tokensecurity" },
      },
      defaults: {
        vessels: {
          self: { uuid: "urn:mrn:signalk:uuid:production-plugin-test" },
        },
      },
    },
    securityConfig: {
      secretKey: secret,
      allow_readonly: false,
      expiration: "1d",
      users: [],
      devices: [
        { clientId: "reader", permissions: "readonly", enabled: true },
        { clientId: "writer", permissions: "readwrite", enabled: true },
        { clientId: "admin", permissions: "admin", enabled: true },
      ],
    },
  });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await server.start();
  t.diagnostic(
    `Node ${process.version}; Signal K ${serverRequire("./package.json").version}; ${pluginId} 0.4.1; installed=${installed}`,
  );
  if (process.env.MCP_TEST_SERVER_VERSION)
    assert.equal(
      serverRequire("./package.json").version,
      process.env.MCP_TEST_SERVER_VERSION,
    );
  const endpoint = new URL(`http://${host}/plugins/signalk-mcp/mcp`);
  const clientFor = async (id) => {
    const client = new Client({
      name: `production-plugin-${id}`,
      version: "1",
    });
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${token(id)}` } },
      }),
    );
    t.after(() => client.close());
    return client;
  };
  const direct = (route, id = "admin", options = {}) =>
    fetch(`http://${host}/plugins/${pluginId}${route}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token(id)}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });
  return { server, configuration, providerConfig, clientFor, direct };
}
const describe = (client) =>
  client.callTool({
    name: "describe_capability",
    arguments: { id: capability },
  });
const execute = (client, operation = "get.definitions", args = {}) =>
  client.callTool({
    name: "execute_capability",
    arguments: { id: capability, operation, arguments: args },
  });
function error(result, code) {
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, code);
}

test(
  "published Alert Center: native permissions, discovery and unchanged forwarding",
  { timeout: 60000 },
  async (t) => {
    const { server, configuration, providerConfig, clientFor, direct } =
      await start(t);
    const provider = loadedPlugin(server, pluginId);
    assert.ok(provider, "published package must load through native discovery");
    const admin = await clientFor("admin");
    const reader = await clientFor("reader");
    assert.equal(
      provider.openApi.paths["/definitions"].get.operationId,
      undefined,
    );
    // Isolated synthetic deltas only. No notifier, audio or connectivity service.
    server.app.handleMessage("mcp-fixture", {
      context: "vessels.self",
      updates: [
        {
          source: { label: "mcp-fixture" },
          timestamp: new Date().toISOString(),
          values: ["bilge", "battery"].map((name) => ({
            path: `notifications.mcp.synthetic.${name}`,
            value: {
              state: "warn",
              method: [],
              message: `Synthetic ${name} alert`,
            },
          })),
        },
      ],
    });
    let expected;
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await direct("/definitions");
      assert.equal(response.status, 200);
      const page = await response.json();
      if (
        page.items.filter((item) =>
          item.pathPattern.startsWith("notifications.mcp.synthetic."),
        ).length === 2
      ) {
        expected = page;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      expected,
      "published provider must ingest both synthetic notifications",
    );

    await t.test(
      "discovers route-derived operation IDs and forwards paginated provider JSON",
      async () => {
        const listing = await admin.callTool({
          name: "list_capabilities",
          arguments: {},
        });
        assert.ok(
          listing.structuredContent.capabilities.some(
            (entry) => entry.id === capability,
          ),
        );
        const info = (await describe(admin)).structuredContent;
        const read = info.operations.find((op) => op.id === "get.definitions");
        assert.equal(read.enabled, true);
        assert.equal(read.permission, "admin");
        assert.equal(read.inputSchema.properties.cursor.maxLength, 512);
        assert.equal(read.inputSchema.properties.limit.maximum, 100);
        const args = { limit: 1, sourceType: "recognized", enabled: true };
        const native = await direct(
          "/definitions?limit=1&sourceType=recognized&enabled=true",
        );
        const first = (await execute(admin, "get.definitions", args))
          .structuredContent.data;
        assert.deepEqual(first, await native.json());
        assert.equal(first.items.length, 1);
        assert.ok(first.nextCursor);
        const second = await execute(admin, "get.definitions", {
          ...args,
          cursor: first.nextCursor,
        });
        const nativeSecond = await direct(
          `/definitions?limit=1&sourceType=recognized&enabled=true&cursor=${encodeURIComponent(first.nextCursor)}`,
        );
        assert.deepEqual(
          second.structuredContent.data,
          await nativeSecond.json(),
        );
        assert.notEqual(
          first.items[0].id,
          second.structuredContent.data.items[0].id,
        );
        assert.deepEqual(
          (await execute(admin)).structuredContent.data,
          expected,
        );
      },
    );

    await t.test(
      "honors conservative admin approval and the provider's native readonly route",
      async () => {
        const read = (await describe(reader)).structuredContent.operations.find(
          (op) => op.id === "get.definitions",
        );
        assert.equal(read.reason, "PERMISSION_DENIED");
        error(await execute(reader), "OPERATION_DISABLED");
        // Alert Center itself permits native readonly callers. It does not filter
        // this JSON by telemetry ACLs, so the reviewed gateway example is admin-only.
        assert.equal((await direct("/definitions", "reader")).status, 200);
        assert.equal(
          (
            await direct("/snooze", "reader", {
              method: "POST",
              body: JSON.stringify({ durationSeconds: 60 }),
            })
          ).status,
          401,
        );
        loadedPlugin(server, "signalk-mcp").start({
          ...configuration,
          pluginOperations: [{ ...approval, permission: "readonly" }],
        });
        try {
          assert.deepEqual(
            (await execute(reader)).structuredContent.data,
            expected,
          );
        } finally {
          loadedPlugin(server, "signalk-mcp").start(configuration);
        }
      },
    );

    await t.test(
      "validates provider inputs and sanitizes native errors",
      async () => {
        for (const args of [
          { limit: 0 },
          { limit: 101 },
          { limit: "1" },
          { enabled: "true" },
          { sourceType: "invalid" },
          { cursor: "x".repeat(513) },
          { token: "synthetic-secret" },
          { method: "POST" },
        ]) {
          error(
            await execute(admin, "get.definitions", args),
            "INVALID_ARGUMENTS",
          );
        }
        assert.deepEqual(
          (await execute(admin, "get.definitions", { cursor: "x".repeat(512) }))
            .structuredContent.data,
          { items: [] },
        );
        // A valid, nonexistent detail ID exercises native error sanitization.
        loadedPlugin(server, "signalk-mcp").start({
          ...configuration,
          pluginOperations: [
            approval,
            {
              ...approval,
              operationId: "get.definitions.by-id",
              path: "/definitions/{id}",
            },
          ],
        });
        try {
          error(
            await execute(admin, "get.definitions.by-id", {
              id: "synthetic-secret-missing",
            }),
            "CAPABILITY_UNAVAILABLE",
          );
        } finally {
          loadedPlugin(server, "signalk-mcp").start(configuration);
        }
      },
    );

    await t.test(
      "unapproved reads and every documented mutation remain unreachable",
      async () => {
        loadedPlugin(server, "signalk-mcp").start({
          ...configuration,
          pluginOperations: [],
        });
        try {
          assert.equal(
            (await describe(admin)).structuredContent.operations.find(
              (op) => op.id === "get.definitions",
            ).reason,
            "NOT_ALLOWLISTED",
          );
          error(await execute(admin), "APPROVAL_PENDING");
          const requests = loadedPlugin(server, "signalk-mcp").schema()
            .properties.readRequests.properties;
          assert.equal(
            Object.values(requests)[0].default.operationId,
            "get.definitions",
          );
          assert.equal(Object.values(requests)[0].default.decision, "pending");
        } finally {
          loadedPlugin(server, "signalk-mcp").start(configuration);
        }
        error(await execute(admin, "get.snooze"), "APPROVAL_PENDING");
        const routes = [
          "/definitions",
          "/occurrences",
          "/snooze",
          "/deliveries",
        ];
        const before = await Promise.all(
          routes.map(async (route) => (await direct(route)).json()),
        );
        const mutations = (
          await describe(admin)
        ).structuredContent.operations.filter((op) => op.method !== "GET");
        assert.ok(mutations.length >= 5);
        for (const operation of mutations) {
          assert.equal(operation.enabled, false);
          error(
            await execute(admin, operation.id, { id: expected.items[0].id }),
            ["POST", "PUT", "PATCH", "DELETE"].includes(operation.method)
              ? "MUTATION_TOOL_REQUIRED"
              : "OPERATION_DISABLED",
          );
        }
        assert.deepEqual(
          await Promise.all(
            routes.map(async (route) => (await direct(route)).json()),
          ),
          before,
        );
      },
    );

    await t.test(
      "changed schemas, routes and operation ID collisions fail closed",
      async () => {
        const original = provider.openApi;
        const cases = [
          [
            "UNSUPPORTED_SCHEMA",
            (doc) => {
              doc.paths["/definitions"].get.parameters[0].schema = {
                type: "object",
              };
            },
          ],
          [
            undefined,
            (doc) => {
              doc.paths["/moved-definitions"] = doc.paths["/definitions"];
              delete doc.paths["/definitions"];
            },
          ],
          [
            "AMBIGUOUS_OPERATION_ID",
            (doc) => {
              doc.paths["/duplicate"] = {
                get: {
                  ...doc.paths["/definitions"].get,
                  operationId: "get.definitions",
                },
              };
            },
          ],
          [
            undefined,
            (doc) => {
              doc.paths["/definitions"].get.operationId = "renamed";
            },
          ],
        ];
        try {
          for (const [reason, change] of cases) {
            const changed = JSON.parse(JSON.stringify(original));
            change(changed);
            provider.openApi = changed;
            const read = (
              await describe(admin)
            ).structuredContent.operations.find(
              (op) => op.id === "get.definitions",
            );
            assert.equal(read?.reason, reason);
            assert.notEqual(read?.enabled, true);
            error(await execute(admin), "OPERATION_DISABLED");
          }
          provider.openApi = { ...original, openapi: "2.0" };
          assert.equal(
            (await describe(admin)).structuredContent.reason,
            "UNSUPPORTED_OPENAPI",
          );
          error(await execute(admin), "UNSUPPORTED_OPENAPI");
        } finally {
          provider.openApi = original;
        }
        assert.deepEqual(
          (await execute(admin)).structuredContent.data,
          expected,
        );
      },
    );

    await t.test(
      "published snooze POST requires saved approval and native writer identity",
      async () => {
        const gateway = loadedPlugin(server, "signalk-mcp");
        const writer = await clientFor("writer");
        const mutate = (client, body = { durationSeconds: 60 }) =>
          client.callTool({
            name: "execute_mutation",
            arguments: {
              id: capability,
              operation: "post.snooze",
              arguments: { body },
            },
          });
        const before = await (await direct("/snooze")).json();
        error(await mutate(reader), "PERMISSION_DENIED");
        error(await mutate(writer), "APPROVAL_PENDING");
        assert.deepEqual(await (await direct("/snooze")).json(), before);
        const reviews = Object.fromEntries(
          Object.entries(gateway.schema().properties.readRequests.properties)
            .filter(([, v]) => v.default.kind === "post")
            .map(([key, value]) => [
              key,
              { ...value.default, decision: "approved" },
            ]),
        );
        assert.equal(Object.keys(reviews).length, 1);
        gateway.start({ ...configuration, readRequests: reviews });
        try {
          error(
            await mutate(writer, { durationSeconds: 0 }),
            "INVALID_ARGUMENTS",
          );
          error(
            await mutate(writer, { durationSeconds: 28801 }),
            "INVALID_ARGUMENTS",
          );
          const result = await mutate(writer);
          assert.equal(result.isError, undefined, JSON.stringify(result));
          assert.equal(result.structuredContent.outcome, "responded");
          assert.equal(result.structuredContent.statusCode, 200);
          assert.deepEqual(
            result.structuredContent.data,
            await (await direct("/snooze")).json(),
          );
          assert.notDeepEqual(result.structuredContent.data, before);
          error(await mutate(reader), "PERMISSION_DENIED");
        } finally {
          gateway.start(configuration);
        }
      },
    );

    await t.test(
      "published policy PATCH and DELETE preserve nested JSON and reset provider state",
      async () => {
        const gateway = loadedPlugin(server, "signalk-mcp");
        const writer = await clientFor("writer");
        const id = expected.items.find((item) =>
          item.pathPattern.startsWith("notifications.mcp.synthetic."),
        ).id;
        const route = `/definitions/${encodeURIComponent(id)}`;
        const before = await (await direct(route)).json();
        const body = {
          enabled: false,
          activationDelaySeconds: 0,
          notifierIds: [],
          notifierRepeatOverrides: {},
          soundEnabled: false,
          speechEnabled: false,
          connectivity: { mode: "queue" },
        };
        const mutate = (client, method, value = body) =>
          client.callTool({
            name: "execute_mutation",
            arguments: {
              id: capability,
              operation: `${method}.definitions.by-id.policy`,
              arguments: {
                id,
                ...(method === "delete" ? {} : { body: value }),
              },
            },
          });
        error(await mutate(reader, "patch"), "PERMISSION_DENIED");
        for (const method of ["patch", "delete"])
          error(await mutate(writer, method), "APPROVAL_PENDING");
        assert.deepEqual(await (await direct(route)).json(), before);
        const reviews = Object.fromEntries(
          Object.entries(gateway.schema().properties.readRequests.properties)
            .filter(([, value]) => value.default.kind === "plugin")
            .map(([key, value]) => [
              key,
              { ...value.default, decision: "approved" },
            ]),
        );
        assert.equal(Object.keys(reviews).length, 2);
        gateway.start({ ...configuration, readRequests: reviews });
        try {
          error(await mutate(writer, "patch", {}), "INVALID_ARGUMENTS");
          error(
            await mutate(writer, "patch", {
              connectivity: { mode: "queue", delaySeconds: 1 },
            }),
            "INVALID_ARGUMENTS",
          );
          const patched = (await mutate(writer, "patch")).structuredContent;
          assert.equal(patched.outcome, "responded");
          assert.equal(patched.statusCode, 200);
          assert.equal(patched.retrySafe, false);
          assert.deepEqual(patched.data, await (await direct(route)).json());
          assert.equal(patched.data.policy.enabled, false);
          assert.equal(patched.data.policy.activationDelaySeconds, 0);
          assert.deepEqual(patched.data.policy.notifierIds, []);
          assert.deepEqual(patched.data.policy.connectivity, { mode: "queue" });
          const reset = (await mutate(writer, "delete")).structuredContent;
          assert.equal(reset.outcome, "responded");
          assert.equal(reset.statusCode, 200);
          assert.deepEqual(reset.data, await (await direct(route)).json());
          assert.deepEqual(reset.data.policy, before.policy);
          error(await mutate(reader, "delete"), "PERMISSION_DENIED");
        } finally {
          gateway.start(configuration);
        }
      },
    );

    await t.test(
      "native configuration disabling the provider makes it unavailable",
      async () => {
        const response = await direct("/config", "admin", {
          method: "POST",
          body: JSON.stringify({
            enabled: false,
            configuration: providerConfig,
          }),
        });
        assert.equal(response.status, 200);
        assert.equal(
          (await describe(admin)).structuredContent.reason,
          "PLUGIN_DISABLED",
        );
        error(await execute(admin), "CAPABILITY_UNAVAILABLE");
      },
    );
  },
);

test(
  "an absent third-party package cannot be enabled by stale approval",
  { timeout: 60000 },
  async (t) => {
    const { clientFor } = await start(t, false);
    const admin = await clientFor("admin");
    const listing = await admin.callTool({
      name: "list_capabilities",
      arguments: {},
    });
    assert.equal(
      listing.structuredContent.capabilities.some(
        (entry) => entry.id === capability,
      ),
      false,
    );
    error(await describe(admin), "CAPABILITY_NOT_FOUND");
    error(await execute(admin), "CAPABILITY_NOT_FOUND");
  },
);
