const { loadedPlugin } = require("./native-server.cjs");
// Opt-in synthetic development benchmark. No domain calculations enter the plugin.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { fork } = require("node:child_process");
const { performance, monitorEventLoopDelay } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");
const { setInterval, clearInterval, clearTimeout } = require("node:timers");
const { start } = require("./runtime-fixture.cjs");
const percentile = (samples, p) =>
  [...samples].sort((a, b) => a - b)[
    Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)
  ] ?? 0;
const memory = () => {
  const { heapUsed, rss } = process.memoryUsage();
  return { heapUsed, rss };
};
async function measure(fixture, paths, load) {
  const latency = [],
    telemetryDelay = [],
    telemetryProcessing = [];
  const active = new Set();
  let requests = 0,
    errors = 0,
    skipped = 0,
    telemetryErrors = 0,
    tickValue = 0,
    peakRss = process.memoryUsage().rss;
  let previous = performance.now();
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const tick = setInterval(() => {
    const now = performance.now();
    telemetryDelay.push(Math.max(0, now - previous - 100));
    previous = now;
    try {
      fixture.seed([
        { path: "navigation.speedOverGround", value: ++tickValue },
      ]);
      assert.equal(
        fixture.server.app.signalk.self.navigation.speedOverGround.value,
        tickValue,
      );
    } catch {
      telemetryErrors++;
    }
    telemetryProcessing.push(performance.now() - now);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 100);
  const before = process.cpuUsage();
  const began = performance.now();
  try {
    for (let i = 0; i < 600; i++) {
      await delay(Math.max(0, began + i * 50 - performance.now()));
      if (!load) continue;
      if (active.size >= 4) {
        skipped++;
        continue;
      }
      const sent = performance.now();
      const pending = fixture
        .request("get_values", { paths })
        .result.then((reply) => {
          assert.equal(reply.status, 200);
          assert.equal(reply.body.result.isError, undefined);
          assert.equal(
            reply.body.result.structuredContent.measurements.length,
            64,
          );
          requests++;
          latency.push(performance.now() - sent);
        })
        .catch(() => {
          errors++;
        })
        .finally(() => active.delete(pending));
      active.add(pending);
    }
    await delay(Math.max(0, began + 30000 - performance.now()));
    await Promise.all(active);
  } finally {
    clearInterval(tick);
    histogram.disable();
  }
  const elapsedMs = performance.now() - began;
  const cpu = process.cpuUsage(before);
  return {
    elapsedMs,
    requests,
    errors,
    skipped,
    telemetryUpdates: tickValue,
    telemetryErrors,
    peakRss,
    cpuOneCorePercent: (cpu.user + cpu.system) / (elapsedMs * 10),
    readP95Ms: percentile(latency, 0.95),
    readP99Ms: percentile(latency, 0.99),
    telemetryLoopP99Ms: percentile(telemetryDelay, 0.99),
    telemetryProcessingP99Ms: percentile(telemetryProcessing, 0.99),
    eventLoopP99Ms: histogram.percentile(99) / 1e6,
    eventLoopMaxMs: histogram.max / 1e6,
  };
}
async function benchmark() {
  assert.equal(
    typeof globalThis.gc,
    "function",
    "run through this script's parent driver",
  );
  const fixture = await start();
  try {
    const values = Array.from({ length: 1000 }, (_, i) => ({
      path: `navigation.fixture.n${i}`,
      value: i,
    }));
    fixture.seed(values);
    const paths = values.slice(0, 64).map((entry) => entry.path);
    for (let n = 0; n < 50; n++)
      await fixture.request("get_values", { paths }).result;
    await delay(1000);
    globalThis.gc();
    globalThis.gc();
    const before = memory();
    const baseline = await measure(fixture, paths, false);
    const load = await measure(fixture, paths, true);
    await delay(1000);
    globalThis.gc();
    globalThis.gc();
    const after = memory();
    const heapGrowth = after.heapUsed - before.heapUsed;
    const gates = {
      allRequests:
        load.requests === 600 && load.errors === 0 && load.skipped === 0,
      telemetry:
        baseline.telemetryErrors === 0 &&
        load.telemetryErrors === 0 &&
        baseline.telemetryUpdates > 0 &&
        load.telemetryUpdates > 0,
      readP95: load.readP95Ms <= 250,
      telemetryLoopP99: load.telemetryLoopP99Ms <= 100,
      retainedHeap: heapGrowth <= 16 * 1024 * 1024,
    };
    await loadedPlugin(fixture.server, "signalk-mcp").stop();
    await fixture.stop();
    process.send({
      date: new Date().toISOString(),
      target: "local development baseline, not Raspberry Pi acceptance",
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      cpu: os.cpus()[0].model,
      logicalCpus: os.cpus().length,
      totalMemory: os.totalmem(),
      node: process.version,
      signalk: fixture.version,
      workload: {
        modelLeaves: 1001,
        pathsPerRead: 64,
        requestsPerSecond: 20,
        maxConcurrent: 4,
        phaseSeconds: 30,
        telemetryHz: 10,
      },
      scope:
        "Combined native server and local HTTP client process; synthetic data only",
      thresholds: {
        readP95Ms: 250,
        telemetryLoopP99Ms: 100,
        retainedHeapBytes: 16 * 1024 * 1024,
      },
      baseline,
      load,
      memory: { before, after, heapGrowth },
      gates,
    });
    process.disconnect();
  } finally {
    fixture.remove();
  }
}
if (process.argv[2] === "--child") {
  benchmark().catch((error) => {
    process.send?.({ error: error.stack });
    process.disconnect?.();
    process.exitCode = 1;
  });
} else {
  const output = process.argv[2];
  assert.ok(output, "Pass an output JSON path");
  let report, grace;
  const child = fork(
    require("node:path").join(__dirname, "runtime-benchmark.cjs"),
    ["--child"],
    {
      execArgv: ["--expose-gc"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  const watchdog = setTimeout(() => {
    child.kill("SIGKILL");
    process.exitCode = 1;
  }, 85000);
  child.on("message", (value) => {
    report = value;
    grace = setTimeout(() => child.kill(), 1500);
  });
  child.on("exit", (code, signal) => {
    clearTimeout(watchdog);
    clearTimeout(grace);
    assert.ok(report, "Benchmark failed to report");
    fs.writeFileSync(
      output,
      JSON.stringify(
        { ...report, naturalExit: signal === null && code === 0 },
        null,
        2,
      ) + "\n",
    );
    if (report.error || !Object.values(report.gates).every(Boolean))
      process.exitCode = 1;
  });
}
