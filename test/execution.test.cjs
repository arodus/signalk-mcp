const { Buffer } = require("node:buffer");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { executeCode } = require("../dist/execution.js");
const { configSchema } = require("../dist/config.js");
const { createMcpServer } = require("../dist/mcp.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const image = `local/worker@sha256:${"a".repeat(64)}`;
function fixture() {
  const principal = { identifier: "admin", permissions: "admin" };
  let allowed = true;
  const calls = [];
  const app = {
    securityStrategy: {
      isDummy: () => false,
      authorizeWS: (c) => {
        c.skIsAuthenticated = true;
        c.skPrincipal = principal;
      },
      checkACL: (_, context, path, source, operation) =>
        allowed &&
        context === "vessels.self" &&
        path === "navigation.speedOverGround" &&
        source === "fixture" &&
        operation === "read",
    },
    getSelfPath: () => ({
      value: 0,
      $source: "fixture",
      timestamp: "2026-11-20T00:00:00Z",
      meta: { units: "m/s" },
    }),
  };
  const result = {
    id: "job",
    status: "completed",
    exitCode: 0,
    oomKilled: false,
    cleanup: "removed",
    output: Buffer.from('{"value":0}'),
  };
  globalThis.__signalk_containerManager = {
    runSandboxJob: async (...args) => {
      calls.push(args);
      return result;
    },
  };
  const config = configSchema.parse({
    experimentalExecution: { enabled: true, image },
  });
  const input = {
    code: "return data.measurements[0].value",
    paths: ["navigation.speedOverGround"],
  };
  const controller = new AbortController();
  return {
    app,
    principal,
    calls,
    result,
    config,
    input,
    controller,
    deny: () => {
      allowed = false;
    },
    run: (args = input) =>
      executeCode(
        app,
        "Bearer secret",
        config,
        () => true,
        args,
        controller.signal,
      ),
  };
}
test("disabled configuration and old manager fail closed", async () => {
  const f = fixture();
  assert.equal(configSchema.parse({}).experimentalExecution.enabled, false);
  assert.equal(
    configSchema.safeParse({ experimentalExecution: { enabled: true } })
      .success,
    false,
  );
  f.config.experimentalExecution.enabled = false;
  await assert.rejects(f.run(), /EXECUTION_DISABLED/);
  f.config.experimentalExecution.enabled = true;
  globalThis.__signalk_containerManager = {
    runJob: () => assert.fail("must not fall back"),
  };
  await assert.rejects(f.run(), /EXECUTION_UNAVAILABLE/);
  assert.equal(f.calls.length, 0);
});
test("snapshot preserves zero, unit, source and timestamp without credentials", async () => {
  const f = fixture();
  const result = await f.run();
  const [request, options] = f.calls[0];
  const envelope = JSON.parse(Buffer.from(request.stdin).toString());
  assert.equal(envelope.version, 1);
  assert.equal(envelope.data.measurements[0].value, 0);
  assert.equal(envelope.data.measurements[0].unit, "m/s");
  assert.equal(envelope.data.measurements[0].source, "fixture");
  assert.equal(envelope.data.measurements[0].timestamp, "2026-11-20T00:00:00Z");
  assert.equal(Buffer.from(request.stdin).includes("secret"), false);
  assert.equal(request.runnerPath, "/usr/local/bin/signalk-mcp-worker");
  assert.equal(options.signal, f.controller.signal);
  assert.equal(result.retrySafe, false);
  assert.equal(Buffer.from(result.output, "base64").toString(), '{"value":0}');
});
test("denied identities, paths, policy overrides and oversized snapshots dispatch nothing", async () => {
  for (const alter of [
    (f) => {
      f.principal.permissions = "readonly";
    },
    (f) => f.deny(),
    (f) => {
      f.input.image = image;
    },
    (f) => {
      f.app.getSelfPath = () => ({
        value: "x".repeat(1024 * 1024),
        $source: "fixture",
      });
    },
    (f) => f.controller.abort(),
  ]) {
    const f = fixture();
    alter(f);
    await assert.rejects(f.run());
    assert.equal(f.calls.length, 0);
  }
});
test("revocation and principal replacement suppress results after dispatch", async () => {
  for (const revoke of [
    (f) => f.deny(),
    (f) => {
      f.principal.identifier = "different-admin";
    },
    (f) => f.controller.abort(),
  ]) {
    const f = fixture();
    globalThis.__signalk_containerManager.runSandboxJob = async () => {
      revoke(f);
      return f.result;
    };
    await assert.rejects(f.run());
  }
});
test("uncertain failures are sanitized and never retried", async () => {
  const f = fixture();
  let count = 0;
  globalThis.__signalk_containerManager.runSandboxJob = async () => {
    count++;
    throw new Error("private daemon detail");
  };
  const response = await f.run();
  assert.equal(response.outcome, "unknown");
  assert.equal(response.retrySafe, false);
  assert.equal(JSON.stringify(response).includes("private"), false);
  assert.equal(count, 1);
});
test("MCP tool is opt-in, non-idempotent and can carry maximum bounded binary output", async () => {
  for (const enabled of [false, true]) {
    const f = fixture();
    f.config.experimentalExecution.enabled = enabled;
    const server = createMcpServer(
      f.app,
      "Bearer secret",
      f.config,
      () => true,
    );
    const client = new Client({ name: "execution-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const tool = (await client.listTools()).tools.find(
        (t) => t.name === "execute_code",
      );
      assert.equal(!!tool, enabled);
      if (enabled) {
        assert.equal(tool.annotations.idempotentHint, false);
        f.result.output = Buffer.alloc(256 * 1024, 255);
        const response = await client.callTool({
          name: "execute_code",
          arguments: f.input,
        });
        assert.equal(response.isError, undefined);
        assert.equal(
          Buffer.from(response.structuredContent.output, "base64").length,
          256 * 1024,
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  }
});
