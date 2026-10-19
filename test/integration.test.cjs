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

const {
  installHistoryProvider,
  checkHistoryProvider,
} = require("./history-provider.cjs");

const serverPackage = process.env.MCP_TEST_SERVER_DIR
  ? path.join(path.resolve(process.env.MCP_TEST_SERVER_DIR), "package.json")
  : require.resolve("signalk-server/package.json");
const serverRequire = createRequire(serverPackage);
const serverVersion = serverRequire("./package.json").version;
const serverApiVersion = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(serverRequire.resolve("@signalk/server-api")),
      "../package.json",
    ),
    "utf8",
  ),
).version;

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test(
  `native plugin on Signal K ${serverVersion}: authentication, ACLs, transport and lifecycle`,
  { timeout: 90000 },
  async (t) => {
    if (process.env.MCP_TEST_SERVER_VERSION) {
      assert.equal(serverVersion, process.env.MCP_TEST_SERVER_VERSION);
      assert.equal(serverApiVersion, process.env.MCP_TEST_SERVER_VERSION);
    }
    t.diagnostic(
      `Node ${process.version}; Signal K ${serverVersion}; ServerAPI ${serverApiVersion}`,
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signalk-mcp-test-"));
    const root =
      process.env.MCP_TEST_PLUGIN_DIR || path.resolve(__dirname, "..");
    const port = await freePort();
    const host = `127.0.0.1:${port}`;
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.symlinkSync(root, path.join(dir, "node_modules/signalk-mcp"), "dir");
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "mcp-test",
        version: "1.0.0",
        dependencies: { "signalk-mcp": "0.1.0" },
      }),
    );
    fs.mkdirSync(path.join(dir, "plugin-config-data"));
    fs.symlinkSync(
      path.join(__dirname, "fixtures/mcp-fixture"),
      path.join(dir, "node_modules/mcp-fixture"),
      "dir",
    );
    fs.writeFileSync(
      path.join(dir, "plugin-config-data/mcp-fixture.json"),
      JSON.stringify({ enabled: true, configuration: {} }),
    );
    fs.symlinkSync(
      path.join(__dirname, "fixtures/mixed-case-fixture"),
      path.join(dir, "node_modules/mixed-case-fixture"),
      "dir",
    );
    fs.writeFileSync(
      path.join(dir, "plugin-config-data/AdvancedWind.json"),
      JSON.stringify({ enabled: true, configuration: {} }),
    );
    fs.writeFileSync(
      path.join(dir, "plugin-config-data/signalk-mcp.json"),
      JSON.stringify({
        enabled: true,
        configuration: {
          staleAfterSeconds: 300,
          pluginOperations: [
            {
              pluginId: "AdvancedWind",
              operationId: "readApproved",
              method: "GET",
              path: "/approved",
              readOnly: true,
            },
            {
              pluginId: "mcp-fixture",
              operationId: "readReading",
              method: "GET",
              path: "/reading/{name}",
              readOnly: true,
            },
            {
              pluginId: "mcp-fixture",
              operationId: "adminReading",
              method: "GET",
              path: "/admin-reading",
              readOnly: true,
            },
            {
              pluginId: "mcp-fixture",
              operationId: "redirect",
              method: "GET",
              path: "/redirect",
              readOnly: true,
            },
            {
              pluginId: "mcp-fixture",
              operationId: "badSchema",
              method: "GET",
              path: "/bad-schema",
              readOnly: true,
            },
          ],
        },
      }),
    );
    const historyStore = process.env.MCP_TEST_INFLUX_URL
      ? await installHistoryProvider(dir)
      : undefined;
    process.env.SIGNALK_NODE_CONFIG_DIR = dir;
    process.env.SIGNALK_DISABLE_SERVER_UPDATES = "true";
    process.env.HTTP_RATE_LIMITS = "api=1000,loginStatus=1000,login=1000";
    process.env.NODE_ENV = "test";
    const Server = serverRequire("./");
    const jwt = serverRequire("jsonwebtoken");
    const secret = crypto.randomBytes(32).toString("hex");
    const securityConfig = {
      allow_readonly: true,
      expiration: "1d",
      secretKey: secret,
      users: [{ username: "crew", type: "readonly" }],
      devices: ["reader", "other", "writer", "admin"].map((clientId) => ({
        clientId,
        permissions:
          clientId === "writer"
            ? "readwrite"
            : clientId === "admin"
              ? "admin"
              : "readonly",
        enabled: true,
      })),
      acls: [
        {
          context: "vessels.self",
          resources: [
            {
              paths: ["navigation.*"],
              permissions: [
                { subject: "reader", permission: "read" },
                { subject: "writer", permission: "read" },
                { subject: "crew", permission: "read" },
                { subject: "admin", permission: "read" },
              ],
            },
            {
              sources: ["private-source.XX"],
              permissions: [{ subject: "other", permission: "read" }],
            },
          ],
        },
      ],
    };
    fs.writeFileSync(
      path.join(dir, "security.json"),
      JSON.stringify({
        allowedCorsOrigins: "https://allowed.example",
      }),
      { mode: 0o600 },
    );
    const server = new Server({
      config: {
        settings: {
          port,
          historyApi: { defaultProvider: "mcp-fixture" },
          mdns: false,
          enforceDataTimeouts: false,
          pipedProviders: [],
          interfaces: { plugins: true, "nmea-tcp": false, tcp: false },
          security: { strategy: "./tokensecurity" },
        },
        defaults: {
          vessels: { self: { uuid: "urn:mrn:signalk:uuid:mcp-test" } },
        },
      },
      securityConfig,
    });
    t.after(async () => {
      try {
        await server.stop();
      } finally {
        await historyStore?.cleanup();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    await server.start();
    const endpoint = new URL(`http://${host}/plugins/signalk-mcp/mcp`);
    const token = (id, opts = { expiresIn: "5m" }) =>
      jwt.sign({ device: id }, secret, opts);
    const bearer = token("reader");
    const request = (
      body,
      authorization = `Bearer ${bearer}`,
      extra = {},
      method = "POST",
    ) =>
      fetch(endpoint, {
        method,
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...(authorization ? { Authorization: authorization } : {}),
          ...extra,
        },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(5000),
      });
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "raw-integration", version: "1" },
      },
    };
    await t.test(
      "requires a valid bearer even with guest reads enabled",
      async () => {
        for (const authorization of [
          undefined,
          "Bearer bad",
          `Bearer ${token("reader", { expiresIn: -1 })}`,
          `Bearer ${token("absent")}`,
        ]) {
          const response = await request(
            initialize,
            authorization === undefined ? "" : authorization,
          );
          assert.equal(response.status, 401);
        }
        assert.equal((await request(initialize)).status, 200);
      },
    );
    await t.test(
      "uses native CORS policy without a plugin Host list and rejects unsupported methods",
      async () => {
        assert.equal(
          (
            await request(initialize, undefined, {
              Origin: "https://evil.example",
            })
          ).status,
          403,
        );
        for (const origin of [
          "null",
          "https://allowed.example/",
          "https://allowed.example https://evil.example",
        ]) {
          assert.equal(
            (await request(initialize, undefined, { Origin: origin })).status,
            403,
          );
        }
        assert.equal(
          (
            await request(initialize, undefined, {
              Origin: "https://evil.example",
              "Access-Control-Allow-Origin": "https://evil.example",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request(initialize, "", {
              Origin: "https://allowed.example",
              Host: "alternate.example",
            })
          ).status,
          401,
        );
        const alternateHost = await new Promise((resolve, reject) => {
          const req = require("node:http").request(
            endpoint,
            {
              method: "POST",
              headers: {
                Host: "evil.example",
                Authorization: `Bearer ${bearer}`,
                Accept: "application/json, text/event-stream",
                "Content-Type": "application/json",
              },
            },
            (res) => {
              res.resume();
              resolve(res.statusCode);
            },
          );
          req.on("error", reject);
          req.end(JSON.stringify(initialize));
        });
        assert.equal(alternateHost, 200);
        assert.equal(
          (
            await request(initialize, undefined, {
              Origin: "https://allowed.example",
            })
          ).status,
          200,
        );
        assert.equal(
          (await request(undefined, undefined, {}, "GET")).status,
          405,
        );
        assert.equal(
          (await request(undefined, undefined, {}, "DELETE")).status,
          405,
        );
        assert.equal(
          (await request(initialize, undefined, { Accept: "text/plain" }))
            .status,
          406,
        );
      },
    );
    server.app.handleMessage("fixture", {
      context: "vessels.self",
      updates: [
        {
          source: { label: "fixture" },
          timestamp: new Date().toISOString(),
          meta: [
            { path: "navigation.speedOverGround", value: { units: "m/s" } },
          ],
          values: [
            { path: "navigation.speedOverGround", value: 0 },
            {
              path: "navigation.position",
              value: { latitude: 50, longitude: 10 },
            },
            { path: "navigation.headingTrue", value: null },
          ],
        },
      ],
    });
    server.app.handleMessage("private-source", {
      context: "vessels.self",
      updates: [
        {
          source: { label: "private-source" },
          timestamp: new Date(Date.now() - 600000).toISOString(),
          values: [{ path: "electrical.batteries.house.voltage", value: 12.7 }],
        },
      ],
    });
    async function clientFor(id) {
      const client = new Client({ name: `test-${id}`, version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(endpoint, {
          requestInit: { headers: { Authorization: `Bearer ${token(id)}` } },
        }),
      );
      t.after(() => client.close());
      return client;
    }
    const { codexClient, hermesClient } = require("./product-clients.cjs");
    await t.test(
      "installed Codex product client",
      { skip: !process.env.MCP_TEST_CODEX_BIN },
      async (subtest) => {
        await codexClient(
          process.env.MCP_TEST_CODEX_BIN,
          endpoint,
          bearer,
          subtest,
        );
      },
    );
    await t.test(
      "installed Hermes product client",
      { skip: !process.env.MCP_TEST_HERMES_DIR },
      async (subtest) => {
        await hermesClient(
          process.env.MCP_TEST_HERMES_DIR,
          endpoint,
          bearer,
          subtest,
        );
      },
    );
    const client = await clientFor("reader");
    await t.test(
      "SDK negotiates, discovers the compact tool catalog and reads live fixture deltas",
      async () => {
        assert.deepEqual(
          (await client.listTools()).tools.map((tool) => tool.name).sort(),
          [
            "describe_capability",
            "describe_put",
            "execute_capability",
            "execute_mutation",
            "get_history",
            "get_notification",
            "get_put_status",
            "get_values",
            "get_vessel_state",
            "list_capabilities",
            "list_notifications",
            "list_paths",
            "list_put_paths",
            "put_value",
          ],
        );
        const result = await client.callTool({
          name: "get_values",
          arguments: {
            paths: [
              "navigation.speedOverGround",
              "navigation.headingTrue",
              "navigation.notPresent",
              "electrical.batteries.house.voltage",
            ],
          },
        });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        const values = result.structuredContent.measurements;
        assert.equal(values[0].value, 0);
        assert.equal(values[0].unit, "m/s");
        assert.equal(values[0].source, "fixture.XX");
        assert.equal(values[0].freshness, "fresh");
        assert.equal(values[1].status, "missing");
        assert.deepEqual(values[2], {
          path: "navigation.notPresent",
          status: "unavailable",
        });
        assert.deepEqual(values[3], {
          path: "electrical.batteries.house.voltage",
          status: "unavailable",
        });
        const listed = await client.callTool({
          name: "list_paths",
          arguments: {},
        });
        assert.ok(
          listed.structuredContent.paths.includes("navigation.speedOverGround"),
          JSON.stringify(listed),
        );
        assert.ok(
          !listed.structuredContent.paths.includes(
            "electrical.batteries.house.voltage",
          ),
        );
      },
    );
    await t.test(
      "concurrent principals remain isolated; source ACLs and staleness survive",
      async () => {
        const other = await clientFor("other");
        const args = {
          name: "get_values",
          arguments: {
            paths: [
              "electrical.batteries.house.voltage",
              "navigation.position",
            ],
          },
        };
        const [a, b] = await Promise.all([
          client.callTool(args),
          other.callTool(args),
        ]);
        assert.equal(a.structuredContent.measurements[0].status, "unavailable");
        assert.equal(b.structuredContent.measurements[0].value, 12.7);
        assert.equal(b.structuredContent.measurements[0].freshness, "stale");
        assert.equal(b.structuredContent.measurements[1].status, "unavailable");
        const list = await other.callTool({
          name: "list_paths",
          arguments: {},
        });
        assert.deepEqual(list.structuredContent.paths, [
          "electrical.batteries.house.voltage",
        ]);
      },
    );
    await t.test(
      "invalid tool inputs and unknown operations cannot reach writes",
      async () => {
        for (const paths of [
          ["__proto__.polluted"],
          ["navigation"],
          Array(65).fill("navigation.position"),
        ]) {
          const result = await client.callTool({
            name: "get_values",
            arguments: { paths },
          });
          if (paths[0] === "navigation")
            assert.equal(
              result.structuredContent.measurements[0].status,
              "unavailable",
            );
          else assert.equal(result.isError, true);
        }
        assert.equal(
          (
            await client.callTool({
              name: "execute_code",
              arguments: { code: "process.exit()" },
            })
          ).isError,
          true,
        );
      },
    );
    const cap = (
      operation,
      args = {},
      id = "plugin.mcp-fixture",
      using = client,
    ) =>
      using.callTool({
        name: "execute_capability",
        arguments: { id, operation, arguments: args },
      });
    await t.test(
      "core capabilities share telemetry ACLs and expose truthful discovery",
      async () => {
        const listing = await client.callTool({
          name: "list_capabilities",
          arguments: {},
        });
        assert.equal(listing.isError, undefined, JSON.stringify(listing));
        assert.equal(listing.structuredContent.discovery, "complete");
        assert.ok(
          listing.structuredContent.capabilities.some(
            (cap) => cap.id === "plugin.mcp-fixture",
          ),
        );
        const description = await client.callTool({
          name: "describe_capability",
          arguments: { id: "signalk.telemetry" },
        });
        assert.ok(
          description.structuredContent.operations.find(
            (op) => op.id === "get_values",
          ).inputSchema.properties.paths,
        );
        const args = {
          paths: [
            "navigation.speedOverGround",
            "electrical.batteries.house.voltage",
          ],
        };
        const [dedicated, generic] = await Promise.all([
          client.callTool({ name: "get_values", arguments: args }),
          cap("get_values", args, "signalk.telemetry"),
        ]);
        assert.deepEqual(
          generic.structuredContent.measurements.map(
            ({ path, value, status }) => ({ path, value, status }),
          ),
          dedicated.structuredContent.measurements.map(
            ({ path, value, status }) => ({ path, value, status }),
          ),
        );
        assert.equal(
          (await cap("put_values", {}, "signalk.telemetry")).isError,
          true,
        );
        assert.equal(
          (await cap("constructor", {}, "signalk.telemetry")).isError,
          true,
        );
        const state = await client.callTool({
          name: "get_vessel_state",
          arguments: {},
        });
        assert.equal(
          state.structuredContent.measurements.find(
            (value) => value.path === "navigation.speedOverGround",
          ).value,
          0,
        );
      },
    );
    await t.test(
      "native mixed-case ID discovery preserves approval and route identity",
      async () => {
        const native = await server.app.getFeatures();
        assert.ok(
          native.plugins.some(
            (plugin) => plugin.id === "AdvancedWind" && plugin.enabled,
          ),
        );
        const listing = await client.callTool({
          name: "list_capabilities",
          arguments: {},
        });
        assert.equal(listing.structuredContent.discovery, "complete");
        assert.ok(
          listing.structuredContent.capabilities.some(
            (cap) =>
              cap.id === "plugin.AdvancedWind" &&
              cap.provider === "AdvancedWind",
          ),
        );
        const description = await client.callTool({
          name: "describe_capability",
          arguments: { id: "plugin.AdvancedWind" },
        });
        assert.equal(description.structuredContent.available, true);
        const unapproved = description.structuredContent.operations.find(
          (op) => op.id === "read",
        );
        assert.equal(unapproved.enabled, false);
        assert.equal(unapproved.reason, "NOT_ALLOWLISTED");
        const provider = loadedPlugin(server, "AdvancedWind");
        assert.equal(provider.testCalls.reads, 0);
        const blocked = await cap("read", {}, "plugin.AdvancedWind");
        assert.equal(blocked.isError, true);
        assert.equal(blocked.content[0].text, "APPROVAL_PENDING");
        assert.equal(provider.testCalls.reads, 0);
        const approved = await cap("readApproved", {}, "plugin.AdvancedWind");
        assert.equal(approved.isError, undefined, JSON.stringify(approved));
        assert.deepEqual(approved.structuredContent.data, { value: 0 });
        assert.equal(provider.testCalls.reads, 1);
        const wrongCase = await client.callTool({
          name: "describe_capability",
          arguments: { id: "plugin.advancedwind" },
        });
        assert.equal(wrongCase.isError, true);
        assert.equal(wrongCase.content[0].text, "CAPABILITY_NOT_FOUND");
      },
    );
    await t.test(
      "v2 notifications preserve records and enforce native path/source permissions for readers and admins",
      async (subtest) => {
        const resources =
          server.app.securityStrategy.getConfiguration().acls[0].resources;
        subtest.after(() => resources.splice(0, 2));
        resources.unshift(
          {
            sources: ["notification-private.*"],
            permissions: [{ subject: "other", permission: "read" }],
          },
          {
            paths: ["notifications.allowed.*"],
            permissions: ["reader", "admin"].map((subject) => ({
              subject,
              permission: "read",
            })),
          },
        );
        const seed = (label, path) =>
          server.app.handleMessage(label, {
            context: "vessels.self",
            updates: [
              {
                source: { label },
                timestamp: "2026-10-18T10:00:00Z",
                values: [
                  {
                    path,
                    value: {
                      state: "alarm",
                      method: ["visual"],
                      message: path,
                      data: { zero: 0, missing: null },
                    },
                  },
                ],
              },
            ],
          });
        seed("notification-public", "notifications.allowed.first");
        seed("notification-public", "notifications.allowed.second");
        seed("notification-private", "notifications.allowed.private");
        seed("notification-public", "notifications.denied");
        const readRaw = async () => {
          const response = await fetch(
            `http://${host}/signalk/v2/api/notifications`,
            {
              headers: { Authorization: `Bearer ${bearer}` },
            },
          );
          assert.equal(response.status, 200);
          return response.json();
        };
        const raw = await readRaw();
        assert.ok(
          Object.values(raw).some(
            (entry) => entry.path === "notifications.denied",
          ),
          "native GET does not apply telemetry ACLs",
        );
        const expected = Object.fromEntries(
          Object.entries(raw).filter(([, entry]) =>
            [
              "notifications.allowed.first",
              "notifications.allowed.second",
            ].includes(entry.path),
          ),
        );
        assert.equal(Object.keys(expected).length, 2);
        const dedicated = await client.callTool({
          name: "list_notifications",
          arguments: {},
        });
        assert.equal(dedicated.isError, undefined, JSON.stringify(dedicated));
        assert.deepEqual(dedicated.structuredContent.notifications, expected);
        assert.deepEqual(
          (await cap("list_notifications", {}, "signalk.notifications"))
            .structuredContent,
          dedicated.structuredContent,
        );
        const admin = await clientFor("admin");
        assert.deepEqual(
          (await cap("list_notifications", {}, "signalk.notifications", admin))
            .structuredContent,
          dedicated.structuredContent,
        );
        const ids = Object.keys(expected).sort();
        const page = await client.callTool({
          name: "list_notifications",
          arguments: { limit: 1 },
        });
        assert.deepEqual(Object.keys(page.structuredContent.notifications), [
          ids[0],
        ]);
        assert.equal(page.structuredContent.nextOffset, 1);
        const second = await client.callTool({
          name: "list_notifications",
          arguments: { offset: 1, limit: 1 },
        });
        assert.deepEqual(Object.keys(second.structuredContent.notifications), [
          ids[1],
        ]);
        assert.equal(second.structuredContent.nextOffset, null);
        const one = await client.callTool({
          name: "get_notification",
          arguments: { id: ids[0] },
        });
        assert.deepEqual(one.structuredContent.notification, raw[ids[0]]);
        assert.deepEqual(
          (
            await cap(
              "get_notification",
              { id: ids[0] },
              "signalk.notifications",
            )
          ).structuredContent,
          one.structuredContent,
        );
        const deniedId = Object.entries(raw).find(
          ([, entry]) => entry.path === "notifications.denied",
        )[0];
        const errors = await Promise.all(
          [deniedId, "unknown"].map((id) =>
            client.callTool({ name: "get_notification", arguments: { id } }),
          ),
        );
        assert.deepEqual(errors[0].content, errors[1].content);
        assert.equal(errors[0].content[0].text, "NOTIFICATION_UNAVAILABLE");
        for (const operation of [
          "raise",
          "silence",
          "acknowledge",
          "clear",
          "update",
          "silenceAll",
          "acknowledgeAll",
        ])
          assert.equal(
            (await cap(operation, {}, "signalk.notifications")).content[0].text,
            "OPERATION_NOT_FOUND",
          );
        assert.deepEqual(
          await readRaw(),
          raw,
          "all MCP reads leave registry state unchanged",
        );
      },
    );
    await t.test(
      "plugin OpenAPI discovery classifies unsupported and unapproved operations",
      async () => {
        const result = await client.callTool({
          name: "describe_capability",
          arguments: { id: "plugin.mcp-fixture" },
        });
        assert.equal(
          result.structuredContent.available,
          true,
          JSON.stringify(result),
        );
        const operations = result.structuredContent.operations;
        assert.equal(
          operations.find((op) => op.id === "readReading").enabled,
          true,
        );
        assert.equal(
          operations.find((op) => op.id === "unapproved").reason,
          "NOT_ALLOWLISTED",
        );
        assert.equal(
          operations.find((op) => op.id === "write").reason,
          "NOT_ALLOWLISTED",
        );
        assert.equal(
          operations.find((op) => op.id === "badSchema").reason,
          "UNSUPPORTED_REFERENCE",
        );
        assert.equal(
          operations.find((op) => op.id === "readReading").inputSchema
            .properties.scale.maximum,
          4,
        );
      },
    );
    await t.test(
      "approved GET reaches native provider with original user identity and validates inputs",
      async () => {
        const result = await cap("readReading", { name: "speed", scale: 2 });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        assert.deepEqual(result.structuredContent.data, {
          principal: "reader",
          name: "speed",
          value: 84,
          cookieSeen: false,
        });
        for (const args of [
          { name: ".." },
          { name: "a/b" },
          { name: "speed", scale: 5 },
          { name: "speed", surprise: true },
        ])
          assert.equal((await cap("readReading", args)).isError, true);
        const other = await clientFor("other");
        assert.equal(
          (
            await cap(
              "readReading",
              { name: "speed" },
              "plugin.mcp-fixture",
              other,
            )
          ).content[0].text,
          "UPSTREAM_PERMISSION_DENIED",
        );
        assert.equal(
          (await cap("adminReading")).content[0].text,
          "UPSTREAM_PERMISSION_DENIED",
        );
        const admin = await clientFor("admin");
        assert.equal(
          (await cap("adminReading", {}, "plugin.mcp-fixture", admin))
            .structuredContent.data.principal,
          "admin",
        );
      },
    );
    await t.test(
      "unknown/writing routes, redirects and schema drift never gain approval",
      async () => {
        const fixture = loadedPlugin(server, "mcp-fixture");
        assert.equal((await cap("unapproved")).isError, true);
        assert.equal((await cap("write")).isError, true);
        assert.equal((await cap("badSchema")).isError, true);
        assert.equal(
          (await cap("redirect")).content[0].text,
          "UPSTREAM_HTTP_ERROR",
        );
        assert.equal(fixture.testCalls.writes, 0);
        assert.equal(fixture.testCalls.unapproved, 0);
        const operation = fixture.testDocument.paths["/reading/{name}"].get;
        fixture.testDocument.paths["/reading/{name}"].get = {
          ...operation,
          operationId: "changed",
        };
        assert.equal(
          (await cap("readReading", { name: "speed" })).isError,
          true,
        );
        fixture.testDocument.paths["/reading/{name}"].get = operation;
      },
    );
    await t.test(
      "history forwards standard responses, honors source ACLs and rejects conflicting provenance",
      async () => {
        const description = await client.callTool({
          name: "describe_capability",
          arguments: { id: "signalk.history" },
        });
        assert.equal(
          description.structuredContent.available,
          true,
          JSON.stringify(description),
        );
        const fixture = loadedPlugin(server, "mcp-fixture");
        const query = {
          provider: "mcp-fixture",
          from: "2026-10-17T10:00:00Z",
          to: "2026-10-17T10:01:00Z",
          resolution: 10,
          paths: [{ path: "navigation.speedOverGround", source: "fixture.XX" }],
        };
        const result = await client.callTool({
          name: "get_history",
          arguments: query,
        });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        assert.equal(result.structuredContent.data[0][1], 0);
        assert.equal(result.structuredContent.values[0].$source, "fixture.XX");
        assert.equal(result.structuredContent.values[0].unit, undefined);
        const before = fixture.testCalls.history;
        const denied = await client.callTool({
          name: "get_history",
          arguments: {
            ...query,
            paths: [
              {
                path: "electrical.batteries.house.voltage",
                source: "private.source",
              },
            ],
          },
        });
        assert.equal(denied.content[0].text, "PERMISSION_DENIED");
        assert.equal(fixture.testCalls.history, before);
        for (const mode of [
          "wrong-source",
          "wrong-path",
          "wrong-context",
          "extra-column",
        ]) {
          fixture.setHistoryMode(mode);
          assert.equal(
            (await client.callTool({ name: "get_history", arguments: query }))
              .isError,
            true,
            mode,
          );
        }
        fixture.setHistoryMode("missing-source");
        const optionalSource = await client.callTool({
          name: "get_history",
          arguments: query,
        });
        assert.equal(
          optionalSource.isError,
          undefined,
          JSON.stringify(optionalSource),
        );
        assert.deepEqual(optionalSource.structuredContent.values, [
          { path: "navigation.speedOverGround", method: "average" },
        ]);
        fixture.setHistoryMode("valid");
        assert.equal(
          (
            await client.callTool({
              name: "get_history",
              arguments: {
                ...query,
                paths: [
                  {
                    path: "navigation.speedOverGround",
                    source: "source-with-hyphens",
                  },
                ],
              },
            })
          ).isError,
          true,
        );
        assert.equal(
          (
            await client.callTool({
              name: "get_history",
              arguments: { ...query, to: "2026-10-30T10:01:00Z" },
            })
          ).content[0].text,
          "HISTORY_QUERY_LIMIT",
        );
        await fixture.stop();
        const unavailable = await client.callTool({
          name: "describe_capability",
          arguments: { id: "signalk.history" },
        });
        assert.equal(
          unavailable.structuredContent.available,
          Boolean(process.env.MCP_TEST_INFLUX_URL),
        );
        assert.equal(
          (await client.callTool({ name: "get_history", arguments: query }))
            .content[0].text,
          "HISTORY_UNAVAILABLE",
        );
        fixture.start();
      },
    );
    await t.test(
      "source and resolution are optional with native no-ACL authorization; ACL changes revoke pending reads",
      async () => {
        const security = server.app.securityStrategy;
        const configuration = security.getConfiguration();
        const original = configuration.acls;
        const fixture = loadedPlugin(server, "mcp-fixture");
        const input = {
          provider: "mcp-fixture",
          from: "2026-10-17T10:00:00Z",
          to: "2026-10-17T10:01:00Z",
          paths: [{ path: "navigation.speedOverGround" }],
        };
        const before = fixture.testCalls.history;
        assert.equal(security.anyACLs(), true);
        const denied = await client.callTool({
          name: "get_history",
          arguments: input,
        });
        assert.equal(denied.content[0].text, "PERMISSION_DENIED");
        assert.equal(fixture.testCalls.history, before);
        let held;
        try {
          configuration.acls = [];
          assert.equal(security.anyACLs(), false);
          const result = await client.callTool({
            name: "get_history",
            arguments: input,
          });
          assert.equal(result.isError, undefined, JSON.stringify(result));
          assert.deepEqual(result.structuredContent, {
            context: "vessels.self",
            range: { from: input.from, to: input.to },
            values: [{ path: "navigation.speedOverGround", method: "average" }],
            data: [[input.from, 0]],
          });
          const position = await client.callTool({
            name: "get_history",
            arguments: {
              ...input,
              paths: [{ path: "navigation.position" }],
            },
          });
          assert.equal(position.isError, undefined, JSON.stringify(position));
          assert.equal(position.structuredContent.values[0].method, "first");
          held = fixture.holdNextRead("history");
          const pending = client.callTool({
            name: "get_history",
            arguments: input,
          });
          await Promise.race([
            held.started,
            pending.then(() => {
              throw new Error("History ended before provider entry");
            }),
          ]);
          configuration.acls = original;
          held.release();
          const revoked = await pending;
          assert.equal(revoked.content[0].text, "PERMISSION_DENIED");
          assert.equal(revoked.structuredContent, undefined);
        } finally {
          configuration.acls = original;
          held?.release();
        }
      },
    );
    await t.test(
      "pinned production History provider",
      { skip: !process.env.MCP_TEST_INFLUX_URL },
      async (t) => {
        await checkHistoryProvider(t, server, host, bearer, client);
      },
    );
    await t.test(
      "history provider errors and deadlines never disclose partial results",
      async () => {
        const fixture = loadedPlugin(server, "mcp-fixture");
        const input = {
          provider: "mcp-fixture",
          from: "2026-10-17T10:00:00Z",
          to: "2026-10-17T10:01:00Z",
          resolution: 10,
          paths: [{ path: "navigation.speedOverGround", source: "fixture.XX" }],
        };
        fixture.setHistoryMode("error");
        try {
          const error = await client.callTool({
            name: "get_history",
            arguments: input,
          });
          assert.equal(error.content[0].text, "UPSTREAM_HTTP_ERROR");
          assert.equal(error.structuredContent, undefined);
        } finally {
          fixture.setHistoryMode("valid");
        }
        const held = fixture.holdNextRead("history");
        const pending = client.callTool({
          name: "get_history",
          arguments: input,
        });
        try {
          await Promise.race([
            held.started,
            pending.then(() => {
              throw new Error("History ended before provider entry");
            }),
          ]);
          const timeout = await pending;
          assert.equal(timeout.content[0].text, "UPSTREAM_UNAVAILABLE");
          assert.equal(timeout.structuredContent, undefined);
        } finally {
          held.release();
        }
      },
    );
    await t.test(
      "Python MCP SDK interoperability",
      { skip: !process.env.MCP_TEST_PYTHON },
      async () => {
        await new Promise((resolve, reject) => {
          const child = require("node:child_process").spawn(
            process.env.MCP_TEST_PYTHON,
            [path.join(__dirname, "python-client.py")],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
          });
          child.stderr.on("data", (chunk) => {
            output += chunk;
          });
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(output)),
          );
          child.stdin.end(
            JSON.stringify({ url: endpoint.href, token: bearer }),
          );
        });
      },
    );
    await t.test(
      "cookie identity cannot override bearer identity",
      async () => {
        const Cookie = `JAUTHENTICATION=${token("admin")}`;
        assert.equal(
          (await request(initialize, "Bearer invalid", { Cookie })).status,
          401,
        );
        const body = {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "get_values",
            arguments: { paths: ["navigation.position"] },
          },
        };
        const response = await request(body, `Bearer ${token("other")}`, {
          Cookie,
        });
        assert.equal(
          (await response.json()).result.structuredContent.measurements[0]
            .status,
          "unavailable",
        );
      },
    );
    await t.test("protocol failures and size limits", async () => {
      assert.equal(
        (
          await request(
            { jsonrpc: "2.0", id: 9, method: "tools/list" },
            undefined,
            {
              "MCP-Protocol-Version": "2099-01-01",
            },
          )
        ).status,
        400,
      );
      assert.equal(
        (await request({ jsonrpc: "2.0", method: "notifications/initialized" }))
          .status,
        202,
      );
      assert.equal(
        (await request({ ...initialize, padding: "x".repeat(65536) })).status,
        413,
      );
    });
    await t.test(
      "permissions are resolved again on subsequent requests",
      async () => {
        const device = server.app.securityStrategy
          .getConfiguration()
          .devices.find((device) => device.clientId === "reader");
        device.permissions = "unknown";
        assert.equal((await request(initialize)).status, 403);
        device.permissions = "readonly";
        const devices = server.app.securityStrategy.getConfiguration().devices;
        devices.splice(devices.indexOf(device), 1);
        assert.equal((await request(initialize)).status, 401);
        devices.push(device);
      },
    );
    await t.test(
      "user tokens retain native permissions and stop working after user removal",
      async () => {
        const userBearer = jwt.sign({ id: "crew" }, secret, {
          expiresIn: "5m",
        });
        const userClient = new Client({ name: "user-principal", version: "1" });
        await userClient.connect(
          new StreamableHTTPClientTransport(endpoint, {
            requestInit: { headers: { Authorization: `Bearer ${userBearer}` } },
          }),
        );
        t.after(() => userClient.close());
        const result = await cap(
          "readReading",
          { name: "speed" },
          "plugin.mcp-fixture",
          userClient,
        );
        assert.equal(result.structuredContent.data.principal, "crew");
        const readings = await userClient.callTool({
          name: "get_values",
          arguments: {
            paths: [
              "navigation.speedOverGround",
              "electrical.batteries.house.voltage",
            ],
          },
        });
        assert.equal(readings.structuredContent.measurements[0].value, 0);
        assert.equal(
          readings.structuredContent.measurements[1].status,
          "unavailable",
        );
        const users = server.app.securityStrategy.getConfiguration().users;
        const user = users.find((entry) => entry.username === "crew");
        const index = users.indexOf(user);
        try {
          user.type = "unknown";
          assert.equal(
            (await request(initialize, `Bearer ${userBearer}`)).status,
            403,
          );
          user.type = "readonly";
          users.splice(index, 1);
          assert.equal(
            (await request(initialize, `Bearer ${userBearer}`)).status,
            401,
          );
        } finally {
          user.type = "readonly";
          if (!users.includes(user)) users.splice(index, 0, user);
        }
      },
    );
    await t.test(
      "native permission changes during a provider response discard the result",
      async () => {
        const fixture = loadedPlugin(server, "mcp-fixture");
        const device = server.app.securityStrategy
          .getConfiguration()
          .devices.find((entry) => entry.clientId === "reader");
        const held = fixture.holdNextRead("plugin");
        const pending = cap("readReading", { name: "speed" });
        try {
          await Promise.race([
            held.started,
            pending.then(() => {
              throw new Error("Provider call ended before the held response");
            }),
          ]);
          device.permissions = "unknown";
          held.release();
          const result = await pending;
          assert.equal(result.isError, true);
          assert.equal(result.content[0].text, "PERMISSION_DENIED");
          assert.equal(result.structuredContent, undefined);
        } finally {
          held.release();
          device.permissions = "readonly";
        }
      },
    );
    await t.test(
      "native history ACL revocation while fetching prevents data disclosure",
      async () => {
        const fixture = loadedPlugin(server, "mcp-fixture");
        const acl =
          server.app.securityStrategy.getConfiguration().acls[0].resources[0];
        const original = acl.permissions;
        const held = fixture.holdNextRead("history");
        const pending = client.callTool({
          name: "get_history",
          arguments: {
            from: "2026-10-17T10:00:00Z",
            to: "2026-10-17T10:01:00Z",
            resolution: 10,
            paths: [
              { path: "navigation.speedOverGround", source: "fixture.XX" },
            ],
          },
        });
        try {
          await Promise.race([
            held.started,
            pending.then(() => {
              throw new Error("Provider call ended before the held response");
            }),
          ]);
          acl.permissions = original.filter(
            (entry) => entry.subject !== "reader",
          );
          held.release();
          const result = await pending;
          assert.equal(result.isError, true);
          assert.equal(result.content[0].text, "PERMISSION_DENIED");
          assert.equal(result.structuredContent, undefined);
        } finally {
          held.release();
          acl.permissions = original;
        }
      },
    );
    await t.test(
      "native admin review: pending, approve, reject, reload and schema change",
      async () => {
        const plugin = loadedPlugin(server, "signalk-mcp");
        const fixture = loadedPlugin(server, "mcp-fixture");
        const configUrl = `http://${host}/plugins/signalk-mcp/config`;
        const adminHeaders = {
          Authorization: `Bearer ${token("admin")}`,
          "Content-Type": "application/json",
        };
        const original = await (
          await fetch(configUrl, { headers: adminHeaders })
        ).json();
        const configuration = globalThis.structuredClone(original);
        const before = fixture.testCalls.unapproved;
        // Earlier blocked calls may already have queued this operation.
        assert.equal(
          (await cap("unapproved")).content[0].text,
          "APPROVAL_PENDING",
        );
        assert.equal(
          (await cap("unapproved")).content[0].text,
          "APPROVAL_PENDING",
        );
        const schemas = plugin.schema().properties.readRequests.properties;
        const entries = Object.entries(schemas).filter(
          ([, entry]) => entry.default.operationId === "unapproved",
        );
        assert.equal(entries.length, 1);
        const [key, entry] = entries[0];
        assert.equal(fixture.testCalls.unapproved, before);
        assert.equal(
          original.configuration.readRequests,
          undefined,
          "MCP must not persist configuration",
        );
        configuration.configuration.readRequests = {
          [key]: { ...entry.default, decision: "approved" },
        };
        for (const principal of [undefined, "reader", "writer"]) {
          const response = await fetch(configUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(principal
                ? { Authorization: `Bearer ${token(principal)}` }
                : {}),
            },
            body: JSON.stringify(configuration),
          });
          assert.ok(
            [401, 403].includes(response.status),
            `${principal}: ${response.status}`,
          );
        }
        async function save(options, expected) {
          const response = await fetch(configUrl, {
            method: "POST",
            headers: adminHeaders,
            body: JSON.stringify(options),
          });
          assert.equal(response.status, 200);
          for (let i = 0; i < 100; i++) {
            const saved =
              plugin.schema().properties.readRequests.properties[key]?.default
                .decision;
            if (saved === expected) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.fail("Native configuration restart did not complete");
        }
        try {
          await save(configuration, "approved");
          const approved = await cap("unapproved");
          assert.equal(approved.isError, undefined, JSON.stringify(approved));
          assert.equal(fixture.testCalls.unapproved, before + 1);
          const persisted = await (
            await fetch(configUrl, { headers: adminHeaders })
          ).json();
          assert.equal(
            persisted.configuration.readRequests[key].decision,
            "approved",
          );
          await plugin.stop();
          assert.equal(
            plugin.schema().properties.readRequests.properties[key].default
              .decision,
            "approved",
            "Disabled plugin retains saved reviews in settings",
          );
          plugin.start(persisted.configuration);
          assert.equal((await cap("unapproved")).isError, undefined);
          // A changed schema requires a separate review; approval is not broadened.
          const operation = fixture.testDocument.paths["/unapproved"].get;
          operation.parameters = [
            {
              name: "count",
              in: "query",
              required: true,
              schema: { type: "integer" },
            },
          ];
          const queuedBefore = Object.keys(
            plugin.schema().properties.readRequests.properties,
          ).length;
          assert.equal(
            (await cap("unapproved")).content[0].text,
            "INVALID_ARGUMENTS",
          );
          assert.equal(
            Object.keys(plugin.schema().properties.readRequests.properties)
              .length,
            queuedBefore,
          );
          assert.equal(
            (await cap("unapproved", { count: 1 })).content[0].text,
            "APPROVAL_PENDING",
          );
          delete operation.parameters;
          configuration.configuration.readRequests[key].decision = "rejected";
          await save(configuration, "rejected");
          const reads = fixture.testCalls.unapproved;
          assert.equal(
            (await cap("unapproved")).content[0].text,
            "APPROVAL_REJECTED",
          );
          assert.equal(fixture.testCalls.unapproved, reads);
          assert.equal((await cap("write")).isError, true);
          assert.equal(fixture.testCalls.writes, 0);
          configuration.configuration.readRequests[key].decision = "approved";
          configuration.configuration.readRequests[key].permission = "admin";
          await save(configuration, "approved");
          assert.equal((await cap("unapproved")).isError, true);
          const admin = await clientFor("admin");
          assert.equal(
            (await cap("unapproved", {}, "plugin.mcp-fixture", admin)).isError,
            undefined,
          );
          const { loadConfiguration, saveConfiguration } =
            await import("../ui/configuration.mjs");
          const nativeFetch =
            (principal) =>
            (url, options = {}) =>
              fetch(`http://${host}/skServer${url}`, {
                ...options,
                headers: {
                  ...options.headers,
                  Authorization: `Bearer ${token(principal)}`,
                },
              });
          const orphan = {
            ...entry.default,
            pluginId: "removed-fixture",
            decision: "rejected",
          };
          const orphanKey = require("../dist/approvals.js").reviewKey(orphan);
          configuration.configuration.readRequests[orphanKey] = orphan;
          await save(configuration, "approved");
          const base = await loadConfiguration(nativeFetch("admin"));
          assert.ok(base.installed.includes("mcp-fixture"));
          assert.equal(base.installed.includes("removed-fixture"), false);
          const draft = globalThis.structuredClone({
            reviews: base.reviews,
            settings: base.settings,
          });
          delete draft.reviews[orphanKey];
          draft.reviews[key].decision = "rejected";
          await assert.rejects(
            saveConfiguration(base, draft, nativeFetch("reader")),
            /administrator/,
          );
          const saved = await saveConfiguration(
            base,
            draft,
            nativeFetch("admin"),
          );
          assert.equal(saved.reviews[orphanKey], undefined);
          assert.equal(saved.reviews[key].decision, "rejected");
          const confirmed = await (
            await fetch(configUrl, { headers: adminHeaders })
          ).json();
          assert.equal(
            confirmed.configuration.readRequests[orphanKey],
            undefined,
          );
          assert.equal(
            confirmed.configuration.readRequests[key].decision,
            "rejected",
          );
          const remote = await fetch(
            `http://${host}/signalk-mcp/remoteEntry.js`,
            { headers: adminHeaders },
          );
          assert.equal(remote.status, 200);
          assert.match(await remote.text(), /signalk_mcp/);
        } finally {
          await save(original, undefined);
        }
      },
    );
    await t.test(
      "unconfigured plugin saves defaults unchanged before native enable without granting approvals",
      async () => {
        const { loadConfiguration, saveConfiguration } =
          await import("../ui/configuration.mjs");
        const nativeFetch =
          (principal) =>
          (url, options = {}) =>
            fetch(`http://${host}/skServer${url}`, {
              ...options,
              headers: {
                ...options.headers,
                Authorization: `Bearer ${token(principal)}`,
              },
            });
        const adminFetch = nativeFetch("admin");
        const configUrl = "/plugins/signalk-mcp/config";
        const original = await (await adminFetch(configUrl)).json();
        const write = async (options) => {
          const result = await adminFetch(configUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(options),
          });
          assert.equal(result.status, 200);
        };
        const waitStatus = async (expected) => {
          let status;
          for (let attempt = 0; attempt < 100; attempt++) {
            status = (await request(initialize)).status;
            if (status === expected) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(status, expected);
        };
        try {
          await write({ enabled: false, enableDebug: true });
          await waitStatus(503);
          const base = await loadConfiguration(adminFetch);
          assert.equal(base.options.configuration, undefined);
          const draft = globalThis.structuredClone({
            reviews: base.reviews,
            settings: base.settings,
          });
          await assert.rejects(
            saveConfiguration(base, draft, nativeFetch("reader")),
            /administrator/,
          );
          const saved = await saveConfiguration(base, draft, adminFetch);
          assert.equal(saved.options.enabled, false);
          assert.equal(saved.options.enableDebug, true);
          assert.deepEqual(saved.options.configuration, { readRequests: {} });
          assert.deepEqual(saved.settings, {
            localTlsServerName: "",
            staleAfterSeconds: 300,
            pluginOperations: [],
          });
          await waitStatus(503);
          await write({ ...saved.options, enabled: true });
          await waitStatus(200);
          assert.equal(
            (await cap("readReading", { name: "speed" })).content[0].text,
            "APPROVAL_PENDING",
          );
        } finally {
          await write(original);
          await waitStatus(200);
        }
      },
    );
    await t.test("disable and re-enable native plugin", async () => {
      const plugin = loadedPlugin(server, "signalk-mcp");
      await plugin.stop();
      assert.equal((await request(initialize)).status, 503);
      plugin.start({});
      assert.equal((await request(initialize)).status, 200);
    });
  },
);
