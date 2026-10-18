# Project brief: native Signal K MCP gateway

**Project:** `signalk-mcp`

**Scope updated:** 2026-10-18, following the owner's explicit direction

**Purpose:** Discover, fetch and forward authorized Signal K data to MCP clients.

This brief supersedes the original proposals for calculations and sandboxed data processing. The gateway does not perform calculations, mathematical analysis, aggregation, integration, inference or other domain transformations on fetched data. It does not provide `execute_code` or a computation worker. These are outside the project scope, not deferred features.

Authorization, input/response validation, bounded selection, pagination and MCP response formatting remain necessary gateway responsibilities. They must not become a place to add derived data or application-specific calculations. Provider-supplied results may be fetched and forwarded with their provenance; the gateway must not calculate missing results or recompute provider values.

## 1. Current implementation

The independent plugin implements authenticated Streamable HTTP, batched telemetry reads, vessel snapshots, legacy notification reads, standard v2 history with native permission checks, a compact capability registry, public feature discovery and on-demand plugin OpenAPI inspection.

Only explicitly reviewed GET operations can execute, using the original Signal K bearer identity and native route permissions. Unknown operations remain disabled. History and OpenAPI coverage are deliberately limited and documented in README.md.

Authenticated reads, standard v2 history and reviewed plugin reads are verified under Signal K 2.32.0/2.33.0 on Node 22/24. The unchanged published packages `signalk-to-influxdb` 1.11.0 and `signalk-alert-center` 0.4.1 are exercised with synthetic data; see [history verification](docs/history-providers.md) and [plugin compatibility](docs/plugin-compatibility.md). Product-client connections, live vessel acceptance and publication remain unverified.

README.md and docs describe implemented behavior and verification. This brief defines the intended scope; it does not establish upstream API availability or live compatibility.

## 2. Objectives

- Install as a native Signal K plugin, with npm/AppStore distribution as the release target.
- Expose MCP Streamable HTTP through the existing Signal K server.
- Reuse existing Signal K identities, bearer tokens and permissions.
- Discover and fetch authorized current telemetry, history and supported read-only APIs.
- Discover installed plugin capabilities through public features, OpenAPI and explicit adapters where needed.
- Forward approved third-party API reads under the original caller's identity.
- Keep the MCP tool catalog compact and support batched reads.
- Remain suitable for ordinary Signal K installations and resource-constrained onboard systems, without Docker or Podman requirements.
- Keep the project independent and useful beyond any single vessel.

## 3. Architecture

```text
MCP client
    |
    | Streamable HTTP + existing Signal K bearer token
    v
Native Signal K MCP endpoint
    |
    | authenticate, validate and authorize each invocation
    v
Read-only capability layer
    |
    +-- current Signal K telemetry
    +-- standardized History API providers
    +-- supported notification reads
    +-- explicitly approved plugin GET operations
    |
    v
Bounded, validated MCP responses preserving provider data
```

Transport, identity, telemetry access, discovery and capability execution remain separate. Dedicated tools and generic capability calls use the same authorization and data-access implementation.

The gateway must not expose controls, configuration writes, arbitrary HTTP requests, host files, shell commands or JavaScript execution. Container Manager integration and sandbox lifecycle management are outside this gateway's scope.

## 4. Authentication and authorization

Reuse Signal K authentication. Do not introduce MCP accounts, a separate key, signing-secret access or privileged tokens.

The endpoint is `/plugins/signalk-mcp/mcp`, accepting the caller's existing bearer token. Native route authorization alone is insufficient: MCP uses POST even for reads, so every individual invocation must also be authorized.

- Reject invalid, expired, revoked or unknown identities and permissions.
- Reject unauthenticated guests and security-disabled servers.
- Preserve the original caller identity throughout provider requests.
- Check Signal K path/source read permissions before exposing telemetry.
- Revalidate permissions after asynchronous requests where necessary.
- Prevent cookies or other credentials from substituting a different identity.
- Fail closed when required authentication or authorization interfaces are unavailable.
- Never treat plugin process access as permission to expose privileged data.

The current security bridge uses isolated, version-sensitive Signal K internals. Supported releases require actual integration tests. Prefer a verified public authentication/authorization interface when one is available.

Some product clients may require OAuth discovery or interactive authorization. Investigate compatibility separately while preserving Signal K identities and permissions; accepting bearer headers alone does not establish every product client's support.

## 5. Transport and tool surface

Use the official MCP TypeScript SDK and stateless Streamable HTTP where supported. Cover initialization, negotiation, content types, protocol versions, concurrent clients, error handling and restart/reconnect behavior with real clients.

| Tool                  | Responsibility                                                 |
| --------------------- | -------------------------------------------------------------- |
| `list_paths`          | Discover authorized measurement paths                          |
| `get_values`          | Fetch multiple current measurements                            |
| `get_vessel_state`    | Fetch a compact selection of current vessel measurements       |
| `get_history`         | Fetch historical results from a compatible registered provider |
| `list_capabilities`   | Discover core and installed-plugin capabilities                |
| `describe_capability` | Describe schemas, permissions, availability and approval state |
| `execute_capability`  | Invoke a supported authorized read-only operation              |

Avoid one tool per measurement or plugin operation. Any future MCP resources must follow the same read-only and authorization boundaries.

Preserve Host/Origin validation, sanitized errors, bounded requests/results, deadlines and concurrency limits. Never log or publish tokens, signing secrets or sensitive vessel data.

## 6. Data contract

Forward values with their Signal K path, unit, timestamp and source where available. Preserve zero, false, null, missing and unavailable distinctions. Do not invent measurements, units, sources or evidence of physical equipment health.

Snapshots are selections of existing values, not calculated summaries. The current implementation exposes selected-source measurement leaves in the self context; broader context or metadata coverage requires explicit design and permission tests.

History must use the standardized Signal K API where a compatible provider exists. Do not add a direct database dependency merely to fetch history. Forward caller query parameters to the provider and preserve its returned values and provenance. Provider-supported methods such as `average`, `min` and `max` are provider query options; this gateway does not implement those calculations.

Apply path/source authorization and validate response context, range, columns, sources and bounds before forwarding history. The v2 response `$source` field is optional. Authorize explicit source filters through native ACLs; when no filter is given, require native confirmation that no telemetry ACLs exist. Refuse contradictory or unexpected column identity, unsupported identifiers and unavailable providers. Do not invent source fields or locally calculated substitutes.

## 7. Capability discovery and plugin reads

Prefer public feature discovery, plugin OpenAPI documents and narrow adapters. Not all installed plugins have complete API descriptions; represent partial support and unavailability explicitly.

Discovery is not approval. Unknown operations stay disabled until their exact plugin, operation, method and path have been reviewed and allowlisted.

- Only reviewed read-only GET operations are eligible.
- GET or OpenAPI presence does not prove the handler is side-effect-free.
- Validate schemas and reject unsupported or ambiguous inputs.
- Reject arbitrary destinations, credential parameters and redirects.
- Preserve native target-route checks and the provider's data-level authorization.
- Treat descriptions and provider data as untrusted input.
- Do not infer telemetry permissions for arbitrary JSON or compensate for a provider that fails to enforce them.
- Retain bounded inputs, outputs, discovery and provider calls.

Use the compact capability interface rather than generating hundreds of MCP tools. Validate interoperability with independently maintained plugins, not only synthetic fixtures.

## 8. Implementation and release sequence

Track the remaining work in [GitHub roadmap #12](https://github.com/arodus/signalk-mcp/issues/12).

### Compatibility and acceptance

- Validate the authentication bridge against an explicit supported Signal K version range.
- Standard v2 History forwarding is exercised with unchanged `signalk-to-influxdb` 1.11.0; see [provider matrix and limits](docs/history-providers.md). Other backends use the same API adapter. Further provider versions still need integration evidence; identifiers altered by the server parser remain rejected.
- Verify discovery and approved reads against independently maintained plugins.
- Test native TLS and reverse-proxy hosting without weakening certificate checks or destination restrictions.
- Test actual MCP products and document bearer/OAuth requirements.

### Read-only coverage

- Investigate a permission-aware adapter for v2 notification registry reads.
- Keep acknowledge, silence, raise, clear and other mutations outside scope.
- Add other read adapters only where authorization and data provenance can be established.

### Hardening and release

- Test lifecycle cleanup, whole-server restart, cancellation, concurrency and bounded resource use.
- Benchmark ARM/Raspberry Pi deployments without degrading Signal K's primary telemetry duties.
- Review security boundaries and dependency exposure.
- Validate installed packages, native configuration and user documentation.
- Prepare a release candidate and verify current npm/AppStore requirements.
- Conduct live read-only vessel acceptance only with explicit deployment/access authorization.
- Publish, release or deploy only when separately authorized, and verify each result independently.

CI success, package installation, AppStore indexing, live retrieval and physical-device operation are distinct forms of evidence. Do not substitute one for another.

## 9. Definition of success

An authenticated MCP client can discover and fetch authorized Signal K measurements and supported plugin/provider responses through a native plugin, with data provenance intact and the original Signal K permissions enforced.

The plugin's responsibility ends at reliable, permission-aware data access and forwarding. Calculations and other data processing are outside this project.
