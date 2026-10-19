// Pack once, install that exact artifact without scripts, and test its native
// endpoint. The receipt identifies what was tested; nothing is published.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const output = path.resolve(process.argv[2] || "package-verification");
const npmCli = process.env.npm_execpath;
assert.ok(
  npmCli && fs.existsSync(npmCli),
  "Run through npm run verify:package",
);
assert.ok(
  process.env.MCP_TEST_PYTHON,
  "Set MCP_TEST_PYTHON to the isolated Python MCP client",
);
fs.mkdirSync(output); // Refuse to overwrite an earlier receipt/artifact.
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180000,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${path.basename(command)} failed: ${result.error?.message || result.stderr || result.stdout}`,
    );
  return result.stdout;
}
const npm = (args, options) =>
  run(process.execPath, [npmCli, ...args], options);
const install = path.join(output, "installed");
try {
  npm(["run", "build"]);
  const [packed] = JSON.parse(
    npm(["pack", "--ignore-scripts", "--json", "--pack-destination", output]),
  );
  for (const required of [
    "dist/index.js",
    "public/remoteEntry.js",
    "README.md",
    "BRIEF.md",
    "AGENTS.md",
    "LICENSE",
    "CHANGELOG.md",
    "docs/images/native-plugin-config.jpg",
    "docs/images/native-put-approvals.png",
  ])
    assert.ok(
      packed.files.some(({ path: file }) => file === required),
      `Missing ${required}`,
    );
  assert.ok(
    !packed.files.some(({ path: file }) => file.startsWith("test/")),
    "Fixtures must not ship",
  );
  const artifact = path.join(output, packed.filename);
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  for (const screenshot of pkg.signalk.screenshots)
    assert.ok(
      packed.files.some(
        ({ path: file }) => file === screenshot.replace(/^\.\//, ""),
      ),
      `Missing screenshot ${screenshot}`,
    );
  fs.mkdirSync(install);
  fs.writeFileSync(
    path.join(install, "package.json"),
    JSON.stringify({
      name: "isolated-package-smoke",
      version: "1.0.0",
      private: true,
    }),
  );
  npm(
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      artifact,
    ],
    { cwd: install },
  );
  const installed = path.join(install, "node_modules", "signalk-mcp");
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-force-exit",
      "test/integration.test.cjs",
      "test/native-puts.test.cjs",
    ],
    {
      cwd: root,
      env: { ...process.env, MCP_TEST_PLUGIN_DIR: installed },
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  fs.writeFileSync(
    path.join(output, "integration.log"),
    `${result.stdout || ""}${result.stderr || ""}`,
  );
  assert.equal(
    result.status,
    0,
    `Installed-package checks failed; see ${path.join(output, "integration.log")}`,
  );
  const audit = JSON.parse(
    npm(["audit", "--omit=dev", "--json"], { cwd: install }),
  );
  const receipt = {
    date: new Date().toISOString(),
    package: `${packed.name}@${packed.version}`,
    artifact: packed.filename,
    sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(artifact))
      .digest("hex"),
    integrity: packed.integrity,
    sourceCommit: run("git", ["rev-parse", "HEAD"]).trim(),
    sourceDirty: run("git", ["status", "--porcelain"]).trim().length > 0,
    node: process.version,
    signalK:
      process.env.MCP_TEST_SERVER_VERSION ||
      require("signalk-server/package.json").version,
    realHistoryBackend: Boolean(process.env.MCP_TEST_INFLUX_URL),
    pythonClient: true,
    productionAudit: audit.metadata.vulnerabilities,
    installedIntegrationPassed: true,
    published: false,
  };
  fs.writeFileSync(
    path.join(output, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  process.stdout.write(`Package verified; artifact and receipt: ${output}\n`);
} finally {
  fs.rmSync(install, { recursive: true, force: true });
}
