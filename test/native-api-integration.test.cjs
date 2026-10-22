const { test } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./put-native-fixture.cjs");
function data(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent;
}
function error(result, code) {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.content[0].text, code);
}
test(
  "native API documents, routes, saved approval and provider permissions on a real server",
  { timeout: 90000 },
  async (t) => {
    const f = await start();
    t.after(async () => {
      try {
        await f.stop();
      } finally {
        f.remove();
      }
    });
    t.diagnostic(
      `Node ${process.version}; Signal K ${f.version}; synthetic providers only`,
    );
    const app = f.server.app;
    const submissions = [];
    const pilot = Object.fromEntries(
      [
        "getData",
        "getState",
        "setState",
        "getMode",
        "setMode",
        "getTarget",
        "setTarget",
        "adjustTarget",
        "engage",
        "disengage",
        "tack",
        "gybe",
        "dodge",
      ].map((name) => [
        name,
        async (...args) => {
          if (name === "getState") return "standby";
          if (name === "getData")
            return { state: "standby", target: 0, engaged: false };
          submissions.push({ name, args });
        },
      ]),
    );
    app.autopilotApi.register("native-pilot", pilot, ["pilot"]);
    app.securityStrategy.getConfiguration().acls[0].resources.unshift({
      paths: ["autopilot"],
      permissions: [{ subject: "writer", permission: "put" }],
    });
    const call = (
      api,
      operation,
      args = {},
      mutation = false,
      principal = "writer",
    ) =>
      f.call(
        mutation ? "execute_mutation" : "execute_capability",
        { id: `api.${api}`, operation, arguments: args },
        principal,
      );
    const operations = {
      course: [
        "get.course",
        {},
        "/signalk/v2/api/vessels/self/navigation/course",
      ],
      weather: ["get._providers", {}, "/signalk/v2/api/weather/_providers"],
      autopilot: [
        "get.by-id.state",
        { id: "pilot" },
        "/signalk/v2/api/vessels/self/autopilots/pilot/state",
      ],
      radar: ["get.root", {}, "/signalk/v2/api/vessels/self/radars"],
      ble: ["get.devices", {}, "/signalk/v2/api/vessels/self/ble/devices"],
      tracks: ["get._providers", {}, "/signalk/v2/api/tracks/_providers"],
      sensors: ["get.gnss", {}, "/signalk/v2/api/vessels/self/sensors/gnss"],
    };
    const advertised = data(await f.call("list_capabilities")).capabilities.map(
      (c) => c.id,
    );
    if (f.version === "2.32.0") {
      assert.equal(advertised.includes("api.tracks"), false);
      error(
        await f.call("describe_capability", { id: "api.tracks" }),
        "CAPABILITY_NOT_FOUND",
      );
      assert.equal((await f.http("/skServer/openapi/tracks")).status, 404);
      delete operations.tracks;
    }
    for (const [api, [operation, args]] of Object.entries(operations)) {
      assert.ok(advertised.includes(`api.${api}`), api);
      const description = data(
        await f.call("describe_capability", { id: `api.${api}` }),
      );
      assert.equal(description.available, true, JSON.stringify(description));
      assert.ok(
        description.operations.some(
          (o) => o.id === operation && o.reason === "NOT_ALLOWLISTED",
        ),
        JSON.stringify(description),
      );
      error(await call(api, operation, args), "APPROVAL_PENDING");
    }
    error(
      await call(
        "autopilot",
        "post.by-id.engage",
        { id: "pilot" },
        true,
        "reader",
      ),
      "PERMISSION_DENIED",
    );
    error(
      await call("autopilot", "post.by-id.engage", { id: "pilot" }, true),
      "APPROVAL_PENDING",
    );
    error(
      await call(
        "autopilot",
        "put.by-id.target",
        { id: "pilot", body: { value: 0 } },
        true,
      ),
      "APPROVAL_PENDING",
    );
    assert.equal(submissions.length, 0);
    const settings = await f.readConfig();
    settings.configuration.readRequests = f.reviews();
    for (const review of Object.values(settings.configuration.readRequests)) {
      assert.equal(review.kind, "api");
      assert.equal("body" in review, false);
      review.decision = "approved";
    }
    await f.saveConfig(settings);
    for (const [api, [operation, args, route]] of Object.entries(operations)) {
      const direct = await f.http(route);
      assert.equal(
        direct.status,
        200,
        `${api}: ${JSON.stringify(direct.body)}`,
      );
      const result = data(await call(api, operation, args));
      assert.deepEqual(result.data, direct.body, api);
    }
    error(
      await call("autopilot", "post.by-id.engage", { id: "pilot" }),
      "MUTATION_TOOL_REQUIRED",
    );
    error(
      await call("autopilot", "post.by-id.engage", { id: "../settings" }, true),
      "INVALID_ARGUMENTS",
    );
    const denied = data(
      await call(
        "autopilot",
        "post.by-id.engage",
        { id: "pilot" },
        true,
        "other",
      ),
    );
    assert.equal(denied.statusCode, 403);
    assert.equal(submissions.length, 0);
    const result = data(
      await call("autopilot", "post.by-id.engage", { id: "pilot" }, true),
    );
    assert.equal(result.statusCode, 200);
    assert.equal(result.retrySafe, false);
    assert.deepEqual(submissions, [{ name: "engage", args: ["pilot"] }]);
    const target = data(
      await call(
        "autopilot",
        "put.by-id.target",
        { id: "pilot", body: { value: 0 } },
        true,
      ),
    );
    assert.equal(target.statusCode, 200);
    assert.deepEqual(submissions[1], { name: "setTarget", args: [0, "pilot"] });
    const changed = await f.readConfig();
    for (const review of Object.values(changed.configuration.readRequests))
      if (review.api === "autopilot" && review.method === "POST")
        review.decision = "rejected";
    await f.saveConfig(changed);
    error(
      await call("autopilot", "post.by-id.engage", { id: "pilot" }, true),
      "APPROVAL_REJECTED",
    );
    assert.equal(submissions.length, 2);
  },
);
