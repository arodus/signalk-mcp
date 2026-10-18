// Isolated native-server process. Credentials travel only over private test IPC.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { loadedPlugin } = require("./native-server.cjs");
const { start } = require("./runtime-fixture.cjs");
const serverRequire = createRequire(
  process.env.MCP_TEST_SERVER_DIR
    ? path.join(process.env.MCP_TEST_SERVER_DIR, "package.json")
    : require.resolve("signalk-server/package.json"),
);
async function main() {
  const directory = process.argv[2];
  let server, dir, tokens;
  if (directory) {
    dir = directory;
    process.env.SIGNALK_NODE_CONFIG_DIR = dir;
    process.env.SIGNALK_DISABLE_SERVER_UPDATES = "true";
    process.env.HTTP_RATE_LIMITS = "api=100000,loginStatus=100000,login=100000";
    process.env.NODE_ENV = "test";
    const Server = serverRequire("./");
    const config = JSON.parse(
      fs.readFileSync(path.join(dir, "restart-config.json"), "utf8"),
    );
    // Load the existing security.json through the native security loader.
    server = new Server({ config });
    await server.start();
  } else {
    ({ server, dir, tokens } = await start());
    fs.writeFileSync(
      path.join(dir, "security.json"),
      JSON.stringify(server.app.securityStrategy.getConfiguration()),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(dir, "restart-config.json"),
      JSON.stringify({
        settings: server.app.config.settings,
        defaults: {
          vessels: { self: { uuid: "urn:mrn:signalk:uuid:runtime-fixture" } },
        },
      }),
    );
  }
  let held;
  process.on("message", async ({ command, id, value }) => {
    try {
      let report = {};
      if (command === "seed") {
        server.app.handleMessage("fixture", {
          context: "vessels.self",
          updates: [
            {
              source: { label: "fixture" },
              timestamp: new Date().toISOString(),
              values: [{ path: "navigation.speedOverGround", value }],
            },
          ],
        });
      } else if (command === "hold") {
        held = loadedPlugin(server, "mcp-fixture").holdNextRead("plugin");
        held.started.then(() => process.send({ type: "provider-started" }));
      } else if (command === "stop-server") {
        const plugin = loadedPlugin(server, "signalk-mcp");
        const stop = plugin.stop.bind(plugin);
        let pluginStopCalls = 0;
        plugin.stop = async () => {
          pluginStopCalls++;
          return stop();
        };
        await server.stop();
        report = { pluginStopCalls };
      } else throw new Error("Unknown fixture command");
      process.send({ type: "reply", id, ...report });
    } catch (error) {
      process.send({ type: "reply", id, error: error.message });
    }
  });
  process.send({
    type: "ready",
    dir,
    tokens,
    endpoint: `http://127.0.0.1:${server.app.config.settings.port}/plugins/signalk-mcp/mcp`,
    version: serverRequire("./package.json").version,
  });
}
main().catch((error) => {
  process.send?.({ type: "failure", error: error.message });
  process.exitCode = 1;
});
