// Optional tests of installed product runtimes, never a model invocation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { clearTimeout } = require("node:timers");
const { createInterface } = require("node:readline");
const exec = promisify(execFile);
const serverName = "signalk_fixture";
const paths = [
  "navigation.speedOverGround",
  "electrical.batteries.house.voltage",
];
function checkValues(result) {
  const values = result.structuredContent.measurements;
  assert.equal(values[0].value, 0);
  assert.equal(values[0].unit, "m/s");
  assert.deepEqual(values[1], { path: paths[1], status: "unavailable" });
}
async function codexClient(binary, endpoint, bearer, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signalk-mcp-codex-"));
  const env = { ...process.env, SIGNALK_MCP_TEST_BEARER: bearer };
  const options = { env, cwd: dir, timeout: 15000, maxBuffer: 1024 * 1024 };
  let child;
  let lines;
  try {
    const version = (await exec(binary, ["--version"], options)).stdout.trim();
    // Config tables merge. Explicitly disable every pre-existing server in this
    // child process, then verify the effective list before starting a thread.
    // No profile, auth file or user configuration is written or replaced.
    const base = [
      "-c",
      "features.apps=false",
      "-c",
      "features.plugins=false",
      "-c",
      "features.hooks=false",
    ];
    const existing = JSON.parse(
      (await exec(binary, [...base, "mcp", "list", "--json"], options)).stdout,
    );
    const disabled = existing
      .filter((entry) => entry.name !== serverName)
      .map((entry) => `${JSON.stringify(entry.name)}={enabled=false}`);
    const fixture = `${serverName}={url=${JSON.stringify(endpoint.toString())},bearer_token_env_var="SIGNALK_MCP_TEST_BEARER",enabled=true,startup_timeout_sec=10}`;
    const overrides = [
      ...base,
      "-c",
      `mcp_servers={${[...disabled, fixture].join(",")}}`,
    ];
    const configured = JSON.parse(
      (await exec(binary, [...overrides, "mcp", "list", "--json"], options))
        .stdout,
    );
    assert.deepEqual(
      configured.filter((s) => s.enabled).map((s) => s.name),
      [serverName],
    );
    child = spawn(binary, [...overrides, "app-server", "--stdio"], {
      env,
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Do not print product logs, which can contain local profile information.
    child.stderr.resume();
    const pending = new Map();
    let nextId = 0;
    lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method && message.id !== undefined) {
        child.stdin.write(
          JSON.stringify({
            id: message.id,
            error: {
              code: -32601,
              message: "No interactive requests in isolated fixture",
            },
          }) + "\n",
        );
        return;
      }
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        if (message.error)
          entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      }
    });
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex ${method} timed out`));
        }, 20000);
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timeout);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timeout);
            reject(e);
          },
        });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    await rpc("initialize", {
      clientInfo: { name: "signalk_fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    for (let connection = 0; connection < 2; connection++) {
      const started = await rpc("thread/start", {
        cwd: dir,
        ephemeral: true,
        config: {
          "features.apps": false,
          "features.plugins": false,
          "features.hooks": false,
        },
      });
      const threadId = started.thread.id;
      const inventory = await rpc("mcpServerStatus/list", {
        threadId,
        serverName,
        detail: "toolsAndAuthOnly",
      });
      assert.equal(inventory.data.length, 1);
      assert.equal(Object.keys(inventory.data[0].tools).length, 9);
      const call = (tool, args) =>
        rpc("mcpServer/tool/call", {
          threadId,
          server: serverName,
          tool,
          arguments: args,
        });
      checkValues(await call("get_values", { paths }));
      const error = await call("execute_capability", {
        id: "plugin.mcp-fixture",
        operation: "write",
        arguments: {},
      });
      assert.equal(error.isError, true);
      assert.equal(error.content[0].text, "OPERATION_DISABLED");
      assert.equal(error.structuredContent, undefined);
      await rpc("thread/unsubscribe", { threadId });
    }
    t.diagnostic(
      `${version}: initialized, nine tools, zero/unit preserved, ACL filtering, tool error, fresh-thread reconnect`,
    );
  } finally {
    lines?.close();
    child?.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
async function hermesClient(root, endpoint, bearer, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signalk-mcp-hermes-"));
  try {
    const python = path.join(root, "venv/bin/python");
    const executable =
      process.env.MCP_TEST_HERMES_PYTHON ||
      (fs.existsSync(python) ? python : path.join(root, ".hermes/bin/python"));
    const child = spawn(
      executable,
      [path.join(__dirname, "product-hermes.py"), root],
      {
        cwd: dir,
        env: {
          ...process.env,
          HERMES_HOME: dir,
          SIGNALK_MCP_TEST_BEARER: bearer,
          PYTHONPATH: root,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output = [];
    child.stdout.on("data", (data) => output.push(data.toString()));
    const errors = [];
    child.stderr.on("data", (data) => errors.push(data.toString()));
    child.stdin.end(JSON.stringify({ endpoint: endpoint.toString() }));
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Hermes fixture timed out"));
      }, 40000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exit, 0, errors.join("").replaceAll(bearer, "[redacted]"));
    assert.ok(output.join("").includes("HERMES_FIXTURE_OK"));
    const stamp = JSON.parse(
      fs.readFileSync(path.join(root, "install-stamp.json"), "utf8"),
    );
    t.diagnostic(
      `Hermes ${stamp.displayVersion} (${stamp.commit}): CLI discovery and native registry reads/errors/reconnect passed`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
module.exports = { codexClient, hermesClient };
