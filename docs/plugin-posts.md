# Reviewed plugin HTTP mutation contracts

POST, PUT, PATCH and DELETE use `execute_mutation` and the existing native Plugin Config Accept/Reject/Save workflow. Each exact method needs its own saved review. PATCH normally makes a partial update; PUT follows the provider’s documented semantics. See the [usage and limits](reference.md#individually-approved-plugin-http-mutations) and [cross-plugin audit](plugin-schema-audit.md).

## Contract identity

`src/capabilities/openapi.ts` uses the shared bounded JSON schema compiler in `src/capabilities/json-schema.ts` and resolves local component references for the endpoint contract. The digest includes the operation (including its descriptions and responses) and path-level parameters. Keys are sorted before hashing; references, depth, node count and serialized size are bounded. Unrelated endpoints, OpenAPI document version and installed package version are excluded. Only a changed endpoint contract requires renewed mutation approval.

The saved `kind: post` record remains unchanged for POST. New `kind: plugin` records represent PUT, PATCH and DELETE. Both contain plugin/operation IDs, exact HTTP method and route, description, input schema, contract digest and decision. Its key binds all these fields except the decision. Existing GET records and manual GET approvals are unchanged. Native telemetry `kind: put` reviews retain their own exact source/metadata binding. Plugin mutations can be revoked while the provider remains installed; queued metadata contains no invocation arguments or bearer tokens.

## Execution and authorization

Every call rediscovers the enabled plugin and its current OpenAPI, checks schema and exact review, and validates inputs without coercion or defaults. Reader identities cannot queue or invoke plugin mutations, including a mutation incorrectly declared readonly by its provider. Lifecycle, identity, enabled state and review are checked after asynchronous discovery before dispatch. An unchanged provider implementation is not established by an unchanged contract.

The shared fixed-local mutation transport carries only the original bearer, JSON content type/length and Accept header. It ignores caller Host/proxy headers and OpenAPI servers, preserves TLS verification and never follows redirects. Native plugin routes remain responsible for their own data permissions. Unlike native Signal K PUT actions, a plugin HTTP mutation does not correspond to a telemetry path/source `put` ACL; no fictitious generic ACL substitute is used.

The inspected Signal K 2.32.0/2.33.0 source (`getFeatures`, `createPluginRouter`, `registerPluginRoutePermissions` and `pluginWriteAuthenticationMiddleware`) provides feature discovery and original-caller routing. `router.access` supports readonly/readwrite; an unclassified route uses native admin authorization. The disposable fixture exercises that default admin route and a deliberately misdeclared readonly POST.

## Responses and limits

Provider JSON is forwarded unchanged with the HTTP status. HTTP 202 means accepted, other valid 2xx means responded; neither proves completion or physical operation. Empty HTTP 204 is preserved without invented data. Failures after attempting dispatch, including non-2xx/redirect, transport failure, invalid JSON, output bounds and later revocation, return an unknown outcome with no automatic retry. Provider error bodies are not exposed. There is no generic plugin mutation request-status lookup, idempotence claim or cancellation guarantee.

Requests retain the existing 64 KiB MCP limit. Plugin mutation JSON results are bounded to 224 KiB before the 256 KiB MCP envelope; the upstream deadline is five seconds. Response processing shares the server event loop and does not isolate provider execution.

## Acceptance coverage

Portable tests cover contract renewal, unchanged versions, references, unsafe schemas/inputs/routes, approval separation, rejection, revocation, provider disablement, values and uncertain outcomes. Native tests use temporary Signal K servers and synthetic handlers for original identity, native admin-route denial, native configuration saves, no-dispatch behavior, redirects, malformed/large responses, disconnects, HTTP errors, 202 and 204.

The unchanged published `signalk-alert-center@0.4.1` `/snooze`, policy PATCH and policy DELETE/reset endpoints are tested separately with all external notifier, sound, speech and connectivity transports disabled. Tests verify the bounded snooze body, nested policy updates and exact provider readback, invalid-policy rejection, and restoration of the original policy after DELETE/reset. This does not approve that operation for a live vessel or establish arbitrary-provider compatibility. Installed-package verification runs both fixtures against the packed gateway. The existing CI matrix covers Node 22/24 with Signal K 2.32.0/2.33.0.

## Shared schema validation

The compiler accepts common bounded JSON contracts rather than adding a plugin-specific adapter: nested objects and arrays, nullable values, local component references, date/date-time/UUID strings, integer/number formats, enums, basic bounds, uniqueness, simple anchored character-class patterns, exact `oneOf`, and object-extension `allOf`. `allOf` validates every branch; explicitly closed branches remain closed. `oneOf` must match exactly one branch, so ambiguous published schemas are not silently interpreted as a union. Free-form JSON and explicitly open objects are validated recursively against size, depth and field-name limits. Unknown validation keywords fail with a location and keyword; documentation-only examples, defaults and annotations never modify arguments.

Scalar query/path serialization remains explicit and bounded. Same-plugin absolute paths are normalized without changing the original reviewed path. Other native namespaces, configuration writes, binary uploads and SSE streams are outside this JSON executor. Source and method remain exact: no URL from OpenAPI or an argument changes the network destination, and idempotent-looking methods are never automatically retried.
