# Resources API

The `api.resources` capability reads and writes Signal K's native v2 Resources API using the caller's existing token. Each write operation needs its own saved administrator review. It supports standard and custom collections from registered providers, including logbook entries and `signalk-wiring` records. Results are forwarded unchanged. Measurement tools retain their own path/source ACL checks; resource contents follow native Resources route permissions.

Use `describe_capability` with `id: "api.resources"`, then `execute_capability` with the same ID and one of these operations:

| Operation                 | Arguments                                                                          | Result                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `list_collections`        | None                                                                               | Native collection descriptions and supported collection names.                              |
| `list_resource_providers` | `collection`                                                                       | Registered provider IDs for that collection, including custom collections.                  |
| `list_resources`          | `collection`, optional `provider`, `limit` and supported filters or custom `query` | Standard or custom resources keyed by resource ID. Use `list_logentries` for logbook lists. |
| `get_resource`            | `collection`, `id`, optional `provider`                                            | One resource, including custom records and logentries by UUID.                              |
| `list_logentries`         | A `date`, both `from` and `to`, or `limit`; optional `provider` and filters        | Logbook entries keyed by UUID.                                                              |
| `list_logentry_dates`     | Optional `provider`, `date` or both `from` and `to`                                | The provider's day calendar and counts.                                                     |

A sole registered provider is selected automatically. If several providers serve a collection, supply its exact ID as `provider`. Reads target that provider explicitly, avoiding merged results and hidden provider errors. A missing collection/provider returns an unavailable error. Discovery does not assume an installed Logbook version registers `logentries`.

## Filters and limits

Routes, waypoints, regions and notes support `limit` (default 100, maximum 500), `bbox` as `[west, south, east, north]`, `distance` in metres, `position` as `[longitude, latitude]` with `distance`, and `zoom`. Notes additionally support a relative resource `href` filter. Charts return metadata and accept no filters. Filter meanings and spatial selection belong to the provider.

Logentry lists require a calendar `date` (`YYYY-MM-DD`), a complete RFC 3339 `from`/`to` pair spanning at most 31 days, or `limit` (1–500). `limit` selects the newest matching entries according to the provider. Optional filters are `bbox`, `category`, `origin` and `author`; author is attribution stored by the provider. A date cannot be combined with a range. Calendar reads use the provider's `dates=true` query and accept an optional date or a complete range spanning at most 366 days, with at most 2000 returned dates.

The adapter forwards at most 500 listed resources and 224 KiB of provider JSON per response, within the existing five-second HTTP timeout. A result exceeding the requested limit or response bounds returns an error instead of a truncated list. Narrow the query when necessary. Providers can have additional query limits.

Resource IDs are single route segments; logentry IDs must be UUIDs. URLs, attachments and chart sources in responses remain data. The adapter does not fetch their contents or chart tiles. Writes use the separate mutation tool and approval flow below.

## Custom collections

Custom collections use the same operations and native HTTP routes as standard resources; plugin OpenAPI is not required. Names must be discovered in the current native resource inventory and providers must still be registered on each call. Collection names are case-sensitive, at most 64 characters, start with a letter and otherwise contain letters, digits, underscores or hyphens. Resource IDs are at most 128 characters, start with a letter or digit and use the same safe characters. Prototype keys, path traversal, reserved control paths and arbitrary URLs are excluded.

`list_resources` accepts an optional `query` object for custom collections. Up to 32 named filters can contain strings (up to 4096 characters), finite numbers, booleans, null or arrays of up to 128 such values. Query JSON is limited to 8 KiB. Values are JSON-encoded for the native handler, preserving strings such as `"123"` and `"null"`, arrays, false and zero. Query keys must start with a letter and contain only letters, digits or underscores (maximum 64 characters). `provider` and `limit` are separate arguments and cannot be overridden through `query`.

Custom lists add no default query parameters except the selected provider. They allow up to 500 results by default; an explicit `limit` is forwarded and also caps the accepted result count. Providers may ignore it. Oversized results fail without truncation, so use provider-supported filters or get records by ID. Standard spatial filters are not assumed to apply to custom collections; supply the provider's documented filters in `query`. The existing specialized logentry operations retain their date/window contracts.

Custom writes accept a bounded JSON object and preserve its fields unchanged. The administrator reviews an exact collection/provider/method contract that explicitly states that field validation, omitted-field handling, deletion and other effects belong to the provider. Native discovery does not advertise field schemas or prove that every write method is usable. A read-only provider can reject a reviewed write; rejection after dispatch is reported as an unknown outcome and never retried. Collection names containing `settings` or `config` have no special permission meaning. Native configuration routes and default-provider management remain inaccessible.

Existing standard and logbook approval identities are unchanged. Custom POST requires a server-generated ID; custom PUT and DELETE accept safe non-UUID IDs. Standard resource and logentry ID validation is retained.

For example, read Wiring devices:

```json
{
  "id": "api.resources",
  "operation": "list_resources",
  "arguments": { "collection": "wiringDevices", "provider": "signalk-wiring" }
}
```

Use `describe_resource` with that collection/provider to inspect write contracts, then submit a valid write to queue its review in native Plugin Config. After an administrator saves approval, use `execute_mutation` with `create_resource`, `put_resource` or `delete_resource`. Wiring's provider preserves omitted fields on updates and soft-deletes devices. Its `wiringSettings` provider rejects writes itself. Attachments, switching, calibration and other plugin-specific routes are separate from native resource CRUD and still require supported plugin API discovery.

## Create, save and delete resources

Call `describe_resource` through `execute_capability` with `collection` and an exact `provider` ID to inspect the three write contracts and their approval state. Then use `execute_mutation` with `id: "api.resources"`:

| Operation         | Arguments                              | Behavior                                                                                                                               |
| ----------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `create_resource` | `collection`, `provider`, `body`       | POST a new resource with a server-generated ID. Supply neither `body.id` nor a chart `identifier`; use `put_resource` for a chosen ID. |
| `put_resource`    | `collection`, `provider`, `id`, `body` | PUT the resource at that ID, creating or replacing it according to the provider's contract. This is an upsert, not a partial patch.    |
| `delete_resource` | `collection`, `provider`, `id`         | DELETE the selected resource.                                                                                                          |

The **Operation catalogue** lists all advertised resource collections and each registered provider without invoking resource handlers. Standard collections, logentries and discovered custom collections expose native-permission reads and individually reviewed POST/PUT/DELETE candidates. Bulk write approval stages exact collection/provider/method contracts for one native save, which rechecks current provider availability and PUT ambiguity. Discovery cannot prove that a provider implements every write method; the native handler remains authoritative.

Alternatively, a valid unapproved write queues metadata in **Operation catalogue** and returns `APPROVAL_PENDING` without submitting it. Review the **Resource / Write** row in native Plugin Config, accept or reject it, and **Save Configuration**. Each review binds one collection, provider, HTTP method, route template, input contract and documented meaning. Create approval does not approve replacement or deletion. Submitted bodies and tokens are not stored in the review. Delete a saved review and save to revoke it.

Writes require native Read/Write or Admin identity and the native Resources route's `put` permission for `resources`. The original token is forwarded; saved review does not replace native permissions. This is separate from telemetry `put_value` actions and their path/source approvals.

The gateway validates known standard/logbook shapes and all body bounds, and preserves extension fields. Custom bodies remain provider-defined JSON objects. Standard resources also pass the native server's schema validation. Logentries require `text`; optional `datetime`, attribution, `telemetry` pathvalues and `enrich` are supported. `enrich: false` asks Logbook to use the supplied snapshot without provider enrichment. Omitted-field preservation and enrichment remain provider behavior. A supplied body ID must match the PUT target. Body inputs are limited to 48 KiB, nesting to 20 levels, and logentry telemetry to 256 pathvalues.

On Signal K 2.32/2.33, native PUT routing prefers an existing resource's provider over the requested provider. To preserve the reviewed provider binding, `put_resource` requires exactly one registered provider for that collection. Multiple-provider reads, creates and deletes use explicit provider selection.

Successful writes return the native status and response with `outcome: "responded"` (or `"accepted"` for HTTP 202). A timeout, disconnection, rejected HTTP response or authorization change after dispatch returns `outcome: "unknown"`, `submitted: true`, and `retrySafe: false`. The gateway never retries a mutation. It does not offer resource revision checks or compare-and-swap updates.

## Examples

Read up to 20 recent logbook entries:

```json
{
  "id": "api.resources",
  "operation": "list_logentries",
  "arguments": { "limit": 20 }
}
```

Read waypoints from a selected provider:

```json
{
  "id": "api.resources",
  "operation": "list_resources",
  "arguments": {
    "collection": "waypoints",
    "provider": "resources-provider",
    "limit": 50,
    "bbox": [9, 53, 11, 55]
  }
}
```

Append a logbook entry after approving that provider's create operation:

```json
{
  "id": "api.resources",
  "operation": "create_resource",
  "arguments": {
    "collection": "logentries",
    "provider": "signalk-logbook",
    "body": { "text": "Arrived at the anchorage.", "enrich": false }
  }
}
```

Use `execute_mutation` for this example and the provider ID returned by your server.

## Verified interfaces

Native route and query contracts were reviewed in the installed Signal K **2.32.0 and 2.33.0** packages (`dist/api/resources/index.js` and `openApi.js`). Standard arrays are JSON-encoded because the native collection handler JSON-parses each query value. The adapter uses fixed local HTTP resource routes with the original bearer, rather than in-process provider methods. It reauthenticates after each asynchronous read and preserves native route errors without exposing provider error bodies.

The Logbook query contract was reviewed at [`meri-imperiumi/signalk-logbook` commit `bf65d25`](https://github.com/meri-imperiumi/signalk-logbook/blob/bf65d25f4eb184368cedecdb9b8405ee037b072f/plugin/provider.js). The published `@meri-imperiumi/signalk-logbook@0.14.3` tarball also contains this provider and its registration (npm shasum `2bf2fb61020b2f9c9a4c006231c969ce2cae041a`). Its `logentries` type is provider-defined on the two supported Signal K versions. Dates, text filters and comma-separated Logbook bounding boxes are serialized separately from standard resource filters. Unknown entry fields, telemetry, units, timestamps, nulls and zeros are preserved.

Portable tests cover discovery, provider selection, query validation and encoding, response limits, identity changes and route restrictions. Native integration tests use real temporary Signal K servers with synthetic resource providers to exercise all six supported collections, native query validation, caller authentication and revocation, resource reads alongside configured measurement ACLs, saved administrator reviews, native Resources write permissions, create/upsert/delete for each collection, and uncertain outcomes after a provider-side write. These tests do not install the Logbook package or establish its deployment state on a vessel.

A separate integration check also passed with the unchanged published **Logbook 0.14.3 provider and `Log` storage** registered on a real temporary Signal K 2.33.0 server (Node 24.22.0). Using synthetic entries and `enrich: false`, it verified saved administrator approval, create/get/filtered list/calendar/upsert/delete, omitted datetime/author preservation and unchanged zero/null/extension data. Full Logbook plugin startup, UI and enrichment were not part of that check. See [verification results](verification.md#native-resources-reads-and-reviewed-writes--2026-10-22).

## Wiring compatibility fixture

The native suite can load the unchanged published `signalk-wiring@0.7.0` plugin into a temporary server with a fresh SQLite database. CI installs this fixture separately on the Node 22/24 and Signal K 2.32.0/2.34.0 matrix; it is not a gateway dependency or part of the npm artifact.

```sh
npm install --prefix /tmp/wiring-provider --ignore-scripts --no-audit --no-fund signalk-wiring@0.7.0
MCP_TEST_WIRING_DIR=/tmp/wiring-provider/node_modules/signalk-wiring \
node --test --test-force-exit test/resources-native.test.cjs
```

Build the gateway first and use Node 22.13 or later for Wiring's built-in SQLite requirement. The fixture checks all eight collection reads, saved approvals, native ACL denial, device and cable creation, arbitrary safe IDs, omitted-field preservation, unchanged provider-derived circuits, soft deletion and the provider's settings-write rejection. It does not call switching or calibration routes, use vessel hardware or establish deployment state.
