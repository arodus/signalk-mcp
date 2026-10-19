# Project brief: native Signal K MCP gateway

**Project:** `signalk-mcp`

**Scope updated:** 2026-10-19, following the owner's explicit direction in issue #30

**Purpose:** Discover, fetch and forward authorized Signal K data and individually approved native PUT actions for MCP clients.

This brief supersedes the original proposals for calculations and sandboxed data processing. The gateway does not perform calculations, mathematical analysis, aggregation, integration, inference or other domain transformations on fetched data. It does not provide `execute_code` or a computation worker. These are outside the project scope, not deferred features.

Authorization, input/response validation, bounded selection, pagination and MCP response formatting remain necessary gateway responsibilities. They must not become a place to add derived data or application-specific calculations. Provider-supplied results may be fetched and forwarded with their provenance; the gateway must not calculate missing results or recompute provider values.

## 1. Current implementation

The independent plugin implements authenticated Streamable HTTP, batched telemetry reads, vessel snapshots, legacy and v2 notification reads, standard v2 history with native permission checks, a compact capability registry, public feature discovery and on-demand plugin OpenAPI inspection.

Plugin execution remains limited to explicitly reviewed GET operations. The development PUT extension uses the same native administrator review/save workflow, binding every action to an exact self-context path, explicit source and reviewed metadata/value contract. There is no blanket PUT grant. Original Signal K bearer identity, native PUT permissions and native route checks remain mandatory. Unknown operations and plugin POSTs remain disabled. History and OpenAPI coverage are deliberately limited and documented in README.md.

Every plugin GET operation and native PUT target starts blocked and requires an individual administrator approval saved through native Plugin Config. There is no blanket plugin or PUT approval, and native Signal K permissions remain mandatory on every call. Built-in data reads use native permissions without that extra operation review. Release `0.1.0-alpha.2` includes native PUT support and first-time configuration saving. Deployment requires separate authorization.

The configurator permits saving unchanged defaults. Its first successful configuration save refreshes the page so Signal K can display the native Enabled switch; saving preserves the existing enable state and does not approve any operation.

Authenticated reads, standard v2 history and reviewed plugin reads are verified under Signal K 2.32.0/2.33.0 on Node 22/24. The unchanged published packages `signalk-to-influxdb` 1.11.0 and `signalk-alert-center` 0.4.1 are exercised with synthetic data; see [history verification](docs/history-providers.md) and [plugin compatibility](docs/plugin-compatibility.md). End-to-end product-client tunnel connections and live vessel acceptance remain unverified; publication evidence is recorded by the release workflow.

README.md and docs describe implemented behavior and verification. This brief defines the intended scope; it does not establish upstream API availability or live compatibility.

## 2. Objectives

- Install as a native Signal K plugin, with npm/AppStore distribution as the release target.
- Expose MCP Streamable HTTP through the existing Signal K server.
- Reuse existing Signal K identities, bearer tokens and permissions.
- Discover and fetch authorized current telemetry, history and supported data APIs.
- Discover installed plugin capabilities through public features, OpenAPI and explicit adapters where needed.
- Forward approved third-party API reads under the original caller's identity.
- Forward individually approved native self-context PUTs under the original caller's identity, using native metadata for discovery and description. Add reviewed plugin POSTs only in a subsequent change.
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
Permission-aware capability layer
    |
    +-- current Signal K telemetry
    +-- standardized History API providers
    +-- supported notification reads
    +-- explicitly approved plugin GET operations
    +-- individually approved native self-context PUT actions
    |
    v
Bounded, validated MCP responses preserving provider data
```

Transport, identity, telemetry access, discovery and capability execution remain separate. Dedicated tools and generic capability calls use the same authorization and data-access implementation.

The gateway must not expose unreviewed controls, arbitrary configuration writes or HTTP requests, host files, shell commands or JavaScript execution. Native PUT actions need one exact saved review each. Container Manager integration and sandbox lifecycle management are outside this gateway's scope.

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
| `list_notifications`  | Fetch authorized v2 notification registry records              |
| `get_notification`    | Fetch one authorized v2 notification record                    |
| `list_capabilities`   | Discover core and installed-plugin capabilities                |
| `describe_capability` | Describe schemas, permissions, availability and approval state |
| `execute_capability`  | Invoke a core read or an individually approved plugin GET      |
| `list_put_paths`      | Discover PUT candidates for an explicit source                 |
| `describe_put`        | Describe one path/source using native metadata                 |
| `put_value`           | Submit one individually approved native PUT                    |
| `get_put_status`      | Check an owned gateway-submitted native request                |
| `execute_mutation`    | Invoke the same approved native PUT implementation             |

Avoid one tool per measurement or plugin operation. Read tools remain read-only; mutation tools use accurate annotations and a separate execution entry point. Any future MCP resources must follow the same authorization boundaries.

Use Signal K’s server-wide CORS policy for browser requests without separate plugin host/origin lists. Preserve bearer authentication, sanitized errors, bounded requests/results, deadlines and concurrency limits. Never log or publish tokens, signing secrets or sensitive vessel data.

## 6. Data contract

Forward values with their Signal K path, unit, timestamp and source where available. Preserve zero, false, null, missing and unavailable distinctions. Do not invent measurements, units, sources or evidence of physical equipment health.

Snapshots are selections of existing values, not calculated summaries. The current implementation exposes selected-source measurement leaves in the self context; broader context or metadata coverage requires explicit design and permission tests.

History must use the standardized Signal K API where a compatible provider exists. Do not add a direct database dependency merely to fetch history. Forward caller query parameters to the provider and preserve its returned values and provenance. Provider-supported methods such as `average`, `min` and `max` are provider query options; this gateway does not implement those calculations.

Apply path/source authorization and validate response context, range, columns, sources and bounds before forwarding history. The v2 response `$source` field is optional. Authorize explicit source filters through native ACLs; when no filter is given, require native confirmation that no telemetry ACLs exist. Refuse contradictory or unexpected column identity, unsupported identifiers and unavailable providers. Do not invent source fields or locally calculated substitutes.

## 7. Capability discovery and plugin reads

Prefer public feature discovery, plugin OpenAPI documents and narrow adapters. Not all installed plugins have complete API descriptions; represent partial support and unavailability explicitly.

Discovery is not approval. A blocked eligible GET request prepares an in-memory review in native Plugin Config; only an administrator saving that form can approve it. The embedded settings table offers Accept/Reject actions, retained rejected rows and deletion for uninstalled plugins; all changes use the native admin configuration API. Saved decisions bind plugin, operation, GET path, input schema and description. Rejections remain blocked, and unchanged provider metadata still requires implementation review on upgrades. Existing exact manual approvals remain supported. MCP exposes no approval or configuration-write tool.

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

The original data-access roadmap is recorded in [#12](https://github.com/arodus/signalk-mcp/issues/12). Track the subsequent individually approved PUT extension and later plugin POST work in [#30](https://github.com/arodus/signalk-mcp/issues/30).

### Compatibility and acceptance

- Validate the authentication bridge against an explicit supported Signal K version range.
- Standard v2 History forwarding is exercised with unchanged `signalk-to-influxdb` 1.11.0; see [provider matrix and limits](docs/history-providers.md). Other backends use the same API adapter. Further provider versions still need integration evidence; identifiers altered by the server parser remain rejected.
- Verify discovery and approved reads against independently maintained plugins.
- Native TLS and reverse-proxy hosting are covered by isolated real-server tests; see [hosting configuration and limits](docs/hosting.md). Certificate verification and fixed local destinations remain enforced.
- Codex and Hermes product runtimes are tested with native bearer authentication; see the [client matrix](docs/clients.md). Desktop/web UI acceptance remains untested, and [ADR 002](docs/decisions/002-client-authentication.md) records the blockers to identity-preserving OAuth.

### Data-access coverage

- V2 notification registry reads use the released `/signalk/v2/api/notifications` endpoint with native context/path/source permission checks. Forward records unchanged; omit records whose source access cannot be verified. This does not implement the proposed alerts subsystem.
- Keep acknowledge, silence, raise, clear and other mutations outside scope.
- Add other read adapters only where authorization and data provenance can be established.

### Hardening and release

- Native tests cover repeated plugin stop/start, cancellation, timeouts, concurrent identities and request-slot recovery. Full server process replacement and MCP client reconnection are tested with persisted native security. In-process shutdown still leaves upstream timers and does not invoke plugin stop hooks; see [resource validation](docs/resource-validation.md).
- The approved local ARM64 development benchmark passes; extended load and large-value observations are recorded separately. Raspberry Pi testing is outside the release acceptance scope; the local ARM64 results do not establish Pi compatibility. Preserve Signal K's primary telemetry duties.
- Security-boundary and dependency-exposure review is recorded in the resource report; reassess the host server's upstream advisories before release.
- Validate installed packages, native configuration and user documentation.
- Use the official Signal K plugin CI for portable platform checks alongside the native integration matrix. Verify registry scoring separately against the published artifact; custom CI success is not a registry score.
- Prepare a release candidate and verify current npm/AppStore requirements. The tag-driven pipeline gates publication on both CI workflows, stamps/verifies npm `gitHead`, and publishes prereleases under `next`; public registry scoring still requires published-artifact verification.
- Reproducible installed-tarball checks, native Plugin Config evidence, changelog and the owner-reviewed vessel procedure are described in [release readiness](docs/release-readiness.md). Preparation does not authorize publication or vessel access.
- Conduct live read-only vessel acceptance after the first alpha release, only with explicit deployment/access authorization; it is not an alpha publication gate.
- Publish, release or deploy only when separately authorized, and verify each result independently.

CI success, package installation, AppStore indexing, live retrieval and physical-device operation are distinct forms of evidence. Do not substitute one for another.

## 9. Definition of success

An authenticated MCP client can discover and fetch authorized Signal K measurements and supported plugin/provider responses through a native plugin, with data provenance intact and the original Signal K permissions enforced.

The plugin's responsibility ends at reliable, permission-aware data access and forwarding, including individually approved native actions. Calculations and other data processing are outside this project.

## 10. Individually approved native actions

Native PUT discovery uses `supportsPut` and actual path metadata; it never infers a handler source from telemetry or invents a command schema from a current value. Source is explicit. Runtime metadata observed through the public delta hook and previously described targets supplement the value model; metadata-only paths advertised before observation may require an explicit `describe_put`. Incomplete enumeration must be reported honestly.

An eligible valid but unapproved action queues bounded review metadata without dispatch. Accept/Reject and native Save Configuration remain the only approval route. Bind the exact context, path, source and metadata/value contract, preserve GET decisions and rejection precedence, and require renewed review when the binding changes. No all-PUT option or wildcard approval is permitted.

Require native `readwrite` or `admin` identity and exact-source `put` ACL authorization before dispatch. Preserve the original bearer through fixed-local HTTP because in-process helpers do not carry the caller's request identity. The supported servers check HTTP PUT ACLs with a null source before choosing the handler, so the gateway must additionally check the explicit source. Metadata configuration writes are excluded from this action interface.

Preserve native request IDs, pending/completed/failed state and status codes. Restrict status lookup to gateway-submitted requests owned by the same native identity, with current approval/permissions, bounded one-hour expiry and lifecycle reset. A later denial must not disguise an already-submitted action as an unexecuted read failure. Unknown outcomes are explicit, with no automatic mutation retries or physical-operation claims.

Plugin POSTs follow only after the native PUT boundary is verified. They require their own exact reviewed method/route/body contract; a GET approval can never enable POST. No generic unrestricted HTTP executor is planned.
