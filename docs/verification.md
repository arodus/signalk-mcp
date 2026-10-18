# Verification record

2026-10-18. Capability-layer checkpoint; local macOS arm64 environment.

## Passed locally

- `MCP_TEST_PYTHON=/tmp/signalk-mcp-python-client/bin/python npm run check` under Node **24.22.0**: strict TypeScript, ESLint, Prettier and **24 passing test-runner entries**, with no skips. These comprise 15 real-server subtests plus their parent and 8 focused tests.
- Actual Signal K **2.33.0** discovers and loads the native CommonJS plugin and synthetic provider from its temporary configuration's node_modules. Native routing and authentication are not replaced with an Express test harness.
- TypeScript MCP SDK **1.32.1** and Python MCP SDK **1.26.0** both initialize over HTTP, discover the seven tools and retrieve zero-valued telemetry with units. Python **3.14.8** runs separately with test credentials passed over stdin.
- Real-server security tests cover malformed/expired/unregistered tokens; guest rejection despite `allow_readonly`; exact Host/Origin enforcement; content negotiation/version handling; request bounds; cookie/bearer identity conflicts; permissions changing and devices being removed; concurrent principals; path/source ACLs; plugin stop/start.
- Capability tests cover dedicated/generic telemetry parity, vessel state, public feature discovery, plugin OpenAPI loading, parameter schemas, original caller identity at a native provider, stricter native admin-route rejection, unapproved/write refusal, redirects, schema changes and unsupported external references. Target write and unapproved handlers remain uncalled.
- History tests use a registered synthetic History API provider, check path/source authorization before calls, preserve zero and provider metadata, accept optional source fields, reject conflicting sources, wrong paths/context and extra columns, enforce query limits, and report unavailable providers. Focused tests additionally cover notification ACL filtering, partial discovery, recursive/duplicate approvals, ambiguous IDs, schema cycles, traversal, bounded HTTP responses and revocation while a response is pending.
- The tarball installs in a disposable directory with **96 production packages**. All **16 real-server integration entries** pass again on Node 24 with Signal K loading the installed tarball and both MCP clients. The package includes README.md, BRIEF.md, AGENTS.md, license, compiled code and design/verification docs; test fixtures and credentials are excluded.
- Production dependency audit (`npm audit --omit=dev`): **0 advisories** at this checkpoint. The earlier full development-tree audit found 18 upstream test-runtime advisories (12 moderate, 5 high, 1 critical), including an older transitive lodash. The new direct schema-conversion dependency was already in that locked dependency tree. No forced upstream overrides were applied. This is an audit snapshot, not a security certification.

## Repository and CI

The existing GitHub repository `arodus/signalk-mcp` was empty. `main` was initialized with README, original brief, repository instructions, license and ignore rules. Implementation was merged through PR #1 as `1891e56`; its Node 22 and 24 CI checks passed. No release or deployment has occurred.

The workflow runs the full suite on Linux Node 22 and 24 with Python 3.12 and checks packaging. The CI result above applies to PR #1; consult each subsequent PR's checks for its own result.

## Remaining acceptance

All test data is synthetic. The unchanged published History provider and Alert Center package are exercised as described below. No ForTuna service, live instrument, notification service or vessel-control hardware was accessed. Retrieval of real vessel measurements remains unverified. Compatibility evidence applies to the exact tested packages and operations.

There is no npm publication, AppStore indexing, vessel deployment, Raspberry Pi benchmark, or production security-review claim. Product UI compatibility, OAuth, non-TCP hosting and whole-server restart remain open. Local resource/load evidence is recorded in the issue #7 follow-up below; Raspberry Pi and longer-duration acceptance remain open. TLS/proxy evidence is recorded in the issue #5 follow-up below. Certificate failures remain closed for HTTP-backed capabilities.

The security bridge is version-sensitive. OpenAPI discovery supports only the documented subset; reviewed providers must enforce their own endpoint data authorization. History accepts optional response source metadata, checks explicit source filters against native ACLs, permits unfiltered reads only with confirmed absence of telemetry ACLs, and rejects identifiers the tested server's HTTP parser would alter. Read-only v2 notification registry coverage remains future work. Notification mutations, calculations, Container Manager integration and sandbox execution are outside the current scope, not deferred work.

## Authentication compatibility follow-up (issue #2)

The native harness can select a separately installed Signal K package with `MCP_TEST_SERVER_DIR` and assert its version with `MCP_TEST_SERVER_VERSION`. CI now defines the four combinations of Signal K 2.32.0/2.33.0 and Node 22/24, with both clients enabled. Consult the follow-up PR checks for remote results.

Local Node 24.22.0 runs passed all **30 test-runner entries** with no skips against each exact server/API pair (2.32.0 and 2.33.0), using Python MCP SDK 1.26.0. The default runtime also passed the complete type/lint/format checks. These results are synthetic integration evidence, not live vessel acceptance.

The expanded suite adds native user-token visibility/removal, permission changes while a plugin read is pending, and history ACL revocation during a provider response. Focused checks reject changed/missing hook contracts, unknown security state and malformed principals; only literal ACL grants permit reads. Production changes are limited to stricter security-state/identity validation and a minimal principal snapshot. No calculation or other data-processing feature is introduced.

See [authentication compatibility](authentication.md) for the supported version policy, source assessment and reproducible runtime selection. The public-interface proposal is a local draft; the private security hooks remain necessary.

## History provider follow-up (issue #3)

The published `signalk-to-influxdb` **1.11.0** package now loads unchanged inside the real temporary Signal K server, backed by a disposable real InfluxDB **1.8.10** container. The version and image digest are pinned; the provider is a development dependency only. Tests generate a random synthetic database and remove it afterward.

On Node **24.22.0**, both Signal K/ServerAPI **2.32.0** and **2.33.0** pass **45 test-runner entries** with Python MCP **1.26.0** and the real-provider tests enabled. The primary runtime also passes strict TypeScript, ESLint and Prettier. CI runs this same backend in the four existing server/Node combinations; consult the issue #3 PR's checks for remote results.

The production provider now works through the standard adapter without requiring optional `$source`. Its extra `sourceRef` metadata is forwarded unchanged, never treated as an authorization alias. Tests cover explicit and omitted source/resolution, standard time-range alternatives, dedicated/generic tool parity, exact JSON forwarding, zero/null preservation, bucket timestamps before the start, source denial, no-ACL checks and revocation. Query/row/byte limits and malformed response checks remain enforced. The upstream hyphen-stripping bug still reproduces and those identifiers remain rejected before querying.

See [provider support matrix and reproductions](history-providers.md). The server-parser upstream proposal remains a local draft. Docker is required only for this optional local integration test and CI fixture, never for the gateway runtime. No upstream message, release, deployment or live-vessel operation was performed.

## Independent plugin compatibility follow-up (issue #4)

`test/production-plugin.test.cjs` loads the unchanged published `signalk-alert-center@0.4.1` package in a real temporary Signal K server and seeds synthetic notification deltas with no notifiers or audio. It discovers the provider OpenAPI, uses the route-derived `get.definitions` identifier and forwards paginated JSON unchanged. The example approval requires admin because the native readonly endpoint does not apply telemetry path/source ACL filtering. Tests explicitly distinguish that gateway restriction from native readonly access and native write refusal.

The suite covers input bounds, pagination, unapproved reads, all documented mutations, disabled/absent providers, document changes and operation ID collisions. The bounded OpenAPI adapter now handles missing operation IDs and explicit strings up to 512 characters, as required by Alert Center; larger schemas still fail closed. README, brief and [provider compatibility documentation](plugin-compatibility.md) describe the exact contract.

On Node 24.22.0, all **41 test entries** pass with no skips against each supported Signal K/ServerAPI version (2.32.0 and 2.33.0), including Python MCP 1.26.0. The primary run passes TypeScript, ESLint and Prettier; `npm pack --dry-run` and `git diff --check` also pass. CI checks the four server/Node combinations, including packaging; consult PR #16 for its current remote results. No live notification delivery, vessel deployment or publication is involved.

## TLS/proxy hosting follow-up (issue #5)

On Node **24.22.0**, the combined suite passes **64 test-runner entries**, with no skips, against both Signal K/ServerAPI **2.32.0** and **2.33.0**, including Python MCP 1.26.0, real InfluxDB/provider and unchanged Alert Center. The primary runtime also passes TypeScript, ESLint and Prettier. `npm pack --dry-run` and `git diff --check` pass.

The new six-scenario real-server matrix covers a TLS proxy, native HTTPS with IP or configured DNS verification names, and three certificate failures. It checks discovery, original-identity plugin/history reads, spoofed routing headers, Host/Origin rejection and disconnect cancellation. Ephemeral certificates and synthetic identities are generated at runtime. The production change adds only a validated optional certificate DNS name for SNI/verification; socket routing and normal certificate trust stay intact. See [hosting recipes and precise limits](hosting.md). CI runs these tests in the existing four-combination matrix; consult the follow-up PR for remote results.

The first hosting CI run exposed a Node/OpenSSL mismatch when verifying IPv4-mapped IPv6 SANs on Linux. A disposable Linux Node 22 container reproduced it. The gateway now uses the equivalent socket-derived IPv4 literal, and all seven hosting entries pass in that Linux reproduction; the full 64-entry primary suite passes again. No certificate bypass or alternate destination was added.

## Product-client and OAuth decision follow-up (issue #6)

Installed **Codex CLI 0.163.0-alpha.10.2** (through its app-server MCP runtime) and **Hermes Agent 0.22.2**, commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8` (CLI discovery plus its native registered handlers), both pass the opt-in product tests. Each initializes, lists seven tools, reads synthetic zero with units, filters a denied path, reports an unapproved write as `OPERATION_DISABLED`, and reads again after explicit disconnect/reconnection. Codex uses a new ephemeral thread; Hermes shuts down and re-discovers its fixture connection. No model or live-vessel call is made.

On Node **24.22.0**, the complete suite passes **58 entries with no skips** against both Signal K/ServerAPI **2.32.0** and **2.33.0**, including both products, Python MCP 1.26.0, unchanged Alert Center and real disposable InfluxDB/History provider. Strict TypeScript, ESLint and Prettier pass. These counts are for the issue #6 branch based on merged main; the separate issue #5 hosting PR adds its own tests.

The [client matrix](clients.md) separates these runtime checks from untested desktop/web UI acceptance and documentation-only Claude support. Product binaries are opt-in local dependencies; ordinary CI explicitly skips those two checks while exercising both SDK clients. Abrupt network outage recovery and interactive authorization remain untested.

[ADR 002](decisions/002-client-authentication.md) retains native bearer mode and documents the blockers to OAuth: a supported Signal K audience/delegation/lifecycle contract is not established. No second identity system, signing-secret access, OAuth implementation or public submission is introduced.

## Lifecycle and local ARM64 follow-up (issue #7)

PRs #17 and #18 merged after all eight push/PR matrix checks passed. The combined main branch includes both hosting and product-client evidence.

The lifecycle follow-up fixes pending client connections and handler cleanup when the plugin stops or a client disconnects. Native tests cover 12 alternating cancellation/stop cycles, concurrent authorized/denied principals, saturation of all eight request slots, rejection of a ninth request, recovery and two real provider timeouts. Focused tests cover oversized/deep models and oversized feature discovery. Resource tracing checks gateway timer/TCP ownership before child termination and distinguishes surviving upstream timers from gateway cleanup.

On Node **24.22.0**, `npm run check` passes **69 entries without skips** against Signal K **2.33.0**, including both installed products, Python MCP and the real isolated providers. The alternate **2.32.0** runtime passes **67 entries**, with only the two opt-in product checks skipped. `npm pack --dry-run` and `git diff --check` pass. Remote results belong to the follow-up PR's own CI checks.

The owner's agreed local development gate passes on this Mac's **Apple M4 Max ARM64**: **600/600** reads at 20/second for 30 seconds, p95 reads **7.83 ms**, p99 telemetry scheduling delay **2.18 ms**, post-GC heap change **−9.68 MiB**. CPU and RSS were reported only. See [the workload, raw results, boundary review, dependency triage and limitations](resource-validation.md). The test harness performs performance measurements; no domain calculation was added to the plugin.

Issue #7 remains open for Raspberry Pi acceptance, whole-server restart and longer-duration/adversarial large-value work. Both server cohorts retain upstream timers after shutdown; the tests do not claim natural process exit. No release, deployment or live vessel test occurred.

## Official plugin CI adoption

PR #19 merged as `e3a50b9` after its eight matrix checks passed. The official CI caller now references `SignalK/signalk-server/.github/workflows/plugin-ci.yml` at inspected revision `340d5bb62c17ec58d2a3497dbbf081cd87af2a96`. It requests Node 22/24 on the upstream Linux x64, Linux ARM64, macOS and Windows matrix and runs the portable `npm test` command. The existing native integration workflow still runs both suites through `npm run check`, with both supported Signal K versions, Python and InfluxDB. No test cases were removed.

The exact upstream entry-point, schema, lifecycle and API-scan scripts pass locally on Node 24.22.0. The scanner also scans fixtures; host-side lookup of loaded plugins is isolated in `test/native-server.cjs`, explicitly separating the native server registry from the plugin App facade. Production security-bridge warnings remain visible and are explained in [authentication compatibility](authentication.md). The upstream lifecycle shim safely receives unavailable-router/invalid-configuration errors; native endpoint operation is verified by our real-server tests.

Registry scoring is a separate release check. The registry's own-test component uses the plugin's tests and can read commands from the official CI caller. The portable suite requires only loopback HTTP and no external service, Python product runtime or Docker backend. It does not use forced test exit. The native integration suite retains its documented server cleanup limitations. Adding this workflow alone does not establish 100/100, registry sandbox compatibility or a published package score.

The first official matrix passed Linux x64, Linux ARM64 and macOS but found CRLF checkout differences in both Windows formatting jobs. A local `core.autocrlf=true` clone reproduced the line endings. `.gitattributes` now requires LF for text files on every platform; formatter rules and test assertions remain unchanged.
