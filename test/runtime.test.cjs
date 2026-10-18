const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const path = require("node:path");
const { clearTimeout } = require("node:timers");
function run(mode) {
  return new Promise((resolve, reject) => {
    let report;
    let stage = "starting";
    let grace;
    const child = fork(path.join(__dirname, "runtime-child.cjs"), [mode], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout.resume();
    child.stderr.resume();
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`${mode} did not report within 35s; last stage: ${stage}`),
      );
    }, 35000);
    child.on("message", (message) => {
      if (message.type === "progress") {
        stage = message.stage;
        return;
      }
      if (message.type === "failure") {
        child.kill();
        reject(new Error(message.message));
      } else {
        report = message;
        // Assertions and provenance capture finish first. This watchdog exposes
        // upstream survivors explicitly instead of using test-force-exit.
        grace = setTimeout(() => child.kill(), 1500);
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(watchdog);
      clearTimeout(grace);
      if (report)
        resolve({ ...report, naturalExit: signal === null && code === 0 });
      else reject(new Error(`${mode} exited before reporting`));
    });
  });
}
test(
  "native lifecycle: repeated cancellation/stop/timeouts release gateway resources",
  { timeout: 60000 },
  async (t) => {
    const baseline = await run("baseline");
    const loaded = await run("gateway");
    assert.equal(loaded.cycles, 12);
    const signature = (entry) => `${entry.type}:${entry.stack[0]}`;
    const counts = (entries) =>
      entries.reduce((result, entry) => {
        const key = signature(entry);
        result[key] = (result[key] ?? 0) + 1;
        return result;
      }, {});
    const reference = counts(baseline.active);
    for (const [origin, count] of Object.entries(counts(loaded.active)))
      assert.ok(
        count <= (reference[origin] ?? 0),
        `Additional surviving handle: ${origin}`,
      );
    t.diagnostic(
      JSON.stringify({
        baselineNaturalExit: baseline.naturalExit,
        gatewayNaturalExit: loaded.naturalExit,
        residualOrigins: reference,
      }),
    );
  },
);
