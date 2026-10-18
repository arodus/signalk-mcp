# Changelog

## Unreleased

- Remove plugin-local host/browser-origin settings and use Signal K’s CORS policy; preserve existing configuration on upgrade. Clarify the HTTPS certificate hostname and refresh the settings-only screenshot.
- Stop oversized JSON request/result serialization at the byte budget; verify client reconnection and permissions across full native server process restarts.
- Add read-only v2 notification registry list/get tools with native context/path/source permissions, unchanged record forwarding, and support for disabled core notification management. No dependency on the proposed alerts subsystem.

Initial read-only native Signal K MCP gateway; no npm release has been published.

- Serve nine MCP tools through the existing Signal K HTTP server using native bearer identities and path/source permissions.
- Discover and forward current telemetry, legacy notification values, v2 notification records, standard v2 History results and explicitly approved plugin GET responses.
- Preserve provider values and metadata without domain calculations or inferred substitutes.
- Support tested native TLS and reverse-proxy configurations with certificate validation and fixed local destinations.
- Bound requests, responses, provider deadlines, discovery and concurrent requests; close pending MCP connections on shutdown and disconnect.
- Verify Signal K 2.32.0/2.33.0, TypeScript/Python MCP clients, unchanged History and Alert Center providers, and opt-in Codex/Hermes product clients.
- Add official Signal K plugin CI alongside the native integration matrix and record the local ARM64 development benchmark.

Release acceptance remains open for Raspberry Pi hardware, upstream in-process shutdown gaps, installed-host dependency assessment, registry scoring and explicitly authorized vessel acceptance. Full process replacement and ten-minute local load/large-value checks are recorded in the resource report. OAuth is not implemented.
