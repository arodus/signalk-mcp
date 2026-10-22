const { test } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./put-native-fixture.cjs");
function error(result, code) {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.content[0].text, code);
}
function data(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent;
}
test(
  "native plugin POSTs: saved review, original identity, route permissions and uncertain outcomes",
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
      `Node ${process.version}; Signal K ${f.version}; synthetic POSTs only`,
    );
    const mutate = (
      mode = "normal",
      args = { body: { value: false } },
      principal = "writer",
    ) =>
      f.call(
        "execute_mutation",
        { id: "plugin.put-fixture", operation: mode, arguments: args },
        principal,
      );
    async function decide(mode, decision = "approved") {
      const settings = await f.readConfig();
      settings.configuration.readRequests = f.reviews();
      const review = Object.values(settings.configuration.readRequests).find(
        (v) => v.kind === "post" && v.operationId === mode,
      );
      assert.ok(review);
      review.decision = decision;
      await f.saveConfig(settings);
    }
    error(await mutate("normal", undefined, "reader"), "PERMISSION_DENIED");
    assert.equal(Object.keys(f.reviews()).length, 0);
    error(await mutate(), "APPROVAL_PENDING");
    assert.equal(f.provider.postCalls.length, 0);
    const pending = Object.values(f.reviews())[0];
    assert.equal(pending.kind, "post");
    assert.equal(pending.method, "POST");
    assert.equal("body" in pending, false);
    for (const principal of [undefined, "reader", "writer"]) {
      const settings = await f.readConfig();
      settings.configuration.readRequests = f.reviews();
      Object.values(settings.configuration.readRequests)[0].decision =
        "approved";
      const result = await f.http(
        "/plugins/signalk-mcp/config",
        principal || null,
        "POST",
        settings,
      );
      assert.ok([401, 403].includes(result.status));
    }
    await decide("normal", "rejected");
    error(await mutate(), "APPROVAL_REJECTED");
    await decide("normal");
    error(
      await mutate("normal", { body: { value: "false" } }),
      "INVALID_ARGUMENTS",
    );
    error(
      await f.call("execute_capability", {
        id: "plugin.put-fixture",
        operation: "normal",
        arguments: { body: { value: false } },
      }),
      "MUTATION_TOOL_REQUIRED",
    );
    const result = data(await mutate());
    assert.equal(result.outcome, "responded");
    assert.equal(result.data.value, false);
    assert.equal(result.data.principal, "writer");
    assert.deepEqual(f.provider.postCalls, [
      { mode: "normal", body: { value: false }, principal: "writer" },
    ]);
    error(await mutate("normal", undefined, "reader"), "PERMISSION_DENIED");
    const original = f.provider.postDocument.paths["/post-normal"].post.summary;
    f.provider.postDocument.paths["/post-normal"].post.summary +=
      " changed meaning";
    error(await mutate(), "APPROVAL_PENDING");
    assert.equal(f.provider.postCalls.length, 1);
    f.provider.postDocument.paths["/post-normal"].post.summary = original;
    for (const mode of [
      "admin",
      "badjson",
      "redirect",
      "large",
      "disconnect",
      "pending",
      "empty",
      "failure",
    ]) {
      error(await mutate(mode), "APPROVAL_PENDING");
      await decide(mode);
      const before = f.provider.postCalls.length;
      const outcome = data(await mutate(mode));
      assert.equal(outcome.retrySafe, false);
      if (mode === "pending") {
        assert.equal(outcome.outcome, "accepted");
        assert.equal(outcome.data.state, "PENDING");
      } else if (mode === "empty") {
        assert.equal(outcome.outcome, "responded");
        assert.equal(outcome.statusCode, 204);
      } else {
        assert.equal(outcome.outcome, "unknown", mode);
        assert.equal(outcome.data, undefined);
      }
      assert.equal(
        f.provider.postCalls.length,
        before + (mode === "admin" ? 0 : 1),
      );
      if (mode === "admin") {
        assert.ok([401, 403].includes(outcome.statusCode));
        assert.equal(
          data(await mutate(mode, undefined, "admin")).data.principal,
          "admin",
        );
      }
    }
    const settings = await f.readConfig();
    settings.configuration.readRequests = {};
    await f.saveConfig(settings);
    const before = f.provider.postCalls.length;
    error(await mutate(), "APPROVAL_PENDING");
    assert.equal(f.provider.postCalls.length, before);
  },
);

test(
  "native plugin PUT/PATCH/DELETE preserve native identities and exact method reviews",
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
      `Node ${process.version}; Signal K ${f.version}; synthetic plugin HTTP methods only`,
    );
    const body = {
      value: { enabled: false, labels: ["sample", null], amount: 0 },
    };
    const mutate = (method, mode = "normal", principal = "writer") =>
      f.call(
        "execute_mutation",
        {
          id: "plugin.put-fixture",
          operation: `${method}-${mode}`,
          arguments: { id: "sample", ...(method === "delete" ? {} : { body }) },
        },
        principal,
      );
    async function approve(method, mode) {
      const settings = await f.readConfig();
      settings.configuration.readRequests = f.reviews();
      const review = Object.values(settings.configuration.readRequests).find(
        (item) =>
          item.kind === "plugin" && item.operationId === `${method}-${mode}`,
      );
      assert.ok(review);
      assert.equal(review.method, method.toUpperCase());
      assert.equal("body" in review, false);
      review.decision = "approved";
      await f.saveConfig(settings);
    }
    for (const method of ["put", "patch", "delete"]) {
      error(await mutate(method, "normal", "reader"), "PERMISSION_DENIED");
      const before = f.provider.mutationCalls.length;
      error(await mutate(method), "APPROVAL_PENDING");
      assert.equal(f.provider.mutationCalls.length, before);
      await approve(method, "normal");
      error(
        await f.call("execute_capability", {
          id: "plugin.put-fixture",
          operation: `${method}-normal`,
          arguments: { id: "sample", ...(method === "delete" ? {} : { body }) },
        }),
        "MUTATION_TOOL_REQUIRED",
      );
      const result = data(await mutate(method));
      assert.equal(result.outcome, "responded");
      assert.equal(result.retrySafe, false);
      assert.equal(result.statusCode, method === "delete" ? 204 : 200);
      const call = f.provider.mutationCalls.at(-1);
      assert.equal(call.method, method.toUpperCase());
      assert.equal(call.principal, "writer");
      if (method !== "delete") assert.deepEqual(call.body, body);
      for (const mode of ["admin", "disconnect", "failure"]) {
        error(await mutate(method, mode), "APPROVAL_PENDING");
        await approve(method, mode);
        const before = f.provider.mutationCalls.length;
        const result = data(await mutate(method, mode));
        assert.equal(result.outcome, "unknown");
        assert.equal(result.retrySafe, false);
        assert.equal(result.data, undefined);
        assert.equal(
          f.provider.mutationCalls.length,
          before + (mode === "admin" ? 0 : 1),
        );
        if (mode === "admin") {
          assert.ok([401, 403].includes(result.statusCode));
          assert.equal(
            data(await mutate(method, mode, "admin")).outcome,
            "responded",
          );
        }
      }
    }
    const settings = await f.readConfig();
    settings.configuration.readRequests = {};
    await f.saveConfig(settings);
    const before = f.provider.mutationCalls.length;
    for (const method of ["put", "patch", "delete"])
      error(await mutate(method), "APPROVAL_PENDING");
    assert.equal(f.provider.mutationCalls.length, before);
  },
);
