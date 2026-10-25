const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { z } = require("zod");
const {
  toJsonSchema,
  timestampSchema,
  uuidSchema,
} = require("../dist/schema.js");
const { configSchema } = require("../dist/config.js");
const {
  valuesInput,
  historyInput,
} = require("../dist/capabilities/schemas.js");
const { discoverOperations } = require("../dist/capabilities/openapi.js");
const { JsonSchemaCompiler } = require("../dist/capabilities/json-schema.js");
const {
  describeResource,
} = require("../dist/capabilities/resource-mutations.js");
const {
  ApprovalRequests,
  applyReviews,
  resourceReview,
  reviewKey,
} = require("../dist/approvals.js");
const baseline = require("./fixtures/zod3-review-keys.json");
const principal = { identifier: "fixture", permissions: "readwrite" };

test("all pinned plugin, native API and resource reviews retain their Zod 3 identities", async () => {
  const actual = {};
  for (const [folder, native] of [
    ["plugin-openapi", false],
    ["native-openapi", true],
  ]) {
    const directory = path.join(__dirname, "fixtures", folder);
    for (const file of fs
      .readdirSync(directory)
      .filter((f) => f.endsWith(".json"))) {
      const id = file.slice(0, -5);
      const document = require(path.join(directory, file));
      for (const operation of discoverOperations(
        document,
        id,
        [],
        principal,
        native ? id : undefined,
      )) {
        if (operation.reason !== "NOT_ALLOWLISTED") continue;
        const key = `${native ? "native" : "plugin"}/${id}/${operation.method}/${operation.id}`;
        const queue = new ApprovalRequests();
        assert.throws(() => queue.request(id, operation), /APPROVAL_PENDING/);
        const review = Object.values(queue.schema().properties)[0].default;
        actual[key] = reviewKey(review);
        assert.equal(actual[key], baseline.reviews[key], key);
        const saved = configSchema.parse({
          readRequests: {
            [baseline.reviews[key]]: { ...review, decision: "approved" },
          },
        });
        assert.equal(
          applyReviews([operation], id, saved.readRequests, principal)[0]
            .enabled,
          true,
          key,
        );
      }
    }
  }
  for (const collection of [
    "routes",
    "waypoints",
    "regions",
    "notes",
    "charts",
    "logentries",
  ]) {
    const provider = "fixture";
    const description = await describeResource(
      {
        authorize: () => principal,
        config: { readRequests: {} },
        get: async (url) =>
          url.endsWith("/_providers")
            ? [provider]
            : { [collection]: { description: collection } },
      },
      { collection, provider },
    );
    for (const operation of description.operations) {
      const review = resourceReview({
        collection,
        provider,
        method: operation.method,
        path: `/signalk/v2/api/resources/${collection}${operation.method === "POST" ? "" : "/{id}"}`,
        description: operation.description,
        inputSchema: operation.inputSchema,
      });
      actual[`resource/${collection}/${operation.id}`] = reviewKey(review);
    }
  }
  assert.deepEqual(actual, baseline.reviews);
});

test("Zod 4 rejects oversized constrained arrays before reading their elements", () => {
  const paths = new Array(65);
  Object.defineProperty(paths, 0, {
    get() {
      throw new Error("Oversized array elements must not be parsed");
    },
  });
  const result = valuesInput.safeParse({ paths });
  assert.equal(result.success, false);
  assert.equal(result.error.issues[0].code, "too_big");
});

test("configuration defaults, strictness and provider timestamp spellings stay compatible", () => {
  assert.deepEqual(configSchema.parse({}), {
    pluginOperations: [],
    readRequests: {},
    staleAfterSeconds: 300,
  });
  assert.equal(configSchema.safeParse({ unexpected: true }).success, false);
  const uuid = "12345678-1234-1234-1234-123456789abc";
  assert.equal(uuidSchema.parse(uuid), uuid);
  for (const from of [
    "2026-10-25T12:00Z",
    "2026-10-25T12:00:00Z",
    "2026-10-25T12:00:00.123+0200",
    "2026-10-25T12:00:00+02:00",
  ]) {
    assert.equal(timestampSchema.parse(from), from);
    assert.equal(
      historyInput.parse({ paths: [{ path: "navigation.position" }], from })
        .from,
      from,
    );
  }
  for (const value of [
    "2026-02-30T12:00:00Z",
    "2026-10-25T25:00:00Z",
    "tomorrow",
  ])
    assert.equal(timestampSchema.safeParse(value).success, false);
});

test("native conversion preserves bounded custom JSON and rejects arbitrary unrepresentable types", () => {
  const compiler = new JsonSchemaCompiler({});
  const bounded = compiler.parse({}, "body");
  const schema = compiler.json(bounded);
  assert.match(schema.description, /2048 nodes/);
  assert.equal(bounded.safeParse({ description: "ok", zero: 0 }).success, true);
  assert.equal(bounded.safeParse(Array(129).fill(0)).success, false);
  for (const input of [z.custom(() => true), z.bigint(), z.date()])
    assert.throws(() => toJsonSchema(input));
  const recursive = z.lazy(() => z.object({ child: recursive }));
  assert.throws(() => toJsonSchema(recursive), /cycle/i);
});

test("schema keyword names in object properties are not treated as schema nodes", () => {
  const schema = toJsonSchema(
    z
      .object({
        type: z.string(),
        anyOf: z.array(z.string()),
        propertyNames: z.object({ type: z.string() }).strict(),
      })
      .strict(),
  );
  assert.deepEqual(Object.keys(schema.properties), [
    "type",
    "anyOf",
    "propertyNames",
  ]);
  assert.equal(schema.properties.propertyNames.type, "object");
  assert.equal(schema.properties.anyOf.type, "array");
});
