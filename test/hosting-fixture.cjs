const { loadedPlugin } = require("./native-server.cjs");
const { Buffer } = require("node:buffer");
const console = require("node:console");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { localGet } = require("../dist/capabilities/http.js");
const [mode, pki] = process.argv.slice(2);
const serverRequire = createRequire(
  process.env.MCP_TEST_SERVER_DIR
    ? path.join(process.env.MCP_TEST_SERVER_DIR, "package.json")
    : require.resolve("signalk-server/package.json"),
);
async function freePort() {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signalk-mcp-hosting-"));
  const port = await freePort();
  const externalPort = mode === "proxy" ? await freePort() : port;
  const host = `127.0.0.1:${externalPort}`;
  const origin = `https://localhost:${externalPort}`;
  const cert =
    mode === "proxy" || mode === "native-ip"
      ? "ip"
      : mode === "untrusted"
        ? "untrusted-server"
        : "dns";
  const clientCa = fs.readFileSync(
    path.join(pki, mode === "untrusted" ? "untrusted.pem" : "trusted.pem"),
  );
  const settings = {
    allowedHosts: [host],
    allowedOrigins: [origin],
    ...(mode === "native-dns" || mode === "untrusted"
      ? { localTlsServerName: "localhost" }
      : mode === "configured-name-mismatch"
        ? { localTlsServerName: "incorrect.invalid" }
        : {}),
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
  for (const [id, root, configuration] of [
    ["signalk-mcp", path.resolve(__dirname, ".."), settings],
    ["mcp-fixture", path.join(__dirname, "fixtures/mcp-fixture"), {}],
  ]) {
    fs.symlinkSync(root, path.join(dir, "node_modules", id), "dir");
    fs.writeFileSync(
      path.join(dir, "plugin-config-data", `${id}.json`),
      JSON.stringify({ enabled: true, configuration }),
    );
  }
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "isolated-hosting-test",
      version: "1.0.0",
      dependencies: { "signalk-mcp": "0.1.0", "mcp-fixture": "1.0.0" },
    }),
  );
  for (const [target, suffix] of [
    ["ssl-cert.pem", "pem"],
    ["ssl-key.pem", "key"],
  ]) {
    fs.writeFileSync(
      path.join(dir, target),
      fs.readFileSync(path.join(pki, `${cert}.${suffix}`)),
      { mode: 0o600 },
    );
  }
  process.env.SIGNALK_NODE_CONFIG_DIR = dir;
  process.env.SIGNALK_DISABLE_SERVER_UPDATES = "true";
  process.env.HTTP_RATE_LIMITS = "api=1000,loginStatus=1000,login=1000";
  process.env.NODE_ENV = "test";
  const secret = crypto.randomBytes(32).toString("hex");
  const token = serverRequire("jsonwebtoken").sign(
    { device: "reader" },
    secret,
    { expiresIn: "5m" },
  );
  const Server = serverRequire("./");
  const server = new Server({
    config: {
      settings: {
        port: mode === "proxy" ? port : await freePort(),
        sslport: port,
        ssl: mode !== "proxy",
        mdns: false,
        enforceDataTimeouts: false,
        pipedProviders: [],
        interfaces: { plugins: true, "nmea-tcp": false, tcp: false },
        security: { strategy: "./tokensecurity" },
      },
      defaults: {
        vessels: { self: { uuid: "urn:mrn:signalk:uuid:hosting-test" } },
      },
    },
    securityConfig: {
      secretKey: secret,
      allow_readonly: false,
      expiration: "1d",
      users: [],
      devices: [{ clientId: "reader", permissions: "readonly", enabled: true }],
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
  let proxy;
  try {
    await server.start();
    if (process.env.MCP_TEST_SERVER_VERSION)
      assert.equal(
        serverRequire("./package.json").version,
        process.env.MCP_TEST_SERVER_VERSION,
      );
    if (mode === "proxy") {
      proxy = https.createServer(
        {
          key: fs.readFileSync(path.join(pki, "ip.key")),
          cert: fs.readFileSync(path.join(pki, "ip.pem")),
        },
        (req, res) => {
          const upstream = http.request(
            {
              hostname: "127.0.0.1",
              port,
              path: req.url,
              method: req.method,
              headers: req.headers,
            },
            (reply) => {
              res.writeHead(reply.statusCode, reply.headers);
              reply.pipe(res);
            },
          );
          upstream.on("error", () => res.destroy());
          res.once("close", () => {
            if (!res.writableFinished) upstream.destroy();
          });
          req.pipe(upstream);
        },
      );
      await new Promise((resolve) =>
        proxy.listen(externalPort, "127.0.0.1", resolve),
      );
    }
    server.app.handleMessage("mcp-fixture", {
      context: "vessels.self",
      updates: [
        {
          source: { label: "fixture" },
          timestamp: new Date().toISOString(),
          values: [{ path: "navigation.speedOverGround", value: 0 }],
        },
      ],
    });
    let id = 0;
    function send(method, params, headers = {}) {
      let request;
      const result = new Promise((resolve, reject) => {
        request = https.request(
          {
            hostname: "127.0.0.1",
            port: externalPort,
            servername: "localhost",
            ca: clientCa,
            method: "POST",
            path: "/plugins/signalk-mcp/mcp",
            headers: {
              Host: host,
              Origin: origin,
              Authorization: `Bearer ${token}`,
              Accept: "application/json, text/event-stream",
              "Content-Type": "application/json",
              "MCP-Protocol-Version": "2025-11-25",
              ...headers,
            },
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              }),
            );
          },
        );
        request.on("error", reject);
        request.end(
          JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        );
      });
      return { request, result };
    }
    const call = async (name, args = {}, headers) =>
      (await send("tools/call", { name, arguments: args }, headers).result).body
        .result;
    assert.equal(
      (
        await send("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "hosting-test", version: "1" },
        }).result
      ).status,
      200,
    );
    assert.equal(
      (await send("tools/list", {}).result).body.result.tools.length,
      9,
    );
    assert.equal(
      (await call("get_values", { paths: ["navigation.speedOverGround"] }))
        .structuredContent.measurements[0].value,
      0,
    );
    const pluginArgs = {
      id: "plugin.mcp-fixture",
      operation: "readReading",
      arguments: { name: "speed" },
    };
    const failedTls = [
      "name-mismatch",
      "untrusted",
      "configured-name-mismatch",
    ].includes(mode);
    const info = await call("describe_capability", {
      id: "plugin.mcp-fixture",
    });
    if (failedTls) {
      assert.equal(info.structuredContent.reason, "UPSTREAM_UNAVAILABLE");
      assert.equal(
        (await call("execute_capability", pluginArgs)).content[0].text,
        "UPSTREAM_UNAVAILABLE",
      );
      assert.equal(
        (await call("get_values", { paths: ["navigation.speedOverGround"] }))
          .structuredContent.measurements[0].value,
        0,
      );
    } else {
      assert.equal(info.structuredContent.available, true);
      const result = await call("execute_capability", pluginArgs, {
        Forwarded: "host=attacker.invalid;proto=http",
        "X-Forwarded-Host": "attacker.invalid",
        "X-Forwarded-Port": "1",
        "X-Forwarded-Proto": "http",
        "X-Original-URL": "http://attacker.invalid/steal",
        Cookie: "unrelated=synthetic",
      });
      assert.deepEqual(result.structuredContent.data, {
        principal: "reader",
        name: "speed",
        value: 42,
        cookieSeen: false,
      });
      const history = await call("get_history", {
        from: "2026-10-17T10:00:00Z",
        to: "2026-10-17T10:01:00Z",
        paths: [{ path: "navigation.speedOverGround", source: "fixture.XX" }],
      });
      assert.equal(history.structuredContent.data[0][1], 0);
      const fixture = loadedPlugin(server, "mcp-fixture");
      const before = fixture.testCalls.disconnected;
      const held = fixture.holdNextRead("plugin");
      const pending = send("tools/call", {
        name: "execute_capability",
        arguments: pluginArgs,
      });
      pending.result.catch(() => {});
      try {
        await Promise.race([
          held.started,
          pending.result.then(() => {
            throw new Error("Provider was not held");
          }),
        ]);
        pending.request.destroy();
        for (
          let attempt = 0;
          attempt < 100 && fixture.testCalls.disconnected === before;
          attempt++
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(
          fixture.testCalls.disconnected,
          before + 1,
          "disconnect must cancel the upstream socket",
        );
      } finally {
        held.release();
      }
    }
    assert.equal(
      (
        await send(
          "tools/list",
          {},
          { Host: "attacker.invalid", "X-Forwarded-Host": host },
        ).result
      ).status,
      403,
    );
    assert.equal(
      (
        await send(
          "tools/list",
          {},
          { Origin: "https://attacker.invalid", "X-Forwarded-Proto": "https" },
        ).result
      ).status,
      403,
    );
    const unavailable = localGet(
      { socket: { localAddress: "127.0.0.1", localPort: await freePort() } },
      `Bearer ${token}`,
      new AbortController().signal,
    );
    await assert.rejects(
      unavailable("/plugins/mcp-fixture/reading/speed"),
      /UPSTREAM_UNAVAILABLE/,
    );
    await assert.rejects(
      localGet(
        { socket: {} },
        `Bearer ${token}`,
        new AbortController().signal,
      )("/plugins/mcp-fixture/reading/speed"),
      /LOCAL_HTTP_UNAVAILABLE/,
    );
  } finally {
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise((resolve) => proxy.close(resolve));
    }
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// Signal K retains upstream handles after stop; assertions finish before exit.
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
