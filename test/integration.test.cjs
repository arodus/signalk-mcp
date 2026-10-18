const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test(
  "native plugin on Signal K 2.33.0: authentication, ACLs, transport and lifecycle",
  { timeout: 90000 },
  async (t) => {
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
    fs.writeFileSync(
      path.join(dir, "plugin-config-data/signalk-mcp.json"),
      JSON.stringify({
        enabled: true,
        configuration: {
          allowedHosts: [host],
          allowedOrigins: ["https://allowed.example"],
          staleAfterSeconds: 300,
          pluginOperations: [
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
    process.env.SIGNALK_NODE_CONFIG_DIR = dir;
    process.env.SIGNALK_DISABLE_SERVER_UPDATES = "true";
    process.env.HTTP_RATE_LIMITS = "api=1000,loginStatus=1000,login=1000";
    process.env.NODE_ENV = "test";
    const Server = require("signalk-server");
    const jwt = require("node:module").createRequire(
      require.resolve("signalk-server"),
    )("jsonwebtoken");
    const secret = crypto.randomBytes(32).toString("hex");
    const securityConfig = {
      allow_readonly: true,
      expiration: "1d",
      secretKey: secret,
      users: [],
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
    const server = new Server({
      config: {
        settings: {
          port,
          mdns: false,
          enforceDataTimeouts: false,
          pipedProviders: [],
          interfaces: { plugins: true },
          security: { strategy: "./tokensecurity" },
        },
        defaults: {
          vessels: { self: { uuid: "urn:mrn:signalk:uuid:mcp-test" } },
        },
      },
      securityConfig,
    });
    t.after(async () => {
      await server.stop();
      fs.rmSync(dir, { recursive: true, force: true });
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
      "validates Host and Origin and unsupported methods",
      async () => {
        assert.equal(
          (
            await request(initialize, undefined, {
              Origin: "https://evil.example",
            })
          ).status,
          403,
        );
        const invalidHost = await new Promise((resolve, reject) => {
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
        assert.equal(invalidHost, 403);
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
    const client = await clientFor("reader");
    await t.test(
      "SDK negotiates, discovers the compact tool catalog and reads live fixture deltas",
      async () => {
        assert.deepEqual(
          (await client.listTools()).tools.map((tool) => tool.name).sort(),
          [
            "describe_capability",
            "execute_capability",
            "get_history",
            "get_values",
            "get_vessel_state",
            "list_capabilities",
            "list_paths",
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
          "METHOD_NOT_READONLY",
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
        const fixture = server.app.pluginsMap["mcp-fixture"];
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
      "history uses standardized provider, honors source ACLs and rejects wrong provenance",
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
        const fixture = server.app.pluginsMap["mcp-fixture"];
        const query = {
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
        assert.equal(result.structuredContent.values[0].source, "fixture.XX");
        assert.equal(result.structuredContent.values[0].unit, "m/s");
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
          "missing-source",
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
        assert.equal(unavailable.structuredContent.available, false);
        assert.equal(
          (await client.callTool({ name: "get_history", arguments: query }))
            .content[0].text,
          "HISTORY_UNAVAILABLE",
        );
        fixture.start();
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
    await t.test("disable and re-enable native plugin", async () => {
      const plugin = server.app.pluginsMap["signalk-mcp"];
      await plugin.stop();
      assert.equal((await request(initialize)).status, 503);
      plugin.start({ allowedHosts: [host] });
      assert.equal((await request(initialize)).status, 200);
    });
  },
);
