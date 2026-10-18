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

const pluginId = "signalk-alert-manager";
const capability = `plugin.${pluginId}`;
const approval = {
  pluginId,
  operationId: "listAlerts",
  method: "GET",
  path: "/alerts",
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
  assert.equal(require(`${pluginId}/package.json`).version, "0.1.0");
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
        ...(installed ? { [pluginId]: "0.1.0" } : {}),
      },
    }),
  );
  const configuration = { allowedHosts: [host], pluginOperations: [approval] };
  const providerConfig = {
    audio: { minAudiblePriority: "off" },
    escalation: { warningToAlarm: { enabled: false } },
    sourceTimeout: { markStaleAfterSeconds: 3600 },
    dev: { enableSimulation: false },
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
    `Node ${process.version}; Signal K ${serverRequire("./package.json").version}; ${pluginId} 0.1.0; installed=${installed}`,
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
const execute = (client, operation = "listAlerts", args = {}) =>
  client.callTool({
    name: "execute_capability",
    arguments: { id: capability, operation, arguments: args },
  });
function error(result, code) {
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, code);
}

test(
  "published alert-manager: native read authorization, discovery and forwarding",
  { timeout: 60000 },
  async (t) => {
    const { server, configuration, providerConfig, clientFor, direct } =
      await start(t);
    const provider = server.app.pluginsMap[pluginId];
    assert.ok(
      provider,
      "published package must load through native plugin discovery",
    );
    await provider.whenReady();
    const admin = await clientFor("admin");
    const reader = await clientFor("reader");
    // Seed synthetic notification deltas through the native server, outside MCP.
    // No browser audio client, live notifier, or vessel hardware is connected.
    server.app.handleMessage("mcp-fixture", {
      context: "vessels.self",
      updates: [
        {
          source: { label: "mcp-fixture" },
          timestamp: new Date().toISOString(),
          values: [
            {
              path: "notifications.mcp.synthetic.bilge",
              value: {
                state: "warn",
                method: [],
                message: "Synthetic bilge alert",
              },
            },
          ],
        },
      ],
    });
    let expected;
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await direct("/alerts");
      assert.equal(response.status, 200);
      const alerts = await response.json();
      if (alerts.length) {
        expected = alerts[0];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(expected, "published provider must consume the synthetic delta");
    assert.equal(expected.message, "Synthetic bilge alert");
    assert.equal(expected.priority, "warning");

    await t.test(
      "discovers real operations and forwards exact provider JSON under admin",
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
        const read = info.operations.find((op) => op.id === "listAlerts");
        assert.equal(read.enabled, true);
        assert.equal(read.permission, "admin");
        assert.deepEqual(read.inputSchema.properties.stale.enum, [
          "true",
          "false",
        ]);
        assert.equal(
          info.operations.find((op) => op.id === "getAlert").reason,
          "UNSUPPORTED_SCHEMA",
        );
        const native = await direct("/alerts?priority=warning&stale=false");
        assert.equal(native.status, 200);
        const result = await execute(admin, "listAlerts", {
          priority: "warning",
          stale: "false",
        });
        assert.deepEqual(result.structuredContent.data, await native.json());
        assert.deepEqual(result.structuredContent.data, [expected]);
        assert.deepEqual(
          (await execute(admin, "listAlerts", { priority: "alarm" }))
            .structuredContent.data,
          [],
        );
      },
    );

    await t.test(
      "enforces admin approval and the target route's independent native permissions",
      async () => {
        const read = (await describe(reader)).structuredContent.operations.find(
          (op) => op.id === "listAlerts",
        );
        assert.equal(read.reason, "PERMISSION_DENIED");
        error(await execute(reader), "OPERATION_DISABLED");
        assert.equal((await direct("/alerts", "reader")).status, 401);
        // A mistakenly relaxed gateway approval must not override native admin routing.
        server.app.pluginsMap["signalk-mcp"].start({
          ...configuration,
          pluginOperations: [{ ...approval, permission: "readonly" }],
        });
        try {
          assert.equal(
            (await describe(reader)).structuredContent.operations.find(
              (op) => op.id === "listAlerts",
            ).enabled,
            true,
          );
          error(await execute(reader), "UPSTREAM_PERMISSION_DENIED");
          assert.deepEqual((await execute(admin)).structuredContent.data, [
            expected,
          ]);
        } finally {
          server.app.pluginsMap["signalk-mcp"].start(configuration);
        }
      },
    );

    await t.test(
      "rejects invalid inputs and sanitizes native provider errors",
      async () => {
        for (const args of [
          { stale: true },
          { stale: "yes" },
          { category: "x".repeat(257) },
          { token: "synthetic-secret" },
          { method: "POST" },
          { path: "/alerts/silence-all" },
        ]) {
          error(await execute(admin, "listAlerts", args), "INVALID_ARGUMENTS");
        }
        // The provider owns semantics not expressed in its string schema.
        error(
          await execute(admin, "listAlerts", {
            state: "synthetic-secret-invalid-state",
          }),
          "UPSTREAM_HTTP_ERROR",
        );
      },
    );

    await t.test(
      "unapproved reads and every documented mutation remain unreachable",
      async () => {
        server.app.pluginsMap["signalk-mcp"].start({
          ...configuration,
          pluginOperations: [],
        });
        try {
          assert.equal(
            (await describe(admin)).structuredContent.operations.find(
              (op) => op.id === "listAlerts",
            ).reason,
            "NOT_ALLOWLISTED",
          );
          error(await execute(admin), "OPERATION_DISABLED");
        } finally {
          server.app.pluginsMap["signalk-mcp"].start(configuration);
        }
        const info = (await describe(admin)).structuredContent;
        const mutations = info.operations.filter((op) => op.method !== "GET");
        assert.ok(mutations.length >= 5);
        for (const operation of mutations) {
          assert.equal(operation.reason, "METHOD_NOT_READONLY");
          error(
            await execute(admin, operation.id, { id: expected.id }),
            "OPERATION_DISABLED",
          );
        }
        assert.deepEqual(await (await direct("/alerts")).json(), [expected]);
      },
    );

    await t.test(
      "rechecks changed documents on each invocation and reports safe diagnostics",
      async () => {
        const original = provider.openApi;
        const cases = [
          [
            "UNSUPPORTED_SCHEMA",
            (doc) => {
              doc.paths["/alerts"].get.parameters[0].schema = {
                type: "object",
              };
            },
          ],
          [
            "NOT_ALLOWLISTED",
            (doc) => {
              doc.paths["/moved-alerts"] = doc.paths["/alerts"];
              delete doc.paths["/alerts"];
            },
          ],
          [
            "AMBIGUOUS_OPERATION_ID",
            (doc) => {
              doc.paths["/duplicate"] = { get: doc.paths["/alerts"].get };
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
            ).structuredContent.operations.find((op) => op.id === "listAlerts");
            assert.equal(read.reason, reason);
            assert.equal(read.enabled, false);
            error(await execute(admin), "OPERATION_DISABLED");
          }
          provider.openApi = { ...original, openapi: "2.0" };
          const unsupported = (await describe(admin)).structuredContent;
          assert.equal(unsupported.available, false);
          assert.equal(unsupported.reason, "UNSUPPORTED_OPENAPI");
          error(await execute(admin), "UNSUPPORTED_OPENAPI");
        } finally {
          provider.openApi = original;
        }
        assert.deepEqual((await execute(admin)).structuredContent.data, [
          expected,
        ]);
      },
    );

    await t.test(
      "a provider disabled through native configuration is unavailable",
      async () => {
        const response = await direct("/config", "admin", {
          method: "POST",
          body: JSON.stringify({
            enabled: false,
            configuration: providerConfig,
          }),
        });
        assert.equal(response.status, 200);
        const info = (await describe(admin)).structuredContent;
        assert.equal(info.reason, "PLUGIN_DISABLED");
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
