// Synthetic native server for lifecycle and opt-in local load measurements.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");
const { Buffer } = require("node:buffer");
const { createRequire } = require("node:module");
const serverRequire = createRequire(
  process.env.MCP_TEST_SERVER_DIR
    ? path.join(process.env.MCP_TEST_SERVER_DIR, "package.json")
    : require.resolve("signalk-server/package.json"),
);
async function start(gateway = true, { manageNotifications = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signalk-mcp-runtime-"));
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const configuration = {
    allowedHosts: [`127.0.0.1:${port}`],
    pluginOperations: [
      {
        pluginId: "mcp-fixture",
        operationId: "readReading",
        method: "GET",
        path: "/reading/{name}",
        readOnly: true,
      },
    ],
  };
  fs.mkdirSync(path.join(dir, "node_modules"));
  fs.mkdirSync(path.join(dir, "plugin-config-data"));
  const dependencies = {};
  for (const [id, root, config] of [
    ["mcp-fixture", path.join(__dirname, "fixtures/mcp-fixture"), {}],
    ...(gateway
      ? [["signalk-mcp", path.resolve(__dirname, ".."), configuration]]
      : []),
  ]) {
    dependencies[id] = "0.1.0";
    fs.symlinkSync(root, path.join(dir, "node_modules", id), "dir");
    fs.writeFileSync(
      path.join(dir, "plugin-config-data", `${id}.json`),
      JSON.stringify({ enabled: true, configuration: config }),
    );
  }
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "isolated-runtime-fixture",
      version: "1.0.0",
      dependencies,
    }),
  );
  process.env.SIGNALK_NODE_CONFIG_DIR = dir;
  process.env.SIGNALK_DISABLE_SERVER_UPDATES = "true";
  process.env.HTTP_RATE_LIMITS = "api=100000,loginStatus=100000,login=100000";
  process.env.NODE_ENV = "test";
  const secret = crypto.randomBytes(32).toString("hex");
  const tokens = Object.fromEntries(
    ["reader", "other"].map((id) => [
      id,
      serverRequire("jsonwebtoken").sign({ device: id }, secret, {
        expiresIn: "1h",
      }),
    ]),
  );
  const Server = serverRequire("./");
  const server = new Server({
    config: {
      settings: {
        port,
        mdns: false,
        enforceDataTimeouts: false,
        notifications: { manageNotifications },
        pipedProviders: [],
        interfaces: { plugins: true, "nmea-tcp": false, tcp: false },
        security: { strategy: "./tokensecurity" },
      },
      defaults: {
        vessels: { self: { uuid: "urn:mrn:signalk:uuid:runtime-fixture" } },
      },
    },
    securityConfig: {
      secretKey: secret,
      allow_readonly: false,
      users: [],
      devices: ["reader", "other"].map((clientId) => ({
        clientId,
        enabled: true,
        permissions: "readonly",
      })),
      acls: [
        {
          context: "vessels.self",
          resources: [
            {
              paths: ["navigation.*"],
              permissions: [{ subject: "reader", permission: "read" }],
            },
          ],
        },
      ],
    },
  });
  await server.start();
  const version = serverRequire("./package.json").version;
  if (
    process.env.MCP_TEST_SERVER_VERSION &&
    version !== process.env.MCP_TEST_SERVER_VERSION
  )
    throw new Error("Unexpected Signal K version");
  const seed = (values) =>
    server.app.handleMessage("fixture", {
      context: "vessels.self",
      updates: [
        {
          source: { label: "fixture" },
          timestamp: new Date().toISOString(),
          values,
        },
      ],
    });
  seed([{ path: "navigation.speedOverGround", value: 0 }]);
  let id = 0;
  function request(name, args = {}, principal = "reader") {
    let req;
    const result = new Promise((resolve, reject) => {
      req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          agent: false,
          method: "POST",
          path: "/plugins/signalk-mcp/mcp",
          headers: {
            Authorization: `Bearer ${tokens[principal]}`,
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": "2025-11-25",
          },
          signal: AbortSignal.timeout(20000),
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("error", reject);
          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      );
    });
    return { result, cancel: () => req.destroy() };
  }
  return {
    server,
    tokens,
    configuration,
    seed,
    request,
    version,
    dir,
    async stop() {
      await server.stop();
    },
    remove() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
module.exports = { start };
