const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  discoverOperations,
  operationRoute,
} = require("../dist/capabilities/openapi.js");
const { JsonSchemaCompiler } = require("../dist/capabilities/json-schema.js");
const writer = { identifier: "fixture", permissions: "readwrite" };
const load = (id) => require(`./fixtures/plugin-openapi/${id}.json`);
const operations = (id) => discoverOperations(load(id), id, [], writer);
const operation = (id, name) => {
  const op = operations(id).find((item) => item.id === name);
  assert.ok(op, name);
  assert.equal(op.reason, "NOT_ALLOWLISTED", JSON.stringify(op.schemaIssue));
  return op;
};

test("seven pinned plugin contracts are admitted by the shared parser or explain their remaining boundary", () => {
  const expected = {
    "signalk-alert-center": [28, 27],
    "signalk-stowage-mgmt": [36, 35],
    "hoekens-anchor-alarm": [11, 7],
    kip: [11, 11],
    "freeboard-sk": [5, 0],
    "signalk-logbook": [6, 6],
    "resources-provider": [3, 1],
  };
  for (const [id, [total, admitted]] of Object.entries(expected)) {
    const entries = operations(id);
    assert.equal(entries.length, total, id);
    assert.equal(
      entries.filter((op) => op.reason === "NOT_ALLOWLISTED").length,
      admitted,
      id,
    );
    assert.ok(
      entries.every((op) => !op.enabled),
      "No schema grants approval",
    );
  }
  assert.equal(
    operations("signalk-alert-center").find((op) => op.path === "/events")
      .reason,
    "UNSUPPORTED_RESPONSE",
  );
  assert.ok(
    operations("freeboard-sk").every((op) => op.reason === "UNSUPPORTED_ROUTE"),
  );
  assert.deepEqual(
    operations("signalk-stowage-mgmt").find(
      (op) => op.path.endsWith("/attachments") && op.method === "POST",
    ).schemaIssue,
    { location: "requestBody", keyword: "application/json-content" },
  );
});

test("Alert Center date filters and policy JSON validate precisely without defaults or stripping", () => {
  for (const name of ["get.alert-history", "get.occurrences"]) {
    const op = operation("signalk-alert-center", name);
    const args = {
      from: "2026-10-22T09:00:00+02:00",
      to: "2026-10-22T12:00:00Z",
      limit: 1,
    };
    assert.deepEqual(op.input.parse(args), args);
    assert.deepEqual(op.input.parse({}), {});
    assert.equal(op.input.safeParse({ from: "tomorrow" }).success, false);
  }
  const op = operation(
    "signalk-alert-center",
    "patch.definitions.by-id.policy",
  );
  const args = {
    id: "sample",
    body: {
      enabled: false,
      notifierIds: ["synthetic"],
      notifierRepeatOverrides: { "synthetic-notifier": 0 },
      soundId: "sample_1",
      connectivity: { mode: "wake_after", delaySeconds: 0 },
    },
  };
  assert.deepEqual(op.input.parse(args), args);
  for (const body of [
    {},
    { notifierIds: ["same", "same"] },
    { soundId: "../file" },
    { connectivity: { mode: "wake_after" } },
    { connectivity: { mode: "queue", delaySeconds: 1 } },
    { connectivity: { mode: "wake_after", delaySeconds: -1 } },
  ])
    assert.equal(
      op.input.safeParse({ id: "sample", body }).success,
      false,
      JSON.stringify(body),
    );
  const schema = op.inputSchema.properties.body;
  assert.equal(schema.minProperties, 1);
  assert.equal(schema.properties.notifierIds.uniqueItems, true);
  assert.ok(schema.properties.connectivity.oneOf);
});

test("Stowage nested JSON keeps null, zero and empty arrays distinct from omission", () => {
  const op = operation("signalk-stowage-mgmt", "patch.items.by-id");
  const args = {
    id: "1",
    body: {
      target_quantity: null,
      notes: null,
      actual_quantity: 0,
    },
  };
  assert.deepEqual(op.input.parse(args), args);
  assert.deepEqual(op.input.parse({ id: "1", body: { notes: "" } }), {
    id: "1",
    body: { notes: "" },
  });
  const create = operation("signalk-stowage-mgmt", "post.items");
  const valid = {
    body: {
      name: "Fixture",
      category_ids: [],
      expires_at: "2026-10-22",
      acquired_date: null,
      price_paid: 0,
    },
  };
  assert.deepEqual(create.input.parse(valid), valid);
  assert.equal(
    create.input.safeParse({
      body: { name: "Fixture", expires_at: "2026-02-30" },
    }).success,
    false,
  );
});

test("Logbook heterogeneous telemetry and timestamp path parameters remain unchanged", () => {
  const op = operation("signalk-logbook", "put.logs.by-date.by-datetime");
  const body = {
    datetime: "2026-10-22T12:30:00.000Z",
    text: "Fixture",
    telemetry: [
      { path: "navigation.position", value: { latitude: 0, longitude: 0 } },
    ],
  };
  // Schema is the legacy provider contract; its exact required fields are checked.
  const args = {
    date: "2026-10-22",
    datetime: "2026-10-22T12:30:00.000Z",
    body,
  };
  assert.deepEqual(op.input.parse(args), args);
  assert.equal(
    operationRoute("signalk-logbook", { ...op, enabled: true }, args),
    "/plugins/signalk-logbook/logs/2026-10-22/2026-10-22T12%3A30%3A00.000Z",
  );
});

test("KIP plugin-prefixed routes normalize once and allOf preserves every field while oneOf rejects overlap", () => {
  const op = operations("kip").find(
    (item) => item.method === "PUT" && item.path.includes("/series/{seriesId}"),
  );
  assert.equal(op.reason, "NOT_ALLOWLISTED");
  const body = {
    seriesId: "one",
    datasetUuid: "two",
    ownerWidgetUuid: "three",
    ownerWidgetSelector: null,
    path: "navigation.speedOverGround",
    enabled: false,
    expansionMode: null,
  };
  const args = { seriesId: "one", body };
  assert.deepEqual(op.input.parse(args), args);
  assert.equal(
    operationRoute("kip", { ...op, enabled: true }, args),
    "/plugins/kip/series/one",
  );
  // Published concrete variant also permits these values: exact oneOf means
  // the overlapping template shape is invalid, rather than choosing a branch.
  assert.equal(
    op.input.safeParse({
      seriesId: "one",
      body: {
        ...body,
        ownerWidgetSelector: "widget-bms",
        expansionMode: "bms-battery-tree",
        familyKey: "batteries",
      },
    }).success,
    false,
  );
});

test("JSON schema compiler rejects unsupported constraints, recursive references, unsafe keys and unbounded values", () => {
  const parse = (schema) => new JsonSchemaCompiler({}).parse(schema, "body");
  for (const schema of [
    { type: "string", pattern: "(a+)+$" },
    { type: "string", pattern: "^[a]{0,9999}[a]{0,9999}$" },
    { type: "string", format: "binary" },
    { type: "object", properties: { password: { type: "string" } } },
    { type: "array", maxItems: 129, items: {} },
    { type: "number", multipleOf: 2 },
    { type: "object", unevaluatedProperties: false },
  ])
    assert.throws(() => parse(schema), /UNSUPPORTED_SCHEMA/);
  const doc = {
    components: {
      schemas: {
        loop: {
          type: "object",
          properties: { child: { $ref: "#/components/schemas/loop" } },
        },
      },
    },
  };
  assert.throws(
    () =>
      new JsonSchemaCompiler(doc).parse(
        { $ref: "#/components/schemas/loop" },
        "body",
      ),
    /UNSUPPORTED_SCHEMA/,
  );
  const any = parse({});
  for (const input of [
    undefined,
    new Date(),
    new (class Example {})(),
    NaN,
    Infinity,
    "x".repeat(16385),
    Array(129).fill(0),
    { secret: "never" },
    JSON.parse('{"__proto__":{}}'),
  ])
    assert.equal(any.safeParse(input).success, false);
  let deep = null;
  for (let i = 0; i < 10; i++) deep = [deep];
  assert.equal(any.safeParse(deep).success, false);
  assert.deepEqual(any.parse({ reading: [0, null, false, ""] }), {
    reading: [0, null, false, ""],
  });
  const nullable = parse({ type: ["string", "null"], maxLength: 4 });
  assert.equal(nullable.parse(null), null);
  assert.equal(nullable.safeParse("longer").success, false);
  const exclusive = parse({
    type: "number",
    minimum: 0,
    exclusiveMinimum: true,
  });
  assert.equal(exclusive.safeParse(0).success, false);
  assert.equal(exclusive.parse(1), 1);
});

test("same-plugin prefixed paths support scoped and dotted IDs while preserving exact reviewed paths", () => {
  for (const id of ["@Scope/MixedCase", "Mixed.Case", "MixedCase"]) {
    const path = `/plugins/${id}/record/{id}`;
    const document = {
      openapi: "3.0.3",
      paths: {
        [path]: {
          put: {
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
          },
        },
      },
    };
    const [op] = discoverOperations(document, id, [], writer);
    assert.equal(op.reason, "NOT_ALLOWLISTED");
    assert.equal(op.path, path);
    assert.equal(
      operationRoute(id, { ...op, enabled: true }, { id: "sample" }),
      `/plugins/${id}/record/sample`,
    );
    const other = discoverOperations(document, "other", [], writer)[0];
    // Scoped foreign paths may also fail the route-derived identifier bound;
    // they must never become executable or reviewable.
    assert.ok(!other || other.reason === "UNSUPPORTED_ROUTE");
  }
});
