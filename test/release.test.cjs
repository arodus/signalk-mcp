const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-release-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.cpSync(path.resolve("scripts"), path.join(cwd, "scripts"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({
      name: "mcp-release-fixture",
      version: "0.1.0-alpha.1",
      files: ["index.js"],
      scripts: {
        prepack:
          "node -e \"throw new Error('release packaging must not rerun build hooks')\"",
      },
    }) + "\n",
  );
  fs.writeFileSync(path.join(cwd, "index.js"), "module.exports = {};\n");
  const git = (...args) => {
    const r = spawnSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-b", "main");
  git("add", ".");
  git("commit", "-m", "fixture");
  const run = (script, args = [], env = {}) =>
    spawnSync(process.execPath, [path.join(cwd, "scripts", script), ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  return { cwd, git, run };
}

test("release tarball stamps actual commit, checksums it and restores manifest even after pack failure", async (t) => {
  const { cwd, git, run } = fixture(t);
  const original = fs.readFileSync(path.join(cwd, "package.json"), "utf8");
  const r = run("create-release-package.mjs");
  assert.equal(r.status, 0, r.stderr);
  const artifact = path.join(cwd, "mcp-release-fixture-0.1.0-alpha.1.tgz");
  const { readPackageManifest } = await import(
    pathToFileURL(path.resolve("scripts/package-archive.mjs"))
  );
  assert.equal(readPackageManifest(artifact).gitHead, git("rev-parse", "HEAD"));
  const hash = createHash("sha256")
    .update(fs.readFileSync(artifact))
    .digest("hex");
  assert.equal(
    fs.readFileSync(artifact + ".sha256", "utf8"),
    `${hash}  ${path.basename(artifact)}\n`,
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
    original,
  );
  const failing = path.join(cwd, "fail.cjs");
  fs.writeFileSync(failing, "process.exit(1)");
  assert.notEqual(
    run("create-release-package.mjs", [], { npm_execpath: failing }).status,
    0,
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
    original,
  );
});

test("published commit verification retries propagation and rejects mismatched gitHead", (t) => {
  const { cwd, git, run } = fixture(t);
  const fake = path.join(cwd, "fake.cjs");
  fs.writeFileSync(
    fake,
    'const fs=require("node:fs");const p="counter";const n=fs.existsSync(p)?Number(fs.readFileSync(p)):0;fs.writeFileSync(p,String(n+1));if(n<1)process.exit(1);console.log(JSON.stringify(process.env.FIXTURE_SHA));',
  );
  const env = {
    NPM_PUBLISH_VERIFY_NPM_CLI: fake,
    NPM_PUBLISH_VERIFY_ATTEMPTS: "2",
    NPM_PUBLISH_VERIFY_DELAY_MS: "0",
    FIXTURE_SHA: git("rev-parse", "HEAD"),
  };
  assert.equal(run("verify-published-release.mjs", [], env).status, 0);
  const mismatch = run("verify-published-release.mjs", [], {
    ...env,
    FIXTURE_SHA: "0".repeat(40),
  });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /gitHead mismatch/);
});

test("release notes require a populated matching version section", (t) => {
  const { cwd, run } = fixture(t);
  fs.writeFileSync(
    path.join(cwd, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\nFuture\n\n## [0.1.0-alpha.1] - 2026-10-19\n\nFirst alpha.\n\n## [0.0.1]\n\nOld.\n",
  );
  const r = run("release-notes.mjs", ["v0.1.0-alpha.1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "First alpha.\n");
  assert.notEqual(run("release-notes.mjs", ["v0.1.0"]).status, 0);
});

test("release tag requires matching notes, an annotated tag and a clean main-branch commit", (t) => {
  const { cwd, git, run } = fixture(t);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-release-origin-"));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "--bare", remote]).status, 0);
  fs.writeFileSync(
    path.join(cwd, "CHANGELOG.md"),
    "## [0.1.0-alpha.1]\n\nFirst alpha.\n",
  );
  git("add", ".");
  git("commit", "-m", "notes");
  git("remote", "add", "origin", remote);
  git("tag", "v0.1.0-alpha.1");
  git("push", "origin", "main", "--tags");
  assert.match(
    run("verify-release-tag.mjs", ["v0.1.0-alpha.1"]).stderr,
    /annotated tag/,
  );
  git("tag", "-d", "v0.1.0-alpha.1");
  git("tag", "-a", "v0.1.0-alpha.1", "-m", "alpha");
  git("push", "--force", "origin", "refs/tags/v0.1.0-alpha.1");
  const valid = run("verify-release-tag.mjs", ["v0.1.0-alpha.1"]);
  assert.equal(valid.status, 0, valid.stderr);
  fs.writeFileSync(path.join(cwd, "index.js"), "dirty\n");
  assert.match(
    run("verify-release-tag.mjs", ["v0.1.0-alpha.1"]).stderr,
    /uncommitted/,
  );
});
