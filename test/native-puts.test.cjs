const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { start } = require("./put-native-fixture.cjs");

function success(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.ok(result.structuredContent, JSON.stringify(result));
  return result.structuredContent;
}
function error(result, code) {
  assert.equal(result.isError, true, JSON.stringify(result));
  if (code === "INVALID_ARGUMENTS")
    assert.match(
      result.content[0].text,
      /^(?:INVALID_ARGUMENTS|MCP error -32602: Input validation error:)/,
      JSON.stringify(result),
    );
  else assert.equal(result.content[0].text, code, JSON.stringify(result));
  assert.equal(result.structuredContent, undefined);
}

test(
  "native PUTs require exact saved review and native identity, with owned request status",
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
    t.diagnostic(`Node ${process.version}; native Signal K ${f.version}`);
    const { provider, gateway, server } = f;
    const paths = provider.testPaths;
    const target = (path = paths.state, source = "public") => ({
      path,
      source,
    });
    const put = (value, path = paths.state, source = "public", principal) =>
      f.call("put_value", { ...target(path, source), value }, principal);
    const status = (requestId, principal) =>
      f.call("get_put_status", { requestId }, principal);
    async function approve(path, source = "public") {
      error(await put(false, path, source), "APPROVAL_PENDING");
      await f.decide(target(path, source));
    }

    await t.test(
      "metadata-only discovery requires an explicit source",
      async () => {
        assert.equal(
          Object.hasOwn(provider.readPath(paths.state) || {}, "value"),
          false,
        );
        // Public metadata deltas are observable after gateway startup even when
        // a command path has never published a measurement value.
        for (const path of Object.values(paths)) {
          const metadata = provider.readMetadata(path);
          if (metadata) provider.setMetadata(path, metadata);
        }
        const listed = success(
          await f.call("list_put_paths", {
            source: "public",
            prefix: "electrical.switches.mcpTest",
          }),
        );
        assert.equal(listed.context, "vessels.self");
        assert.equal(listed.source, "public");
        assert.equal(listed.sourceVerification, "native-handler-on-dispatch");
        assert.equal(listed.discoveryCoverage, "model-and-observed-metadata");
        assert.equal(
          listed.historicalMetadataOnlyPaths,
          "explicit-describe-required",
        );
        assert.equal(listed.discoveryTruncated, false);
        assert.ok(listed.paths.includes(paths.state));
        assert.ok(!listed.paths.includes(paths.unsupported));
        assert.ok(!listed.paths.includes(paths.missing));
        const page = success(
          await f.call("list_put_paths", { source: "public", limit: 1 }),
        );
        assert.equal(page.paths.length, 1);
        assert.equal(page.nextOffset, 1);
        const description = success(await f.call("describe_put", target()));
        assert.equal(description.path, paths.state);
        assert.equal(description.source, "public");
        assert.equal(description.metadata.supportsPut, true);
        assert.equal(description.nativeHandlerValidation, true);
        assert.equal(description.schemaDiagnostics[0].code, "NO_INPUT_TYPE");
        assert.equal(description.approvalStatus, "required");
        assert.equal(description.approvalSaved, false);
        assert.equal(description.enabled, false);
        assert.equal(description.sourceVerified, false);
        assert.equal(
          description.sourceVerification,
          "native-handler-on-dispatch",
        );
        error(await f.call("list_put_paths", {}), "INVALID_ARGUMENTS");
        error(
          await f.call("describe_put", { path: paths.state }),
          "INVALID_ARGUMENTS",
        );
        const privatePaths = success(
          await f.call("list_put_paths", { source: "private" }),
        );
        assert.deepEqual(privatePaths.paths, []);
        assert.equal(provider.testCalls.length, 0);
      },
    );

    await t.test(
      "invalid input and unavailable metadata never queue or dispatch",
      async () => {
        const before = JSON.stringify(f.reviews());
        for (const args of [
          { path: paths.state, value: 0 },
          { ...target(), source: "*", value: 0 },
          { ...target(), source: "", value: 0 },
          { ...target(), context: "vessels.other", value: 0 },
          { ...target(), requestId: crypto.randomUUID(), value: 0 },
          {
            ...target(),
            path: "electrical.switches.mcpTest.state.meta",
            value: 0,
          },
          { ...target(), path: "http://invalid.example/command", value: 0 },
          target(),
        ])
          error(await f.call("put_value", args), "INVALID_ARGUMENTS");
        for (const value of [3, false])
          error(await put(value, paths.constrained), "INVALID_PUT_VALUE");
        for (const path of [paths.unsupported, paths.missing])
          error(await put(0, path), "PUT_UNAVAILABLE");
        error(
          await f.call("get_put_status", { requestId: "not-a-uuid" }),
          "INVALID_ARGUMENTS",
        );
        assert.equal(JSON.stringify(f.reviews()), before);
        assert.equal(provider.testCalls.length, 0);
      },
    );

    await t.test(
      "native PUT ACLs apply to the exact source and role before dispatch",
      async () => {
        assert.equal(
          server.app.securityStrategy.checkACL(
            "writer",
            "vessels.self",
            paths.state,
            "private",
            "put",
          ),
          false,
        );
        const before = provider.testCalls.length;
        for (const [principal, source] of [
          ["writer", "private"],
          ["reader", "public"],
          ["writeonly", "public"],
          ["admin", "public"],
          ["other", "public"],
        ])
          error(
            await put(0, paths.state, source, principal),
            "PERMISSION_DENIED",
          );
        assert.equal(provider.testCalls.length, before);
        assert.deepEqual(f.reviews(), {});
        // The native HTTP route checks a null source. The gateway closes this gap
        // by checking the explicit source before dispatching to that native route.
        const raw = await f.http(
          `/signalk/v1/api/vessels/self/${paths.state.replaceAll(".", "/")}`,
          "writer",
          "PUT",
          { source: "private", value: "synthetic-native-source-check" },
        );
        assert.equal(raw.status, 200);
        assert.equal(provider.testCalls.length, before + 1);
        error(await put(0, paths.state, "private"), "PERMISSION_DENIED");
        assert.equal(provider.testCalls.length, before + 1);
      },
    );

    await t.test(
      "blocked calls queue metadata and only native admin saving approves",
      async () => {
        const before = provider.testCalls.length;
        error(await put(false), "APPROVAL_PENDING");
        error(await put(0), "APPROVAL_PENDING");
        error(
          await f.call("execute_mutation", {
            id: "signalk.put",
            operation: "put_value",
            arguments: { ...target(), value: 0 },
          }),
          "APPROVAL_PENDING",
        );
        error(
          await f.call("execute_capability", {
            id: "signalk.put",
            operation: "put_value",
            arguments: { ...target(), value: 0 },
          }),
          "MUTATION_TOOL_REQUIRED",
        );
        const entries = Object.entries(f.reviews());
        assert.equal(entries.length, 1);
        const [key, review] = entries[0];
        assert.equal(review.kind, "put");
        assert.equal(review.context, "vessels.self");
        assert.equal(review.path, paths.state);
        assert.equal(review.source, "public");
        assert.equal(review.decision, "pending");
        for (const field of ["value", "token", "authorization", "requestId"])
          assert.equal(Object.hasOwn(review, field), false);
        const serialized = JSON.stringify(review);
        for (const token of Object.values(f.tokens))
          assert.equal(serialized.includes(token), false);
        const original = await f.readConfig();
        assert.equal(original.configuration.readRequests?.[key], undefined);
        assert.equal(provider.testCalls.length, before);
        const proposed = globalThis.structuredClone(original);
        proposed.configuration.readRequests = {
          [key]: { ...review, decision: "approved" },
        };
        for (const principal of [null, "reader", "writer"])
          assert.ok(
            [401, 403].includes(
              (
                await f.http(
                  "/plugins/signalk-mcp/config",
                  principal,
                  "POST",
                  proposed,
                )
              ).status,
            ),
          );
        error(await put(false), "APPROVAL_PENDING");
        await f.decide(target());
        assert.equal(
          (await f.readConfig()).configuration.readRequests[key].decision,
          "approved",
        );
        for (const value of [false, 0, null]) {
          const result = success(
            value === 0
              ? await f.call("execute_mutation", {
                  id: "signalk.put",
                  operation: "put_value",
                  arguments: { ...target(), value },
                })
              : await put(value),
          );
          assert.equal(result.submitted, true);
          assert.equal(result.outcome, "completed");
          assert.equal(result.retrySafe, false);
          assert.equal(result.reply.statusCode, 200);
          assert.deepEqual(provider.testCalls.at(-1), {
            context: "vessels.self",
            path: paths.state,
            source: "public",
            value,
          });
        }
        assert.equal(provider.testCalls.length, before + 3);
      },
    );

    await t.test(
      "saved rejection and schema changes do not inherit approval",
      async () => {
        await f.decide(target(), "rejected");
        const before = provider.testCalls.length;
        error(await put(0), "APPROVAL_REJECTED");
        assert.equal(provider.testCalls.length, before);
        await f.decide(target(), "approved");
        const original = success(
          await f.call("describe_put", target()),
        ).metadata;
        provider.setMetadata(paths.state, {
          ...original,
          description:
            "Changed synthetic command semantics require a new review",
        });
        error(await put(0), "APPROVAL_PENDING");
        assert.equal(provider.testCalls.length, before);
        const stateReviews = Object.values(f.reviews()).filter(
          (review) => review.path === paths.state,
        );
        assert.equal(stateReviews.length, 2);
        assert.notEqual(stateReviews[0].schemaHash, stateReviews[1].schemaHash);
        provider.setMetadata(paths.state, original);
        assert.equal(success(await put(0)).outcome, "completed");
      },
    );

    await t.test(
      "metadata enum constraints are checked before approval and dispatch",
      async () => {
        const description = success(
          await f.call("describe_put", target(paths.constrained)),
        );
        assert.deepEqual(description.inputSchema.enum, [0, 1, 2]);
        error(await put(1, paths.constrained), "APPROVAL_PENDING");
        await f.decide(target(paths.constrained));
        const before = provider.testCalls.length;
        error(await put(3, paths.constrained), "INVALID_PUT_VALUE");
        assert.equal(provider.testCalls.length, before);
        assert.equal(
          success(await put(0, paths.constrained)).reply.statusCode,
          200,
        );
      },
    );

    await t.test(
      "native pending status is correlated with its submitting identity",
      async () => {
        await approve(paths.pending);
        const pending = success(await put(false, paths.pending));
        assert.equal(pending.outcome, "pending");
        assert.match(pending.requestId, /^[0-9a-f-]{36}$/);
        assert.equal(
          success(await status(pending.requestId)).outcome,
          "pending",
        );
        for (const principal of ["other", "admin", "reader"])
          error(
            await status(pending.requestId, principal),
            "PUT_REQUEST_UNAVAILABLE",
          );
        error(await status(crypto.randomUUID()), "PUT_REQUEST_UNAVAILABLE");
        const anonymous = await f.http(
          "/plugins/signalk-mcp/mcp",
          null,
          "POST",
          {
            jsonrpc: "2.0",
            id: 100,
            method: "tools/call",
            params: {
              name: "get_put_status",
              arguments: { requestId: pending.requestId },
            },
          },
        );
        assert.equal(anonymous.status, 401);
        provider.complete(paths.pending, 502);
        const completed = success(await status(pending.requestId));
        assert.equal(completed.outcome, "completed");
        assert.equal(completed.reply.state, "COMPLETED");
        assert.equal(completed.reply.statusCode, 502);
        assert.equal(completed.retrySafe, false);
        const raw = await f.http(
          `/signalk/v1/requests/${pending.requestId}`,
          null,
        );
        assert.equal(raw.status, 200);
        assert.equal(raw.body.statusCode, 502);
      },
    );

    await t.test(
      "untracked native IDs and revoked permissions deny gateway status",
      async () => {
        const raw = await f.http(
          `/signalk/v1/api/vessels/self/${paths.pending.replaceAll(".", "/")}`,
          "writer",
          "PUT",
          { source: "public", value: 0 },
        );
        assert.equal(raw.status, 202);
        error(await status(raw.body.requestId), "PUT_REQUEST_UNAVAILABLE");
        const pending = success(await put(0, paths.pending));
        const config = server.app.securityStrategy.getConfiguration();
        const resources = config.acls[0].resources;
        const resource = resources.find((entry) =>
          entry.paths?.includes("electrical.switches.mcpTest.*"),
        );
        const original = resource.permissions;
        try {
          resource.permissions = original.filter(
            (entry) => entry.subject !== "writer",
          );
          error(await status(pending.requestId), "PERMISSION_DENIED");
          const before = provider.testCalls.length;
          error(await put(0), "PERMISSION_DENIED");
          assert.equal(provider.testCalls.length, before);
        } finally {
          resource.permissions = original;
        }
        provider.complete(paths.pending);
      },
    );

    await t.test(
      "completed native failures remain failures in the forwarded reply",
      async () => {
        await approve(paths.failure);
        const before = provider.testCalls.length;
        const result = success(await put(null, paths.failure));
        assert.equal(result.outcome, "completed");
        assert.equal(result.reply.statusCode, 502);
        assert.equal(result.retrySafe, false);
        assert.equal(provider.testCalls.length, before + 1);
      },
    );

    await t.test(
      "permission revocation after submission suppresses the native reply without retry",
      async () => {
        await approve(paths.held);
        const before = provider.testCalls.length;
        const pending = put(false, paths.held);
        const resources =
          server.app.securityStrategy.getConfiguration().acls[0].resources;
        const resource = resources.find((entry) =>
          entry.paths?.includes("electrical.switches.mcpTest.*"),
        );
        const original = resource.permissions;
        try {
          for (
            let attempt = 0;
            attempt < 100 && provider.testCalls.length === before;
            attempt++
          )
            await new Promise((resolve) => setTimeout(resolve, 10));
          assert.equal(provider.testCalls.length, before + 1);
          resource.permissions = original.filter(
            (entry) => entry.subject !== "writer",
          );
          provider.releaseDelayed();
          const result = success(await pending);
          assert.equal(result.outcome, "unknown");
          assert.equal(result.code, "AUTHORIZATION_CHANGED_AFTER_SUBMISSION");
          assert.equal(result.retrySafe, false);
          assert.equal(result.reply, undefined);
          assert.equal(provider.testCalls.length, before + 1);
        } finally {
          resource.permissions = original;
          provider.releaseDelayed();
        }
      },
    );

    await t.test(
      "a lost native response is unknown and is never retried",
      async () => {
        await approve(paths.timeout);
        const before = provider.testCalls.length;
        try {
          const result = success(await put(false, paths.timeout));
          assert.equal(result.submitted, true);
          assert.equal(result.outcome, "unknown");
          assert.equal(result.code, "NATIVE_PUT_OUTCOME_UNKNOWN");
          assert.equal(result.retrySafe, false);
          assert.equal(provider.testCalls.length, before + 1);
        } finally {
          provider.releaseDelayed();
        }
      },
    );

    await t.test(
      "stop and start discard gateway request correlation",
      async () => {
        const pending = success(await put(false, paths.pending));
        const settings = await f.readConfig();
        await gateway.stop();
        gateway.start(settings.configuration);
        error(await status(pending.requestId), "PUT_REQUEST_UNAVAILABLE");
        const beforeDescribe = success(
          await f.call("list_put_paths", { source: "public" }),
        );
        assert.equal(beforeDescribe.paths.includes(paths.state), false);
        success(await f.call("describe_put", target()));
        const afterDescribe = success(
          await f.call("list_put_paths", { source: "public" }),
        );
        assert.ok(afterDescribe.paths.includes(paths.state));
        provider.complete(paths.pending);
      },
    );

    await t.test(
      "an explicit nonexistent source receives native 405 without widening approval",
      async () => {
        error(await put(0, paths.state, "absent"), "APPROVAL_PENDING");
        await f.decide(target(paths.state, "absent"));
        const before = provider.testCalls.length;
        const result = success(await put(0, paths.state, "absent"));
        assert.equal(result.outcome, "completed");
        assert.equal(result.reply.statusCode, 405);
        assert.equal(provider.testCalls.length, before);
        error(await put(0, paths.state, "another"), "APPROVAL_PENDING");
        assert.equal(provider.testCalls.length, before);
      },
    );

    await t.test(
      "unchanged reads preserve zero and source metadata",
      async () => {
        const values = success(
          await f.call("get_values", { paths: ["navigation.speedOverGround"] }),
        );
        assert.equal(values.measurements[0].value, 0);
        assert.equal(values.measurements[0].source, "synthetic.XX");
        assert.equal(
          values.measurements[0].timestamp,
          "2026-10-19T10:00:00.000Z",
        );
      },
    );

    await t.test(
      "native value choices require saved approval and preserve exact raw values",
      async () => {
        const selected = target(paths.choices);
        const describe = async () =>
          success(await f.call("describe_put", selected));
        const before = provider.testCalls.length;
        let description = await describe();
        assert.equal(description.schemaStatus, "available");
        assert.equal(description.schemaSource, "native-possible-values");
        assert.deepEqual(description.inputSchema.enum, ["off", "on"]);
        assert.equal(description.approvalStatus, "required");
        const originalReviews = JSON.stringify(f.reviews());
        await describe();
        assert.equal(JSON.stringify(f.reviews()), originalReviews);
        error(await put("OFF", paths.choices), "INVALID_PUT_VALUE");
        assert.equal(JSON.stringify(f.reviews()), originalReviews);
        error(await put("off", paths.choices), "APPROVAL_PENDING");
        description = await describe();
        assert.equal(description.approvalStatus, "pending");
        assert.equal(description.approvalSaved, false);
        assert.equal(description.reason, "APPROVAL_PENDING");
        assert.equal(provider.testCalls.length, before);
        await f.decide(selected, "pending");
        description = await describe();
        assert.equal(description.approvalStatus, "pending");
        assert.equal(description.approvalSaved, true);
        assert.equal(description.enabled, false);
        await f.decide(selected);
        description = await describe();
        assert.equal(description.approvalStatus, "approved");
        assert.equal(description.approvalSaved, true);
        assert.equal(description.enabled, true);
        assert.equal(description.sourceVerified, false);
        assert.equal(description.reason, null);
        const generic = success(
          await f.call("execute_capability", {
            id: "signalk.put",
            operation: "describe_put",
            arguments: selected,
          }),
        );
        assert.deepEqual(generic, description);
        assert.equal(
          success(await put("off", paths.choices)).outcome,
          "completed",
        );
        assert.equal(provider.testCalls.at(-1).value, "off");
        error(await put(0, paths.choices), "INVALID_PUT_VALUE");
        error(await put("off", paths.choices, "private"), "PERMISSION_DENIED");
        error(
          await put("off", paths.choices, "public", "reader"),
          "PERMISSION_DENIED",
        );
        assert.equal(provider.testCalls.length, before + 1);
        provider.setMetadata(paths.choices, {
          supportsPut: true,
          type: "multiple",
          possibleValues: [
            { title: "Off", value: "off" },
            { title: "Zero", value: 0 },
          ],
        });
        description = await describe();
        assert.equal(description.approvalStatus, "required");
        assert.equal(description.enabled, false);
        error(await put(0, paths.choices), "APPROVAL_PENDING");
        await f.decide(selected);
        assert.equal(success(await put(0, paths.choices)).outcome, "completed");
        assert.equal(provider.testCalls.at(-1).value, 0);
        error(await put("0", paths.choices), "INVALID_PUT_VALUE");
        await f.decide(selected, "rejected");
        description = await describe();
        assert.equal(description.approvalStatus, "rejected");
        assert.equal(description.reason, "APPROVAL_REJECTED");
        error(await put("off", paths.choices), "APPROVAL_REJECTED");
        assert.equal(provider.testCalls.length, before + 2);
      },
    );

    await t.test(
      "stale supportsPut metadata after native plugin disable reports native 405",
      async () => {
        const before = provider.testCalls.length;
        const stopped = provider.testLifecycle.stops;
        const disabled = await f.http(
          "/plugins/put-fixture/config",
          "admin",
          "POST",
          { enabled: false, configuration: {} },
        );
        assert.equal(disabled.status, 200);
        for (
          let attempt = 0;
          attempt < 100 && provider.testLifecycle.stops === stopped;
          attempt++
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(provider.testLifecycle.stops > stopped);
        assert.equal(provider.readMetadata(paths.state).supportsPut, true);
        const result = success(await put(0));
        assert.equal(result.outcome, "completed");
        assert.equal(result.reply.statusCode, 405);
        assert.equal(provider.testCalls.length, before);
      },
    );
  },
);
