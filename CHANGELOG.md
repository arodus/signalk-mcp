# Changelog

## [Unreleased]

- Fix `INVALID_FEATURES` when native plugin IDs contain uppercase letters, such as `AdvancedWind` and `SpeedAndCurrent`. Preserve exact IDs for discovery, OpenAPI, routing and approval matching while retaining input bounds and path-safety checks.

## [0.1.0-alpha.3] - 2026-10-19

- Add individually reviewed plugin POST endpoints with bounded JSON inputs through `execute_mutation`. Each endpoint requires its own administrator approval saved through native Plugin Config, plus a native write-capable identity and provider permission checks.
- Bind POST approvals to the reviewed endpoint contract: method, route, inputs and documented meaning. A plugin package version change alone does not invalidate approval.
- Show POST endpoints as writes in the admin configurator and allow saved approvals to be revoked while the provider remains installed.
- Preserve provider responses and report uncertain mutation outcomes without automatic retries or claims of physical completion.
- Verify plugin POST and production-provider integration tests against the exact release tarball before publishing.

## [0.1.0-alpha.2] - 2026-10-19

- Describe the gateway as permission-aware data access with individually approved actions. Every plugin GET and native PUT starts blocked and needs its own saved administrator approval; there is no blanket approval. Built-in data reads continue to use native Signal K permissions.

- Add individually approved native self-context PUTs using the existing Plugin Config review table, exact path/source/metadata binding and native PUT permissions. There is no blanket PUT grant; plugin POSTs remain disabled.
- Add bounded metadata-driven PUT discovery, explicit source selection, owned request-status tracking and truthful uncertain outcomes without automatic mutation retries. Preserve existing reads, plugin GET reviews and native configuration saves.

- Allow saving unchanged default configuration on first setup and refresh the native admin page so Enable becomes available. Preserve host flags and require native administrator authorization without granting operation approvals.

## [0.1.0-alpha.1] - 2026-10-19

- Add the tag-driven release pipeline used by Alert Center: both CI gates, release-tag and notes checks, commit-stamped tarballs, exact-package integration checks, npm prerelease tags and published `gitHead` verification.

- Refresh the package listing and README with supported reads, the approval-table screenshot and explicit authentication limits. Remove Pi testing from release acceptance and schedule vessel acceptance after the first alpha.

- Replace the long approval form with an embedded table, Accept/Reject buttons, retained rejected rows and deletion for uninstalled plugins. Save through the existing Signal K admin configuration API.

- Queue eligible blocked plugin reads for native admin review, with deduplicated pending requests, saved approve/reject decisions, schema-bound approvals and unchanged Signal K permission enforcement.

- Remove plugin-local host/browser-origin settings and use Signal K’s CORS policy; preserve existing configuration on upgrade. Clarify the HTTPS certificate hostname and refresh the settings-only screenshot.
- Stop oversized JSON request/result serialization at the byte budget; verify client reconnection and permissions across full native server process restarts.
- Add read-only v2 notification registry list/get tools with native context/path/source permissions, unchanged record forwarding, and support for disabled core notification management. No dependency on the proposed alerts subsystem.

First alpha of the native Signal K MCP gateway, initially providing data reads.

- Serve nine MCP tools through the existing Signal K HTTP server using native bearer identities and path/source permissions.
- Discover and forward current telemetry, legacy notification values, v2 notification records, standard v2 History results and explicitly approved plugin GET responses.
- Preserve provider values and metadata without domain calculations or inferred substitutes.
- Support tested native TLS and reverse-proxy configurations with certificate validation and fixed local destinations.
- Bound requests, responses, provider deadlines, discovery and concurrent requests; close pending MCP connections on shutdown and disconnect.
- Verify Signal K 2.32.0/2.33.0, TypeScript/Python MCP clients, unchanged History and Alert Center providers, and opt-in Codex/Hermes product clients.
- Add official Signal K plugin CI alongside the native integration matrix and record the local ARM64 development benchmark.

Known alpha limitations: the public registry score and ChatGPT/Codex tunnel connection remain to be verified end-to-end. Raspberry Pi testing is out of scope. Upstream in-process shutdown is a documented limitation; use full-process restart. Installed-host assessment and explicitly authorized vessel acceptance follow the first alpha. Full process replacement and ten-minute local load/large-value checks are recorded in the resource report. OAuth is not implemented.
