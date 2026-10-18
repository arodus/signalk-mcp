const { loadedPlugin } = require("./native-server.cjs");
const assert = require("node:assert/strict");
const { createHook } = require("node:async_hooks");
const {
  setTimeout: delay,
  setImmediate: immediate,
} = require("node:timers/promises");
const { start } = require("./runtime-fixture.cjs");
const mode = process.argv[2];
Error.stackTraceLimit = 30;
const resources = new Map();
const hook = createHook({
  init(id, type, trigger, resource) {
    if (!["Timeout", "TCPSERVERWRAP", "TCPWRAP"].includes(type)) return;
    const fullStack = new Error().stack;
    const stack = fullStack
      .split("\n")
      .filter(
        (line) =>
          !line.includes("node:") &&
          !line.includes("runtime-child.cjs") &&
          !line.includes("Error"),
      );
    resources.set(id, {
      type,
      resource: new globalThis.WeakRef(resource),
      stack,
      fullStack,
    });
  },
  destroy(id) {
    resources.delete(id);
  },
});
hook.enable();
const pluginArgs = {
  id: "plugin.mcp-fixture",
  operation: "readReading",
  arguments: { name: "speed" },
};
async function main() {
  const fixture = await start(mode !== "baseline");
  let cycles = 0;
  try {
    if (mode !== "baseline") {
      const plugin = loadedPlugin(fixture.server, "signalk-mcp");
      const provider = loadedPlugin(fixture.server, "mcp-fixture");
      const read = () =>
        fixture.request("get_values", { paths: ["navigation.speedOverGround"] })
          .result;
      for (let cycle = 0; cycle < 12; cycle++) {
        process.send({ type: "progress", stage: `cycle ${cycles} start` });
        const held = provider.holdNextRead("plugin");
        const pending = fixture.request("execute_capability", pluginArgs);
        pending.result.catch(() => {});
        await held.started;
        process.send({
          type: "progress",
          stage: `cycle ${cycles} provider entered`,
        });
        const before = provider.testCalls.disconnected;
        if (cycle % 2) pending.cancel();
        else await plugin.stop();
        process.send({
          type: "progress",
          stage: `cycle ${cycles} stop returned`,
        });
        await Promise.race([
          pending.result.catch(() => {}),
          delay(1000).then(() => {
            throw new Error(
              "Client connection survived cancellation/stop for 1s",
            );
          }),
        ]);
        for (
          let n = 0;
          n < 100 && provider.testCalls.disconnected === before;
          n++
        )
          await delay(10);
        assert.equal(
          provider.testCalls.disconnected,
          before + 1,
          "provider socket must close",
        );
        held.release();
        if (!(cycle % 2)) {
          assert.equal((await read()).status, 503);
          plugin.start(fixture.configuration);
        }
        const [allowed, denied] = await Promise.all([
          read(),
          fixture.request(
            "get_values",
            { paths: ["navigation.speedOverGround"] },
            "other",
          ).result,
        ]);
        assert.equal(
          allowed.body.result.structuredContent.measurements[0].value,
          0,
        );
        assert.deepEqual(denied.body.result.structuredContent.measurements[0], {
          path: "navigation.speedOverGround",
          status: "unavailable",
        });
        cycles++;
      }
      // Fill the real transport's eight slots and recover them on disconnect.
      const saturated = [];
      try {
        for (let n = 0; n < 8; n++) {
          const held = provider.holdNextRead("plugin");
          const pending = fixture.request("execute_capability", pluginArgs);
          pending.result.catch(() => {});
          saturated.push({ held, pending });
          await held.started;
        }
        const busy = await read();
        assert.equal(busy.status, 429);
        assert.equal(busy.body.error, "BUSY");
      } finally {
        for (const { pending } of saturated) pending.cancel();
        await Promise.allSettled(
          saturated.map(({ pending }) => pending.result),
        );
        for (const { held } of saturated) held.release();
      }
      await delay(50);
      assert.equal((await read()).status, 200);
      // Real HTTP deadline, twice, to check recovery after repeated slow reads.
      for (let n = 0; n < 2; n++) {
        const held = provider.holdNextRead("plugin");
        const pending = fixture.request("execute_capability", pluginArgs);
        await held.started;
        try {
          assert.equal(
            (await pending.result).body.result.content[0].text,
            "UPSTREAM_UNAVAILABLE",
          );
        } finally {
          held.release();
        }
        assert.equal(
          (await read()).body.result.structuredContent.measurements[0].value,
          0,
        );
      }
      await plugin.stop();
    }
    await fixture.stop();
    // Node's HTTP Date-header cache creates an unreferenced timer until the
    // next second boundary, sometimes on an MCP response stack. Let that
    // native cache expire before asserting ownership; do not clear any timer.
    await delay(1100);
    await immediate();
    const remaining = [...resources.values()].filter((entry) => {
      const resource = entry.resource.deref();
      return resource && resource._destroyed !== true;
    });
    const active = remaining
      .filter((entry) => entry.resource.deref()?.hasRef?.() === true)
      .map(({ type, stack }) => ({ type, stack }));
    const owned = remaining.filter((entry) =>
      entry.stack.some(
        (line) =>
          (line.includes("/dist/index.js") &&
            !line.includes("/node_modules/")) ||
          line.includes("/dist/capabilities/http.js"),
      ),
    );
    assert.deepEqual(
      owned.map(({ type, resource, fullStack }) => ({
        type,
        fullStack,
        timeout: resource.deref()?._idleTimeout,
        referenced: resource.deref()?.hasRef?.(),
      })),
      [],
      "gateway-owned resources must be gone before child termination",
    );
    hook.disable();
    process.send({
      type: "report",
      mode,
      version: fixture.version,
      cycles,
      active,
    });
    process.disconnect();
  } finally {
    fixture.remove();
  }
}
main().catch((error) => {
  process.send?.({ type: "failure", message: error.stack });
  process.exitCode = 1;
  process.disconnect?.();
});
