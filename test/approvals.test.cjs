const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  ApprovalRequests,
  applyReviews,
  reviewKey,
} = require("../dist/approvals.js");
const { discoverOperations } = require("../dist/capabilities/openapi.js");
const { configSchema } = require("../dist/config.js");
const reader = { identifier: "reader", permissions: "readonly" };
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
  assert.throws(() => requests.request("fixture", write), /OPERATION_DISABLED/);
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
