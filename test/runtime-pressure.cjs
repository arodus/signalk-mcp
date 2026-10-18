// Opt-in, synthetic large-value recovery measurements in a capped child process.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { fork } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const { clearTimeout } = require("node:timers");
const { loadedPlugin } = require("./native-server.cjs");
const { start } = require("./runtime-fixture.cjs");
function memory() {
  globalThis.gc();
  globalThis.gc();
  return {
    ...process.memoryUsage(),
    peakRss: process.resourceUsage().maxRSS * 1024,
  };
}
async function child() {
  const fixture = await start();
  try {
    const report = {
      date: new Date().toISOString(),
      node: process.version,
      signalk: fixture.version,
      platform: process.platform,
      architecture: process.arch,
      cpu: os.cpus()[0].model,
      maxOldSpaceMiB: 384,
      scope: "Synthetic native model values; combined server and HTTP client",
      cases: [],
    };
    for (const [name, value, count, expected] of [
      ["small", "x".repeat(1024), 64, undefined],
      ["large-string", "x".repeat(8 * 1024 * 1024), 1, "OUTPUT_LIMIT"],
      ["repeated-large-value", "x".repeat(1024 * 1024), 64, "OUTPUT_LIMIT"],
      ["escaped-value", "\u0000".repeat(128 * 1024), 1, "OUTPUT_LIMIT"],
      [
        "wide-object",
        Object.fromEntries(
          Array.from({ length: 30000 }, (_, n) => [`key${n}`, n]),
        ),
        1,
        "OUTPUT_LIMIT",
      ],
    ]) {
      const values = Array.from({ length: count }, (_, n) => ({
        path: `navigation.pressure.n${n}`,
        value,
      }));
      fixture.seed(values);
      const paths = values.map(({ path }) => path);
      await fixture.request("get_values", { paths }).result;
      await delay(100);
      const before = memory();
      const latencies = [];
      for (let i = 0; i < 20; i++) {
        const began = performance.now();
        const response = await fixture.request("get_values", { paths }).result;
        latencies.push(performance.now() - began);
        assert.equal(response.status, 200);
        assert.equal(response.body.result.isError, expected ? true : undefined);
        if (expected)
          assert.equal(response.body.result.content[0].text, expected);
        const [read, denied] = await Promise.all([
          fixture.request("get_values", {
            paths: ["navigation.speedOverGround"],
          }).result,
          fixture.request("get_values", { paths }, "other").result,
        ]);
        assert.equal(
          read.body.result.structuredContent.measurements[0].value,
          0,
        );
        assert.ok(
          denied.body.result.structuredContent.measurements.every(
            (entry) => entry.status === "unavailable",
          ),
        );
      }
      await delay(100);
      const after = memory();
      report.cases.push({
        name,
        paths: count,
        iterations: 20,
        expected: expected ?? "success",
        before,
        after,
        heapGrowth: after.heapUsed - before.heapUsed,
        maxReadMs: Math.max(...latencies),
        readP95Ms: [...latencies].sort((a, b) => a - b)[18],
        recoveryAndDenialPassed: true,
      });
      fixture.seed(values.map(({ path }) => ({ path, value: null })));
    }
    await loadedPlugin(fixture.server, "signalk-mcp").stop();
    await fixture.stop();
    process.send({ report });
    process.disconnect();
  } finally {
    fixture.remove();
  }
}
if (process.argv[2] === "--child") {
  child().catch((error) => {
    process.send?.({ error: error.stack });
    process.disconnect?.();
    process.exitCode = 1;
  });
} else {
  const output = process.argv[2];
  assert.ok(output, "Pass an output JSON path");
  let report, grace;
  const worker = fork(
    path.join(__dirname, "runtime-pressure.cjs"),
    ["--child"],
    {
      execArgv: ["--expose-gc", "--max-old-space-size=384"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  const watchdog = setTimeout(() => {
    worker.kill("SIGKILL");
    process.exitCode = 1;
  }, 120000);
  worker.on("message", (message) => {
    report = message;
    grace = setTimeout(() => worker.kill(), 1500);
  });
  worker.on("exit", (code, signal) => {
    clearTimeout(watchdog);
    clearTimeout(grace);
    fs.writeFileSync(
      output,
      JSON.stringify(
        {
          ...(report?.report ?? {
            error: report?.error ?? "child exited without a report",
          }),
          naturalExit: signal === null && code === 0,
          exit: { code, signal },
        },
        null,
        2,
      ) + "\n",
    );
    if (!report?.report) process.exitCode = 1;
  });
}
