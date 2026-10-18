const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getHistory } = require("../dist/capabilities/history.js");
const { historyInput } = require("../dist/capabilities/schemas.js");
const { canReadAllSources } = require("../dist/auth.js");

function fixture() {
  const input = historyInput.parse({
    from: "2026-10-17T10:00:01Z",
    to: "2026-10-17T10:01:00Z",
    paths: [{ path: "navigation.speedOverGround", source: "allowed" }],
  });
  const principal = { identifier: "reader", permissions: "readonly" };
  const app = {
    selfContext: "vessels.test",
    securityStrategy: {
      isDummy: () => false,
      authorizeWS() {},
      anyACLs: () => true,
      checkACL: (_id, _context, _path, source) => source === "allowed",
    },
  };
  const response = {
    context: app.selfContext,
    range: { from: input.from, to: input.to },
    values: [{ path: input.paths[0].path, method: "average", units: "m/s" }],
    data: [
      ["2026-10-17T10:00:00.000Z", 0],
      [input.to, null],
    ],
  };
  const calls = [];
  const get = async (url) => {
    calls.push(url);
    return url.endsWith("_providers")
      ? { standard: { isDefault: true } }
      : response;
  };
  return {
    app,
    input,
    principal,
    response,
    calls,
    get,
    run: () => getHistory(app, () => principal, get, input),
  };
}

test("standard history forwards optional metadata, bucket timestamps, zero and null unchanged", async () => {
  const f = fixture();
  assert.equal(await f.run(), f.response);
  const query = new URL(f.calls[1], "http://localhost").searchParams;
  assert.equal(query.get("paths"), "navigation.speedOverGround|allowed");
  assert.equal(query.has("resolution"), false);
  assert.equal(query.get("provider"), "standard");
  f.response.values[0].$source = "allowed";
  assert.equal(await f.run(), f.response);
  f.response.values[0].$source = "private";
  await assert.rejects(f.run, /HISTORY_PROVENANCE_MISMATCH/);
});

test("unfiltered history requires a literal native no-ACL result, even for an admin", async () => {
  const f = fixture();
  delete f.input.paths[0].source;
  f.principal.permissions = "admin";
  // An empty-source/path grant can miss a preceding source-specific denial.
  f.app.securityStrategy.checkACL = () => true;
  for (const decision of [
    true,
    undefined,
    null,
    0,
    "false",
    Promise.resolve(false),
  ]) {
    f.app.securityStrategy.anyACLs = () => decision;
    await assert.rejects(f.run, /PERMISSION_DENIED/);
  }
  delete f.app.securityStrategy.anyACLs;
  await assert.rejects(f.run, /PERMISSION_DENIED/);
  assert.deepEqual(f.calls, []);
  f.app.securityStrategy.anyACLs = () => false;
  assert.equal(await f.run(), f.response);
  assert.equal(
    new URL(f.calls[1], "http://localhost").searchParams.get("paths"),
    "navigation.speedOverGround",
  );
  f.app.securityStrategy.checkACL = () => false;
  assert.equal(
    canReadAllSources(f.app, f.principal, f.input.paths[0].path),
    false,
  );
});

test("history rechecks source access and no-ACL state after each asynchronous read", async () => {
  for (const filtered of [true, false]) {
    for (const revokeAt of [1, 2]) {
      const f = fixture();
      if (!filtered) delete f.input.paths[0].source;
      let granted = true;
      f.app.securityStrategy.anyACLs = () => !granted;
      f.app.securityStrategy.checkACL = () => granted;
      await assert.rejects(
        () =>
          getHistory(
            f.app,
            () => f.principal,
            async (url) => {
              const result = await f.get(url);
              if (f.calls.length === revokeAt) granted = false;
              return result;
            },
            f.input,
          ),
        /PERMISSION_DENIED/,
      );
      assert.equal(f.calls.length, revokeAt);
    }
  }
});

test("history validates repeated path columns without requiring optional source labels", async () => {
  const f = fixture();
  f.app.securityStrategy.checkACL = () => true;
  f.input.paths.push({ ...f.input.paths[0], source: "other" });
  f.response.values.push({ ...f.response.values[0] });
  f.response.data.forEach((row) => row.push(7));
  assert.equal(await f.run(), f.response);
  f.response.values[1].$source = "allowed";
  assert.equal(await f.run(), f.response);
  f.response.values[0].$source = "other";
  f.response.values[1].$source = "allowed";
  assert.equal(await f.run(), f.response);
  f.response.values[1].$source = "other";
  await assert.rejects(f.run, /HISTORY_PROVENANCE_MISMATCH/);
});

test("history preserves bounds and rejects malformed standard responses", async () => {
  for (const change of [
    (r) => {
      r.context = "vessels.other";
    },
    (r) => {
      r.range.from = "2026-10-17T00:00:00Z";
    },
    (r) => {
      r.values[0].path = "electrical.secret";
    },
    (r) => {
      r.values[0].method = "max";
    },
    (r) => {
      r.values[0].$source = null;
    },
    (r) => {
      r.data[0].push(99);
    },
    (r) => {
      r.data[0][0] = "invalid";
    },
    (r) => {
      r.data = Array.from({ length: 2001 }, () => r.data[0]);
    },
  ]) {
    const f = fixture();
    change(f.response);
    await assert.rejects(
      f.run,
      /INVALID_HISTORY_RESPONSE|HISTORY_PROVENANCE_MISMATCH/,
    );
  }
});

test("history bounds optional time-range combinations without adding query defaults", async () => {
  const f = fixture();
  delete f.input.from;
  f.input.duration = 60;
  f.response.range.from = "2026-10-17T10:00:00Z";
  assert.equal(await f.run(), f.response);
  const params = new URL(f.calls[1], "http://localhost").searchParams;
  assert.equal(params.has("from"), false);
  assert.equal(params.get("duration"), "60");
  f.response.range.from = "2026-10-17T09:00:00Z";
  await assert.rejects(f.run, /INVALID_HISTORY_RESPONSE/);
  for (const time of [
    {},
    { to: f.input.to },
    { from: f.response.range.from, to: f.input.to, duration: 60 },
    { from: f.response.range.from, to: "2026-10-30T00:00:00Z" },
  ]) {
    await assert.rejects(
      () =>
        getHistory(f.app, () => f.principal, f.get, {
          paths: f.input.paths,
          ...time,
        }),
      /INVALID_ARGUMENTS|HISTORY_QUERY_LIMIT/,
    );
  }
});
