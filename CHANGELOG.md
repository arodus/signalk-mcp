# Changelog

## Unreleased

- Migrate gateway validation to patched Zod 4.6.7 and replace direct `zod-to-json-schema` usage with native Draft 7 input-schema conversion.
- Preserve saved approval identities across the migration, including bounded OpenAPI compositions and Resources mutations, and retain accepted provider timestamp and GUID spellings.
- Add migration coverage for 165 existing review identities and rejection of oversized arrays before element validation.

## [0.3.0] - 2026-10-22

- Discover and execute supported Course, Weather, Autopilot, Radar, BLE, Tracks and Sensors API operations through the shared OpenAPI pipeline, without separate adapters for each API. Availability depends on the installed Signal K version and providers.
- Require individual saved administrator review for each native API operation, bound to its method, route, input contract and documented meaning. Forward the original bearer token and preserve native route authorization.
- Cache static native API descriptions after their first successful fetch for the plugin lifecycle, sharing concurrent requests and retrying failed discovery. Permissions, saved approvals and provider results remain live.
- Extend bounded JSON schema support for annotated local references, scalar alternatives, duration strings and safe patterns. Unsupported schemas, configuration writes, binary transfers and streams remain blocked.
- Add native API approval controls and real Signal K integration coverage, including installed-package checks across the supported runtime matrix.

Existing saved approvals retain their reviewed scope; upgrading grants no additional permissions. Supported runtimes remain Signal K 2.32.0/2.33.0 on Node.js 22/24.

## [0.2.0] - 2026-10-22

- Add native v2 Resources API reads for routes, waypoints, regions, notes, chart metadata and logbook entries, with explicit provider selection and bounded provider-side queries.
- Add individually reviewed resource creation, replacement and deletion. Reviews bind the collection, provider, method and input contract; native identity and Resources write permissions remain required.
- Extend reviewed plugin HTTP operations to PUT, PATCH and DELETE alongside GET and POST. Approval for one method never approves another, and uncertain mutations are never retried automatically.
- Expand supported OpenAPI JSON contracts with a shared bounded schema parser. Offline checks accept 87 of 100 operations across seven pinned plugin API documents; unsupported contracts remain blocked. This does not imply that every audited endpoint was executed.
- Extend native integration coverage for Resources operations and plugin methods, including published Alert Center policy PATCH and DELETE/reset with external delivery disabled. Document separate Logbook provider and Stowage checks and their limits.
- Add the Signal K MCP icon, AppStore recommendations and clearer plugin compatibility, installation and approval guidance.

Existing saved approvals retain their reviewed scope; upgrading grants no additional permissions. Supported runtimes remain Signal K 2.32.0/2.33.0 on Node.js 22/24.

## [0.1.1] - 2026-10-20

- Isolate release-packaging tests from the parent workflow's `GITHUB_OUTPUT` by giving each fixture its own writable temporary output file. This prevents test failures when the Signal K registry sandbox exposes the inherited workflow path as read-only.
- Add regression coverage for a read-only inherited output file and verify that packaging still emits the expected artifact and checksum outputs without changing the parent's file.
- Runtime behavior, dependencies and authorization rules are unchanged. Public registry scoring requires a new registry run against this release.

## [0.1.0] - 2026-10-20

Initial stable release of the native Signal K MCP gateway, consolidating the alpha releases.

### Data access

- Connect MCP agents through Streamable HTTP inside an existing Signal K server, using native bearer tokens and permissions.
- Discover and fetch current telemetry, vessel snapshots, notifications and standard v2 History API results, preserving provider values, units, timestamps, sources and missing values.
- Discover installed plugin capabilities and inspect their OpenAPI descriptions, preserving native plugin IDs including mixed-case names.
- Provide fourteen tools for data access, discovery, reviewed plugin operations and native PUT actions. The gateway does not calculate derived values or execute agent-written code.

### Individually approved operations

- Require a separate administrator review for each plugin GET, plugin POST and native self-context PUT action, saved through native Plugin Config. Native permissions remain mandatory on every call; there is no blanket approval.
- Queue eligible blocked requests for review without dispatching them or retaining submitted values or tokens. The embedded approval table supports acceptance, rejection and review of the exact operation contract.
- Bind native PUT approvals to an exact path, explicit source and reviewed metadata/value contract. Explain unsupported schemas, distinguish queued requests from saved decisions, and support explicitly declared scalar input choices without coercion.
- Bind plugin POST approvals to the method, route, supported JSON inputs and documented meaning. Package version changes alone do not invalidate an unchanged POST contract.
- Forward approved actions with the original caller's identity, preserve provider responses, and track gateway-submitted native PUT requests by owner. Report uncertain outcomes without automatic retries or claims of physical completion.

### Installation and reliability

- Support Signal K 2.32.0 and 2.33.0 on Node.js 22 and 24, with native server and installed-package CI coverage, TypeScript/Python MCP clients and isolated History and plugin providers.
- Ship the compiled plugin and embedded admin configurator; installation does not require build scripts. Allow unchanged defaults to be saved on first setup before enabling the plugin.
- Use Signal K's browser-origin policy and support tested native TLS and reverse-proxy hosting.
- Bound requests, responses, discovery, concurrency and provider deadlines. Cover cancellation, plugin stop/start, full server process replacement and client reconnection with synthetic integration tests.
- Document installation, standard Signal K token creation, major agent-client setup, approval workflows, upgrades, rollback and troubleshooting.
- Provide tag-driven release checks, commit-stamped tarballs, retained checksums and published npm commit verification.

### Known limits

- OAuth is not implemented. Clients must support Streamable HTTP with an existing Signal K bearer token.
- Product-client evidence varies; earlier Codex/Hermes runtime checks cover a smaller read catalog. The current full catalog, desktop/web interfaces and ChatGPT tunnel connection are not all verified.
- History and plugin API support have documented schema, identifier and authorization limits; unsupported operations remain blocked.
- Supported Signal K versions have an upstream in-process shutdown limitation. Use full server process replacement for the tested restart behavior.
- Local ARM64 measurements do not certify Raspberry Pi hardware. Complete vessel acceptance, physical operation and public AppStore/registry scoring are separate from automated test results.
