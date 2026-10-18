// The pinned published provider runs unchanged inside the real Signal K server.
// Only this test setup writes synthetic rows to a disposable local InfluxDB.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { URLSearchParams } = require("node:url");
const { createRequire } = require("node:module");

const providerId = "signalk-to-influxdb";
const from = "2026-10-17T10:00:00Z";
const to = "2026-10-17T10:01:00Z";
const context = "vessels.urn:mrn:signalk:uuid:mcp-test";

async function installHistoryProvider(dir) {
  const url = new URL(process.env.MCP_TEST_INFLUX_URL);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1", "Use a disposable loopback database");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  const database = `mcp_history_${crypto.randomBytes(8).toString("hex")}`;
  async function query(q) {
    const response = await fetch(new URL("/query", url), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ q, db: database }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.results?.[0]?.error, undefined, JSON.stringify(result));
    return result;
  }
  await query(`CREATE DATABASE ${database}`);
  const points = [
    ["navigation.speedOverGround", "fixture.XX", 0, from],
    ["navigation.speedOverGround", "fixture.XX", 5, "2026-10-17T10:00:02Z"],
    ["navigation.speedOverGround", "fixture.XX", 7, to],
    ["navigation.speedOverGround", "private.source", 99, from],
    ["navigation.speedOverGround", "fixture-XX", 31, from],
    ["navigation.speedOverGround", "fixtureXX", 47, from],
    ["navigation.test-path", "fixture.XX", 53, from],
    ["navigation.testpath", "fixture.XX", 61, from],
  ];
  for (let index = 0; index < 2002; index++)
    points.push([
      "navigation.many",
      "fixture.XX",
      index,
      new Date(Date.parse(from) + index * 1000).toISOString(),
    ]);
  const response = await fetch(
    new URL(`/write?db=${database}&precision=ms`, url),
    {
      method: "POST",
      body: points
        .map(
          ([measurement, source, value, timestamp]) =>
            `${measurement},context=${context},source=${source} value=${value} ${Date.parse(timestamp)}`,
        )
        .join("\n"),
      signal: AbortSignal.timeout(5000),
    },
  );
  assert.equal(response.status, 204, await response.text());
  const packageFile = require.resolve(`${providerId}/package.json`);
  const version = require(packageFile).version;
  assert.equal(version, "1.11.0");
  fs.symlinkSync(
    path.dirname(packageFile),
    path.join(dir, "node_modules", providerId),
    "dir",
  );
  fs.writeFileSync(
    path.join(dir, "plugin-config-data", `${providerId}.json`),
    JSON.stringify({
      enabled: true,
      configuration: {
        protocol: "http",
        host: url.hostname,
        port: Number(url.port),
        database,
        resolution: 200,
        batchWriteInterval: 0,
        recordTrack: false,
        storeOthers: false,
      },
    }),
  );
  return { cleanup: () => query(`DROP DATABASE ${database}`) };
}

async function checkHistoryProvider(t, server, host, bearer, client) {
  const base = `http://${host}/signalk/v2/api/history`;
  const input = {
    provider: providerId,
    from,
    to,
    resolution: 10,
    paths: [
      {
        path: "navigation.speedOverGround",
        source: "fixture.XX",
        method: "first",
      },
    ],
  };
  async function read(paths, extras = {}) {
    const params = new URLSearchParams({
      provider: providerId,
      context: "vessels.self",
      from,
      to,
      resolution: "10",
      paths,
      ...extras,
    });
    for (const [key, value] of Object.entries(extras))
      if (value === undefined) params.delete(key);
    const response = await fetch(`${base}/values?${params}`, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  await t.test(
    "real Influx provider source filters work without optional response $source",
    async () => {
      const raw = await read("navigation.speedOverGround:first|fixture.XX");
      assert.equal(raw.context, context);
      assert.deepEqual(raw.values, [
        {
          path: "navigation.speedOverGround",
          method: "first",
          sourceRef: "fixture.XX",
        },
      ]);
      assert.deepEqual(raw.data, [
        ["2026-10-17T10:00:00.000Z", 0],
        ["2026-10-17T10:01:00.000Z", 7],
      ]);
      assert.equal(Date.parse(raw.range.from), Date.parse(from));
      assert.equal(Date.parse(raw.range.to), Date.parse(to));
      assert.equal(raw.values[0].units, undefined);
      const alternateSource = await read(
        "navigation.speedOverGround:first|private.source",
      );
      assert.equal(alternateSource.data[0][1], 99);
      const result = await client.callTool({
        name: "get_history",
        arguments: input,
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.deepEqual(result.structuredContent, raw);
      const generic = await client.callTool({
        name: "execute_capability",
        arguments: {
          id: "signalk.history",
          operation: "get_history",
          arguments: input,
        },
      });
      assert.deepEqual(generic.structuredContent, raw);
      const absent = await read("navigation.speedOverGround:first|absent.XX");
      assert.deepEqual(absent.data, []);
      const empty = await client.callTool({
        name: "get_history",
        arguments: {
          ...input,
          paths: [{ ...input.paths[0], source: "absent.XX" }],
        },
      });
      assert.equal(empty.isError, undefined, JSON.stringify(empty));
      assert.deepEqual(empty.structuredContent, absent);
    },
  );
  await t.test(
    "standard time-range alternatives are forwarded to the production provider",
    async () => {
      const raw = await read("navigation.speedOverGround:first|fixture.XX");
      for (const time of [
        { from, duration: 60 },
        { to, duration: 60 },
      ]) {
        const result = await client.callTool({
          name: "get_history",
          arguments: {
            provider: providerId,
            paths: input.paths,
            resolution: 10,
            ...time,
          },
        });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        assert.deepEqual(result.structuredContent, raw);
      }
      for (const time of [
        { duration: 60 },
        { from: new Date(Date.now() - 60000).toISOString() },
      ]) {
        const result = await client.callTool({
          name: "get_history",
          arguments: {
            provider: providerId,
            paths: [{ ...input.paths[0], source: "absent.XX" }],
            ...time,
          },
        });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        assert.deepEqual(result.structuredContent.data, []);
        if (time.duration)
          assert.equal(
            Date.parse(result.structuredContent.range.to) -
              Date.parse(result.structuredContent.range.from),
            60000,
          );
      }
    },
  );
  await t.test(
    "unfiltered production reads omit optional source and resolution only without native ACLs",
    async () => {
      const configuration = server.app.securityStrategy.getConfiguration();
      const original = configuration.acls;
      try {
        configuration.acls = [];
        const raw = await read("navigation.speedOverGround:first", {
          resolution: undefined,
        });
        const result = await client.callTool({
          name: "get_history",
          arguments: {
            provider: providerId,
            from,
            to,
            paths: [{ path: "navigation.speedOverGround", method: "first" }],
          },
        });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        assert.deepEqual(result.structuredContent, raw);
      } finally {
        configuration.acls = original;
      }
    },
  );
  await t.test(
    "native source denial blocks real-provider reads for an otherwise readable path",
    async () => {
      const security = server.app.securityStrategy;
      const acl = security.getConfiguration().acls[0];
      const original = acl.resources;
      acl.resources = [
        {
          sources: ["private.source"],
          permissions: [{ subject: "other", permission: "read" }],
        },
        ...original,
      ];
      try {
        assert.equal(
          security.checkACL(
            "reader",
            "vessels.self",
            "navigation.speedOverGround",
            "fixture.XX",
            "read",
          ),
          true,
        );
        assert.equal(
          security.checkACL(
            "reader",
            "vessels.self",
            "navigation.speedOverGround",
            "private.source",
            "read",
          ),
          false,
        );
        const result = await client.callTool({
          name: "get_history",
          arguments: {
            ...input,
            paths: [
              {
                path: "navigation.speedOverGround",
                source: "private.source",
                method: "first",
              },
            ],
          },
        });
        assert.equal(result.content[0].text, "PERMISSION_DENIED");
        assert.equal(result.structuredContent, undefined);
      } finally {
        acl.resources = original;
      }
    },
  );
  await t.test(
    "real server strips hyphens and selects different stored path/source",
    async () => {
      const source = await read("navigation.speedOverGround:first|fixture-XX");
      assert.equal(source.values[0].sourceRef, "fixtureXX");
      assert.equal(source.data[0][1], 47);
      const field = await read("navigation.test-path:first|fixture.XX");
      assert.equal(field.values[0].path, "navigation.testpath");
      assert.equal(field.data[0][1], 61);
      // The gateway rejects the original identifiers before issuing a query.
      for (const paths of [
        [{ path: "navigation.speedOverGround", source: "fixture-XX" }],
        [{ path: "navigation.test-path", source: "fixture.XX" }],
      ]) {
        assert.equal(
          (
            await client.callTool({
              name: "get_history",
              arguments: { ...input, paths },
            })
          ).isError,
          true,
        );
      }
    },
  );
  await t.test(
    "provider returns unaligned bucket timestamps and has no implicit 2000-row cap",
    async () => {
      const raw = await read("navigation.speedOverGround:first|fixture.XX", {
        from: "2026-10-17T10:00:01Z",
      });
      assert.deepEqual(raw.data[0], ["2026-10-17T10:00:00.000Z", 5]);
      const forwarded = await client.callTool({
        name: "get_history",
        arguments: {
          ...input,
          from: "2026-10-17T10:00:01Z",
        },
      });
      assert.equal(forwarded.isError, undefined, JSON.stringify(forwarded));
      assert.deepEqual(forwarded.structuredContent, raw);
      const many = await read("navigation.many:first|fixture.XX", {
        to: "2026-10-17T10:33:21Z",
        resolution: "1",
      });
      assert.equal(many.data.length, 2002);
      const provider = await server.app.getHistoryApi(providerId);
      const providerRequire = createRequire(
        require.resolve(`${providerId}/package.json`),
      );
      const { Temporal } = providerRequire("@js-temporal/polyfill");
      const direct = await provider.getValues({
        from: Temporal.Instant.from(from),
        to: Temporal.Instant.from(to),
        context: "vessels.self",
        resolution: 10,
        pathSpecs: [
          {
            path: "navigation.speedOverGround",
            aggregate: "first",
            parameter: [],
            sourceRef: "fixture-XX",
          },
        ],
      });
      // The unchanged provider accepts hyphens; mutation happens in the HTTP parser.
      assert.equal(direct.values[0].sourceRef, "fixture-XX");
      assert.equal(direct.data[0][1], 31);
    },
  );
}
module.exports = { installHistoryProvider, checkHistoryProvider };
