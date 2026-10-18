const clone = (value) => JSON.parse(JSON.stringify(value));
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  listNotifications,
  getNotification,
} = require("../dist/capabilities/notifications.js");
const { CapabilityRegistry } = require("../dist/capabilities/registry.js");
const { GatewayError } = require("../dist/auth.js");

function fixture() {
  const principal = { identifier: "reader", permissions: "readonly" };
  const response = {};
  const model = {};
  const checks = [];
  const app = {
    selfContext: "vessels.urn:mrn:signalk:uuid:test",
    getPath: (path) => model[path],
    securityStrategy: {
      isDummy: () => false,
      anyACLs: () => true,
      authorizeWS: (connection) => {
        connection.skIsAuthenticated = true;
        connection.skPrincipal = principal;
      },
      checkACL: (id, context, path, source, operation) => {
        checks.push({ id, context, path, source, operation });
        return (
          context === "vessels.self" &&
          source === "public" &&
          path !== "notifications.denied"
        );
      },
    },
  };
  const add = (
    id,
    source = "public",
    context = "vessels.self",
    path = `notifications.${id}`,
  ) => {
    const entry = {
      context,
      path,
      value: {
        id,
        state: "alarm",
        message: id,
        data: { zero: 0, missing: null },
        status: { acknowledged: false },
      },
    };
    response[id] = entry;
    model[
      `${context === "vessels.self" || !context ? app.selfContext : context}.${path}`
    ] = { $source: source, value: clone(entry.value) };
    return entry;
  };
  const get = async (path) => {
    assert.equal(path, "/signalk/v2/api/notifications");
    return clone(response);
  };
  const registry = new CapabilityRegistry(
    app,
    "Bearer fixture",
    { staleAfterSeconds: 300 },
    () => true,
    get,
  );
  return { app, principal, response, model, checks, add, get, registry };
}

test("v2 records are forwarded unchanged; pagination follows permission filtering", async () => {
  const f = fixture();
  f.add("a", "private");
  const b = f.add("b");
  b.value.createdAt = "2026-01-01T00:00:00Z";
  f.model[`${f.app.selfContext}.${b.path}`].value = clone(b.value);
  f.add("c", "private");
  const d = f.add("d");
  const page = await f.registry.execute(
    "signalk.notifications",
    "list_notifications",
    { limit: 1 },
  );
  assert.deepEqual(page, {
    registry: "v2",
    notifications: { b },
    nextOffset: 1,
  });
  assert.deepEqual(
    await f.registry.execute("signalk.notifications", "list_notifications", {
      offset: 1,
      limit: 1,
    }),
    { registry: "v2", notifications: { d }, nextOffset: null },
  );
  assert.deepEqual(
    await f.registry.execute("signalk.notifications", "get_notification", {
      id: "b",
    }),
    { registry: "v2", id: "b", notification: b },
  );
  assert.ok(!Object.hasOwn(d, "timestamp"));
  assert.ok(!Object.hasOwn(d, "$source"));
  assert.ok(f.checks.every((check) => check.operation === "read"));
  for (const id of ["a", "absent", "../silenceAll"])
    await assert.rejects(
      f.registry.execute("signalk.notifications", "get_notification", { id }),
      /NOTIFICATION_UNAVAILABLE/,
    );
});

test("source identity requires an exact native-model value and all ambiguous sources must be allowed", async () => {
  const f = fixture();
  const entry = f.add("shared");
  const node = f.model[`${f.app.selfContext}.${entry.path}`];
  node.values = { private: { value: clone(entry.value) } };
  assert.deepEqual(
    (
      await listNotifications(f.app, () => f.principal, f.get, {
        offset: 0,
        limit: 32,
      })
    ).notifications,
    {},
  );
  node.values.private.value.message = "different";
  assert.deepEqual(
    (
      await listNotifications(f.app, () => f.principal, f.get, {
        offset: 0,
        limit: 32,
      })
    ).notifications,
    { shared: entry },
  );
  node.value.message = "changed since registry snapshot";
  await assert.rejects(
    getNotification(f.app, () => f.principal, f.get, "shared"),
    /NOTIFICATION_UNAVAILABLE/,
  );
  // An old authorized value in the source-specific model can still prove access.
  node.values.public = { value: clone(entry.value) };
  assert.deepEqual(
    (await getNotification(f.app, () => f.principal, f.get, "shared"))
      .notification,
    entry,
  );
  delete node.values;
  delete node.$source;
  node.value = clone(entry.value);
  await assert.rejects(
    getNotification(f.app, () => f.principal, f.get, "shared"),
    /NOTIFICATION_UNAVAILABLE/,
  );
  f.app.securityStrategy.anyACLs = () => false;
  f.app.securityStrategy.checkACL = () => true;
  assert.deepEqual(
    (await getNotification(f.app, () => f.principal, f.get, "shared"))
      .notification,
    entry,
  );
});

test("native context and admin ACLs remain enforced; missing source policy fails closed", async () => {
  const f = fixture();
  f.add("native", "public", f.app.selfContext);
  f.add("empty", "public", "");
  f.add("foreign", "public", "vessels.foreign");
  f.add("denied");
  f.add("unknown", "public", "vessels.__proto__");
  delete f.app.securityStrategy.anyACLs;
  f.principal.permissions = "admin";
  const result = await f.registry.execute(
    "signalk.notifications",
    "list_notifications",
    {},
  );
  assert.deepEqual(Object.keys(result.notifications), ["empty", "native"]);
  assert.ok(f.checks.some((check) => check.context === "vessels.foreign"));
  assert.ok(f.checks.some((check) => check.context === "vessels.self"));
  assert.ok(f.checks.every((check) => check.source === "public"));
});

test("unavailable API, malformed or oversized responses and unsafe inputs fail closed", async () => {
  const f = fixture();
  for (const response of [
    [],
    null,
    { id: null },
    { id: { context: "", path: "navigation.position", value: {} } },
    { id: { context: "", path: "notifications.constructor", value: {} } },
    Object.fromEntries(Array.from({ length: 20001 }, (_, i) => [i, {}])),
  ])
    await assert.rejects(
      listNotifications(
        f.app,
        () => f.principal,
        async () => response,
        { offset: 0, limit: 32 },
      ),
      /INVALID_NOTIFICATIONS_RESPONSE/,
    );
  await assert.rejects(
    listNotifications(
      f.app,
      () => f.principal,
      async () => {
        throw new GatewayError("CAPABILITY_UNAVAILABLE");
      },
      { offset: 0, limit: 32 },
    ),
    /CAPABILITY_UNAVAILABLE/,
  );
  for (const args of [
    { limit: 65 },
    { offset: -1 },
    { source: "public" },
    { url: "https://example.invalid" },
  ])
    await assert.rejects(
      f.registry.execute("signalk.notifications", "list_notifications", args),
      /INVALID_ARGUMENTS/,
    );
  for (const operation of [
    "raise",
    "acknowledge",
    "silence",
    "clear",
    "silenceAll",
    "update",
    "delete",
  ])
    await assert.rejects(
      f.registry.execute("signalk.notifications", operation, {}),
      /OPERATION_NOT_FOUND/,
    );
});

test("credentials and ACLs are rechecked after the registry HTTP response", async () => {
  const f = fixture();
  f.add("allowed");
  const registry = new CapabilityRegistry(
    f.app,
    "Bearer fixture",
    {},
    () => true,
    async () => {
      f.principal.permissions = "unknown";
      return f.response;
    },
  );
  await assert.rejects(
    registry.execute("signalk.notifications", "list_notifications", {}),
    /PERMISSION_DENIED/,
  );
  f.principal.permissions = "readonly";
  const changed = await listNotifications(
    f.app,
    () => f.principal,
    async () => {
      f.app.securityStrategy.checkACL = () => false;
      return f.response;
    },
    { offset: 0, limit: 32 },
  );
  assert.deepEqual(changed.notifications, {});
});

test("discovery reports unavailable registry operations while legacy list remains enabled", async () => {
  const f = fixture();
  const registry = new CapabilityRegistry(
    f.app,
    "Bearer fixture",
    {},
    () => true,
    async () => {
      throw new GatewayError("CAPABILITY_UNAVAILABLE");
    },
  );
  const description = await registry.describe("signalk.notifications");
  assert.equal(description.available, true);
  for (const op of description.operations) {
    assert.equal(op.enabled, op.id === "list");
    if (op.id !== "list") assert.equal(op.reason, "CAPABILITY_UNAVAILABLE");
  }
});

test("non-self records use their own native context without rewriting the forwarded record", async () => {
  const f = fixture();
  const entry = f.add(
    "foreign",
    "public",
    "vessels.urn:mrn:imo:mmsi:123456789",
  );
  f.app.securityStrategy.checkACL = (id, context, path, source, operation) =>
    id === "reader" &&
    context === entry.context &&
    path === entry.path &&
    source === "public" &&
    operation === "read";
  assert.deepEqual(
    (await getNotification(f.app, () => f.principal, f.get, "foreign"))
      .notification,
    entry,
  );
});
