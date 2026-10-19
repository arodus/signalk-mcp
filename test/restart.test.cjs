const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { clearTimeout } = require("node:timers");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
function message(child, predicate) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", received);
      child.off("exit", exited);
    };
    const received = (data) => {
      if (data.type === "failure" || data.error) {
        cleanup();
        reject(new Error(data.error));
      } else if (predicate(data)) {
        cleanup();
        resolve(data);
      }
    };
    const exited = () => {
      cleanup();
      reject(new Error("Server exited before expected reply"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Server IPC deadline exceeded"));
    }, 10000);
    child.on("message", received);
    child.once("exit", exited);
  });
}
test(
  "same MCP clients reconnect across three full native process replacements with persisted permissions",
  { timeout: 45000 },
  async (t) => {
    let child,
      dir,
      serial = 0;
    const clients = [];
    const terminate = async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
      const exited = once(child, "exit", { signal: AbortSignal.timeout(3000) });
      child.kill("SIGTERM");
      await exited;
    };
    t.after(async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
      try {
        await terminate();
      } finally {
        if (child?.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    const boot = async () => {
      child = fork(
        path.join(__dirname, "restart-child.cjs"),
        dir ? [dir] : [],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      child.stdout.resume();
      child.stderr.resume();
      const ready = await message(child, (data) => data.type === "ready");
      dir = ready.dir;
      if (process.env.MCP_TEST_SERVER_VERSION)
        assert.equal(ready.version, process.env.MCP_TEST_SERVER_VERSION);
      return ready;
    };
    const command = (name, value) => {
      const id = ++serial;
      const reply = message(
        child,
        (data) => data.type === "reply" && data.id === id,
      );
      child.send({ command: name, value, id });
      return reply;
    };
    const first = await boot();
    const initialConfig = fs.readFileSync(
      path.join(dir, "plugin-config-data/signalk-mcp.json"),
      "utf8",
    );
    for (const identity of ["reader", "other"]) {
      const client = new Client({ name: `restart-${identity}`, version: "1" });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(first.endpoint), {
          requestInit: {
            headers: { Authorization: `Bearer ${first.tokens[identity]}` },
          },
        }),
      );
    }
    const read = (client) =>
      client.callTool({
        name: "get_values",
        arguments: { paths: ["navigation.speedOverGround"] },
      });
    for (let generation = 0; generation <= 3; generation++) {
      await command("seed", generation);
      const [allowed, denied] = await Promise.all(clients.map(read));
      assert.equal(allowed.structuredContent.measurements[0].value, generation);
      assert.deepEqual(denied.structuredContent.measurements[0], {
        path: "navigation.speedOverGround",
        status: "unavailable",
      });
      assert.equal((await clients[0].listTools()).tools.length, 14);
      assert.equal(
        fs.readFileSync(
          path.join(dir, "plugin-config-data/signalk-mcp.json"),
          "utf8",
        ),
        initialConfig,
      );
      if (generation === 3) break;
      await command("hold");
      const entered = message(
        child,
        (data) => data.type === "provider-started",
      );
      const pending = clients[0]
        .callTool({
          name: "execute_capability",
          arguments: {
            id: "plugin.mcp-fixture",
            operation: "readReading",
            arguments: { name: "speed" },
          },
        })
        .then(
          () => false,
          () => true,
        );
      await entered;
      await terminate();
      assert.equal(
        await pending,
        true,
        "in-flight read must fail when its server process exits",
      );
      await assert.rejects(read(clients[0]));
      const next = await boot();
      assert.equal(next.endpoint, first.endpoint);
      // Reuse the original Client/transport/bearer; no new credentials or manual reconnect.
    }
    const shutdown = await command("stop-server");
    await assert.rejects(read(clients[0]));
    t.diagnostic(
      JSON.stringify({
        replacements: 3,
        clientReuse: true,
        persistedSecurity: true,
        nativeStopPluginCalls: shutdown.pluginStopCalls,
        scope: "Process replacement; not proof of complete in-process cleanup",
      }),
    );
  },
);
