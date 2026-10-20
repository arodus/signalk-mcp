# Changelog

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
