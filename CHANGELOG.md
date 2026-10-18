# Changelog

## Unreleased

Initial read-only native Signal K MCP gateway; no npm release has been published.

- Serve seven MCP tools through the existing Signal K HTTP server using native bearer identities and path/source permissions.
- Discover and forward current telemetry, legacy notification values, standard v2 History results and explicitly approved plugin GET responses.
- Preserve provider values and metadata without domain calculations or inferred substitutes.
- Support tested native TLS and reverse-proxy configurations with certificate validation and fixed local destinations.
- Bound requests, responses, provider deadlines, discovery and concurrent requests; close pending MCP connections on shutdown and disconnect.
- Verify Signal K 2.32.0/2.33.0, TypeScript/Python MCP clients, unchanged History and Alert Center providers, and opt-in Codex/Hermes product clients.
- Add official Signal K plugin CI alongside the native integration matrix and record the local ARM64 development benchmark.

Release acceptance remains open for Raspberry Pi hardware, whole-server restart, longer-duration/adversarial load, registry scoring and explicitly authorized vessel acceptance. OAuth and v2 notification registry reads are not implemented.
