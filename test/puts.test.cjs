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
        checkedSource === null &&
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
  const target = puts.describe(authorize, { path });
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

test("native PUT discovery exposes metadata-only candidates with native path ACLs and no values", () => {
  const f = fixture();
  assert.deepEqual(f.puts.list(f.authorize, {}).paths, [path]);
  assert.throws(
    () => f.puts.list(f.authorize, { source: "private" }),
    /Unrecognized/,
  );
  assert.ok(putPathsInput.safeParse({}).success);
  const description = f.puts.describe(f.authorize, { path });
  assert.equal(description.metadata.supportsPut, true);
  assert.equal(description.metadata.units, "ratio");
  assert.equal(description.schemaStatus, "unspecified");
  assert.equal(description.handlerSelection, "native-default");
  assert.equal(description.nativeHandlerValidation, true);
  assert.equal(Object.hasOwn(description, "value"), false);
  assert.throws(
    () => f.puts.describe(f.authorize, { path, source: "private" }),
    /Unrecognized/,
  );
  for (const permissions of ["readonly", "unknown"]) {
    f.principal.permissions = permissions;
    assert.equal(canPut(f.app, f.principal, path), false);
    assert.throws(() => f.puts.list(f.authorize, {}), /PERMISSION_DENIED/);
  }
});

test("PUT descriptions explain schema gaps, saved approvals and native default routing without queueing", () => {
  const f = fixture();
  const describe = () =>
    f.puts.describe(f.authorize, { path }, f.config.readRequests);
  const queueBefore = JSON.stringify(f.requests.schema());
  let result = describe();
  assert.equal(result.schemaDiagnostics[0].code, "NO_INPUT_TYPE");
  assert.equal(result.schemaDiagnostics[0].field, "metadata.type");
  assert.equal(result.schemaSource, "native-metadata");
  assert.equal(result.approvalStatus, "approved");
  assert.equal(result.enabled, true);
  assert.equal(result.reason, null);
  assert.equal(result.handlerSelection, "native-default");
  const review = Object.values(f.config.readRequests)[0];
  review.decision = "pending";
  assert.equal(describe().approvalStatus, "pending");
  assert.equal(describe().enabled, false);
  review.decision = "rejected";
  assert.equal(describe().approvalStatus, "rejected");
  assert.equal(describe().reason, "APPROVAL_REJECTED");
  f.config.readRequests = {};
  assert.equal(describe().approvalStatus, "required");
  assert.equal(describe().reason, "NOT_ALLOWLISTED");
  f.state.metadata = { supportsPut: true, type: "multiple" };
  result = describe();
  assert.equal(result.schemaStatus, "unsupported");
  assert.equal(result.schemaDiagnostics[0].code, "UNSUPPORTED_INPUT_TYPE");
  assert.match(result.schemaDiagnostics[0].message, /multiple/);
  assert.equal(result.enabled, false);
  assert.equal(result.reason, "UNSUPPORTED_PUT_SCHEMA");
  assert.equal(JSON.stringify(f.requests.schema()), queueBefore);
  assert.equal(f.state.calls.length, 0);
});

test("native possibleValues supply exact enum constraints without coercion or automatic approval", async () => {
  for (const values of [
    ["on", "off", "charger only"],
    [0, 1, 4],
    [false, true],
    [null, false, 0, "0"],
  ]) {
    const metadata = {
      supportsPut: true,
      type: "multiple",
      possibleValues: values.map((value) => ({
        title: "Untrusted display label",
        value,
      })),
    };
    const f = fixture(metadata);
    const description = f.puts.describe(
      f.authorize,
      { path },
      f.config.readRequests,
    );
    assert.equal(description.schemaStatus, "available");
    assert.equal(description.schemaSource, "native-possible-values");
    assert.deepEqual(description.schemaDiagnostics, []);
    assert.deepEqual(description.inputSchema, { enum: values });
    assert.deepEqual(description.metadata, metadata);
    for (const value of values) {
      await f.puts.execute(f.context, { path, value });
      assert.deepEqual(f.state.calls.at(-1).body, { value });
    }
    const count = f.state.calls.length;
    for (const value of ["OFF", "false", "unlisted", {}, []])
      await assert.rejects(
        f.puts.execute(f.context, { path, value }),
        /INVALID_PUT_VALUE/,
      );
    assert.equal(f.state.calls.length, count);
    f.config.readRequests = {};
    await assert.rejects(
      f.puts.execute(f.context, { path, value: values[0] }),
      /APPROVAL_PENDING/,
    );
    assert.equal(f.state.calls.length, count);
    assert.equal(Object.keys(f.requests.schema().properties).length, 1);
    f.state.allowed = false;
    await assert.rejects(
      f.puts.execute(f.context, { path, value: values[0] }),
      /PERMISSION_DENIED/,
    );
    assert.equal(f.state.calls.length, count);
  }
});

test("malformed, ambiguous or conflicting native choices cannot queue or dispatch", async () => {
  for (const metadata of [
    { possibleValues: [] },
    { possibleValues: "off" },
    { possibleValues: ["off"] },
    { possibleValues: [{ title: "off" }] },
    { possibleValues: [{ value: {} }] },
    { possibleValues: [{ value: [] }] },
    { possibleValues: [{ value: "off" }, { value: "off" }] },
    { possibleValues: Array.from({ length: 129 }, (_, value) => ({ value })) },
    { enum: ["on"], possibleValues: [{ value: "off" }] },
    { enum: [0, 0], possibleValues: [{ value: 0 }, { value: 1 }] },
    { type: "range", possibleValues: [{ value: 0 }] },
    { type: "number", possibleValues: [{ value: "off" }] },
    { minimum: 1, possibleValues: [{ value: 0 }] },
  ]) {
    const f = fixture({ supportsPut: true, type: "multiple", ...metadata });
    f.config.readRequests = {};
    const description = f.puts.describe(
      f.authorize,
      { path },
      f.config.readRequests,
    );
    assert.equal(description.schemaStatus, "unsupported");
    assert.match(
      description.schemaDiagnostics[0].code,
      /NATIVE_CHOICES|UNSUPPORTED_INPUT_TYPE/,
    );
    await assert.rejects(
      f.puts.execute(f.context, { path, value: "off" }),
      /UNSUPPORTED_PUT_SCHEMA/,
    );
    assert.equal(Object.keys(f.requests.schema().properties).length, 0);
    assert.equal(f.state.calls.length, 0);
  }
});

test("explicit schemas retain precedence and nested diagnostics; native choices never drop declared constraints", async () => {
  const explicit = fixture({
    supportsPut: true,
    schema: { type: "string", pattern: "^off$" },
    type: "multiple",
    possibleValues: [{ value: "off" }],
  });
  const description = explicit.puts.describe(explicit.authorize, {
    path,
  });
  assert.equal(description.schemaSource, "explicit-schema");
  assert.equal(description.schemaDiagnostics[0].field, "schema.pattern");
  await assert.rejects(
    explicit.puts.execute(explicit.context, { path, value: "off" }),
    /UNSUPPORTED_PUT_SCHEMA/,
  );
  const nested = fixture({
    supportsPut: true,
    schema: { type: "object", properties: { mode: { type: "multiple" } } },
  });
  assert.equal(
    nested.puts.describe(nested.authorize, { path }).schemaDiagnostics[0].field,
    "schema.properties.mode.type",
  );
  const constrained = fixture({
    supportsPut: true,
    type: "integer",
    minimum: 0,
    maximum: 4,
    possibleValues: [{ value: 0 }, { value: 4 }],
  });
  assert.deepEqual(
    constrained.puts.describe(constrained.authorize, { path }).inputSchema,
    { type: "integer", minimum: 0, maximum: 4, enum: [0, 4] },
  );
  await assert.rejects(
    constrained.puts.execute(constrained.context, { path, value: 1 }),
    /INVALID_PUT_VALUE/,
  );
  await constrained.puts.execute(constrained.context, {
    path,
    value: 0,
  });
});

test("changed native choices or meaning require a new exact saved review", async () => {
  const f = fixture({
    supportsPut: true,
    type: "multiple",
    possibleValues: [{ title: "Off", value: "off" }],
  });
  f.state.metadata.possibleValues.push({ title: "On", value: "on" });
  assert.equal(
    f.puts.describe(f.authorize, { path }, f.config.readRequests)
      .approvalStatus,
    "required",
  );
  await assert.rejects(
    f.puts.execute(f.context, { path, value: "on" }),
    /APPROVAL_PENDING/,
  );
  assert.equal(f.state.calls.length, 0);
  const target = f.puts.describe(f.authorize, { path });
  const review = { ...putReview(target), decision: "approved" };
  f.config.readRequests[reviewKey(review)] = review;
  await f.puts.execute(f.context, { path, value: "on" });
  f.state.metadata.possibleValues[0].title = "Different meaning";
  await assert.rejects(
    f.puts.execute(f.context, { path, value: "off" }),
    /APPROVAL_PENDING/,
  );
  assert.equal(f.state.calls.length, 1);
});

test("metadata observation indexes only bounded self paths, including targets without telemetry", () => {
  const f = fixture();
  f.app.getPath = () => ({});
  const puts = new NativePuts(f.app);
  assert.deepEqual(puts.list(f.authorize, {}).paths, []);
  puts.observeDelta({
    context: "vessels.foreign",
    updates: [{ meta: [{ path, value: { supportsPut: true } }] }],
  });
  assert.deepEqual(puts.list(f.authorize, {}).paths, []);
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
  const discovered = puts.list(f.authorize, {});
  assert.deepEqual(discovered.paths, [path]);
  assert.equal(discovered.discoveryCoverage, "model-and-observed-metadata");
  assert.equal(
    discovered.historicalMetadataOnlyPaths,
    "explicit-describe-required",
  );
  f.state.allowed = false;
  assert.deepEqual(puts.list(f.authorize, {}).paths, []);
  f.state.allowed = true;
  puts.reset();
  assert.deepEqual(puts.list(f.authorize, {}).paths, []);
  puts.describe(f.authorize, { path });
  assert.deepEqual(puts.list(f.authorize, {}).paths, [path]);
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
  assert.equal(puts.list(f.authorize, {}).discoveryTruncated, true);
  assert.equal(puts.list(f.authorize, {}).metadataPathLimit, 2048);
});

test("PUT input uses default routing and bounded JSON, preserving false, zero and null", async () => {
  const f = fixture();
  for (const value of [0, false, null, "", { value: 0 }, [false, null]]) {
    const result = await f.puts.execute(f.context, { path, value });
    assert.equal(result.outcome, "completed");
    assert.equal(result.submitted, true);
    assert.equal(result.retrySafe, false);
    assert.deepEqual(f.state.calls.at(-1).body, { value });
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
    assert.equal(putInput.safeParse({ path, value }).success, false);
  assert.equal(putInput.safeParse({ path }).success, false);
  for (const invalidSource of [
    undefined,
    "",
    "*",
    "fixture.*",
    "fixture?",
    "x\ny",
  ])
    assert.equal(
      putInput.safeParse({ path: invalidSource, value: 1 }).success,
      false,
    );
  for (const invalidPath of [
    "../admin",
    path + ".meta",
    path + ".meta.units",
    "constructor.x",
  ])
    assert.equal(
      putInput.safeParse({ path: invalidPath, value: 1 }).success,
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
  const description = f.puts.describe(f.authorize, { path });
  assert.equal(description.schemaStatus, "available");
  assert.deepEqual(description.inputSchema.enum, [0, 1, 2]);
  for (const value of [-1, 3, false, null, "1"])
    await assert.rejects(
      f.puts.execute(f.context, { path, value }),
      /INVALID_PUT_VALUE/,
    );
  assert.equal(f.state.calls.length, 0);
  await f.puts.execute(f.context, { path, value: 0 });
  const unspecified = fixture({
    supportsPut: true,
    displayScale: { lower: 1, upper: 2 },
    zones: [{ lower: 5 }],
  });
  assert.equal(
    unspecified.puts.describe(unspecified.authorize, { path }).schemaStatus,
    "unspecified",
  );
  assert.equal(
    (
      await unspecified.puts.execute(unspecified.context, {
        path,
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
      f.puts.describe(f.authorize, { path }).schemaStatus,
      "unsupported",
    );
    await assert.rejects(
      f.puts.execute(f.context, { path, value: 1 }),
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
          value: { b: false, a: 1 },
        })
      ).outcome,
      "completed",
    );
    await assert.rejects(
      f.puts.execute(f.context, { path, value: { a: 1, b: true } }),
      /INVALID_PUT_VALUE/,
    );
  }
});

test("role and exact native put ACL precede approval queueing and dispatch", async () => {
  const f = fixture();
  f.config.readRequests = {};
  f.state.allowed = false;
  await assert.rejects(
    f.puts.execute(f.context, { path, value: 9 }),
    /PERMISSION_DENIED/,
  );
  assert.equal(Object.keys(f.requests.schema().properties).length, 0);
  assert.equal(f.state.calls.length, 0);
  f.state.allowed = true;
  await assert.rejects(
    f.puts.execute(f.context, { path, value: "secret input" }),
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
    f.puts.execute(f.context, { path, value: 1 }),
    /PERMISSION_DENIED/,
  );
});

test("approval changes and stale supportsPut cannot dispatch", async () => {
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
      f.puts.execute(f.context, { path, value: 1 }),
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
  const failed = await f.puts.execute(f.context, { path, value: 0 });
  assert.equal(failed.reply.state, "FAILED");
  assert.equal(failed.reply.statusCode, 502);
});

test("a request cannot inherit another already-approved metadata variant", async () => {
  const f = fixture({ supportsPut: true, description: "variant A" });
  const original = f.state.metadata;
  const variant = { supportsPut: true, description: "variant B" };
  f.state.metadata = variant;
  const approved = {
    ...putReview(f.puts.describe(f.authorize, { path })),
    decision: "approved",
  };
  f.config.readRequests[reviewKey(approved)] = approved;
  f.state.metadata = original;
  f.context.http.put = async () => {
    f.state.metadata = variant;
    return f.nativeReply();
  };
  const changed = await f.puts.execute(f.context, { path, value: 0 });
  assert.equal(changed.outcome, "unknown");
  assert.equal(changed.code, "AUTHORIZATION_CHANGED_AFTER_SUBMISSION");
  await assert.rejects(
    f.puts.status(f.context, { requestId: changed.requestId }),
    /PUT_REQUEST_UNAVAILABLE/,
  );
});

test("request status is scoped to this gateway submission, principal, current ACL and saved approval", async () => {
  const f = fixture();
  const result = await f.puts.execute(f.context, { path, value: 1 });
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
    const result = await f.puts.execute(f.context, { path, value: 1 });
    assert.equal(result.outcome, "unknown");
    assert.equal(Object.hasOwn(result, "requestId"), false);
    assert.equal(Object.hasOwn(result, "reply"), false);
  }
});

test("status rechecks authorization and native correlation after asynchronous polling", async () => {
  const f = fixture();
  const submitted = await f.puts.execute(f.context, { path, value: 1 });
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
    f.puts.execute(f.context, { path, value: 1 }),
  );
  assert.equal(completions.length, 128);
  await assert.rejects(
    f.puts.execute(f.context, { path, value: 2 }),
    /PUT_REQUEST_CAPACITY/,
  );
  const now = Date.now;
  Date.now = () => now() + 3600001;
  try {
    await assert.rejects(
      f.puts.execute(f.context, { path, value: 2 }),
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
      (await f.puts.execute(f.context, { path, value: 3 })).outcome,
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
  await actions.put(route, { value: false });
  const requestId = randomUUID();
  await actions.getRequest(requestId);
  assert.equal(received[0].method, "PUT");
  assert.deepEqual(JSON.parse(received[0].body), { value: false });
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
      () => actions.put(invalid, { value: 1 }),
      /INVALID_LOCAL_ROUTE/,
    );
  for (const id of ["../plugins", "id?token=secret", "not-a-uuid"])
    assert.throws(() => actions.getRequest(id), /INVALID_LOCAL_ROUTE/);
  replies.push({ status: 302, location: "/plugins/unsafe", body: {} });
  await assert.rejects(
    actions.put(route, { value: 1 }),
    /NATIVE_PUT_REDIRECT_REFUSED/,
  );
  assert.equal(received.length, 3);
  replies.push({ status: 401, body: { error: "unauthorized" } });
  await assert.rejects(
    actions.put(route, { value: 1 }),
    (error) =>
      error instanceof NativeActionHttpError && error.httpStatus === 401,
  );
  const native = fixture().nativeReply("COMPLETED", 403);
  replies.push({ status: 403, body: native });
  assert.deepEqual(await actions.put(route, { value: 1 }), native);
  replies.push({
    status: 200,
    contentType: "text/html",
    body: "<html>not JSON</html>",
  });
  await assert.rejects(actions.put(route, { value: 1 }), /UPSTREAM_NOT_JSON/);
  replies.push({ status: 200, body: "invalid JSON" });
  await assert.rejects(
    actions.put(route, { value: 1 }),
    /UPSTREAM_INVALID_JSON/,
  );
});

test("standing PUT rules cover future paths while enforcing current metadata, native permissions and revocation", async () => {
  const f = fixture({ supportsPut: true, type: "boolean" });
  const rule = {
    kind: "put-rule",
    context: "vessels.self",
    path: "electrical.switches.**",
    decision: "approved",
  };
  f.config.readRequests = { [reviewKey(rule)]: rule };
  const future = "electrical.switches.newDevice.state";
  f.app.getMetadata = (p) =>
    p === `vessels.self.${future}` ? f.state.metadata : undefined;
  f.app.securityStrategy.checkACL = (id, context, p, source, operation) =>
    f.state.allowed &&
    id === "writer" &&
    context === "vessels.self" &&
    p === future &&
    source === null &&
    operation === "put";
  await f.puts.execute(f.context, { path: future, value: false });
  assert.deepEqual(f.state.calls[0].body, { value: false });
  assert.equal(Object.keys(f.requests.schema().properties).length, 0);
  f.state.metadata.description = "New provider description";
  await f.puts.execute(f.context, { path: future, value: true });
  await assert.rejects(
    f.puts.execute(f.context, { path: future, value: 1 }),
    /INVALID_PUT_VALUE/,
  );
  f.state.allowed = false;
  await assert.rejects(
    f.puts.execute(f.context, { path: future, value: true }),
    /PERMISSION_DENIED/,
  );
  f.state.allowed = true;
  f.state.metadata.supportsPut = false;
  await assert.rejects(
    f.puts.execute(f.context, { path: future, value: true }),
    /PUT_UNAVAILABLE/,
  );
  f.state.metadata.supportsPut = true;
  rule.decision = "rejected";
  await assert.rejects(
    f.puts.execute(f.context, { path: future, value: true }),
    /APPROVAL_REJECTED/,
  );
  assert.equal(f.state.calls.length, 2);
  assert.equal(
    putInput.safeParse({ path: "electrical.switches.*", value: 0 }).success,
    false,
  );
  assert.equal(
    putInput.safeParse({ path: future, source: "public", value: 0 }).success,
    false,
  );
});
