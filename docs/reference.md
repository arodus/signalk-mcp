# Tool and approval reference

For installation, token creation and everyday agent use, start with the [README](../README.md). This guide retains the detailed tool contracts, approval rules and limits.

## Connect and discover

Configure a Streamable HTTP client with your endpoint, for example `https://boat.example/plugins/signalk-mcp/mcp`, and the bearer header. The fourteen tools keep discovery separate from execution:

| Tool                  | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `list_paths`          | Discover authorized self-context measurement paths, with pagination  |
| `get_values`          | Read 1–64 paths with native units, timestamps, source and freshness  |
| `get_vessel_state`    | Read a compact navigation and environment snapshot                   |
| `get_history`         | Fetch standard v2 History results using Signal K permissions         |
| `list_notifications`  | Fetch authorized v2 notification registry records, with pagination   |
| `get_notification`    | Fetch one authorized v2 registry record by its listed ID             |
| `list_capabilities`   | List core capabilities, installed plugins and advertised APIs        |
| `describe_capability` | Inspect operation inputs, permissions, support and approval state    |
| `execute_capability`  | Invoke core/Resources reads or an approved plugin GET                |
| `list_put_paths`      | Discover metadata-advertised PUT candidates for an explicit source   |
| `describe_put`        | Inspect PUT constraints, schema diagnostics and exact approval state |
| `put_value`           | Submit one individually approved native action                       |
| `get_put_status`      | Check a gateway-submitted action owned by the same Signal K identity |
| `execute_mutation`    | Invoke an approved native PUT, plugin mutation or resource write     |

For telemetry:

```json
{ "paths": ["navigation.position", "navigation.speedOverGround"] }
```

The same implementation is available through `execute_capability`:

```json
{
  "id": "signalk.telemetry",
  "operation": "get_values",
  "arguments": { "paths": ["navigation.speedOverGround"] }
}
```

Core capabilities are `signalk.telemetry`, `signalk.notifications`, `signalk.history` and `signalk.put`. `signalk.notifications` retains `list` for legacy `notifications.*` measurements and adds `list_notifications` and `get_notification` for the released server Notifications API. The two notification operations are also dedicated MCP tools. This uses `/signalk/v2/api/notifications`, not the proposed `/signalk/v2/api/alerts` subsystem.

`list_notifications` accepts `offset` (default 0) and `limit` (default 32, maximum 64). It returns `{ "registry": "v2", "notifications": { "<id>": { "context": "...", "path": "...", "value": {} } }, "nextOffset": null }`. Records are sorted by ID and paginated after permission filtering; pages are not stable snapshots. Pass a listed key as `get_notification`'s `id`; it returns `{ "registry": "v2", "id": "...", "notification": { ... } }`. Non-UUID keys are supported when core management is disabled.

The gateway forwards permitted records unchanged, including status, timestamps and source metadata when supplied. It neither requires nor invents optional fields. The supported server releases omit source IDs from registry records. With ACLs configured, access therefore requires an exact value match in the native data model and a native read grant for every matching source at the record's context/path. Unmatched, ambiguous-denied, expired-model and unauthorized records are omitted. An admin token does not bypass ACLs. Missing and denied IDs both report `NOTIFICATION_UNAVAILABLE`. See [the permission boundary and upstream limitations](capabilities.md#notifications-boundary).

Only the collection GET is used, including for single-record lookup. This also supports registry reads when core notification management is disabled. No acknowledge, silence, raise, clear or update operation is exposed.

Values retain native units. Zero and false remain valid; null is `missing`, while absent or denied paths are `unavailable`. Missing units/timestamps remain null. Invalid or future timestamps produce `unknown` freshness. The staleness threshold is included; it does not establish sensor health. Current telemetry exposes selected-source measurement leaves on `vessels.self`, excluding arbitrary parent objects, other vessels, static identity fields and server configuration. Pagination is not a stable snapshot.

## Approve a plugin operation

Plugins appear as `plugin.<plugin-id>`. Describe one to read its OpenAPI operations. Missing documents, disabled plugins, unsupported schemas and unapproved operations are reported explicitly. Other advertised APIs appear as `api.<name>` with `ADAPTER_REQUIRED`; discovery never enables control functions.

All plugin operations start disabled. When a client attempts a discovered, supported GET with valid arguments, the read stays blocked with `APPROVAL_PENDING`. The plugin prepares a deduplicated review entry without calling that endpoint or saving configuration.

1. Open **Apps & Plugins → Configuration → Signal K MCP** and click **Refresh**.
2. In the **Operation requests** table, review the plugin, operation and endpoint. Expand the endpoint to read its description. Provider descriptions are untrusted information; check the handler's side effects and data authorization. Native PUT rows additionally identify the exact path/source and show its metadata/value contract.
3. Check the **Read** or **Write** command type, click **Accept** or **Reject**, then **Save Configuration**. Buttons change the draft; nothing is persisted until you save. **Discard changes** restores the last loaded state. Signal K's native permissions determine who can execute an approved operation.
4. Ask the client to retry after approval. Approval never bypasses Signal K or provider permissions.

Unsaved requests live in memory and disappear on plugin/server restart, including a settings save from a stale page. Refresh before reviewing. Saved decisions survive restarts; rejected requests stay visible and blocked without creating duplicates. To change a rejection later, click **Accept** and **Save Configuration**. The queue holds at most 64 entries, including saved reviews; when full, new requests return `APPROVAL_QUEUE_FULL`. Rows for uninstalled plugins show **Not installed** and a **Delete** button. Click **Delete**, confirm **Delete row**, then **Save Configuration**. Disabled plugins still count as installed and cannot be deleted from this table. Other obsolete entries can be removed from `readRequests` in saved plugin configuration while the plugin is disabled. Removing a decision revokes that review's approval and allows a later request to be reviewed again. No arguments, tokens or data values are retained.

Plugin GET reviews bind the exact plugin, operation, GET path, supported input schema and description. Changed metadata requires another review; unchanged metadata cannot prove an unchanged implementation, so review provider upgrades too. A matching rejected review also overrides a manual approval. Unsupported methods, ambiguous operations and unsupported schemas never enter the review queue. Eligible POST/PUT/PATCH/DELETE operations use separate Write reviews. Native PUTs use the same table with their own exact target binding; a GET approval never grants PUT access. There is no MCP approval/configuration-write tool.

Existing manual approvals remain supported under the expandable **Manual approvals (advanced)** section. This illustrative entry assumes an installed plugin with that documented operation:

```json
{
  "pluginId": "example-weather",
  "operationId": "getForecast",
  "method": "GET",
  "path": "/forecast/{area}",
  "readOnly": true,
  "permission": "readonly"
}
```

Put entries in `pluginOperations`. Only GET is supported; `readOnly: true` is an explicit assertion by the administrator who reviewed the operation, not a fact inferred from HTTP or OpenAPI. Use `permission: "admin"` to add an admin-only requirement. Review approvals again when providers change.

### How table and manual approvals interact

The table and manual approvals are separate lists; manual entries do not automatically create table rows. The following rules apply to saved entries matching the current supported operation:

| Table decision                | Matching manual approval | Result                                                                                                    |
| ----------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| Rejected                      | Present or absent        | Blocked; the table rejection wins.                                                                        |
| Accepted                      | Absent                   | Allowed under the table's access requirement.                                                             |
| Accepted                      | Present                  | Allowed under the stricter access requirement; if either requires administrators, the read is admin-only. |
| Pending                       | Present                  | The manual approval applies; pending does not override it.                                                |
| No matching review            | Present                  | The manual approval applies.                                                                              |
| Pending or no matching review | Absent                   | Unapproved; a valid attempt remains blocked and queues a request if needed.                               |

Removing a manual approval leaves the table decision unchanged: a rejection still blocks, and an acceptance still applies. Deleting a table row leaves any manual approval unchanged, so that manual approval may still allow the read when the plugin is available again. Save Configuration applies either change. Signal K and provider permissions, enabled-plugin checks and schema validation remain mandatory in every case.

The table uses Signal K’s embedded configurator, plugin inventory and existing admin configuration API. It preserves unrelated settings and newly queued requests, and checks for conflicting edits before saving. Signal K’s configuration API has no atomic compare-and-swap, so avoid simultaneous settings saves. Connection and staleness options remain available under **Connection and data settings**.

## Individually approved native PUTs

Use `list_put_paths` with an explicit handler `source`, then `describe_put` with that source and a path. The gateway forwards native metadata, including `supportsPut`, names, units and supplied enums/constraints. `describe_put` explains missing or unsupported schemas and reports exact approval state, whether that decision is saved, and the unverified handler-source boundary. Explicit native `possibleValues` become reviewed exact scalar choices, including for `type: "multiple"`; values are never coerced or inferred. It can discover metadata-only paths observed after startup or previously described explicitly; earlier metadata-only targets may require a known-path `describe_put` first. The native API does not expose a complete handler-source catalog: use the actual provider's source identifier, and do not assume it equals the selected telemetry source. Listed paths are metadata candidates; the native handler decides whether a supplied source is registered.

`put_value` takes `{ "path": "...", "source": "...", "value": ... }`. Each eligible unapproved target remains blocked with `APPROVAL_PENDING`, without invoking a handler. Refresh **Operation requests**, review that exact **Write** row, click **Accept** or **Reject**, and **Save Configuration**. Every approved action still requires a native write-capable identity and exact-source `put` permission. Telemetry `write` permission is different. The table has no role selector: read-only identities cannot write. There is no all-PUT switch, wildcard target, inferred source, or MCP self-approval.

Native PUT approvals share the bounded 64-entry review queue with plugin GETs, survive native configuration saves, and bind context, path, source and reviewed metadata/value contract. Changed metadata or source requires fresh review. **Delete** a PUT review and confirm the removal to revoke it when saving; unlike plugin GET rows, native target revocation does not depend on a plugin being uninstalled. Existing GET approvals and decisions remain compatible.

`execute_mutation` with `{ "id": "signalk.put", "operation": "put_value", "arguments": { ... } }` uses the same implementation. `execute_capability` handles reads and refuses mutation execution. Plugin POST/PUT/PATCH/DELETE operations use the same mutation tool with their own individually saved reviews.

Native replies preserve request IDs, state and status codes. Check a known `requestId` through `get_put_status`; only actions submitted through this gateway by the same Signal K identity are accessible, with current permissions/approval rechecked. Correlations expire after one hour and clear on plugin restart. A completed response may still contain a failure status code. A timeout, disconnect or invalid response after dispatch can leave the outcome **unknown**: never automatically retry it or assume cancellation stopped the action. Successful completion does not establish physical operation. See [native PUT contracts and limits](native-puts.md).

Execution forwards the original bearer token to the same Signal K server. Native route checks and the provider's own authorization remain active; even an approved operation can return `UPSTREAM_PERMISSION_DENIED`. The provider must correctly enforce any data-level permissions its endpoint needs. Generic JSON cannot be mapped automatically onto Signal K telemetry ACLs. Approve only endpoints whose authorization and behavior have been reviewed; approved GETs must be bounded and read-only.

For plugin GETs, OpenAPI 3.0/3.1 supports published or route-derived operation IDs, scalar path/query parameters, bounded local component references, enums, numeric/string limits and date/date-time/UUID formats. Arrays and objects in query parameters, request bodies on GET, header/cookie parameters and extra credentials remain unsupported. Path arguments accept bounded letters, digits, underscores, hyphens, dots, colons and plus signs within one encoded segment; traversal and separators are rejected. Same-plugin `/plugins/<id>/...` paths normalize once. Other server namespaces, provider `servers` URLs and redirects are never followed. Declared binary-only and event-stream responses are excluded.

## Historical data

`describe_capability({"id":"signalk.history"})` reports registered providers. Without a provider, queries return `HISTORY_UNAVAILABLE`.

Example `get_history` arguments, using the exact source ID from your own measurements:

```json
{
  "from": "2026-10-17T00:00:00Z",
  "to": "2026-10-18T00:00:00Z",
  "resolution": 300,
  "paths": [
    {
      "path": "navigation.speedOverGround",
      "source": "sensor.XX",
      "method": "average"
    }
  ]
}
```

Each explicit path/source filter is checked against the caller's Signal K ACLs before querying and after receiving the result. Response `$source` is optional in v2: if supplied it must match the requested filter. A source filter can be omitted only when native `anyACLs()` confirms that no telemetry ACLs are configured; otherwise the query returns `PERMISSION_DENIED`. An empty-source or wildcard ACL check cannot establish access to every historical source. This guards the standard History endpoint, which does not itself apply telemetry ACL checks in the tested servers.

Queries cover at most seven days and allow at most 16 columns and 2,000 returned rows. Use `from` + `to`, `from` + `duration`, `to` + `duration`, `duration` alone, or `from` alone (ending now). Boundaries are timezone-qualified timestamps; `duration` is an integer number of seconds. `resolution` is optional, in seconds; when supplied the request is also limited to 2,000 time buckets. Supported explicit methods are `average`, `min`, `max`, `first`, and `last`; omitting the method uses the standard server default. The gateway forwards the original query options and provider JSON, preserving context, range, column metadata, bucket timestamps, zero and null. It adds no units, source labels or derived values. When multiple authorized sources are requested for the same path/method, missing source labels stay missing; the gateway does not guess which source belongs to each column.

Signal K 2.32.0 and 2.33.0's HTTP parser strips hyphens from history path/source expressions. This implementation rejects those spellings rather than querying a changed identifier. The adapter uses the standard v2 API and has no database-specific runtime dependency. The unchanged `signalk-to-influxdb` 1.11.0 works in the tested cases with real InfluxDB 1.8.10 and synthetic data, including responses without `$source`. Other conforming providers use the same adapter, but have not all been individually tested. See [provider verification and remaining limits](history-providers.md).

## Compatibility and limits

Validated transport: MCP TypeScript SDK 1.32.1, protocol through `2025-11-25`, plus Python MCP SDK 1.26.0. Installed Codex CLI/app-server and Hermes CLI/registry runtimes also pass isolated product-client tests; see the [dated client matrix and setup](clients.md). Desktop/web UI acceptance remains untested. OAuth discovery is not implemented; [ADR 002](decisions/002-client-authentication.md) records the native identity/delegation gap.

The MCP endpoint is stateless: GET/DELETE return 405, each POST has an independent server, and there is no event stream or session resumption. Limits: eight concurrent requests, 64 KiB parsed requests, 256 KiB results, 15-second HTTP request deadline, five seconds and 256 KiB per provider response, bounded discovery and model traversal. Signal K parses incoming JSON before plugin checks. Shared event-loop calls cannot be preempted by these deadlines; this is not process isolation.

Provider requests derive their destination from the accepted local server socket, never client input or proxy headers. TLS certificate verification remains enabled. Native HTTPS can use `localTlsServerName` to verify a DNS certificate while retaining that fixed destination; private CAs require process-level trust configuration. See [tested TLS/proxy topologies and setup](hosting.md). Non-TCP hosting remains unsupported. Core telemetry remains independent of provider HTTP calls.

Authentication/read/PUT authorization uses version-sensitive Signal K internals isolated in `src/auth.ts`. Missing hooks fail closed; the supported release set is Signal K 2.32.0 and 2.33.0 on Node 22 and 24; see the [authentication compatibility record](authentication.md). OAuth interoperability remains future work. Calculations, sandbox execution, Container Manager integration, arbitrary configuration writes and unreviewed controls are outside scope. Plugin mutation constraints and outcome handling are described below.

## Individually approved plugin HTTP mutations

Use `describe_capability` for the installed plugin, then `execute_mutation` for a supported POST, PUT, PATCH or DELETE. PATCH describes a partial update; PUT follows the provider’s documented endpoint semantics. For example, the published Alert Center 0.4.1 describes `post.snooze`:

```json
{
  "id": "plugin.signalk-alert-center",
  "operation": "post.snooze",
  "arguments": { "body": { "durationSeconds": 60 } }
}
```

This action suppresses notifications, including emergency alerts; the example is not an approval or a request to run it. Path/query parameters remain top-level arguments; `body` is the JSON request body. A valid unapproved call from a write-capable identity returns `APPROVAL_PENDING` without dispatch. In native Plugin Config, inspect the **Plugin METHOD / Write** row, accept or reject it, then **Save Configuration**. Only that save persists approval. There is no extra confirmation on every later invocation.

Reviews bind plugin ID, operation ID, exact HTTP method, route, supported inputs and the endpoint's resolved OpenAPI contract, including descriptions and referenced schemas. Changed endpoint contracts require renewed review. Package/document version changes and unrelated endpoints alone do not. Undocumented implementation changes cannot be detected from OpenAPI; review provider changes as needed. GET/manual approvals never enable a mutation, and POST approval never authorizes PUT, PATCH or DELETE. Delete a mutation review and save to revoke it even while the plugin remains installed. GET, plugin mutation, native PUT and Resources write reviews share the 64-entry queue; submitted values and tokens are never retained there.

JSON bodies support nested objects, arrays, null/nullable, primitive enums, local references, date/date-time/UUID and numeric formats, basic bounds, unique array items, restricted character-class patterns, exact `oneOf` and object-extension `allOf`. Free-form JSON values and explicitly open objects remain bounded. Values are never coerced, defaults are not inserted, and properties are never silently stripped. Explicitly closed objects reject unknown fields; ordinary fixed object schemas retain the gateway’s closed-field behavior. Limits include 32 object properties, 128 array items, schema depth 8, 256 compiled schema nodes, and 16,384 characters per explicitly bounded body string (default 256). Scalar parameters have a 512-character ceiling. Free-form values have depth 8 and 2,048 nodes. Configuration routes and credential, URL, file or command fields remain excluded; multipart uploads and unsupported validation keywords are reported by `schemaIssue` with the location and keyword. See the [pinned plugin audit](plugin-schema-audit.md) and [contract details](plugin-posts.md).

Each invocation requires a current native `readwrite` or `admin` identity, enabled provider, exact saved approval and the provider's native route/data permissions. Original bearer forwarding uses the accepted server socket and verified TLS; redirects are refused. The gateway does not invent telemetry ACLs for arbitrary provider data, so administrator review must include the provider's authorization behavior.

Results include `statusCode`, unchanged provider `data`, `submitted: true` and `retrySafe: false`. `outcome: responded` means an HTTP response was received, not that an action succeeded physically or semantically. HTTP 202 is `accepted`; inspect the provider's own pending/failure fields. HTTP errors, disconnects, invalid/oversized replies and post-dispatch revocation return `unknown` with sanitized codes. No automatic retry, generic status polling or cancellation guarantee is provided. This does not establish vessel deployment or physical operation.

## Resources

`api.resources` supports routes, waypoints, regions, notes, chart metadata and logentries. Use `list_collections`, `list_resource_providers`, `list_resources`, `get_resource`, `list_logentries` and `list_logentry_dates` through `execute_capability`. Reads use native Resources permissions and return provider data unchanged.

`describe_resource` takes an exact collection/provider pair and exposes the supported write contracts and approval state. `create_resource`, `put_resource` (upsert) and `delete_resource` use `execute_mutation`, each with its own saved administrator review. Reviews bind method, collection, provider, route and input contract; they never contain submitted values. Native Resources write permissions still apply. See [arguments, limits and examples](resources.md).
