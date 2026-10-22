# Generic native API discovery and execution

Course, Weather, Autopilot, Radar, BLE, Tracks and Sensors use the same OpenAPI parser, approval workflow and HTTP executor as plugin APIs. The only API-specific metadata is the fixed native route namespace. No per-provider or per-API execution adapter is required. Tracks is present in Signal K 2.33.0 and absent from 2.32.0; it is only exposed when advertised by the installed server.

`list_capabilities` checks the current native feature inventory. `describe_capability` loads the advertised API document from `/skServer/openapi/<api>` and reports supported operations and their saved approval state. Discovery never queues approvals or calls a control operation. `execute_capability` performs GETs; `execute_mutation` performs POST, PUT, PATCH and DELETE. An eligible unapproved invocation queues metadata only, returning `APPROVAL_PENDING`. A native administrator must review and save the exact operation before execution.

## Discovery lifetime

The seven built-in OpenAPI documents are static in the supported server releases. A gateway-wide cache fetches each lazily on first use, coalesces concurrent fetches and reuses it across MCP requests. It contains at most seven documents, no provider results or credentials. Failed fetches are evicted. Starting or stopping the MCP plugin clears the cache; server upgrades require restarting the server. Documents are served publicly and independently of the caller by the supported native Swagger handler.

Plugin OpenAPI documents remain live because providers may change a contract at runtime. The native `PLUGINS_CHANGED` event reports configuration changes but does not cover every possible document mutation. Feature inventory, identity, saved approval decisions and provider data remain live. Parsing a cached native document does not cache an authorization decision. Newly registered providers are visible through subsequent provider-list calls.

## Authorization and contracts

All generic native operations, including GETs, require exact saved review. A review binds API namespace, operation ID, method, normalized path, supported input schema and documented meaning/security contract. It does not grant a different method or a plugin operation with the same name. Document version alone does not revoke approval. A matching saved rejection wins. Mutations also require a native write-capable identity.

The executor forwards the original bearer through native HTTP routing. Signal K and the provider own endpoint authorization, including access to data returned by those endpoints. The gateway does not invent telemetry-path ACLs for arbitrary API responses. Measurement tools and native telemetry PUT actions retain their existing path/source checks.

Provider responses pass through unchanged. The gateway never calculates tracks, weather or control values. Output schemas are not compiled into inferred data transformations; response transport and descriptions are included in review binding. As with plugin mutations, a failed or disconnected submission has an unknown outcome and is never automatically retried.

## Audited schema coverage

The fixtures in `test/fixtures/native-openapi` come from the published Signal K 2.33.0 package. Counts measure supported contracts, not successful execution of every route or physical device behavior.

| API       | Documented operations | Reviewable contracts | Remaining limits                                                                           |
| --------- | --------------------: | -------------------: | ------------------------------------------------------------------------------------------ |
| Course    |                    15 |                   11 | Two configuration writes; unsupported destination composition and arrival-time pattern     |
| Weather   |                     7 |                    6 | Default-provider configuration write                                                       |
| Autopilot |                    23 |                   22 | Default-provider configuration write                                                       |
| Radar     |                    10 |                   10 | Actual route/provider availability still applies                                           |
| BLE       |                    14 |                    7 | Settings/provider configuration, gateway ingestion, streams, MAC-address parameter pattern |
| Tracks    |                     3 |                    3 | Provider availability and native query validation still apply                              |
| Sensors   |                     3 |                    1 | GNSS configuration writes excluded                                                         |
| Total     |                    75 |                   60 |                                                                                            |

The shared parser supports annotation siblings on local references, bounded scalar `oneOf` parameters, duration strings and simple anchored patterns. Numeric `min`/`max` aliases used by Weather are enforced as bounds; conflicting standard and alias bounds are rejected. Unsupported contracts are reported explicitly, not silently weakened.

Configuration writes, arbitrary URLs, binary transfers, SSE and WebSocket streams remain outside scope. OpenAPI `servers` cannot select a destination. Fixed namespaces, decoded path validation and bounded same-server HTTP remain mandatory. An advertised document is not proof that every route has a handler or a configured provider.

## Verification

`test/native-api.test.cjs` covers all seven pinned documents, contract binding, namespace/method separation, unsafe routes, unsupported transports, schema validation, cache lifecycle and caller authorization. `test/native-api-integration.test.cjs` loads a real temporary Signal K server, discovers the installed server’s documents (seven on 2.33.0, six on 2.32.0), saves reviews through native admin configuration, compares representative GETs with native responses and exercises a synthetic autopilot provider. It verifies read-only rejection, native route permission denial for a different caller, successful single dispatch and saved revocation. No live vessel controls are used.
