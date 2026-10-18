# History provider compatibility

The gateway uses the standard `/signalk/v2/api/history` API for any registered provider. It has no database-specific runtime adapter or database client. It validates authorization and response structure, then forwards the provider JSON unchanged. It performs no calculations on data and adds no units or inferred source labels.

## Verified matrix

| Provider                         | Server/API              | Backend                             | Gateway status                                                                                                   |
| -------------------------------- | ----------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Synthetic `mcp-fixture`          | 2.32.0 / 2.33.0         | In-memory fixtures                  | Standard contract, omitted optional fields, permission and revocation coverage                                   |
| `signalk-to-influxdb` **1.11.0** | 2.32.0 / 2.33.0         | InfluxDB **1.8.10**, synthetic rows | Works unchanged for the tested standard v2 queries; hyphenated identifiers are rejected due to the server parser |
| Other registered v2 providers    | Not individually tested | Provider-defined                    | Same standard adapter; compatibility depends on honoring the v2 query contract and gateway limits                |

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

The provider includes `range.from` and `range.to` as ISO strings representing the requested boundaries. Both endpoints are inclusive, including the sample exactly at `to`. The gateway forwards the complete response unchanged. This includes the provider's extra `sourceRef` field; it is not converted to `$source` or used as an authorization alias. Missing units stay missing. Dedicated `get_history` and generic capability execution produce identical provider JSON.

The provider groups samples into backend time buckets. For `from=10:00:01Z`, a sample at `10:00:02Z` produces a row timestamp of `10:00:00Z`, outside the requested range. The gateway accepts and forwards this bucket timestamp unchanged. It checks the response range against the query and validates timestamp syntax and row dimensions without shifting timestamps or recomputing values.

A 2,002-sample fixture produces 2,002 rows in the raw API: the provider has no implicit gateway-sized 2,000-row cap. The gateway retains its separate query, row and byte bounds. It does not truncate a result and present it as complete.

The published provider calls `influx.query(...)` without an AbortSignal or cancellation hook. Its History provider interface has no HTTP cancellation argument. The gateway aborts its local HTTP fetch after five seconds; this cannot prove cancellation of backend work. A held synthetic provider response verifies that timeout returns `UPSTREAM_UNAVAILABLE` without data; a throwing provider returns a sanitized `UPSTREAM_HTTP_ERROR`. These are gateway-boundary tests, not a measured cancellation guarantee for InfluxDB.

## Minimal reproductions

`test/history-provider.cjs`, invoked by the existing real-server harness, contains the executable reproductions and synthetic seed data:

1. Store `fixture-XX=31` and `fixtureXX=47` under the same path. Query the raw History HTTP endpoint for `fixture-XX`; Signal K 2.32.0/2.33.0 selects `fixtureXX` and returns 47. Calling the unchanged provider directly with `sourceRef: "fixture-XX"` returns 31. The mutation is in the server's HTTP parser.
2. Store `navigation.test-path=53` and `navigation.testpath=61`. Query the former through HTTP; the response names the latter and returns 61. The gateway rejects the original hyphenated spellings before requesting data.
3. Query an unchanged non-hyphenated path/source. The native provider returns `values[0].sourceRef`, but `$source` is absent. Both MCP invocation forms return the same JSON as the native API, including zero, metadata and exact range/timestamps.

## Optional fields and authorization

The [standard History API](https://demo.signalk.org/documentation/Developing/REST_APIs/History_API.html) and installed `@signalk/server-api/history` types make response `$source` optional. Authorization is established by the explicit source filter sent to the conforming provider, with native path/source ACL checks before and after asynchronous calls. If `$source` is present, it must match the requested source. An omitted field is valid and stays omitted. No provider-specific aliases or fabricated provenance are needed. Providers, like native telemetry producers, are trusted to honor their declared query contract; response metadata alone could never prove that a provider did so.

Query `source`, `method`, `resolution`, `provider`, `from` and `to` are optional. Queries must still describe a bounded range: `from` plus `to`, `from` plus `duration`, `to` plus `duration`, `duration` alone, or `from` alone. The gateway accepts duration as integer seconds, forwards it unchanged and leaves relative-time resolution to the provider. Method defaults come from Signal K. The supported explicit methods and numeric resolution bounds are documented in the README.

An unfiltered history response can combine sources without labelling them. Therefore omitting the source filter requires native `anyACLs()` to confirm no telemetry ACLs exist, plus a native read grant. With configured or unknown ACL state, it returns `PERMISSION_DENIED` before querying; supply an authorized source filter instead. An admin identity or a read grant for an empty/wildcard source cannot establish universal source access. This state is rechecked after each asynchronous read, including ACL insertion while the provider is responding. No signing secrets or security configuration are read by production code.

Columns must match the requested path/method counts. Supplied source labels must fit the requested filters, including when a provider reorders columns; missing labels remain absent even when several authorized sources share a path/method. The gateway never assigns source labels to those columns. Unexpected or contradictory columns, malformed rows, wrong contexts/ranges and oversized results fail closed with no partial output.

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

No provider change is required merely to add optional `$source`. The adapter accepts its absence and preserves any supplied metadata. No upstream issue or message has been sent.
