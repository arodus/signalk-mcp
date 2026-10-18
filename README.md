# Signal K MCP

A native, read-only Signal K plugin for vessel telemetry, capability discovery and approved plugin API calls over MCP Streamable HTTP. It runs at `/plugins/signalk-mcp/mcp`, using the existing Signal K server, bearer tokens and permissions. No extra account, key, listener or container is required.

**Scope:** discover, fetch and forward authorized data. The gateway does not calculate, aggregate, transform or infer data values and does not provide code execution. Provider-computed results may be fetched and forwarded without being recomputed.

**Development status:** authenticated telemetry and the read-only capability layer are implemented and integration-tested against Signal K 2.32.0 and 2.33.0 with synthetic providers and the published `signalk-alert-manager@0.1.0` package using synthetic alerts. Its reviewed read is admin-only; see the [provider compatibility example](docs/plugin-compatibility.md). There is no npm/AppStore release or vessel deployment yet.

[Project brief](BRIEF.md) · [Working instructions](AGENTS.md) · [Architecture](docs/architecture.md) · [Capability design](docs/capabilities.md) · [Verification](docs/verification.md)

## Install for evaluation

Use Node.js 24 (Signal K's recommended major); Node 22 or later is required. From the repository:

```sh
npm ci --ignore-scripts --omit=optional
npm run check
npm pack
```

Install the tarball in a **test** Signal K 2.32.0 or 2.33.0 configuration directory, using its service account:

```sh
npm install --omit=dev --ignore-scripts /absolute/path/signalk-mcp-0.1.0.tgz
```

Restart Signal K, configure the plugin in Plugin Config, then enable it:

```json
{
  "allowedHosts": ["boat.example:3000"],
  "allowedOrigins": [],
  "staleAfterSeconds": 300,
  "pluginOperations": []
}
```

`allowedHosts` contains exact incoming Host headers, including ports. Behind a proxy, configure the Host it forwards. Forwarded host headers do not determine trust. An empty `allowedOrigins` rejects present Origin headers and permits native clients that omit Origin. Browser use also depends on Signal K's CORS policy.

Enable Signal K security and supply an existing user/device token in `Authorization: Bearer <token>` on every request. Guest reads and security-disabled servers are refused. The plugin does not create tokens or read signing secrets. Use Signal K TLS or a trusted TLS reverse proxy for remote access.

## Connect and discover

Configure a Streamable HTTP client with your endpoint, for example `https://boat.example/plugins/signalk-mcp/mcp`, and the bearer header. The seven tools keep discovery separate from execution:

| Tool                  | Purpose                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `list_paths`          | Discover authorized self-context measurement paths, with pagination |
| `get_values`          | Read 1–64 paths with native units, timestamps, source and freshness |
| `get_vessel_state`    | Read a compact navigation and environment snapshot                  |
| `get_history`         | Query a registered History API provider with explicit source checks |
| `list_capabilities`   | List core capabilities, installed plugins and advertised APIs       |
| `describe_capability` | Inspect operation inputs, permissions, support and approval state   |
| `execute_capability`  | Invoke a core or explicitly approved read-only plugin operation     |

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

Core capabilities are `signalk.telemetry`, `signalk.notifications` and `signalk.history`. `signalk.notifications` provides a paginated `list` of authorized `notifications.*` measurement values; it does not expose notification lifecycle commands or the full v2 alarm registry.

Values retain native units. Zero and false remain valid; null is `missing`, while absent or denied paths are `unavailable`. Missing units/timestamps remain null. Invalid or future timestamps produce `unknown` freshness. The staleness threshold is included; it does not establish sensor health. Current telemetry exposes selected-source measurement leaves on `vessels.self`, excluding arbitrary parent objects, other vessels, static identity fields and server configuration. Pagination is not a stable snapshot.

## Approve a plugin operation

Plugins appear as `plugin.<plugin-id>`. Describe one to read its OpenAPI operations. Missing documents, disabled plugins, unsupported schemas and unapproved operations are reported explicitly. Other advertised APIs appear as `api.<name>` with `ADAPTER_REQUIRED`; discovery never enables control functions.

All plugin operations start disabled. After reviewing the target implementation for side effects, data authorization and safe inputs/outputs, add an exact allowlist entry. This illustrative entry assumes an installed plugin with that documented operation:

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

Execution forwards the original bearer token to the same Signal K server. Native route checks and the provider's own authorization remain active; even an approved operation can return `UPSTREAM_PERMISSION_DENIED`. The provider must correctly enforce any data-level permissions its endpoint needs. Generic JSON cannot be mapped automatically onto Signal K telemetry ACLs. Approve only endpoints whose authorization and bounded read-only behavior have been reviewed.

OpenAPI support is deliberately partial: versions 3.0/3.1; named operations; primitive path/query parameters; bounded local component references; enums and basic numeric/string limits. Arrays, objects, patterns, composition, external references, request bodies and credential/network-target parameters are disabled. Path parameters accept letters, digits, underscores and hyphens. Header/cookie parameters and extra credentials are unsupported. Provider `servers` URLs and redirects are never followed.

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

Each path/source is checked against the current caller's Signal K ACLs before querying and after receiving the result. Responses must match the requested context, time range, paths, sources and aggregation methods; missing source provenance is refused. This guards the standardized History endpoint, which does not itself apply these telemetry ACL checks in the tested server.

Queries require explicit timezone-qualified boundaries, cover at most seven days, and allow at most 16 columns and 2,000 rows/time buckets. Supported methods are `average`, `min`, `max`, `first`, and `last`; `resolution` is in seconds. These are query methods executed by the history provider; the gateway forwards their results and performs no calculations on the values.

Signal K 2.33.0's HTTP parser strips hyphens from history path/source expressions. This implementation rejects those spellings rather than querying a changed identifier. Providers that omit `$source` in response columns are unsupported. This is not broad compatibility evidence for existing production history plugins.

## Compatibility and limits

Validated transport: MCP TypeScript SDK 1.32.1, protocol through `2025-11-25`, plus Python MCP SDK 1.26.0. Product UI compatibility with ChatGPT, Claude, Codex or Hermes is not established. OAuth discovery is not implemented.

The MCP endpoint is stateless: GET/DELETE return 405, each POST has an independent server, and there is no event stream or session resumption. Limits: eight concurrent requests, 64 KiB parsed requests, 256 KiB results, 15-second HTTP request deadline, five seconds and 256 KiB per provider response, bounded discovery and model traversal. Signal K parses incoming JSON before plugin checks. Shared event-loop calls cannot be preempted by these deadlines; this is not process isolation.

Provider requests derive their destination from the accepted local server socket, never client input or proxy headers. TLS certificate verification remains enabled; self-signed/name-mismatched loopback certificates and non-TCP/socket-activated hosting are currently unsupported for HTTP-backed capabilities. Core telemetry remains independent of these calls. Test reverse-proxy/TLS deployments before use.

Authentication/read authorization uses version-sensitive Signal K internals isolated in `src/auth.ts`. Missing hooks fail closed; the supported release set is Signal K 2.32.0 and 2.33.0 on Node 22 and 24; see the [authentication compatibility record](docs/authentication.md). OAuth interoperability and publishing remain future work. Calculations, sandbox execution, Container Manager integration and writes/control are outside scope.

## Development

```sh
npm run check
```

Tests use a real temporary Signal K instance, a synthetic installed provider, disposable identities and synthetic deltas. Signal K binds its test listener using its default address; run in an isolated development environment. No vessel connection is configured.

To include the second client (Python 3.10+):

```sh
python3 -m venv /tmp/signalk-mcp-python
/tmp/signalk-mcp-python/bin/pip install -r test/python-requirements.txt
MCP_TEST_PYTHON=/tmp/signalk-mcp-python/bin/python npm test
```

Without `MCP_TEST_PYTHON`, that test is explicitly skipped. Credentials reach Python over stdin. The test runner uses `--test-force-exit` after tests/cleanup because the upstream test server leaves background handles after stopping; the plugin does not force process exit.

To verify an installed tarball, set `MCP_TEST_PLUGIN_DIR` to the installed package directory while running the integration test. CI covers Signal K 2.32.0 and 2.33.0 on Node 22 and 24 with both clients. See the verification report for actual results and outstanding acceptance work.
