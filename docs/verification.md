# Verification record

2026-10-18. Capability-layer checkpoint; local macOS arm64 environment.

## Passed locally

- `MCP_TEST_PYTHON=/tmp/signalk-mcp-python-client/bin/python npm run check` under Node **24.22.0**: strict TypeScript, ESLint, Prettier and **24 passing test-runner entries**, with no skips. These comprise 15 real-server subtests plus their parent and 8 focused tests.
- Actual Signal K **2.33.0** discovers and loads the native CommonJS plugin and synthetic provider from its temporary configuration's node_modules. Native routing and authentication are not replaced with an Express test harness.
- TypeScript MCP SDK **1.32.1** and Python MCP SDK **1.26.0** both initialize over HTTP, discover the seven tools and retrieve zero-valued telemetry with units. Python **3.14.8** runs separately with test credentials passed over stdin.
- Real-server security tests cover malformed/expired/unregistered tokens; guest rejection despite `allow_readonly`; exact Host/Origin enforcement; content negotiation/version handling; request bounds; cookie/bearer identity conflicts; permissions changing and devices being removed; concurrent principals; path/source ACLs; plugin stop/start.
- Capability tests cover dedicated/generic telemetry parity, vessel state, public feature discovery, plugin OpenAPI loading, parameter schemas, original caller identity at a native provider, stricter native admin-route rejection, unapproved/write refusal, redirects, schema changes and unsupported external references. Target write and unapproved handlers remain uncalled.
- History tests use a registered synthetic History API provider, check path/source authorization before calls, preserve zero/units/source provenance, reject wrong/missing sources, wrong paths/context and extra columns, enforce query limits, and report unavailable providers. Focused tests additionally cover notification ACL filtering, partial discovery, recursive/duplicate approvals, ambiguous IDs, schema cycles, traversal, bounded HTTP responses and revocation while a response is pending.
- The tarball installs in a disposable directory with **96 production packages**. All **16 real-server integration entries** pass again on Node 24 with Signal K loading the installed tarball and both MCP clients. The package includes README.md, BRIEF.md, AGENTS.md, license, compiled code and design/verification docs; test fixtures and credentials are excluded.
- Production dependency audit (`npm audit --omit=dev`): **0 advisories** at this checkpoint. The earlier full development-tree audit found 18 upstream test-runtime advisories (12 moderate, 5 high, 1 critical), including an older transitive lodash. The new direct schema-conversion dependency was already in that locked dependency tree. No forced upstream overrides were applied. This is an audit snapshot, not a security certification.

## Repository and CI

The existing GitHub repository `arodus/signalk-mcp` was empty. `main` was initialized with README, original brief, repository instructions, license and ignore rules. Implementation was merged through PR #1 as `1891e56`; its Node 22 and 24 CI checks passed. No release or deployment has occurred.

The workflow runs the full suite on Linux Node 22 and 24 with Python 3.12 and checks packaging. The CI result above applies to PR #1; consult each subsequent PR's checks for its own result.

## Remaining acceptance

All test data is synthetic. Providers include synthetic fixtures and the published alert-manager package described below. No ForTuna service, live instrument, notification service or vessel-control hardware was accessed. Retrieval of real vessel measurements with an owner's existing token remains unverified. Production-plugin compatibility is limited to the exact package and operation below.

There is no npm publication, AppStore indexing, vessel deployment, Raspberry Pi benchmark, or production security-review claim. Product UI compatibility, OAuth, TLS/reverse-proxy combinations, non-TCP hosting, whole-server restart and resource/load benchmarking remain open. In particular, loopback TLS certificate mismatch fails closed for HTTP-backed capabilities.

The security bridge is version-sensitive. OpenAPI discovery supports only the documented subset; reviewed providers must enforce their own endpoint data authorization. History requires explicit source provenance and rejects identifiers the tested server's HTTP parser would alter. Read-only v2 notification registry coverage remains future work. Notification mutations, calculations, Container Manager integration and sandbox execution are outside the current scope, not deferred work.

## Authentication compatibility follow-up (issue #2)

The native harness can select a separately installed Signal K package with `MCP_TEST_SERVER_DIR` and assert its version with `MCP_TEST_SERVER_VERSION`. CI now defines the four combinations of Signal K 2.32.0/2.33.0 and Node 22/24, with both clients enabled. Consult the follow-up PR checks for remote results.

Local Node 24.22.0 runs passed all **30 test-runner entries** with no skips against each exact server/API pair (2.32.0 and 2.33.0), using Python MCP SDK 1.26.0. The default runtime also passed the complete type/lint/format checks. These results are synthetic integration evidence, not live vessel acceptance.

The expanded suite adds native user-token visibility/removal, permission changes while a plugin read is pending, and history ACL revocation during a provider response. Focused checks reject changed/missing hook contracts, unknown security state and malformed principals; only literal ACL grants permit reads. Production changes are limited to stricter security-state/identity validation and a minimal principal snapshot. No calculation or other data-processing feature is introduced.

See [authentication compatibility](authentication.md) for the supported version policy, source assessment and reproducible runtime selection. The public-interface proposal is a local draft; the private security hooks remain necessary.

## Independent plugin compatibility follow-up (issue #4)

`test/production-plugin.test.cjs` installs the unchanged npm `signalk-alert-manager@0.1.0` package into a real temporary Signal K server. The test seeds one synthetic notification through the native delta interface, with audio disabled and no external services or equipment. It discovers the published OpenAPI document and forwards `listAlerts` responses unchanged. A readonly identity is refused both by the reviewed admin approval and, when a test deliberately relaxes that approval, by the native target route itself.

The suite tests invalid arguments, sanitized provider errors, unapproved reads, every documented mutation, changed schemas/routes/duplicate IDs, native provider disablement and a fresh server with the provider package absent but its approval retained. Unsupported UUID/date-time input schemas stay disabled. A focused configuration test checks actionable approval guidance without echoing input.

See [the reproducible approval and source review](plugin-compatibility.md). The full local Node 24.22.0 check passes **39 test-runner entries** with Python enabled and no skips on Signal K 2.33.0. All **8 real-provider test entries** also pass locally against Signal K 2.32.0 on Node 24.22.0. The suite additionally targets the inherited four-way CI matrix. Remote validation results belong to the issue #4 PR; the earlier checkpoint counts above are historical. This does not establish live alert health, hardware operation, or compatibility with arbitrary providers or future package versions.
