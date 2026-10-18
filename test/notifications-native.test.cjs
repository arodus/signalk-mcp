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
      fetch(
        `http://${fixture.configuration.allowedHosts[0]}/signalk/v2/api/notifications${suffix}`,
        {
          headers: { Authorization: `Bearer ${fixture.tokens.reader}` },
        },
      );
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
