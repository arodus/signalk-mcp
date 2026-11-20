const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { start } = require("./put-native-fixture.cjs");

const input = {
  code: "return data.measurements[0].value + 2",
  paths: ["navigation.speedOverGround"],
};
async function prepare() {
  const f = await start({ telemetryReaders: ["writer", "admin"] });
  f.server.app.handleMessage("fixture", {
    context: "vessels.self",
    updates: [
      {
        source: { label: "fixture" },
        timestamp: new Date().toISOString(),
        values: [{ path: "navigation.speedOverGround", value: 0 }],
      },
    ],
  });
  const settings = await f.readConfig();
  settings.configuration.experimentalExecution = {
    enabled: true,
    image:
      process.env.MCP_EXECUTION_TEST_IMAGE ||
      `local/worker@sha256:${"a".repeat(64)}`,
  };
  await f.saveConfig(settings);
  return f;
}

test(
  "native execution uses saved enablement and native identity; ordinary reads survive an absent runtime",
  { timeout: 60000 },
  async () => {
    const f = await prepare();
    const old = globalThis.__signalk_containerManager;
    let calls = 0;
    let snapshot;
    try {
      globalThis.__signalk_containerManager = {
        runSandboxJob: async (request) => {
          calls++;
          const envelope = JSON.parse(Buffer.from(request.stdin).toString());
          snapshot = envelope.data;
          return {
            id: "native-fixture",
            status: "completed",
            exitCode: 0,
            oomKilled: false,
            output: Buffer.from('{"version":1,"value":2}\n'),
            cleanup: "removed",
          };
        },
      };
      const denied = await f.call("execute_code", input, "reader");
      assert.equal(denied.isError, true);
      assert.equal(calls, 0);
      const result = await f.call("execute_code", input, "admin");
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.equal(result.structuredContent.status, "completed");
      assert.equal(calls, 1);
      assert.equal(snapshot.measurements[0].value, 0);
      delete globalThis.__signalk_containerManager;
      const missing = await f.call("execute_code", input, "admin");
      assert.equal(missing.content[0].text, "EXECUTION_UNAVAILABLE");
      const read = await f.call("get_values", { paths: input.paths }, "writer");
      assert.equal(read.structuredContent.measurements[0].value, 0);
      assert.equal(
        snapshot.measurements[0].source,
        read.structuredContent.measurements[0].source,
      );
    } finally {
      globalThis.__signalk_containerManager = old;
      await f.stop();
      f.remove();
    }
  },
);

test(
  "opt-in native MCP to real Container Manager executor and Docker",
  {
    skip:
      !process.env.MCP_EXECUTION_TEST_IMAGE ||
      !process.env.MCP_CONTAINER_TEST_DIR,
    timeout: 90000,
  },
  async () => {
    const { pathToFileURL } = require("node:url");
    const path = require("node:path");
    const root = process.env.MCP_CONTAINER_TEST_DIR;
    const { SandboxExecutor } = await import(
      pathToFileURL(path.join(root, "dist/sandbox-executor.js")).href
    );
    const { detectRuntime } = await import(
      pathToFileURL(path.join(root, "dist/runtime.js")).href
    );
    assert.ok(await detectRuntime("docker"));
    const executor = new SandboxExecutor();
    const old = globalThis.__signalk_containerManager;
    const f = await prepare();
    const results = [];
    globalThis.__signalk_containerManager = {
      runSandboxJob: async (request, options) => {
        const result = await executor.run(request, options.signal);
        results.push(result);
        return result;
      },
    };
    try {
      const denied = await f.call("execute_code", input, "reader");
      assert.equal(denied.isError, true);
      assert.equal(results.length, 0);
      const success = await f.call("execute_code", input, "admin");
      assert.equal(success.isError, undefined, JSON.stringify(success));
      assert.equal(
        success.structuredContent.status,
        "completed",
        JSON.stringify(success),
      );
      assert.equal(success.structuredContent.cleanup, "removed");
      assert.deepEqual(
        JSON.parse(
          Buffer.from(success.structuredContent.output, "base64").toString(),
        ),
        { version: 1, value: 2 },
      );
      const failure = await f.call(
        "execute_code",
        { ...input, code: 'throw new Error("private")' },
        "admin",
      );
      assert.equal(failure.structuredContent.status, "failed");
      assert.equal(failure.structuredContent.cleanup, "removed");
      const overflow = await f.call(
        "execute_code",
        {
          ...input,
          code: 'process.stdout.write("x".repeat(512*1024)); await new Promise(()=>{})',
        },
        "admin",
      );
      assert.equal(overflow.structuredContent.status, "output-limit");
      assert.equal(overflow.structuredContent.cleanup, "removed");
      const deadline = await f.call(
        "execute_code",
        { ...input, code: "while(true) {}" },
        "admin",
      );
      assert.equal(deadline.structuredContent.status, "failed");
      assert.equal(deadline.structuredContent.exitCode, 137);
      assert.equal(deadline.structuredContent.cleanup, "removed");
      // A disconnected native HTTP request must abort the executing container.
      const { setTimeout: delay } = require("node:timers/promises");
      const cancellation = new AbortController();
      const pending = fetch(`${f.baseUrl}/plugins/signalk-mcp/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.tokens.admin}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: {
            name: "execute_code",
            arguments: { ...input, code: "while(true) {}" },
          },
        }),
        signal: cancellation.signal,
      }).catch(() => undefined);
      await delay(750);
      cancellation.abort();
      await pending;
      for (let attempt = 0; attempt < 100 && results.length < 5; attempt++)
        await delay(50);
      assert.equal(results.length, 5);
      assert.equal(results[4].status, "cancelled");
      assert.equal(results[4].cleanup, "removed");
      const read = await f.call("get_values", { paths: input.paths }, "writer");
      assert.equal(read.structuredContent.measurements[0].value, 0);
    } finally {
      globalThis.__signalk_containerManager = old;
      await f.stop();
      f.remove();
    }
  },
);
