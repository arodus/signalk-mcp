# History provider compatibility

The gateway discovers, fetches and forwards. It does not calculate history values, repair identifiers, infer sources or replace provider results. A registered provider is discoverable without being compatible with the gateway's response contract.

## Verified matrix

| Provider                         | Server/API      | Backend                                      | Gateway status                                                                                                           |
| -------------------------------- | --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Synthetic `mcp-fixture`          | 2.32.0 / 2.33.0 | In-memory test data                          | Contract and permission regression fixture only; not a production provider                                               |
| `signalk-to-influxdb` **1.11.0** | 2.32.0 / 2.33.0 | Real InfluxDB **1.8.10** with synthetic rows | **Blocked**: response columns contain `sourceRef`, not required `$source`; the server also alters hyphenated identifiers |
| Other provider versions/products | Not tested      | Not tested                                   | Unknown; discovery alone does not establish support                                                                      |

The test dependency is pinned in `package-lock.json`; it is not a gateway runtime dependency. Its published npm package records upstream commit [`c1a48cc07aa106ea0ccbe5ae358cb9fe67322c10`](https://github.com/tkurki/signalk-to-influxdb/tree/c1a48cc07aa106ea0ccbe5ae358cb9fe67322c10). The Docker fixture uses image digest `sha256:299ebda2c7e308dbef42e26ac9b8fd1d9b3bcb8a0aee80c6509aa0219c1d0290` rather than an unpinned latest image.

## Observed contract

The native plugin registers through `app.registerHistoryApiProvider`. The test loads its published package unchanged beside this gateway inside a real temporary Signal K instance. Storage is a disposable loopback-bound InfluxDB container; the test writes only its randomly named synthetic database. No vessel data or existing database is used.

The query is a standard authenticated GET to `/signalk/v2/api/history/values` with `provider=signalk-to-influxdb`, `context=vessels.self`, explicit `from`/`to`, `resolution` in seconds and `paths=navigation.speedOverGround:first|fixture.XX`. The provider receives `PathSpec.sourceRef`, resolves self to the canonical vessel context and applies the exact source to its InfluxQL `WHERE "source" = ...` filter. Separate stored values from `private.source` do not appear in the `fixture.XX` result; an absent source produces no rows. This proves filtering for these fixtures, not a general authorization audit of that plugin.

For the aligned test range, the raw result includes:

```json
{
  "context": "vessels.urn:mrn:signalk:uuid:mcp-test",
  "values": [
    {
      "path": "navigation.speedOverGround",
      "method": "first",
      "sourceRef": "fixture.XX"
    }
  ],
  "data": [
    ["2026-10-17T10:00:00.000Z", 0],
    ["2026-10-17T10:01:00.000Z", 7]
  ]
}
```

The provider includes `range.from` and `range.to` as ISO strings representing the requested boundaries. Both endpoints are inclusive, including the sample exactly at `to`. Columns carry path/method/requested source; they do not include units. The gateway's existing metadata path would obtain standard units from Signal K, but this provider fails provenance validation first and no result is forwarded.

The provider groups samples into backend time buckets. For `from=10:00:01Z`, a sample at `10:00:02Z` produces a row timestamp of `10:00:00Z`, outside the requested range. The gateway refuses out-of-range rows; it does not shift their timestamps or widen the query. Aligned ranges avoid that particular condition but do not resolve the provenance blocker.

A 2,002-sample fixture produces 2,002 rows in the raw API: the provider has no implicit gateway-sized 2,000-row cap. The gateway retains its separate query, row and byte bounds. It does not truncate a result and present it as complete.

The published provider calls `influx.query(...)` without an AbortSignal or cancellation hook. Its History provider interface has no HTTP cancellation argument. The gateway aborts its local HTTP fetch after five seconds; this cannot prove cancellation of backend work. A held synthetic provider response verifies that timeout returns `UPSTREAM_UNAVAILABLE` without data; a throwing provider returns a sanitized `UPSTREAM_HTTP_ERROR`. These are gateway-boundary tests, not a measured cancellation guarantee for InfluxDB.

## Minimal reproductions

`test/history-provider.cjs`, invoked by the existing real-server harness, contains the executable reproductions and synthetic seed data:

1. Store `fixture-XX=31` and `fixtureXX=47` under the same path. Query the raw History HTTP endpoint for `fixture-XX`; Signal K 2.32.0/2.33.0 selects `fixtureXX` and returns 47. Calling the unchanged provider directly with `sourceRef: "fixture-XX"` returns 31. The mutation is in the server's HTTP parser.
2. Store `navigation.test-path=53` and `navigation.testpath=61`. Query the former through HTTP; the response names the latter and returns 61. The gateway rejects the original hyphenated spellings before requesting data.
3. Query an unchanged non-hyphenated path/source. The native provider returns `values[0].sourceRef`, but `$source` is absent. Calling `get_history` returns `HISTORY_PROVENANCE_MISMATCH` with no structured data.

The server API's request type uses `sourceRef`; its response `ValueList` uses `$source`. These fields are not interchangeable merely because their names refer to sources. See the installed `@signalk/server-api/history` types and the pinned provider's `valuesForSpecs` and `querySourceGroup` implementations. No compatibility alias is added here.

Run against a disposable local backend:

```sh
docker run --detach --rm --name signalk-mcp-history-test \
  --publish 127.0.0.1:8086:8086 \
  influxdb:1.8.10@sha256:299ebda2c7e308dbef42e26ac9b8fd1d9b3bcb8a0aee80c6509aa0219c1d0290
# Wait for GET http://127.0.0.1:8086/ping to return 204.
MCP_TEST_INFLUX_URL=http://127.0.0.1:8086 \
MCP_TEST_PYTHON=/path/to/isolated/python \
npm run check
docker stop signalk-mcp-history-test
```

Use Node 24 for the primary check and install Python dependencies from `test/python-requirements.txt`. `MCP_TEST_SERVER_DIR` and `MCP_TEST_SERVER_VERSION` select the alternate runtime as described in [authentication.md](authentication.md). Without `MCP_TEST_INFLUX_URL`, the real-provider subtest is explicitly skipped; ordinary synthetic contract tests still run. CI supplies the pinned database service in every server/Node matrix combination. The local setup validates loopback HTTP and refuses credential-bearing database URLs.

## Local upstream proposal draft — not sent

For Signal K server: validate history expressions without silently deleting valid identifier characters. Preserve supported path/source bytes exactly and reject unsupported syntax with a client error. Add collision regressions covering hyphenated and non-hyphenated stored identifiers, including both path and source. Do not remove input validation or interpolate unchecked expressions into database queries.

For `signalk-to-influxdb`: return the standardized `$source` for each explicitly source-filtered column, backed by the actual source restriction used for the query. Do not invent provenance for unfiltered/mixed-source results. Add tests against the server's `ValueList` response contract. Clarify bucket timestamp/range semantics and cancellation/row-limit behavior before claiming end-to-end bounded support.

An MCP compatibility adapter would require a separately reviewed, version-bound provider contract that proves every returned column is source-restricted and preserves path, method, range and values. This change deliberately does not ship such an adapter. Existing pre/post-query authorization and exact provenance checks remain unchanged. Any future proposal needs explicit review; no upstream issue or message was sent as part of this work.
