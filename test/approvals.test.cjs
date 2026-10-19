const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  ApprovalRequests,
  applyReviews,
  applyPutReview,
  putReview,
  reviewKey,
} = require("../dist/approvals.js");
const { discoverOperations } = require("../dist/capabilities/openapi.js");
const { configSchema } = require("../dist/config.js");
const reader = { identifier: "reader", permissions: "readonly" };
const writer = { identifier: "writer", permissions: "readwrite" };
const putTarget = {
  context: "vessels.self",
  path: "steering.autopilot.target.headingTrue",
  source: "fixture.autopilot",
  metadata: { description: "Desired heading", units: "rad" },
  inputSchema: { type: "number", minimum: 0, maximum: 6.28 },
};
const document = {
  openapi: "3.0.3",
  paths: {
    "/read": {
      get: {
        operationId: "read",
        summary: "Read fixture",
        parameters: [
          {
            name: "count",
            in: "query",
            schema: { type: "integer", maximum: 10 },
          },
        ],
      },
    },
    "/write": { post: { operationId: "write" } },
  },
};
const operations = (doc = document) =>
  discoverOperations(doc, "fixture", [], reader);
function queued(requests) {
  return Object.fromEntries(
    Object.entries(requests.schema().properties).map(([key, schema]) => [
      key,
      globalThis.structuredClone(schema.default),
    ]),
  );
}
test("requests deduplicate without granting access or keeping arguments, and are bounded", () => {
  const requests = new ApprovalRequests();
  const [read, write] = operations();
  for (let i = 0; i < 10; i++)
    assert.throws(() => requests.request("fixture", read), /APPROVAL_PENDING/);
  assert.equal(Object.keys(queued(requests)).length, 1);
  assert.equal(read.enabled, false);
  assert.throws(
    () =>
      requests.request("fixture", {
        ...write,
        method: "DELETE",
        reason: "METHOD_NOT_READONLY",
      }),
    /OPERATION_DISABLED/,
  );
  const review = Object.values(queued(requests))[0];
  assert.deepEqual(
    Object.keys(review).sort(),
    [
      "pluginId",
      "operationId",
      "path",
      "schemaHash",
      "description",
      "decision",
      "permission",
    ].sort(),
  );
  for (let i = 1; i < 64; i++)
    assert.throws(
      () => requests.request(`fixture-${i}`, read),
      /APPROVAL_PENDING/,
    );
  assert.throws(
    () => requests.request("fixture-overflow", read),
    /APPROVAL_QUEUE_FULL/,
  );
  assert.equal(Object.keys(queued(requests)).length, 64);
  requests.reset();
  assert.equal(Object.keys(queued(requests)).length, 0);
});
test("saved reviews bind exact operation/schema and retain native principal restrictions", () => {
  const requests = new ApprovalRequests();
  assert.throws(
    () => requests.request("fixture", operations()[0]),
    /APPROVAL_PENDING/,
  );
  const reviews = queued(requests);
  const [key, review] = Object.entries(reviews)[0];
  assert.equal(reviewKey(review), key);
  review.decision = "approved";
  review.permission = "admin";
  assert.equal(configSchema.safeParse({ readRequests: reviews }).success, true);
  assert.equal(
    applyReviews(operations(), "fixture", reviews, reader)[0].reason,
    "PERMISSION_DENIED",
  );
  assert.equal(
    applyReviews(operations(), "fixture", reviews, {
      ...reader,
      permissions: "admin",
    })[0].enabled,
    true,
  );
  review.permission = "readonly";
  assert.equal(
    applyReviews(operations(), "fixture", reviews, reader)[0].enabled,
    true,
  );
  for (const mutate of [
    (doc) => {
      doc.paths["/read"].get.parameters[0].schema.maximum = 20;
    },
    (doc) => {
      doc.paths["/read"].get.operationId = "renamed";
    },
    (doc) => {
      doc.paths["/new"] = doc.paths["/read"];
      delete doc.paths["/read"];
    },
    (doc) => {
      doc.paths["/read"].get.summary = "Changed behavior";
    },
  ]) {
    const changed = globalThis.structuredClone(document);
    mutate(changed);
    assert.equal(
      applyReviews(operations(changed), "fixture", reviews, reader).some(
        (op) => op.enabled,
      ),
      false,
    );
  }
  review.decision = "rejected";
  requests.reset(reviews);
  assert.throws(
    () => requests.request("fixture", operations()[0]),
    /APPROVAL_REJECTED/,
  );
  assert.equal(
    applyReviews(operations(), "fixture", reviews, reader)[0].reason,
    "APPROVAL_REJECTED",
  );
  assert.equal(Object.keys(queued(requests)).length, 1);
  review.path = "/other";
  assert.equal(
    configSchema.safeParse({ readRequests: reviews }).success,
    false,
  );
});

test("a rejection overrides a matching manual approval without weakening admin restrictions", () => {
  const requests = new ApprovalRequests();
  assert.throws(
    () => requests.request("fixture", operations()[0]),
    /APPROVAL_PENDING/,
  );
  const reviews = queued(requests);
  const review = Object.values(reviews)[0];
  const manual = [
    {
      pluginId: "fixture",
      operationId: "read",
      method: "GET",
      path: "/read",
      readOnly: true,
      permission: "admin",
    },
  ];
  review.decision = "approved";
  assert.equal(
    applyReviews(
      discoverOperations(document, "fixture", manual, reader),
      "fixture",
      reviews,
      reader,
    )[0].enabled,
    false,
  );
  manual[0].permission = "readonly";
  review.permission = "admin";
  assert.equal(
    applyReviews(
      discoverOperations(document, "fixture", manual, reader),
      "fixture",
      reviews,
      reader,
    )[0].enabled,
    false,
  );
  review.decision = "rejected";
  const admin = { ...reader, permissions: "admin" };
  const rejected = applyReviews(
    discoverOperations(document, "fixture", manual, admin),
    "fixture",
    reviews,
    admin,
  )[0];
  assert.equal(rejected.enabled, false);
  assert.equal(rejected.reason, "APPROVAL_REJECTED");
  const ambiguous = operations()[0];
  ambiguous.reason = "AMBIGUOUS_OPERATION_ID";
  assert.throws(
    () => requests.request("fixture", ambiguous),
    /OPERATION_DISABLED/,
  );
});

test("legacy GET review keys and saved configuration remain unchanged alongside PUT reviews", () => {
  const legacy = {
    pluginId: "fixture",
    operationId: "read",
    path: "/read",
    description: "Example",
    schemaHash: "a".repeat(64),
    decision: "approved",
    permission: "readonly",
  };
  assert.equal(
    reviewKey(legacy),
    "6ae3f8833200b42ee609aca829e3ad5d2fd12cbe0a9ae730b9352c08119c1c7b",
  );
  const put = putReview(putTarget);
  const reviews = { [reviewKey(legacy)]: legacy, [reviewKey(put)]: put };
  const parsed = configSchema.parse({ readRequests: reviews });
  assert.deepEqual(parsed.readRequests, reviews);
  assert.equal("kind" in parsed.readRequests[reviewKey(legacy)], false);
});

test("PUT approval binds exact source, path, meaning and value schema with canonical object keys", () => {
  const accepted = { ...putReview(putTarget), decision: "approved" };
  const reviews = { [reviewKey(accepted)]: accepted };
  const allowed = applyPutReview(putTarget, reviews, writer);
  assert.deepEqual(allowed, {
    enabled: true,
    reason: null,
    status: "approved",
  });
  for (const permissions of ["readonly", "unknown", ""])
    assert.equal(
      applyPutReview(putTarget, reviews, { ...reader, permissions }).reason,
      "PERMISSION_DENIED",
    );
  assert.equal(
    applyPutReview(putTarget, reviews, { ...writer, permissions: "admin" })
      .enabled,
    true,
  );
  for (const changes of [
    { source: "fixture.other" },
    { path: "steering.autopilot.target.headingMagnetic" },
    {
      metadata: {
        ...putTarget.metadata,
        description: "Changed control meaning",
      },
    },
    { metadata: { ...putTarget.metadata, units: "deg" } },
    { inputSchema: { ...putTarget.inputSchema, maximum: 360 } },
  ])
    assert.equal(
      applyPutReview({ ...putTarget, ...changes }, reviews, writer).reason,
      "NOT_ALLOWLISTED",
    );
  const reordered = {
    ...putTarget,
    metadata: { units: "rad", description: "Desired heading" },
    inputSchema: { maximum: 6.28, minimum: 0, type: "number" },
  };
  assert.equal(reviewKey(putReview(reordered)), reviewKey(accepted));
  assert.equal(applyPutReview(reordered, reviews, writer).enabled, true);
  accepted.decision = "pending";
  assert.equal(applyPutReview(putTarget, reviews, writer).enabled, false);
  accepted.decision = "rejected";
  assert.equal(
    applyPutReview(putTarget, reviews, { ...writer, permissions: "admin" })
      .reason,
    "APPROVAL_REJECTED",
  );
});

test("PUT reviews reject gateway permission policy, forged keys and broad targets", () => {
  const review = putReview(putTarget);
  const key = reviewKey(review);
  for (const changes of [
    { permission: "readonly" },
    { permission: "readwrite" },
    { permission: "admin" },
    { permission: "anyone" },
    { source: "*" },
    { source: "fixture?" },
    { source: "[fixture]" },
    { source: "fixture source" },
    { context: "vessels.other" },
    { path: "steering.*" },
    { metadata: { ...review.metadata, units: "deg" } },
    { inputSchema: { type: "string" } },
    { value: 1 },
    { token: "not-a-real-token" },
  ]) {
    const forged = { ...review, decision: "approved", ...changes };
    assert.equal(
      configSchema.safeParse({ readRequests: { [key]: forged } }).success,
      false,
    );
    assert.equal(
      applyPutReview(putTarget, { [key]: forged }, writer).enabled,
      false,
    );
  }
  assert.equal(
    configSchema.safeParse({ readRequests: { ["b".repeat(64)]: review } })
      .success,
    false,
  );
  for (const changes of [
    { source: "" },
    { source: "bad\nsource" },
    { metadata: { invalid: undefined } },
    { metadata: { tooLarge: "x".repeat(32768) } },
  ])
    assert.throws(
      () => putReview({ ...putTarget, ...changes }),
      /OPERATION_DISABLED/,
    );
});

test("PUT requests queue only immutable administrative metadata and share the bounded GET queue", () => {
  const requests = new ApprovalRequests();
  const target = globalThis.structuredClone(putTarget);
  for (let i = 0; i < 3; i++)
    assert.throws(
      () =>
        requests.requestPut({ ...target, value: 2, token: "not-a-real-token" }),
      /APPROVAL_PENDING/,
    );
  const pending = Object.values(queued(requests))[0];
  assert.deepEqual(
    Object.keys(pending).sort(),
    [
      "kind",
      "context",
      "path",
      "source",
      "metadata",
      "inputSchema",
      "schemaHash",
      "decision",
    ].sort(),
  );
  assert.equal(JSON.stringify(pending).includes("not-a-real-token"), false);
  target.metadata.units = "deg";
  assert.equal(Object.values(queued(requests))[0].metadata.units, "rad");
  // A review draft never changes execution authorization; only saved config is supplied.
  pending.decision = "approved";
  assert.equal(applyPutReview(putTarget, {}, writer).enabled, false);
  assert.equal(Object.values(queued(requests))[0].decision, "pending");
  for (let i = 0; i < 63; i++)
    assert.throws(
      () => requests.request(`fixture-${i}`, operations()[0]),
      /APPROVAL_PENDING/,
    );
  assert.throws(() => requests.requestPut(putTarget), /APPROVAL_PENDING/);
  assert.throws(
    () => requests.requestPut({ ...putTarget, source: "fixture.other" }),
    /APPROVAL_QUEUE_FULL/,
  );
  assert.equal(Object.keys(queued(requests)).length, 64);
  const rejected = { ...putReview(putTarget), decision: "rejected" };
  requests.reset({ [reviewKey(rejected)]: rejected });
  assert.throws(() => requests.requestPut(putTarget), /APPROVAL_REJECTED/);
  const schema = Object.values(requests.schema().properties)[0];
  assert.equal(Object.hasOwn(schema.properties, "permission"), false);
  assert.equal(Object.hasOwn(schema.default, "permission"), false);
  assert.match(schema.description, /fixture.autopilot/);
  assert.match(schema.description, /Desired heading/);
  assert.match(schema.description, /maximum/);
});

test("fallback approval forms expose only decisions and keep legacy GET permission immutable", () => {
  const requests = new ApprovalRequests();
  assert.throws(
    () => requests.request("fixture", operations()[0]),
    /APPROVAL_PENDING/,
  );
  assert.throws(() => requests.requestPut(putTarget), /APPROVAL_PENDING/);
  const schemas = requests.schema().properties;
  const ui = requests.uiSchema();
  for (const [key, schema] of Object.entries(schemas)) {
    for (const [field, property] of Object.entries(schema.properties)) {
      if (field === "decision") continue;
      assert.equal(property.readOnly, true);
      assert.equal(ui[key][field]["ui:widget"], "hidden");
      assert.equal(property.oneOf, undefined);
    }
    if (!schema.default.kind)
      assert.equal(schema.properties.permission.const, "readonly");
  }
});
