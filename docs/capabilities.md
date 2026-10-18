# ADR 002: Read-only capability registry and discovery

Date: 2026-10-18. Scope: native telemetry, notification measurements, standardized history, plugin feature/OpenAPI discovery and explicitly approved GET invocation.

## Architecture

`src/capabilities/registry.ts` owns capability lookup, descriptions and execution. Dedicated tools delegate to that registry, so generic calls cannot bypass the telemetry ACL implementation. Every entry requires an authenticated, recognized Signal K principal; asynchronous work rechecks identity before returning. Disabled/stopped plugins cannot admit new work, and active HTTP requests are aborted on stop/disconnect/deadline.

`getFeatures()` is the public feature inventory. We project API names and plugin IDs/enabled state, exclude our own plugin, bound the inventory, and report discovery failure without disabling core telemetry. Plugin descriptions are loaded on demand from `/skServer/openapi/plugins/:pluginId`. This uses the server's HTTP discovery surface instead of reading `pluginsMap` internals. API names without a dedicated adapter are discoverable but not executable.

An OpenAPI operation is executable only when its plugin is enabled, its operation ID is unique, its schema is supported, and configuration matches the plugin ID, operation ID, GET method and exact path. Duplicate configuration approvals and recursive approvals for this plugin are invalid. Unknown operations, mutation methods and unsupported schema features stay disabled. Documentation is untrusted data, never instructions or proof of read-only behavior. An approval must follow review of the actual handler, including side effects and data-level authorization.

`src/capabilities/http.ts` only issues bounded GETs back to the socket address/port that accepted the MCP request. It forwards only the original bearer token and an Accept header. It follows no redirects, does not fetch external schema references, ignores OpenAPI `servers`, and never uses caller Host/proxy headers to select a destination. Native plugin-route authorization is therefore exercised as the original caller, without a minted plugin/admin token. TLS verification is never disabled. Non-TCP hosting and loopback certificate mismatch fail closed.

Gateway approval is not a promise that the target route will accept the caller. Signal K may impose a stricter permission. Conversely, generic plugin output cannot automatically be translated into telemetry ACL checks; an approved provider remains responsible for its endpoint's data authorization. The test fixture explicitly proves both target ACL and admin-route enforcement.

## History boundary

The standardized History route in the inspected 2.33.0 runtime selects a provider and passes parsed query parameters to it; it does not carry a user principal into that provider or check telemetry ACLs. We therefore authorize explicit path/source pairs before querying and again on response. Context, range, column identity/source/method and row dimensions/timestamps are validated and projected before return. No hidden extra columns or missing source provenance are accepted. Inputs, time buckets, rows, bytes and timeouts are bounded. Queries use the standard HTTP API with the original bearer and a provider ID obtained from the provider inventory.

The server's expression sanitizer removes hyphens even though source IDs can contain them. We reject unsupported expressions rather than silently changing identifiers. A future upstream fix or separately verified direct-provider adapter is needed to broaden support. No direct InfluxDB queries or guessed source provenance are used. Provider work may continue after HTTP cancellation; the gateway cannot cancel an upstream implementation that does not support it.

Notification reads use legacy `notifications.*` model leaves through the same path/source ACLs. No raise/acknowledge/silence/clear operations are exposed. Full v2 notification registry support is separate future work.

## Sources and tests

Source inspection: Signal K master `340d5bb62c17ec58d2a3497dbbf081cd87af2a96`; integration runtime: npm `signalk-server@2.33.0`.

- [Public feature API](https://github.com/SignalK/signalk-server/blob/340d5bb62c17ec58d2a3497dbbf081cd87af2a96/packages/server-api/src/features.ts)
- [OpenAPI HTTP routes](https://github.com/SignalK/signalk-server/blob/340d5bb62c17ec58d2a3497dbbf081cd87af2a96/src/api/swagger.ts)
- [History route and expression parser](https://github.com/SignalK/signalk-server/blob/340d5bb62c17ec58d2a3497dbbf081cd87af2a96/src/api/history/index.ts)
- [Token and route authorization](https://github.com/SignalK/signalk-server/blob/340d5bb62c17ec58d2a3497dbbf081cd87af2a96/src/tokensecurity.ts)

Tests include a synthetic installed native plugin with OpenAPI, readonly/admin/write routes and a registered History API provider. They exercise actual feature discovery, OpenAPI loading, route authentication, caller identity, source ACLs, unapproved/write refusal, external-reference rejection, redirects, schema changes, provider disappearance and malformed history provenance. Focused tests cover partial discovery, notification filtering, schema ambiguity, traversal, output bounds and revocation during an asynchronous response. These are real integration tests with synthetic providers, not validation of arbitrary production plugins.

The project remains independent; contributing to or depending on another MCP plugin is not part of the current direction. Container Manager and execution-worker decisions remain deferred as documented in ADR 001.
