const { test } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./runtime-fixture.cjs");

test(
  "v2 collection reads work with core notification management disabled",
  { timeout: 30000 },
  async (t) => {
    const fixture = await start(true, { manageNotifications: false });
    t.after(async () => {
      try {
        await fixture.stop();
      } finally {
        fixture.remove();
      }
    });
    // Default native CORS permits any origin. The gateway follows that policy,
    // but browser-origin requests still need their own valid bearer identity.
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "browser-fixture", version: "1" },
      },
    };
    const browserRead = (origin, authorization) =>
      fetch(`${fixture.baseUrl}/plugins/signalk-mcp/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Origin: origin,
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify(initialize),
      });
    const permitted = await browserRead(
      "https://client.example",
      `Bearer ${fixture.tokens.reader}`,
    );
    assert.equal(permitted.status, 200);
    assert.equal(permitted.headers.get("access-control-allow-origin"), "*");
    await permitted.arrayBuffer();
    for (const [origin, authorization, expected] of [
      ["https://client.example", undefined, 401],
      ["https://client.example", "Bearer invalid", 401],
      ["null", `Bearer ${fixture.tokens.reader}`, 403],
      ["https://client.example/path", `Bearer ${fixture.tokens.reader}`, 403],
    ]) {
      const response = await browserRead(origin, authorization);
      assert.equal(response.status, expected);
      await response.arrayBuffer();
    }
    const { server, seed } = fixture;
    server.app.securityStrategy.getConfiguration().acls[0].resources.push({
      paths: ["notifications.allowed"],
      permissions: [{ subject: "reader", permission: "read" }],
    });
    const value = {
      state: "alarm",
      method: ["visual"],
      message: "Synthetic handler-owned notification",
      data: { zero: 0, missing: null },
    };
    seed([
      { path: "notifications.allowed", value },
      { path: "notifications.denied", value: { ...value, message: "Denied" } },
    ]);
    const get = (suffix = "") =>
      fetch(`${fixture.baseUrl}/signalk/v2/api/notifications${suffix}`, {
        headers: { Authorization: `Bearer ${fixture.tokens.reader}` },
      });
    const raw = await (await get()).json();
    assert.ok(Object.hasOwn(raw, "notifications.allowed"));
    assert.ok(!Object.hasOwn(raw["notifications.allowed"].value, "id"));
    assert.ok(!Object.hasOwn(raw["notifications.allowed"].value, "status"));
    assert.equal(
      (await get("/00000000-0000-4000-8000-000000000001")).status,
      501,
    );
    const call = async (name, args = {}, principal = "reader") => {
      const response = await fixture.request(name, args, principal).result;
      assert.equal(response.status, 200);
      assert.equal(
        response.body.result.isError,
        undefined,
        JSON.stringify(response.body),
      );
      return response.body.result.structuredContent;
    };
    const listed = await call("list_notifications");
    assert.deepEqual(listed, {
      registry: "v2",
      notifications: { "notifications.allowed": raw["notifications.allowed"] },
      nextOffset: null,
    });
    assert.deepEqual(
      (await call("get_notification", { id: "notifications.allowed" }))
        .notification,
      raw["notifications.allowed"],
    );
    assert.deepEqual(
      (await call("list_notifications", {}, "other")).notifications,
      {},
    );
    assert.deepEqual(await (await get()).json(), raw);
  },
);
