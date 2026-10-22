const { test } = require("node:test");
const assert = require("node:assert/strict");
const { discoverOperations } = require("../dist/capabilities/openapi.js");
const { ApprovalRequests } = require("../dist/approvals.js");
const { CapabilityRegistry } = require("../dist/capabilities/registry.js");
const { configSchema } = require("../dist/config.js");
const { localPost } = require("../dist/capabilities/http.js");
const writer = { identifier: "writer", permissions: "readwrite" };
function spec() {
  return {
    openapi: "3.0.3",
    info: { version: "1" },
    paths: {
      "/action/{id}": {
        post: {
          operationId: "act",
          summary: "Synthetic action",
          description: "Changes the synthetic state",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["enabled", "level"],
                  properties: {
                    enabled: { type: "boolean" },
                    level: { type: "integer", minimum: 0, maximum: 10 },
                    note: { type: "string", maxLength: 10 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: "Action result" } },
        },
      },
    },
  };
}
function fixture(method = "POST") {
  const doc = spec();
  if (method !== "POST") {
    doc.paths["/action/{id}"][method.toLowerCase()] =
      doc.paths["/action/{id}"].post;
    delete doc.paths["/action/{id}"].post;
  }
  const requests = new ApprovalRequests();
  const config = configSchema.parse({});
  let principal = writer;
  let enabled = true;
  let running = true;
  let onGet = () => {};
  let post = async () => ({
    status: 200,
    data: { state: "COMPLETED", statusCode: 502 },
  });
  const calls = [];
  const app = {
    getFeatures: async () => ({
      apis: [],
      plugins: [{ id: "fixture", enabled, version: "1" }],
    }),
    securityStrategy: {
      isDummy: () => false,
      checkACL: () => true,
      authorizeWS: (connection) => {
        connection.skIsAuthenticated = true;
        connection.skPrincipal = principal;
      },
    },
  };
  const registry = new CapabilityRegistry(
    app,
    "Bearer synthetic",
    config,
    () => running,
    async () => {
      onGet();
      return doc;
    },
    requests,
    undefined,
    undefined,
    async (route, body) => {
      calls.push({ route, body });
      return post();
    },
    undefined,
    method === "POST"
      ? undefined
      : async (verb, route, body) => {
          calls.push({ method: verb, route, body });
          return post();
        },
  );
  const reviews = () =>
    Object.fromEntries(
      Object.entries(requests.schema().properties).map(([k, v]) => [
        k,
        globalThis.structuredClone(v.default),
      ]),
    );
  const approve = () => {
    config.readRequests = reviews();
    for (const v of Object.values(config.readRequests)) v.decision = "approved";
    requests.reset(config.readRequests);
  };
  const execute = (args = { id: "demo", body: { enabled: false, level: 0 } }) =>
    registry.executeMutation("plugin.fixture", "act", args);
  return {
    doc,
    requests,
    config,
    calls,
    registry,
    reviews,
    approve,
    execute,
    principal: (p) => {
      principal = p;
    },
    enabled: (v) => {
      enabled = v;
    },
    running: (v) => {
      running = v;
    },
    onGet: (f) => {
      onGet = f;
    },
    post: (f) => {
      post = f;
    },
  };
}
test("POSTs queue only metadata, require individual saved review and preserve false/zero", async () => {
  const f = fixture();
  await assert.rejects(f.execute(), /APPROVAL_PENDING/);
  assert.equal(f.calls.length, 0);
  const review = Object.values(f.reviews())[0];
  assert.equal(review.kind, "post");
  assert.equal(review.method, "POST");
  assert.ok(review.inputSchema.properties.body);
  assert.ok(!JSON.stringify(review).includes("Bearer synthetic"));
  assert.equal("arguments" in review, false);
  f.approve();
  assert.ok(configSchema.safeParse(f.config).success);
  const result = await f.execute();
  assert.deepEqual(f.calls, [
    {
      route: "/plugins/fixture/action/demo",
      body: { enabled: false, level: 0 },
    },
  ]);
  assert.equal(result.outcome, "responded");
  assert.equal(result.retrySafe, false);
  assert.deepEqual(result.data, { state: "COMPLETED", statusCode: 502 });
  await assert.rejects(
    f.registry.execute("plugin.fixture", "act", {}),
    /MUTATION_TOOL_REQUIRED/,
  );
});
test("POST approval binds contract, not package/document version or unrelated endpoints", async () => {
  const f = fixture();
  await assert.rejects(f.execute(), /APPROVAL_PENDING/);
  f.approve();
  f.doc.info.version = "2";
  f.doc.paths["/unrelated"] = { get: { summary: "Other read" } };
  await f.execute();
  assert.equal(f.calls.length, 1);
  for (const change of [
    (op) => {
      op.summary += " changed";
    },
    (op) => {
      op.description += " changed";
    },
    (op) => {
      op.requestBody.content[
        "application/json"
      ].schema.properties.level.maximum = 9;
    },
    (op) => {
      op.parameters[0].description = "Different target meaning";
    },
    (op) => {
      op.responses[200].description += " changed";
    },
  ]) {
    const original = globalThis.structuredClone(
      f.doc.paths["/action/{id}"].post,
    );
    change(f.doc.paths["/action/{id}"].post);
    await assert.rejects(f.execute(), /APPROVAL_PENDING/);
    f.doc.paths["/action/{id}"].post = original;
  }
  assert.equal(f.calls.length, 1);
  const doc = spec();
  doc.paths["/action/{id}"].post.requestBody.content[
    "application/json"
  ].schema.properties.level = { $ref: "#/components/schemas/Level" };
  doc.components = {
    schemas: { Level: { type: "integer", minimum: 0, maximum: 10 } },
  };
  const before = discoverOperations(doc, "fixture", [], writer)[0].contractHash;
  doc.components.schemas.Level.maximum = 20;
  assert.notEqual(
    discoverOperations(doc, "fixture", [], writer)[0].contractHash,
    before,
  );
});
test("POSTs deny readers, rejections, revoked identities, disabled providers and lifecycle changes before dispatch", async () => {
  const f = fixture();
  f.principal({ ...writer, permissions: "readonly" });
  await assert.rejects(f.execute(), /PERMISSION_DENIED/);
  assert.deepEqual(f.reviews(), {});
  f.principal(writer);
  await assert.rejects(f.execute(), /APPROVAL_PENDING/);
  f.approve();
  Object.values(f.config.readRequests)[0].decision = "rejected";
  await assert.rejects(f.execute(), /APPROVAL_REJECTED/);
  Object.values(f.config.readRequests)[0].decision = "approved";
  f.onGet(() => f.principal({ ...writer, permissions: "readonly" }));
  await assert.rejects(f.execute(), /PERMISSION_DENIED/);
  f.principal(writer);
  f.onGet(() => f.running(false));
  await assert.rejects(f.execute(), /PLUGIN_STOPPED/);
  f.running(true);
  f.onGet(() => f.enabled(false));
  await assert.rejects(f.execute(), /CAPABILITY_UNAVAILABLE/);
  assert.equal(f.calls.length, 0);
});
test("POST JSON subset fails closed for uploads, arbitrary bodies, unsafe routes and unsupported schema semantics", async () => {
  for (const change of [
    (op) => {
      op.requestBody.content["multipart/form-data"] =
        op.requestBody.content["application/json"];
    },
    (op) => {
      op.requestBody.content["application/json"].schema.additionalProperties =
        "yes";
    },
    (op) => {
      op.requestBody.content["application/json"].schema.properties.level = {
        type: "array",
      };
    },
    (op) => {
      op.requestBody.content[
        "application/json"
      ].schema.properties.level.nullable = "yes";
    },
    (op) => {
      op.requestBody.content["application/json"].schema.properties.url = {
        type: "string",
      };
    },
    (op) => {
      op.requestBody.content["application/json"].schema.required.push(
        "missing",
      );
    },
  ]) {
    const doc = spec();
    change(doc.paths["/action/{id}"].post);
    const op = discoverOperations(doc, "fixture", [], writer)[0];
    assert.equal(op.enabled, false);
    assert.notEqual(op.reason, "NOT_ALLOWLISTED");
  }
  const f = fixture();
  await assert.rejects(f.execute(), /APPROVAL_PENDING/);
  f.approve();
  for (const args of [
    { id: "../config", body: { enabled: false, level: 0 } },
    { id: "demo" },
    { id: "demo", body: { enabled: false, level: -1 } },
    { id: "demo", body: { enabled: false, level: 0, extra: 1 } },
    { id: "demo", body: null },
  ])
    await assert.rejects(f.execute(args), /INVALID_ARGUMENTS/);
  assert.equal(f.calls.length, 0);
  const doc = {
    openapi: "3.0.3",
    paths: { "/config": { post: { operationId: "config" } } },
  };
  assert.equal(
    discoverOperations(doc, "fixture", [], writer)[0].reason,
    "UNSUPPORTED_ROUTE",
  );
  const noBody = discoverOperations(
    { openapi: "3.0.3", paths: { "/act": { post: { operationId: "act" } } } },
    "fixture",
    [],
    writer,
  )[0];
  assert.equal(noBody.input.safeParse({ body: {} }).success, false);
  assert.equal(noBody.input.safeParse({}).success, true);
});
test("GET manual approvals cannot authorize POST; mutation boundary cannot execute GET", async () => {
  const f = fixture();
  f.config.pluginOperations.push({
    pluginId: "fixture",
    operationId: "act",
    method: "GET",
    path: "/action/{id}",
    readOnly: true,
    permission: "readonly",
  });
  await assert.rejects(f.execute(), /APPROVAL_PENDING/);
  f.doc.paths["/action/{id}"].get = { operationId: "read" };
  await assert.rejects(
    f.registry.executeMutation("plugin.fixture", "read", {}),
    /OPERATION_DISABLED/,
  );
  assert.equal(f.calls.length, 0);
});
test("POST responses preserve pending data and uncertain outcomes never retry", async () => {
  const f = fixture();
  await assert.rejects(f.execute(), /APPROVAL_PENDING/);
  f.approve();
  f.post(async () => ({
    status: 202,
    data: { requestId: "provider-owned", state: "PENDING" },
  }));
  assert.equal((await f.execute()).outcome, "accepted");
  f.post(async () => {
    throw new Error("secret upstream details");
  });
  const result = await f.execute();
  assert.equal(result.outcome, "unknown");
  assert.equal(result.retrySafe, false);
  assert.equal(result.submitted, true);
  assert.equal(f.calls.length, 2);
  assert.ok(!JSON.stringify(result).includes("secret"));
  f.post(async () => {
    f.running(false);
    return { status: 200, data: { secret: true } };
  });
  const revoked = await f.execute();
  assert.equal(revoked.outcome, "unknown");
  assert.equal(revoked.data, undefined);
});
test("POST adapter refuses arbitrary destinations and configuration routes", async () => {
  const post = localPost(
    { socket: { localAddress: "127.0.0.1", localPort: 1 } },
    "Bearer fixture",
    new AbortController().signal,
  );
  for (const route of [
    "https://example.invalid/",
    "/plugins/fixture/config",
    "/plugins/signalk-mcp/act",
    "/plugins/fixture/../config",
    "/plugins/fixture/action#fragment",
    "/signalk/v1/api/test",
  ])
    await assert.rejects(post(route, {}), /INVALID_LOCAL_ROUTE/);
});

test("POST reserves body argument and binds inherited endpoint meaning/security", () => {
  const doc = {
    openapi: "3.0.3",
    paths: {
      "/action": {
        post: {
          operationId: "act",
          parameters: [
            { name: "body", in: "query", schema: { type: "string" } },
          ],
        },
      },
    },
  };
  assert.equal(
    discoverOperations(doc, "fixture", [], writer)[0].reason,
    "UNSUPPORTED_PARAMETER",
  );
  delete doc.paths["/action"].post.parameters;
  const original = discoverOperations(doc, "fixture", [], writer)[0]
    .contractHash;
  doc.security = [{ bearer: [] }];
  assert.notEqual(
    discoverOperations(doc, "fixture", [], writer)[0].contractHash,
    original,
  );
  delete doc.security;
  doc.paths["/action"].description = "Changed endpoint meaning";
  assert.notEqual(
    discoverOperations(doc, "fixture", [], writer)[0].contractHash,
    original,
  );
});
test("POST revocation after dispatch hides provider data and preserves uncertainty", async () => {
  for (const revoke of [
    (f) => f.principal({ ...writer, permissions: "readonly" }),
    (f) => {
      f.config.readRequests = {};
    },
  ]) {
    const f = fixture();
    await assert.rejects(f.execute(), /APPROVAL_PENDING/);
    f.approve();
    f.post(async () => {
      revoke(f);
      return { status: 200, data: { protected: "fixture result" } };
    });
    const result = await f.execute();
    assert.equal(result.outcome, "unknown");
    assert.equal(result.data, undefined);
    assert.equal(f.calls.length, 1);
  }
});

test("POST contract approval ignores object-key and required-field ordering", async () => {
  const f = fixture();
  await assert.rejects(f.execute(), /APPROVAL_PENDING/);
  f.approve();
  const schema =
    f.doc.paths["/action/{id}"].post.requestBody.content["application/json"]
      .schema;
  schema.properties = Object.fromEntries(
    Object.entries(schema.properties).reverse(),
  );
  schema.required.reverse();
  await f.execute();
  assert.equal(f.calls.length, 1);
});

test("plugin PUT/PATCH/DELETE require their own saved review, preserve values and never execute through reads", async () => {
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const f = fixture(method);
    await assert.rejects(f.execute(), /APPROVAL_PENDING/);
    const pending = Object.values(f.reviews())[0];
    assert.equal(pending.kind, "plugin");
    assert.equal(pending.method, method);
    assert.equal("body" in pending, false);
    f.approve();
    await assert.rejects(
      f.registry.execute("plugin.fixture", "act", {
        id: "demo",
        body: { enabled: false, level: 0 },
      }),
      /MUTATION_TOOL_REQUIRED/,
    );
    const result = await f.execute();
    assert.equal(result.outcome, "responded");
    assert.equal(result.retrySafe, false);
    assert.deepEqual(f.calls[0], {
      method,
      route: "/plugins/fixture/action/demo",
      body: { enabled: false, level: 0 },
    });
    f.doc.paths["/action/{id}"].post =
      f.doc.paths["/action/{id}"][method.toLowerCase()];
    delete f.doc.paths["/action/{id}"][method.toLowerCase()];
    await assert.rejects(f.execute(), /APPROVAL_PENDING/);
    assert.equal(f.calls.length, 1);
  }
});

test("all plugin mutation methods recheck identity and review after provider response without leaking data or retrying", async () => {
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    for (const revoke of [
      (f) => f.principal({ identifier: "other", permissions: "readwrite" }),
      (f) => f.principal({ identifier: "writer", permissions: "readonly" }),
      (f) => {
        f.config.readRequests = {};
      },
      (f) => f.running(false),
    ]) {
      const f = fixture(method);
      await assert.rejects(f.execute(), /APPROVAL_PENDING/);
      f.approve();
      f.post(async () => {
        revoke(f);
        return { status: 200, data: { privateValue: "must not escape" } };
      });
      const result = await f.execute();
      assert.equal(result.outcome, "unknown");
      assert.equal(result.retrySafe, false);
      assert.equal(result.data, undefined);
      assert.equal(f.calls.length, 1);
    }
    const f = fixture(method);
    await assert.rejects(f.execute(), /APPROVAL_PENDING/);
    f.approve();
    f.post(async () => {
      throw new Error("private provider details");
    });
    assert.equal(
      (await f.execute()).code,
      "PLUGIN_MUTATION_RESULT_UNAVAILABLE",
    );
    assert.equal(f.calls.length, 1);
  }
});

test("fixed-local plugin mutation transport preserves methods, bearer and mixed-case paths and rejects encoded escapes", async (t) => {
  const http = require("node:http");
  const { localPluginMutation } = require("../dist/capabilities/http.js");
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body,
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ received: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const send = localPluginMutation(
    { socket: { localAddress: "127.0.0.1", localPort: server.address().port } },
    "Bearer synthetic-original",
    new AbortController().signal,
  );
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    await send(
      method,
      "/plugins/MixedCase/_record/2026-10-22T12%3A00%3A00.000Z",
      { value: null },
    );
    assert.deepEqual(calls.at(-1), {
      method,
      url: "/plugins/MixedCase/_record/2026-10-22T12%3A00%3A00.000Z",
      authorization: "Bearer synthetic-original",
      body: '{"value":null}',
    });
    for (const path of [
      "/plugins/MixedCase/%2e%2e/other",
      "/plugins/MixedCase/value%2fconfig",
      "/plugins/MixedCase/value%3ftoken=x",
      "/plugins/MixedCase/%5cadmin",
      "/plugins/MixedCase/%63onfig",
      "/plugins/MixedCase/_config/item",
      "/plugins/MixedCase/ui-config/charts",
      "/plugins/MixedCase//record",
      "/plugins/MixedCase/%zz",
    ])
      await assert.rejects(send(method, path, {}), /INVALID_LOCAL_ROUTE/);
  }
  await send("DELETE", "/plugins/MixedCase/-record/");
  await assert.rejects(
    send("GET", "/plugins/MixedCase/record"),
    /INVALID_LOCAL_ROUTE/,
  );
  assert.equal(calls.length, 5);
});
