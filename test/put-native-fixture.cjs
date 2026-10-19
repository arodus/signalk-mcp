const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { loadedPlugin } = require("./native-server.cjs");

const serverRequire = createRequire(
  process.env.MCP_TEST_SERVER_DIR
    ? path.join(path.resolve(process.env.MCP_TEST_SERVER_DIR), "package.json")
    : require.resolve("signalk-server/package.json"),
);

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signalk-mcp-native-put-"));
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.mkdirSync(path.join(dir, "plugin-config-data"));
  const dependencies = {};
  for (const [id, root] of [
    [
      "signalk-mcp",
      process.env.MCP_TEST_PLUGIN_DIR || path.resolve(__dirname, ".."),
    ],
    ["put-fixture", path.join(__dirname, "fixtures/put-fixture")],
  ]) {
    dependencies[id] = "1.0.0";
    fs.symlinkSync(root, path.join(dir, "node_modules", id), "dir");
    fs.writeFileSync(
      path.join(dir, "plugin-config-data", `${id}.json`),
      JSON.stringify({ enabled: true, configuration: {} }),
    );
  }
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "isolated-native-puts",
      version: "1.0.0",
      dependencies,
    }),
  );
  process.env.SIGNALK_NODE_CONFIG_DIR = dir;
  process.env.SIGNALK_DISABLE_SERVER_UPDATES = "true";
  process.env.HTTP_RATE_LIMITS = "api=10000,loginStatus=10000,login=10000";
  process.env.NODE_ENV = "test";
  const secret = crypto.randomBytes(32).toString("hex");
  const ids = ["writer", "other", "reader", "admin", "writeonly"];
  const tokens = Object.fromEntries(
    ids.map((id) => [
      id,
      serverRequire("jsonwebtoken").sign({ device: id }, secret, {
        expiresIn: "1h",
      }),
    ]),
  );
  const prefix = "electrical.switches.mcpTest";
  const securityConfig = {
    secretKey: secret,
    allow_readonly: false,
    users: [],
    devices: ids.map((clientId) => ({
      clientId,
      enabled: true,
      permissions:
        clientId === "admin"
          ? "admin"
          : clientId === "reader"
            ? "readonly"
            : "readwrite",
    })),
    acls: [
      {
        context: "vessels.self",
        resources: [
          {
            sources: ["private"],
            permissions: [{ subject: "other", permission: "put" }],
          },
          {
            paths: [`${prefix}.*`],
            permissions: [
              { subject: "writer", permission: "put" },
              { subject: "reader", permission: "put" },
              { subject: "writeonly", permission: "write" },
            ],
          },
          {
            paths: ["navigation.*"],
            permissions: [{ subject: "writer", permission: "read" }],
          },
        ],
      },
    ],
  };
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
        vessels: { self: { uuid: "urn:mrn:signalk:uuid:native-put-fixture" } },
      },
    },
    securityConfig,
  });
  try {
    await server.start();
  } catch (error) {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const version = serverRequire("./package.json").version;
  if (process.env.MCP_TEST_SERVER_VERSION)
    assert.equal(version, process.env.MCP_TEST_SERVER_VERSION);
  const baseUrl = `http://127.0.0.1:${port}`;
  const gateway = loadedPlugin(server, "signalk-mcp");
  const provider = loadedPlugin(server, "put-fixture");
  let sequence = 0;
  async function http(route, principal = "writer", method = "GET", data) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(principal ? { Authorization: `Bearer ${tokens[principal]}` } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: AbortSignal.timeout(25000),
    });
    const raw = await response.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { text: raw };
    }
    return { status: response.status, body };
  }
  async function call(name, args = {}, principal = "writer") {
    const response = await http("/plugins/signalk-mcp/mcp", principal, "POST", {
      jsonrpc: "2.0",
      id: ++sequence,
      method: "tools/call",
      params: { name, arguments: args },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.result, JSON.stringify(response.body));
    return response.body.result;
  }
  const configRoute = "/plugins/signalk-mcp/config";
  async function readConfig() {
    const response = await http(configRoute, "admin");
    assert.equal(response.status, 200);
    return response.body;
  }
  function reviews() {
    return Object.fromEntries(
      Object.entries(gateway.schema().properties.readRequests.properties).map(
        ([key, schema]) => [key, globalThis.structuredClone(schema.default)],
      ),
    );
  }
  async function saveConfig(settings) {
    const response = await http(configRoute, "admin", "POST", settings);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        JSON.stringify(reviews()) ===
        JSON.stringify(settings.configuration.readRequests || {})
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Native admin configuration restart did not complete");
  }
  async function decide(target, decision = "approved") {
    const found = Object.entries(reviews())
      .reverse()
      .find(
        ([, review]) =>
          review.kind === "put" &&
          review.path === target.path &&
          review.source === target.source,
      );
    assert.ok(
      found,
      "PUT must queue a review before a native admin can save it",
    );
    const [key, review] = found;
    const settings = await readConfig();
    settings.configuration.readRequests = {
      ...reviews(),
      [key]: { ...review, decision },
    };
    await saveConfig(settings);
    return key;
  }
  return {
    server,
    gateway,
    provider,
    tokens,
    version,
    baseUrl,
    dir,
    http,
    call,
    readConfig,
    saveConfig,
    reviews,
    decide,
    async stop() {
      provider.releaseDelayed();
      await server.stop();
    },
    remove() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { start };
