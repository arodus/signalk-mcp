# Reviewed plugin POST contracts

The POST extension uses `execute_mutation` and the existing native Plugin Config Accept/Reject/Save workflow. Plugin PUT/PATCH/DELETE and arbitrary HTTP/configuration access remain excluded. See the [usage and limits](../README.md#individually-approved-plugin-posts).

## Contract identity

`src/capabilities/openapi.ts` validates a deliberately narrow JSON object body subset and resolves local component references for the endpoint contract. The digest includes the operation (including its descriptions and responses) and path-level parameters. Keys are sorted before hashing; references, depth, node count and serialized size are bounded. Unrelated endpoints, OpenAPI document version and installed package version are excluded. This follows the owner's explicit decision on 2026-10-19: only a changed endpoint contract requires renewed POST approval.

The saved `kind: post` record contains plugin/operation IDs, exact POST route, description, input schema, contract digest and decision. Its key binds all these fields except the decision. Existing GET records and manual GET approvals are unchanged. PUT reviews retain their own exact source/metadata binding. POSTs can be revoked while the provider remains installed; queued metadata contains no invocation arguments or bearer tokens.

## Execution and authorization

Every call rediscovers the enabled plugin and its current OpenAPI, checks schema and exact review, and validates inputs without coercion or defaults. Reader identities cannot queue or invoke POSTs, including a POST incorrectly declared readonly by its provider. Lifecycle, identity, enabled state and review are checked after asynchronous discovery before dispatch. An unchanged provider implementation is not established by an unchanged contract.

The dedicated fixed-local POST adapter carries only the original bearer, JSON content type/length and Accept header. It ignores caller Host/proxy headers and OpenAPI servers, preserves TLS verification and never follows redirects. Native plugin routes remain responsible for their own data permissions. Unlike native Signal K PUT actions, a plugin POST does not correspond to a telemetry path/source `put` ACL; no fictitious generic ACL substitute is used.

The inspected Signal K 2.32.0/2.33.0 source (`getFeatures`, `createPluginRouter`, `registerPluginRoutePermissions` and `pluginWriteAuthenticationMiddleware`) provides feature discovery and original-caller routing. `router.access` supports readonly/readwrite; an unclassified route uses native admin authorization. The disposable fixture exercises that default admin route and a deliberately misdeclared readonly POST.

## Responses and limits

Provider JSON is forwarded unchanged with the HTTP status. HTTP 202 means accepted, other valid 2xx means responded; neither proves completion or physical operation. Empty HTTP 204 is preserved without invented data. Failures after attempting dispatch, including non-2xx/redirect, transport failure, invalid JSON, output bounds and later revocation, return an unknown outcome with no automatic retry. Provider error bodies are not exposed. There is no generic POST request-status lookup, idempotence claim or cancellation guarantee.

Requests retain the existing 64 KiB MCP limit. POST JSON results are bounded to 224 KiB before the 256 KiB MCP envelope; the upstream deadline is five seconds. Response processing shares the server event loop and does not isolate provider execution.

## Acceptance coverage

Portable tests cover contract renewal, unchanged versions, references, unsafe schemas/inputs/routes, approval separation, rejection, revocation, provider disablement, values and uncertain outcomes. Native tests use temporary Signal K servers and synthetic handlers for original identity, native admin-route denial, native configuration saves, no-dispatch behavior, redirects, malformed/large responses, disconnects, HTTP errors, 202 and 204.

The unchanged published `signalk-alert-center@0.4.1` `/snooze` endpoint is tested separately with no external notifier, sound, speech or connectivity transports enabled. Its bounded integer body and native readwrite routing are verified against provider state. This does not approve that operation for a live vessel or establish arbitrary-provider compatibility. Installed-package verification runs both fixtures against the packed gateway. The existing CI matrix covers Node 22/24 with Signal K 2.32.0/2.33.0.
