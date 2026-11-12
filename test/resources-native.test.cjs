const { test } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("./runtime-fixture.cjs");
const uuid = "00000000-0000-4000-8000-000000000001";
const root = "/signalk/v2/api/resources";

test(
  "native Resources routing uses the original bearer and registered providers with unchanged results",
  { timeout: 30000 },
  async (t) => {
    const fixture = await start();
    t.after(async () => {
      try {
        await fixture.stop();
      } finally {
        fixture.remove();
      }
    });
    t.diagnostic(
      `Node ${process.version}; Signal K ${fixture.version}; synthetic resource providers, not the Logbook package`,
    );
    const security = fixture.server.app.securityStrategy;
    assert.equal(security.anyACLs(), true);
    const calls = [];
    const entry = {
      id: uuid,
      datetime: "2026-10-22T01:02:03Z",
      timestamp: "2026-10-22T01:02:04Z",
      author: "123",
      origin: "null",
      text: "Synthetic log entry",
      telemetry: [{ path: "environment.depth.belowKeel", value: 0 }],
      $source: "resource-fixture",
      "x-fixture": { unknown: null, href: "https://example.invalid/no-fetch" },
    };
    let onRead = () => {};
    const { resourcesApi } = fixture.server.app;
    for (const type of [
      "routes",
      "waypoints",
      "regions",
      "notes",
      "charts",
      "logentries",
      "custom",
    ]) {
      resourcesApi.register("resource-fixture", {
        type,
        methods: {
          listResources: async (query) => {
            calls.push({ type, query });
            onRead();
            if (query.dates === true) return { "2026-10-22": { count: 1 } };
            return {
              [uuid]:
                type === "logentries"
                  ? entry
                  : { name: type, zero: 0, missing: null },
            };
          },
          getResource: async (id) => {
            calls.push({ type, id });
            onRead();
            if (id !== uuid) throw new Error("synthetic missing resource");
            return type === "logentries" ? entry : { name: type };
          },
          setResource: async () => {
            throw new Error("resource mutation must never run");
          },
          deleteResource: async () => {
            throw new Error("resource mutation must never run");
          },
        },
      });
    }
    async function call(operation, args = {}, expectedCode) {
      const response = await fixture.request("execute_capability", {
        id: "api.resources",
        operation,
        arguments: args,
      }).result;
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const result = response.body.result;
      if (expectedCode) {
        assert.equal(result.isError, true, JSON.stringify(result));
        assert.equal(
          result.content[0].text,
          expectedCode,
          JSON.stringify(result),
        );
        return result;
      }
      assert.equal(result.isError, undefined, JSON.stringify(result));
      return result.structuredContent;
    }
    const native = async (path, token = fixture.tokens.reader) =>
      fetch(`${fixture.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    assert.equal((await native(root, "invalid")).status, 401);
    assert.equal((await native(`${root}/logentries?limit=1`)).status, 200);
    const collections = await call("list_collections");
    assert.ok(collections.supportedCollections.includes("logentries"));
    const providers = await call("list_resource_providers", {
      collection: "logentries",
    });
    assert.deepEqual(providers.providers, ["resource-fixture"]);
    assert.deepEqual(
      (
        await call("list_logentries", {
          date: "2026-10-22",
          author: "123",
          origin: "null",
          category: "true",
          bbox: [170, -10, -170, 10],
        })
      ).data,
      { [uuid]: entry },
    );
    assert.deepEqual(calls.at(-1).query, {
      date: "2026-10-22",
      author: "123",
      origin: "null",
      category: "true",
      bbox: "170,-10,-170,10",
      provider: "resource-fixture",
    });
    assert.deepEqual(
      (await call("get_resource", { collection: "logentries", id: uuid })).data,
      entry,
    );
    assert.deepEqual(
      (await call("list_logentry_dates", { date: "2026-10-22" })).data,
      { "2026-10-22": { count: 1 } },
    );
    for (const collection of ["routes", "waypoints", "regions", "notes"]) {
      const args = {
        collection,
        bbox: [1, 2, 3, 4],
        position: [2, 3],
        distance: 100,
        zoom: 2,
        limit: 5,
      };
      if (collection === "notes") args.href = `/resources/waypoints/${uuid}`;
      await call("list_resources", args);
      assert.deepEqual(calls.at(-1).query.bbox, [1, 2, 3, 4]);
      assert.deepEqual(calls.at(-1).query.position, [2, 3]);
      assert.equal(calls.at(-1).query.limit, 5);
      assert.equal(calls.at(-1).query.distance, 100);
      assert.deepEqual(
        (await call("get_resource", { collection, id: uuid })).data,
        { name: collection },
      );
    }
    await call("list_resources", {
      collection: "custom",
      query: { zone: "123", removed: false, tags: ["a", "b"] },
    });
    assert.deepEqual(calls.at(-1).query, {
      zone: "123",
      removed: false,
      tags: ["a", "b"],
      provider: "resource-fixture",
    });
    await call("list_resources", { collection: "charts" });
    assert.deepEqual(calls.at(-1).query, { provider: "resource-fixture" });
    await call(
      "get_resource",
      { collection: "routes", id: "00000000-0000-4000-8000-000000000002" },
      "CAPABILITY_UNAVAILABLE",
    );
    // Ordinary telemetry retains its own per-path ACL filtering. Resource
    // payloads follow native Resources access, including historical telemetry.
    fixture.seed([{ path: "environment.depth.belowKeel", value: 0 }]);
    const readings = await fixture.request("get_values", {
      paths: ["environment.depth.belowKeel"],
    }).result;
    assert.ok(
      !JSON.stringify(readings.body.result.structuredContent).includes(
        '"value":0',
      ),
    );
    // Revoking the caller during an awaited native provider read must prevent
    // returning that response, even though the upstream request already ran.
    onRead = () => {
      const devices = security.getConfiguration().devices;
      devices.splice(
        devices.findIndex((d) => d.clientId === "reader"),
        1,
      );
    };
    await call(
      "get_resource",
      { collection: "logentries", id: uuid },
      "INVALID_TOKEN",
    );
    const rejected = await native(root);
    assert.equal(rejected.status, 401);
  },
);

const { start: startWrites } = require("./put-native-fixture.cjs");
test(
  "native Resources create/upsert/delete require saved method/provider reviews and native write access",
  { timeout: 90000 },
  async (t) => {
    const f = await startWrites();
    t.after(async () => {
      try {
        await f.stop();
      } finally {
        f.remove();
      }
    });
    t.diagnostic(
      `Node ${process.version}; Signal K ${f.version}; synthetic resource mutations only`,
    );
    const { resourcesApi } = f.server.app;
    const calls = [];
    const stored = new Map();
    const resourceBodies = {
      wiringDevices: { name: "Synthetic lamp", ratedPower: 0, spare: null },
      routes: {
        name: "route",
        feature: {
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
        },
      },
      waypoints: {
        name: "waypoint",
        feature: { geometry: { type: "Point", coordinates: [0, 0] } },
      },
      regions: {
        feature: {
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        },
      },
      notes: { title: "note", position: { latitude: 0, longitude: 0 } },
      charts: {
        name: "chart",
        type: "tilelayer",
        url: "https://example.invalid/{z}/{x}/{y}.png",
      },
      logentries: {
        text: "entry",
        enrich: false,
        telemetry: [{ path: "navigation.speedOverGround", value: 0 }],
        "x-fixture": { keep: null },
      },
    };
    for (const type of Object.keys(resourceBodies)) {
      resourcesApi.register("resource-fixture", {
        type,
        methods: {
          listResources: async () => Object.fromEntries(stored.get(type) ?? []),
          getResource: async (id) => {
            const value = stored.get(type)?.get(id);
            if (!value) throw new Error("not found");
            return value;
          },
          setResource: async (id, body) => {
            calls.push({ type, method: "set", id, body });
            if (!stored.has(type)) stored.set(type, new Map());
            stored.get(type).set(id, body);
            if (body["x-fail"])
              throw new Error("PRIVATE PROVIDER ERROR must not escape");
          },
          deleteResource: async (id) => {
            calls.push({ type, method: "delete", id });
            stored.get(type)?.delete(id);
          },
        },
      });
    }
    const nativeCatalogue = (path, token) =>
      fetch(`${f.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    const catalogueRoot = "/plugins/signalk-mcp/catalogue";
    const indexResponse = await nativeCatalogue(
      catalogueRoot + "?offset=0",
      f.tokens.admin,
    );
    assert.equal(indexResponse.status, 200);
    const index = await indexResponse.json();
    for (const collection of [
      "routes",
      "waypoints",
      "regions",
      "notes",
      "charts",
      "logentries",
    ]) {
      assert.ok(
        index.capabilities.some((c) => c.id === `resource.${collection}`),
      );
      const response = await nativeCatalogue(
        catalogueRoot + `?id=resource.${collection}`,
        f.tokens.admin,
      );
      assert.equal(response.status, 200);
      const catalogue = await response.json();
      assert.ok(
        catalogue.operations.some(
          (o) =>
            o.provider === "resource-fixture" &&
            o.method === "POST" &&
            o.review,
        ),
      );
      assert.ok(
        catalogue.operations.some(
          (o) => o.method === "GET" && o.approvalRequired === false,
        ),
      );
    }
    assert.equal(calls.length, 0, "catalogue must read metadata only");
    const mutate = (operation, collection, body, id, principal = "writer") =>
      f.call(
        "execute_mutation",
        {
          id: "api.resources",
          operation,
          arguments: {
            collection,
            provider: "resource-fixture",
            ...(body === undefined ? {} : { body }),
            ...(id === undefined ? {} : { id }),
          },
        },
        principal,
      );
    function error(result, code) {
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(result.content[0].text, code);
    }
    function data(result) {
      assert.equal(result.isError, undefined, JSON.stringify(result));
      return result.structuredContent;
    }
    async function decide(collection, method, decision = "approved") {
      const config = await f.readConfig();
      config.configuration.readRequests = f.reviews();
      const review = Object.values(config.configuration.readRequests).find(
        (r) =>
          r.kind === "resource" &&
          r.collection === collection &&
          r.method === method,
      );
      assert.ok(review);
      review.decision = decision;
      await f.saveConfig(config);
    }
    error(
      await mutate(
        "create_resource",
        "logentries",
        resourceBodies.logentries,
        undefined,
        "reader",
      ),
      "PERMISSION_DENIED",
    );
    assert.equal(Object.keys(f.reviews()).length, 0);
    error(
      await mutate("create_resource", "logentries", resourceBodies.logentries),
      "APPROVAL_PENDING",
    );
    const pending = Object.values(f.reviews())[0];
    assert.equal(pending.kind, "resource");
    assert.equal(pending.provider, "resource-fixture");
    assert.equal(JSON.stringify(pending).includes('"text":"entry"'), false);
    assert.equal(calls.length, 0);
    for (const principal of [null, "reader", "writer"]) {
      const settings = await f.readConfig();
      settings.configuration.readRequests = f.reviews();
      Object.values(settings.configuration.readRequests)[0].decision =
        "approved";
      assert.ok(
        [401, 403].includes(
          (
            await f.http(
              "/plugins/signalk-mcp/config",
              principal,
              "POST",
              settings,
            )
          ).status,
        ),
      );
    }
    await decide("logentries", "POST", "rejected");
    error(
      await mutate("create_resource", "logentries", resourceBodies.logentries),
      "APPROVAL_REJECTED",
    );
    await decide("logentries", "POST");
    // Saved approval cannot substitute for the original user's native resources
    // PUT permission. The fixture initially grants only telemetry action PUTs.
    const denied = data(
      await mutate("create_resource", "logentries", resourceBodies.logentries),
    );
    assert.equal(denied.outcome, "unknown");
    assert.equal(denied.statusCode, 403);
    assert.equal(calls.length, 0);
    f.server.app.securityStrategy.getConfiguration().acls[0].resources.unshift({
      paths: ["resources"],
      permissions: [{ subject: "writer", permission: "put" }],
    });
    for (const [collection, body] of Object.entries(resourceBodies)) {
      if (collection !== "logentries") {
        error(
          await mutate("create_resource", collection, body),
          "APPROVAL_PENDING",
        );
        await decide(collection, "POST");
      }
      const created = data(await mutate("create_resource", collection, body));
      assert.equal(created.outcome, "responded", JSON.stringify(created));
      assert.equal(created.statusCode, 201);
      assert.equal(created.retrySafe, false);
      const id = created.data.id;
      assert.match(id, /^[0-9a-f-]{36}$/i);
      assert.deepEqual(stored.get(collection).get(id), body);
      const updated = { ...body, "x-update": { exact: null, zero: 0 } };
      error(
        await mutate("put_resource", collection, updated, id),
        "APPROVAL_PENDING",
      );
      await decide(collection, "PUT");
      const saved = data(await mutate("put_resource", collection, updated, id));
      assert.equal(saved.outcome, "responded", JSON.stringify(saved));
      assert.equal(saved.statusCode, 200);
      assert.deepEqual(stored.get(collection).get(id), updated);
      const before = calls.length;
      const other = data(
        await mutate("put_resource", collection, updated, id, "other"),
      );
      assert.equal(other.outcome, "unknown");
      assert.equal(other.statusCode, 403);
      assert.equal(calls.length, before);
      error(
        await mutate("delete_resource", collection, undefined, id),
        "APPROVAL_PENDING",
      );
      await decide(collection, "DELETE");
      assert.equal(
        data(await mutate("delete_resource", collection, undefined, id))
          .statusCode,
        200,
      );
      assert.equal(stored.get(collection).has(id), false);
    }
    const before = calls.length;
    const failed = data(
      await mutate("create_resource", "logentries", {
        ...resourceBodies.logentries,
        "x-fail": true,
      }),
    );
    assert.equal(failed.outcome, "unknown");
    assert.equal(failed.submitted, true);
    assert.equal(failed.retrySafe, false);
    assert.equal(failed.data, undefined);
    assert.ok(!JSON.stringify(failed).includes("PRIVATE PROVIDER ERROR"));
    assert.equal(calls.length, before + 1);
    resourcesApi.register("other-resource-fixture", {
      type: "logentries",
      methods: {
        listResources: async () => ({}),
        getResource: async () => {
          throw new Error("missing");
        },
        setResource: async () => {
          throw new Error("must not write");
        },
        deleteResource: async () => {
          throw new Error("must not delete");
        },
      },
    });
    error(
      await mutate(
        "put_resource",
        "logentries",
        resourceBodies.logentries,
        uuid,
      ),
      "RESOURCE_PUT_PROVIDER_AMBIGUOUS",
    );
    assert.equal(calls.length, before + 1);
    const settings = await f.readConfig();
    settings.configuration.readRequests = {};
    await f.saveConfig(settings);
    error(
      await mutate("create_resource", "logentries", resourceBodies.logentries),
      "APPROVAL_PENDING",
    );
  },
);

test(
  "published Wiring plugin supports native resource CRUD through MCP with synthetic storage",
  {
    timeout: 90000,
    skip:
      !process.env.MCP_TEST_WIRING_DIR &&
      "Set MCP_TEST_WIRING_DIR to unpacked signalk-wiring 0.7.0",
  },
  async (t) => {
    const path = require("node:path");
    const wiring = path.resolve(process.env.MCP_TEST_WIRING_DIR);
    assert.equal(require(path.join(wiring, "package.json")).version, "0.7.0");
    const f = await startWrites({ plugins: [["signalk-wiring", wiring]] });
    t.after(async () => {
      try {
        await f.stop();
      } finally {
        f.remove();
      }
    });
    t.diagnostic(
      `Node ${process.version}; Signal K ${f.version}; published Wiring 0.7.0; temporary SQLite and synthetic devices only`,
    );
    const unpack = (result) => {
      assert.equal(result.isError, undefined, JSON.stringify(result));
      return result.structuredContent;
    };
    const read = async (operation, args) =>
      unpack(
        await f.call(
          "execute_capability",
          {
            id: "api.resources",
            operation,
            arguments: args,
          },
          "reader",
        ),
      );
    const collections = await read("list_collections", {});
    for (const collection of [
      "wiringDevices",
      "wiringWireRuns",
      "wiringCircuits",
      "wiringPlans",
      "wiringZones",
      "wiringConduits",
      "wiringSchematics",
      "wiringSettings",
    ]) {
      assert.ok(collections.supportedCollections.includes(collection));
      const listed = await read("list_resources", { collection });
      assert.equal(listed.provider, "signalk-wiring");
    }
    const settings = await read("get_resource", {
      collection: "wiringSettings",
      id: "config",
    });
    assert.equal(settings.data.defaultLengthUnit, "m");
    const mutate = (operation, collection, body, id, principal = "writer") =>
      f.call(
        "execute_mutation",
        {
          id: "api.resources",
          operation,
          arguments: {
            collection,
            provider: "signalk-wiring",
            ...(body === undefined ? {} : { body }),
            ...(id === undefined ? {} : { id }),
          },
        },
        principal,
      );
    async function approve(collection, method) {
      const config = await f.readConfig();
      config.configuration.readRequests = f.reviews();
      const review = Object.values(config.configuration.readRequests).find(
        (r) =>
          r.kind === "resource" &&
          r.collection === collection &&
          r.method === method,
      );
      assert.ok(review);
      review.decision = "approved";
      await f.saveConfig(config);
    }
    async function reviewed(operation, collection, body, id, method) {
      const pending = await mutate(operation, collection, body, id);
      assert.equal(pending.content[0].text, "APPROVAL_PENDING");
      await approve(collection, method);
      return unpack(await mutate(operation, collection, body, id));
    }
    const lamp = {
      name: "Synthetic lamp",
      type: "light",
      role: "consumer",
      ratedPowerW: 0,
      notes: "fixture",
      neverRemote: true,
    };
    assert.equal(
      (
        await mutate(
          "create_resource",
          "wiringDevices",
          lamp,
          undefined,
          "reader",
        )
      ).content[0].text,
      "PERMISSION_DENIED",
    );
    assert.equal(Object.keys(f.reviews()).length, 0);
    const pending = await mutate("create_resource", "wiringDevices", lamp);
    assert.equal(pending.content[0].text, "APPROVAL_PENDING");
    await approve("wiringDevices", "POST");
    // Saved gateway review does not replace the caller's native Resources ACL.
    const denied = unpack(
      await mutate("create_resource", "wiringDevices", lamp),
    );
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.outcome, "unknown");
    f.server.app.securityStrategy.getConfiguration().acls[0].resources.unshift({
      paths: ["resources"],
      permissions: [{ subject: "writer", permission: "put" }],
    });
    const created = unpack(
      await mutate("create_resource", "wiringDevices", lamp),
    );
    assert.equal(created.statusCode, 201);
    const id = created.data.id;
    const got = await read("get_resource", { collection: "wiringDevices", id });
    assert.equal(got.data.name, lamp.name);
    assert.equal(got.data.ratedPowerW, 0);
    assert.equal(got.data.neverRemote, true);
    const native = await f.http(
      `${root}/wiringDevices/${id}?provider=signalk-wiring`,
      "reader",
    );
    assert.deepEqual(got.data, native.body);
    const updated = await reviewed(
      "put_resource",
      "wiringDevices",
      { notes: "updated" },
      id,
      "PUT",
    );
    assert.equal(updated.outcome, "responded");
    const preserved = await read("get_resource", {
      collection: "wiringDevices",
      id,
    });
    assert.equal(
      preserved.data.name,
      lamp.name,
      "provider preserves omitted fields",
    );
    assert.equal(preserved.data.notes, "updated");
    // Custom resource ids need not be UUIDs.
    const supplyId = "synthetic-battery";
    const supply = unpack(
      await mutate(
        "put_resource",
        "wiringDevices",
        {
          name: "Synthetic battery",
          type: "battery",
          role: "storage",
          nominalVoltage: 12,
        },
        supplyId,
      ),
    );
    assert.equal(supply.outcome, "responded");
    const cable = await reviewed(
      "create_resource",
      "wiringWireRuns",
      {
        fromDeviceId: supplyId,
        toDeviceId: id,
        gauge: 2.5,
        gaugeUnit: "mm2",
        length: 0,
        lengthUnit: "m",
      },
      undefined,
      "POST",
    );
    assert.equal(cable.outcome, "responded");
    const circuits = await read("list_resources", {
      collection: "wiringCircuits",
    });
    const nativeCircuits = await f.http(
      `${root}/wiringCircuits?provider=signalk-wiring`,
      "reader",
    );
    assert.deepEqual(
      circuits.data,
      nativeCircuits.body,
      "derived provider data is forwarded unchanged",
    );
    assert.ok(Object.keys(circuits.data).length > 0);
    const removed = await reviewed(
      "delete_resource",
      "wiringDevices",
      undefined,
      id,
      "DELETE",
    );
    assert.equal(removed.outcome, "responded");
    assert.equal(
      (await read("get_resource", { collection: "wiringDevices", id })).data
        .status,
      "removed",
    );
    const settingsWrite = await reviewed(
      "put_resource",
      "wiringSettings",
      {},
      "config",
      "PUT",
    );
    assert.equal(settingsWrite.outcome, "unknown");
    assert.equal(settingsWrite.statusCode, 404);
    assert.equal(settingsWrite.retrySafe, false);
    assert.deepEqual(
      (
        await read("get_resource", {
          collection: "wiringSettings",
          id: "config",
        })
      ).data,
      settings.data,
      "the provider rejects configuration writes; collection names do not determine permissions",
    );
  },
);
