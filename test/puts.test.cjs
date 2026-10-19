const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const http = require("node:http");
const { Buffer } = require("node:buffer");
const { NativePuts, putInput, putPathsInput } = require("../dist/puts.js");
const { canPut } = require("../dist/auth.js");
const { configSchema } = require("../dist/config.js");
const {
  ApprovalRequests,
  putReview,
  reviewKey,
} = require("../dist/approvals.js");
const {
  localActions,
  NativeActionHttpError,
} = require("../dist/capabilities/http.js");

const path = "electrical.switches.fixture.state";
const source = "fixture.public";
function fixture(metadata = { supportsPut: true, units: "ratio" }) {
  const principal = { identifier: "writer", permissions: "readwrite" };
  const state = { allowed: true, metadata, calls: [], replies: new Map() };
  const app = {
    selfContext: "vessels.synthetic",
    securityStrategy: {
      isDummy: () => false,
      authorizeWS: () => {},
      checkACL: (id, context, checkedPath, checkedSource, operation) =>
        state.allowed &&
        id === principal.identifier &&
        context === "vessels.self" &&
        checkedPath === path &&
        checkedSource === source &&
        operation === "put",
    },
    getMetadata: (fullPath) =>
      fullPath === `vessels.self.${path}` ? state.metadata : undefined,
    getPath: () => ({
      electrical: {
        switches: { fixture: { state: { meta: state.metadata } } },
      },
    }),
  };
  const puts = new NativePuts(app);
  const authorize = () => ({ ...principal });
  const requests = new ApprovalRequests();
  const config = configSchema.parse({});
  const target = puts.describe(authorize, { path, source });
  const review = { ...putReview(target), decision: "approved" };
  config.readRequests[reviewKey(review)] = review;
  const nativeReply = (
    state = "COMPLETED",
    statusCode = 200,
    requestId = randomUUID(),
  ) => ({
    state,
    statusCode,
    requestId,
    user: "writer",
    href: `/signalk/v1/requests/${requestId}`,
  });
  const actions = {
    put: async (route, body) => {
      state.calls.push({ route, body });
      const reply = nativeReply();
      state.replies.set(reply.requestId, reply);
      return reply;
    },
    getRequest: async (id) => state.replies.get(id),
  };
  const context = { authorize, requests, config, http: actions };
  return {
    state,
    principal,
    app,
    puts,
    authorize,
    requests,
    config,
    context,
    nativeReply,
  };
}

test("native PUT discovery exposes metadata-only candidates with exact source ACLs and no values", () => {
  const f = fixture();
  assert.deepEqual(f.puts.list(f.authorize, { source }).paths, [path]);
  assert.equal(f.puts.list(f.authorize, { source: "private" }).paths.length, 0);
  assert.throws(() => putPathsInput.parse({}), /source/);
  const description = f.puts.describe(f.authorize, { path, source });
  assert.equal(description.metadata.supportsPut, true);
  assert.equal(description.metadata.units, "ratio");
  assert.equal(description.schemaStatus, "unspecified");
  assert.equal(description.sourceVerification, "native-handler-on-dispatch");
  assert.equal(description.nativeHandlerValidation, true);
  assert.equal(Object.hasOwn(description, "value"), false);
  assert.throws(
    () => f.puts.describe(f.authorize, { path, source: "private" }),
    /PERMISSION_DENIED/,
  );
  for (const permissions of ["readonly", "unknown"]) {
    f.principal.permissions = permissions;
    assert.equal(canPut(f.app, f.principal, path, source), false);
    assert.throws(
      () => f.puts.list(f.authorize, { source }),
      /PERMISSION_DENIED/,
    );
  }
});

test("metadata observation indexes only bounded self paths, including targets without telemetry", () => {
  const f = fixture();
  f.app.getPath = () => ({});
  const puts = new NativePuts(f.app);
  assert.deepEqual(puts.list(f.authorize, { source }).paths, []);
  puts.observeDelta({
    context: "vessels.foreign",
    updates: [{ meta: [{ path, value: { supportsPut: true } }] }],
  });
  assert.deepEqual(puts.list(f.authorize, { source }).paths, []);
  puts.observeDelta({
    context: f.app.selfContext,
    updates: [
      {
        meta: [
          { path, value: { supportsPut: true, private: "never retained" } },
        ],
        values: [{ path, value: "never retained either" }],
      },
    ],
  });
  const discovered = puts.list(f.authorize, { source });
  assert.deepEqual(discovered.paths, [path]);
  assert.equal(discovered.discoveryCoverage, "model-and-observed-metadata");
  assert.equal(
    discovered.historicalMetadataOnlyPaths,
    "explicit-describe-required",
  );
  f.state.allowed = false;
  assert.deepEqual(puts.list(f.authorize, { source }).paths, []);
  f.state.allowed = true;
  puts.reset();
  assert.deepEqual(puts.list(f.authorize, { source }).paths, []);
  puts.describe(f.authorize, { path, source });
  assert.deepEqual(puts.list(f.authorize, { source }).paths, [path]);
  puts.observeDelta({
    updates: [
      {
        meta: Array.from({ length: 2049 }, (_, i) => ({
          path: `synthetic.path${i}`,
          value: "ignored",
        })),
      },
    ],
  });
  assert.equal(puts.list(f.authorize, { source }).discoveryTruncated, true);
  assert.equal(puts.list(f.authorize, { source }).metadataPathLimit, 2048);
});

test("PUT input requires a literal source and bounded JSON, preserving false, zero and null", async () => {
  const f = fixture();
  for (const value of [0, false, null, "", { value: 0 }, [false, null]]) {
    const result = await f.puts.execute(f.context, { path, source, value });
    assert.equal(result.outcome, "completed");
    assert.equal(result.submitted, true);
    assert.equal(result.retrySafe, false);
    assert.deepEqual(f.state.calls.at(-1).body, { value, source });
    assert.equal(
      f.state.calls.at(-1).route,
      "/signalk/v1/api/vessels/self/electrical/switches/fixture/state",
    );
  }
  const circular = {};
  circular.child = circular;
  let deep = null;
  for (let i = 0; i < 18; i++) deep = { deep };
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => 1,
    new Date(),
    circular,
    deep,
    "x".repeat(32769),
    Array(1025).fill(0),
  ])
    assert.equal(putInput.safeParse({ path, source, value }).success, false);
  assert.equal(putInput.safeParse({ path, source }).success, false);
  for (const invalidSource of [
    undefined,
    "",
    "*",
    "fixture.*",
    "fixture?",
    "x\ny",
  ])
    assert.equal(
      putInput.safeParse({ path, source: invalidSource, value: 1 }).success,
      false,
    );
  for (const invalidPath of [
    "../admin",
    path + ".meta",
    path + ".meta.units",
    "constructor.x",
  ])
    assert.equal(
      putInput.safeParse({ path: invalidPath, source, value: 1 }).success,
      false,
    );
});

test("native constraints are explicit; display ranges and current telemetry invent no schema", async () => {
  const f = fixture({
    supportsPut: true,
    type: "number",
    enum: [0, 1, 2],
    minimum: 0,
    maximum: 2,
  });
  const description = f.puts.describe(f.authorize, { path, source });
  assert.equal(description.schemaStatus, "available");
  assert.deepEqual(description.inputSchema.enum, [0, 1, 2]);
  for (const value of [-1, 3, false, null, "1"])
    await assert.rejects(
      f.puts.execute(f.context, { path, source, value }),
      /INVALID_PUT_VALUE/,
    );
  assert.equal(f.state.calls.length, 0);
  await f.puts.execute(f.context, { path, source, value: 0 });
  const unspecified = fixture({
    supportsPut: true,
    displayScale: { lower: 1, upper: 2 },
    zones: [{ lower: 5 }],
  });
  assert.equal(
    unspecified.puts.describe(unspecified.authorize, { path, source })
      .schemaStatus,
    "unspecified",
  );
  assert.equal(
    (
      await unspecified.puts.execute(unspecified.context, {
        path,
        source,
        value: null,
      })
    ).outcome,
    "completed",
  );
});

test("unsupported or malformed explicit schemas block queueing and dispatch without dropping constraints", async () => {
  for (const schema of [
    { type: "string", pattern: "^safe$" },
    { $ref: "#/components/value" },
    { oneOf: [{ type: "number" }, { type: "null" }] },
    { type: "number", minimum: "zero" },
    { type: "number", minimum: 3, maximum: 1 },
    { type: "invalid" },
    { type: "object", required: "field" },
    {
      type: "object",
      properties: { field: { type: "string", pattern: "^safe$" } },
    },
    { type: "object", additionalProperties: { type: "number" } },
    { type: "array", items: [{ type: "number" }] },
    "not-a-schema",
  ]) {
    const f = fixture({ supportsPut: true, schema });
    f.config.readRequests = {};
    assert.equal(
      f.puts.describe(f.authorize, { path, source }).schemaStatus,
      "unsupported",
    );
    await assert.rejects(
      f.puts.execute(f.context, { path, source, value: 1 }),
      /UNSUPPORTED_PUT_SCHEMA/,
    );
    assert.equal(Object.keys(f.requests.schema().properties).length, 0);
    assert.equal(f.state.calls.length, 0);
  }
});

test("explicit object enum and const constraints compare JSON values independently of key order", async () => {
  for (const constraint of [
    { enum: [{ a: 1, b: false }] },
    { const: { a: 1, b: false } },
  ]) {
    const f = fixture({
      supportsPut: true,
      schema: { type: "object", ...constraint },
    });
    assert.equal(
      (
        await f.puts.execute(f.context, {
          path,
          source,
          value: { b: false, a: 1 },
        })
      ).outcome,
      "completed",
    );
    await assert.rejects(
      f.puts.execute(f.context, { path, source, value: { a: 1, b: true } }),
      /INVALID_PUT_VALUE/,
    );
  }
});

test("role and exact native put ACL precede approval queueing and dispatch", async () => {
  const f = fixture();
  f.config.readRequests = {};
  f.state.allowed = false;
  await assert.rejects(
    f.puts.execute(f.context, { path, source, value: 9 }),
    /PERMISSION_DENIED/,
  );
  assert.equal(Object.keys(f.requests.schema().properties).length, 0);
  assert.equal(f.state.calls.length, 0);
  f.state.allowed = true;
  await assert.rejects(
    f.puts.execute(f.context, { path, source, value: "secret input" }),
    /APPROVAL_PENDING/,
  );
  assert.equal(
    JSON.stringify(f.requests.schema()).includes("secret input"),
    false,
  );
  assert.equal(f.state.calls.length, 0);
  f.principal.permissions = "admin";
  f.state.allowed = false;
  await assert.rejects(
    f.puts.execute(f.context, { path, source, value: 1 }),
    /PERMISSION_DENIED/,
  );
});

test("approval changes, source changes and stale supportsPut cannot dispatch", async () => {
  for (const change of [
    (f) => {
      Object.values(f.config.readRequests)[0].decision = "rejected";
    },
    (f) => {
      f.state.metadata = {
        ...f.state.metadata,
        description: "changed native contract",
      };
    },
    (f) => {
      f.state.metadata.supportsPut = false;
    },
  ]) {
    const f = fixture();
    change(f);
    await assert.rejects(
      f.puts.execute(f.context, { path, source, value: 1 }),
      /APPROVAL_REJECTED|APPROVAL_PENDING|PUT_UNAVAILABLE/,
    );
    assert.equal(f.state.calls.length, 0);
  }
});

test("native replies remain pending/completed, including completed action failure over HTTP 200", async () => {
  const f = fixture();
  const reply = f.nativeReply("PENDING", 202);
  reply.action = { href: reply.href };
  f.context.http.put = async () => reply;
  f.state.replies.set(reply.requestId, reply);
  const pending = await f.puts.execute(f.context, {
    path,
    source,
    value: false,
  });
  assert.equal(pending.outcome, "pending");
  reply.state = "COMPLETED";
  reply.statusCode = 502;
  reply.message = "synthetic failure";
  const status = await f.puts.status(f.context, {
    requestId: pending.requestId,
  });
  assert.equal(status.outcome, "completed");
  assert.equal(status.reply.statusCode, 502);
  assert.equal(status.reply.message, "synthetic failure");
  f.context.http.put = async () => f.nativeReply("FAILED", 502);
  const failed = await f.puts.execute(f.context, { path, source, value: 0 });
  assert.equal(failed.reply.state, "FAILED");
  assert.equal(failed.reply.statusCode, 502);
});

test("a request cannot inherit another already-approved metadata variant", async () => {
  const f = fixture({ supportsPut: true, description: "variant A" });
  const original = f.state.metadata;
  const variant = { supportsPut: true, description: "variant B" };
  f.state.metadata = variant;
  const approved = {
    ...putReview(f.puts.describe(f.authorize, { path, source })),
    decision: "approved",
  };
  f.config.readRequests[reviewKey(approved)] = approved;
  f.state.metadata = original;
  f.context.http.put = async () => {
    f.state.metadata = variant;
    return f.nativeReply();
  };
  const changed = await f.puts.execute(f.context, { path, source, value: 0 });
  assert.equal(changed.outcome, "unknown");
  assert.equal(changed.code, "AUTHORIZATION_CHANGED_AFTER_SUBMISSION");
  await assert.rejects(
    f.puts.status(f.context, { requestId: changed.requestId }),
    /PUT_REQUEST_UNAVAILABLE/,
  );
});

test("request status is scoped to this gateway submission, principal, current ACL and saved approval", async () => {
  const f = fixture();
  const result = await f.puts.execute(f.context, { path, source, value: 1 });
  await assert.rejects(
    f.puts.status(f.context, { requestId: randomUUID() }),
    /PUT_REQUEST_UNAVAILABLE/,
  );
  f.principal.identifier = "other";
  await assert.rejects(
    f.puts.status(f.context, { requestId: result.requestId }),
    /PUT_REQUEST_UNAVAILABLE/,
  );
  f.principal.identifier = "writer";
  f.state.allowed = false;
  await assert.rejects(
    f.puts.status(f.context, { requestId: result.requestId }),
    /PERMISSION_DENIED/,
  );
  f.state.allowed = true;
  Object.values(f.config.readRequests)[0].decision = "rejected";
  await assert.rejects(
    f.puts.status(f.context, { requestId: result.requestId }),
    /APPROVAL_REJECTED/,
  );
  f.puts.reset();
  await assert.rejects(
    f.puts.status(f.context, { requestId: result.requestId }),
    /PUT_REQUEST_UNAVAILABLE/,
  );
});

test("post-submission revocation and ambiguous transport outcomes preserve uncertainty without retries", async () => {
  for (const changed of ["acl", "role", "approval", "reset", "disconnect"]) {
    const f = fixture();
    let count = 0;
    f.context.http.put = async () => {
      count++;
      if (changed === "acl") f.state.allowed = false;
      if (changed === "role") f.principal.permissions = "readonly";
      if (changed === "approval")
        Object.values(f.config.readRequests)[0].decision = "rejected";
      if (changed === "reset") f.puts.reset();
      if (changed === "disconnect") throw new Error("sensitive socket message");
      return f.nativeReply();
    };
    const result = await f.puts.execute(f.context, {
      path,
      source,
      value: "must not persist",
    });
    assert.equal(result.outcome, "unknown", changed);
    assert.equal(result.submitted, true);
    assert.equal(result.retrySafe, false);
    assert.equal(Object.hasOwn(result, "reply"), false);
    assert.equal(JSON.stringify(result).includes("sensitive"), false);
    assert.equal(JSON.stringify(f.puts).includes("must not persist"), false);
    assert.equal(count, 1);
  }
});

test("native user/ID/href mismatch or invalid output cannot disclose an uncorrelated reply", async () => {
  for (const alter of [
    (reply) => {
      reply.user = "foreign";
    },
    (reply) => {
      reply.requestId = "arbitrary";
    },
    (reply) => {
      reply.href = "https://elsewhere.invalid";
    },
    (reply) => {
      reply.action = { href: "/plugins/other/status" };
    },
    (reply) => {
      reply.state = ["PENDING"];
    },
    (reply) => {
      reply.message = "x".repeat(225 * 1024);
    },
  ]) {
    const f = fixture();
    f.context.http.put = async () => {
      const reply = f.nativeReply();
      alter(reply);
      return reply;
    };
    const result = await f.puts.execute(f.context, { path, source, value: 1 });
    assert.equal(result.outcome, "unknown");
    assert.equal(Object.hasOwn(result, "requestId"), false);
    assert.equal(Object.hasOwn(result, "reply"), false);
  }
});

test("status rechecks authorization and native correlation after asynchronous polling", async () => {
  const f = fixture();
  const submitted = await f.puts.execute(f.context, { path, source, value: 1 });
  f.context.http.getRequest = async (id) => {
    f.state.allowed = false;
    return f.state.replies.get(id);
  };
  await assert.rejects(
    f.puts.status(f.context, { requestId: submitted.requestId }),
    /PERMISSION_DENIED/,
  );
  f.state.allowed = true;
  f.context.http.getRequest = async () => f.nativeReply();
  await assert.rejects(
    f.puts.status(f.context, { requestId: submitted.requestId }),
    /INVALID_NATIVE_PUT_REPLY/,
  );
});

test("bounded correlation reserves capacity before dispatch and never evicts an in-flight submission", async () => {
  const f = fixture();
  const completions = [];
  f.context.http.put = () =>
    new Promise((resolve) => completions.push(resolve));
  const pending = Array.from({ length: 128 }, () =>
    f.puts.execute(f.context, { path, source, value: 1 }),
  );
  assert.equal(completions.length, 128);
  await assert.rejects(
    f.puts.execute(f.context, { path, source, value: 2 }),
    /PUT_REQUEST_CAPACITY/,
  );
  const now = Date.now;
  Date.now = () => now() + 3600001;
  try {
    await assert.rejects(
      f.puts.execute(f.context, { path, source, value: 2 }),
      /PUT_REQUEST_CAPACITY/,
    );
    for (const resolve of completions) resolve(f.nativeReply("PENDING", 202));
    const replies = await Promise.all(pending);
    await assert.rejects(
      f.puts.status(f.context, { requestId: replies[0].requestId }),
      /PUT_REQUEST_UNAVAILABLE/,
    );
    f.context.http.put = async () => f.nativeReply();
    assert.equal(
      (await f.puts.execute(f.context, { path, source, value: 3 })).outcome,
      "completed",
    );
  } finally {
    Date.now = now;
  }
});

test("native local actions use only accepted socket destination, bearer header and fixed routes", async (t) => {
  const received = [];
  const replies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    });
    const next = replies.shift() ?? { status: 200, body: { ok: true } };
    res.statusCode = next.status;
    res.setHeader("Content-Type", next.contentType ?? "application/json");
    if (next.location) res.setHeader("Location", next.location);
    res.end(
      typeof next.body === "string" ? next.body : JSON.stringify(next.body),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const req = {
    socket: {
      localAddress: "::ffff:127.0.0.1",
      localPort: server.address().port,
    },
    headers: { host: "untrusted.invalid", cookie: "session=secret" },
  };
  const actions = localActions(
    req,
    "Bearer synthetic-token",
    new AbortController().signal,
  );
  const route =
    "/signalk/v1/api/vessels/self/electrical/switches/fixture/state";
  await actions.put(route, { value: false, source });
  const requestId = randomUUID();
  await actions.getRequest(requestId);
  assert.equal(received[0].method, "PUT");
  assert.deepEqual(JSON.parse(received[0].body), { value: false, source });
  assert.equal(received[0].headers.authorization, "Bearer synthetic-token");
  assert.equal(received[0].headers.cookie, undefined);
  assert.equal(received[1].url, `/signalk/v1/requests/${requestId}`);
  for (const invalid of [
    "https://elsewhere.invalid",
    "/plugins/action",
    "/signalk/v1/api/vessels/self/x?token=bad",
    "/signalk/v1/api/vessels/self/../admin",
    "/signalk/v1/api/vessels/self/constructor",
    "/signalk/v1/api/vessels/self/electrical/switches/fixture/state/meta/units",
  ])
    assert.throws(
      () => actions.put(invalid, { value: 1, source }),
      /INVALID_LOCAL_ROUTE/,
    );
  for (const id of ["../plugins", "id?token=secret", "not-a-uuid"])
    assert.throws(() => actions.getRequest(id), /INVALID_LOCAL_ROUTE/);
  replies.push({ status: 302, location: "/plugins/unsafe", body: {} });
  await assert.rejects(
    actions.put(route, { value: 1, source }),
    /NATIVE_PUT_REDIRECT_REFUSED/,
  );
  assert.equal(received.length, 3);
  replies.push({ status: 401, body: { error: "unauthorized" } });
  await assert.rejects(
    actions.put(route, { value: 1, source }),
    (error) =>
      error instanceof NativeActionHttpError && error.httpStatus === 401,
  );
  const native = fixture().nativeReply("COMPLETED", 403);
  replies.push({ status: 403, body: native });
  assert.deepEqual(await actions.put(route, { value: 1, source }), native);
  replies.push({
    status: 200,
    contentType: "text/html",
    body: "<html>not JSON</html>",
  });
  await assert.rejects(
    actions.put(route, { value: 1, source }),
    /UPSTREAM_NOT_JSON/,
  );
  replies.push({ status: 200, body: "invalid JSON" });
  await assert.rejects(
    actions.put(route, { value: 1, source }),
    /UPSTREAM_INVALID_JSON/,
  );
});
