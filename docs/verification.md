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

All telemetry and providers are synthetic. No ForTuna service, live instrument, notification service or vessel-control hardware was accessed. Retrieval of real vessel measurements with an owner's existing token and compatibility with independently maintained production plugins remain unverified.

There is no npm publication, AppStore indexing, vessel deployment, Raspberry Pi benchmark, or production security-review claim. Product UI compatibility, OAuth, TLS/reverse-proxy combinations, non-TCP hosting, whole-server restart and resource/load benchmarking remain open. In particular, loopback TLS certificate mismatch fails closed for HTTP-backed capabilities.

The security bridge is version-sensitive. OpenAPI discovery supports only the documented subset; reviewed providers must enforce their own endpoint data authorization. History requires explicit source provenance and rejects identifiers the tested server's HTTP parser would alter. Read-only v2 notification registry coverage remains future work. Notification mutations, calculations, Container Manager integration and sandbox execution are outside the current scope, not deferred work.
