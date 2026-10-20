# Verification record

## Stable 0.1.0 preparation (2026-10-20)

The release preparation sets both package manifests to `0.1.0`, consolidates the changelog into one dated version entry, and updates installation, upgrade and compatibility guidance. Runtime code and dependencies are unchanged. The release checklist distinguishes preparation from publication and retains outstanding product-client, complete vessel-acceptance and public registry evidence.

On Node **24.22.0** / Signal K **2.33.0**, `MCP_TEST_PYTHON=/tmp/signalk-mcp-python-client/bin/python npm run check` passes type checking, ESLint, formatting, **90 portable tests** and **62 native integration tests**. Python MCP interoperability passes. Three optional installed-product-client/production-History checks are skipped locally; no current product-client or real History acceptance is inferred from this run. CI separately exercises real isolated History across the four supported Node/Signal K combinations.

The release-note extractor accepts `v0.1.0`; manifest versions, the single changelog version section, local documentation links and `git diff --check` pass. Exact clean-commit package evidence and preparation-PR CI results are recorded with the candidate artifact and PR. The final merged/tagged commit must pass the release workflow again before publication. This checkpoint does not establish stable publication, deployment or physical operation.

## Native PUT schema diagnostics and declared choices (2026-10-19)

`describe_put` now reports the first schema problem with its code, field and explanation, schema provenance, exact approval status, whether that approval is saved, submission eligibility/block reason and an explicit unverified handler-source flag. Pending in-memory requests remain distinct from saved decisions. Discovery itself does not queue reviews or invoke handlers, and approved metadata does not establish handler registration or physical operation.

Native scalar `possibleValues` supply exact reviewed enum values, including native `type: "multiple"`. String, number, boolean and null values retain their types without coercion. Malformed, duplicate, oversized or conflicting choices remain blocked. Explicit schemas retain precedence, other declared constraints remain enforced and changes to choices or their labels require fresh review. Existing approval binding and native permissions remain mandatory.

On Node **24.22.0** / Signal K **2.33.0**, `MCP_TEST_PYTHON=/tmp/signalk-mcp-python-client/bin/python npm run check` passes type checking, ESLint, formatting, **90 portable tests** and **62 native integration tests**, with three optional installed-product-client/production-History skips. Python interoperability passes. The focused native PUT suite passes all **17 entries without skips** on Node **22.23.3** / Signal K **2.33.0**, Node **24.22.0** / Signal K **2.32.0**, and Node **22.23.3** / Signal K **2.32.0** as well. `git diff --check` passes.

The synthetic native test covers metadata-only discovery, generic/dedicated description parity, required and queued/saved pending decisions, native administrator approval/rejection, exact string and zero forwarding, invalid-value refusal before queueing, source/role denials and renewed approval after changed choices. Portable tests additionally cover mixed scalar types, malformed choices, conflicting declarations (including duplicate enum entries), explicit-schema precedence, nested diagnostics, and changed labels. No live credentials, controls or hardware were used for these tests. This checkpoint is local verification, not CI, publication or deployment.

## Mixed-case native plugin discovery (2026-10-19)

Read-only inspection of tunaplotter's `/signalk/v2/features` found 47 native plugin entries. Exactly `AdvancedWind` and `SpeedAndCurrent` failed the gateway's lowercase-only plugin-ID validator, causing the whole plugin/API inventory to return `INVALID_FEATURES`. Signal K exposes native `plugin.id` values, which need not match lowercase npm package names. The shared validator now accepts bounded ASCII mixed-case IDs without normalizing them, and its exported JSON Schema retains that accepted character set.

An offline replay of that inventory with synthetic authentication returns `discovery: complete`, 58 capabilities and no next page. This is a replay of discovery metadata, not a deployment or a claim that every plugin's operations are supported. No live operation was executed and the vessel installation was not changed.

`MCP_TEST_PYTHON=/tmp/signalk-mcp-python-client/bin/python npm run check` on Node **24.22.0** / Signal K **2.33.0** passes type checking, lint, formatting, **85 portable tests** and **61 native integration tests**, with three optional product-client/production-History skips. Python MCP interoperability passes. The main native integration file also passes on Node **22.23.3** / Signal K **2.33.0**, Node **24.22.0** / Signal K **2.32.0**, and Node **22.23.3** / Signal K **2.32.0**: 25 passing entries and three optional skips in each combination. `git diff --check` passes.

The new synthetic native plugin uses npm package name `mixed-case-fixture` and native ID `AdvancedWind`. Tests verify complete discovery, on-demand native OpenAPI inspection, an unapproved read returning `APPROVAL_PENDING` without invoking the handler, exact approved native GET forwarding preserving zero, and rejection of differently cased capability lookup. Focused tests additionally verify both affected live IDs, scoped mixed-case IDs, case-distinct approvals, exported JSON Schema, and continued rejection of traversal, URL syntax and oversized IDs. They do not use live credentials or vessel-control hardware.

## Alpha 2 release preparation (2026-10-19)

`0.1.0-alpha.2` includes the native PUT approval implementation and initial configuration save fix. Local `npm run check` passes on Node **24.22.0** / Signal K **2.33.0**: type checking, lint, formatting, **72 portable tests** and **58 native integration tests**. The two opt-in product clients and production History backend are skipped locally; the Python MCP client is enabled. The release workflow separately gates publication on both CI workflows, the four supported runtime combinations with real isolated History, and verification of the exact commit-stamped package. Publication and remote CI evidence are recorded by that workflow; these local checks do not establish vessel deployment or physical operation.

## Initial configuration save fix (2026-10-19)

The configurator allows saving defaults without an edit, including when Signal K has no stored configuration. After that first confirmed save it reloads the page so the host shows its native Enabled switch. Later unchanged saves remain available without reloading. Existing enable/logging/debug flags, administrator enforcement, conflict checks and operation approvals are preserved.

On Node **24.19.0** / Signal K **2.33.0**, `npm run check` passes type checking, lint, formatting, **72 portable tests** and **58 native integration tests**, with three optional installed-product-client/production-History skips. Python MCP interoperability passes. The new native regression saves an unconfigured disabled plugin without edits, rejects a reader save, preserves host flags, enables through the native configuration API and confirms plugin reads still require approval. `git diff --check` passes.

In a disposable real Signal K **2.33.0** Admin UI, an unconfigured plugin saves unchanged, the page refresh exposes Enabled, and toggling Enabled starts the endpoint. Further unchanged saves succeed at **1280** and **390** pixel widths. This verifies a local synthetic server; it is not a package release, deployment or physical-device test. Remote CI is recorded in the fix PR.

## Individually approved native PUT checkpoint (issue #30, 2026-10-19)

The development branch adds exact administrator approvals for native self-vessel PUT targets. There is no blanket PUT approval or PUT-specific role selector: the configurator labels commands **Read** or **Write**, and native Signal K roles and path/source ACLs apply on every invocation. Plugin POSTs remain disabled. This checkpoint does not describe a release or deployment.

On Node **24.22.0** with Signal K **2.33.0**, `npm run check` passes TypeScript, ESLint, formatting, **71 portable tests**, and **57 native integration tests** with three optional skips. The native suite also passes with the same counts on Node **22.23.3** / Signal K **2.33.0**, Node **22.23.3** / Signal K **2.32.0**, and Node **24.22.0** / Signal K **2.32.0**. Python MCP interoperability passes in all four combinations. The skipped cases require optional installed Codex/Hermes clients or a disposable production History backend; those paths are not claimed verified by this checkpoint.

Real temporary Signal K servers and synthetic handlers cover native admin saves, explicit source authorization, exact metadata/schema approval binding, zero/false/null values, pending-request ownership, native failure replies, revocation and uncertain outcomes without automatic retry, lifecycle resets, and stale handlers. Portable tests cover strict tool inputs and mutation annotations, schema and correlation bounds, expiry, changed target variants and malformed native replies. No live notification service or vessel-control hardware is used, and handler acknowledgement is not proof of physical operation.

Metadata-only targets are covered through public metadata lookup and observed metadata deltas. Historical metadata-only paths cannot be enumerated through the tested public API and require explicit description; discovery reports that limitation.

The embedded native configurator was inspected at **390**, **1280**, and **1920** pixel viewport widths, including expanded metadata. Read/Write labels and action controls remain visible, with no role selectors or horizontal overflow. The updated screenshot is [native PUT approvals](images/native-put-approvals.png). Installed-package verification and remote CI results are recorded with the implementation PR.

2026-10-18. Capability-layer checkpoint; local macOS arm64 environment.

## Passed locally

- `MCP_TEST_PYTHON=/tmp/signalk-mcp-python-client/bin/python npm run check` under Node **24.22.0**: strict TypeScript, ESLint, Prettier and **24 passing test-runner entries**, with no skips. These comprise 15 real-server subtests plus their parent and 8 focused tests.
- Actual Signal K **2.33.0** discovers and loads the native CommonJS plugin and synthetic provider from its temporary configuration's node_modules. Native routing and authentication are not replaced with an Express test harness.
- TypeScript MCP SDK **1.32.1** and Python MCP SDK **1.26.0** both initialize over HTTP, discover the nine tools and retrieve zero-valued telemetry with units. Python **3.14.8** runs separately with test credentials passed over stdin.
- Real-server security tests cover malformed/expired/unregistered tokens; guest rejection despite `allow_readonly`; host CORS origin enforcement and alternate Host acceptance; content negotiation/version handling; request bounds; cookie/bearer identity conflicts; permissions changing and devices being removed; concurrent principals; path/source ACLs; plugin stop/start.
- Capability tests cover dedicated/generic telemetry parity, vessel state, public feature discovery, plugin OpenAPI loading, parameter schemas, original caller identity at a native provider, stricter native admin-route rejection, unapproved/write refusal, redirects, schema changes and unsupported external references. Target write and unapproved handlers remain uncalled.
- History tests use a registered synthetic History API provider, check path/source authorization before calls, preserve zero and provider metadata, accept optional source fields, reject conflicting sources, wrong paths/context and extra columns, enforce query limits, and report unavailable providers. Focused tests additionally cover notification ACL filtering, partial discovery, recursive/duplicate approvals, ambiguous IDs, schema cycles, traversal, bounded HTTP responses and revocation while a response is pending.
- The tarball installs in a disposable directory with **96 production packages**. All **16 real-server integration entries** pass again on Node 24 with Signal K loading the installed tarball and both MCP clients. The package includes README.md, BRIEF.md, AGENTS.md, license, compiled code and design/verification docs; test fixtures and credentials are excluded.
- Production dependency audit (`npm audit --omit=dev`): **0 advisories** at this checkpoint. The earlier full development-tree audit found 18 upstream test-runtime advisories (12 moderate, 5 high, 1 critical), including an older transitive lodash. The new direct schema-conversion dependency was already in that locked dependency tree. No forced upstream overrides were applied. This is an audit snapshot, not a security certification.

## Repository and CI

The existing GitHub repository `arodus/signalk-mcp` was empty. `main` was initialized with README, original brief, repository instructions, license and ignore rules. Implementation was merged through PR #1 as `1891e56`; its Node 22 and 24 CI checks passed. No release or deployment has occurred.

The workflow runs the full suite on Linux Node 22 and 24 with Python 3.12 and checks packaging. The CI result above applies to PR #1; consult each subsequent PR's checks for its own result.

## Remaining acceptance

All test data is synthetic. The unchanged published History provider and Alert Center package are exercised as described below. No ForTuna service, live instrument, notification service or vessel-control hardware was accessed. Retrieval of real vessel measurements remains unverified. Compatibility evidence applies to the exact tested packages and operations.

There is no npm publication, AppStore indexing, vessel deployment, Raspberry Pi benchmark, or production security-review claim. Product UI compatibility, OAuth, non-TCP hosting and upstream in-process shutdown remain open. Full server process replacement is covered by the later issue #7 checkpoint. Local resource/load evidence is recorded in the issue #7 follow-up below; Raspberry Pi and production-duration acceptance remain open; the later checkpoint records a ten-minute local run. TLS/proxy evidence is recorded in the issue #5 follow-up below. Certificate failures remain closed for HTTP-backed capabilities.

The security bridge is version-sensitive. OpenAPI discovery supports only the documented subset; reviewed providers must enforce their own endpoint data authorization. History accepts optional response source metadata, checks explicit source filters against native ACLs, permits unfiltered reads only with confirmed absence of telemetry ACLs, and rejects identifiers the tested server's HTTP parser would alter. Read-only v2 notification registry coverage is described in the issue #9 checkpoint below. Notification mutations, calculations, Container Manager integration and sandbox execution are outside the current scope, not deferred work.

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

At this checkpoint, issue #7 retained Raspberry Pi, whole-server restart and longer-duration/adversarial work; the later checkpoint below records subsequent local coverage. Both server cohorts retain upstream timers after shutdown; the tests do not claim natural process exit. No release, deployment or live vessel test occurred.

## Official plugin CI adoption

PR #19 merged as `e3a50b9` after its eight matrix checks passed. The official CI caller now references `SignalK/signalk-server/.github/workflows/plugin-ci.yml` at inspected revision `340d5bb62c17ec58d2a3497dbbf081cd87af2a96`. It requests Node 22/24 on the upstream Linux x64, Linux ARM64, macOS and Windows matrix and runs the portable `npm test` command. The existing native integration workflow still runs both suites through `npm run check`, with both supported Signal K versions, Python and InfluxDB. No test cases were removed.

The exact upstream entry-point, schema, lifecycle and API-scan scripts pass locally on Node 24.22.0. The scanner also scans fixtures; host-side lookup of loaded plugins is isolated in `test/native-server.cjs`, explicitly separating the native server registry from the plugin App facade. Production security-bridge warnings remain visible and are explained in [authentication compatibility](authentication.md). The upstream lifecycle shim safely receives unavailable-router/invalid-configuration errors; native endpoint operation is verified by our real-server tests.

Registry scoring is a separate release check. The registry's own-test component uses the plugin's tests and can read commands from the official CI caller. The portable suite requires only loopback HTTP and no external service, Python product runtime or Docker backend. It does not use forced test exit. The native integration suite retains its documented server cleanup limitations. Adding this workflow alone does not establish 100/100, registry sandbox compatibility or a published package score.

The first official matrix passed Linux x64, Linux ARM64 and macOS but found CRLF checkout differences in both Windows formatting jobs. A local `core.autocrlf=true` clone reproduced the line endings. `.gitattributes` now requires LF for text files on every platform; formatter rules and test assertions remain unchanged.

## Release-preparation checkpoint (issue #8)

`npm run verify:package` now creates an exact tarball, verifies its required files/screenshots, installs it without scripts or development dependencies, runs the native integration tests through that installed entry point and audits the resulting production dependency tree. CI retains the artifact and its hash/version/source-state receipt for each supported server/Node combination. Local preparation runs passed on Node 24.22.0 / Signal K 2.33.0 and Node 22.23.3 / Signal K 2.32.0, with Python MCP and the real isolated History provider; installed production audits reported zero advisories. The full required check still passes 23 portable tests and 44 native entries, with only two opt-in product checks skipped.

Native configuration was exercised in the published Signal K 2.33.0 admin UI with a disposable admin and synthetic data: save/reload persisted a change, restoration succeeded, disable reported stopped and re-enable restored ready status. The captured screenshot is shipped and referenced by `signalk.screenshots`. `CHANGELOG.md` explicitly labels the initial version unreleased. The [release procedure](release-readiness.md) covers artifact verification, installation, rollback/removal, registry limitations and an unperformed owner-reviewed vessel acceptance procedure.

The npm name lookup returned E404 and GitHub had no releases on 2026-10-18; publication rights remain unverified. No npm release, AppStore score/indexing or vessel deployment is claimed. Issue #8 remains open for the final acceptance gates.

## Read-only Notifications API checkpoint (issue #9)

The adapter targets the released `/signalk/v2/api/notifications` collection in Signal K 2.32.0 and 2.33.0, not the proposed alerts subsystem. It exposes `list_notifications` and `get_notification` through both dedicated tools and `signalk.notifications`; legacy measurement `list` remains available. Records are forwarded unchanged after native context/path/source permission checks. With ACLs configured, missing source provenance is resolved only by exact native-model value matching; unresolved records are omitted. See [the boundary and limitations](capabilities.md#notifications-boundary).

Local validation on Node 24.22.0 / Signal K 2.33.0 passes type checking, lint, formatting, 30 portable tests and 46 native test entries; two optional product-client tests are skipped. The 46 native entries also pass on Node 22.23.3 / Signal K 2.32.0. Both native runs include Python MCP and the real isolated History provider. Tests reproduce the native collection's lack of per-record ACL filtering, then verify MCP reader/admin path and source denials, pagination, dedicated/generic equivalence, unchanged records and rejection of lifecycle operations. A real server with core notification management disabled verifies path-based IDs and absent optional ID/status fields. Focused tests cover unavailable APIs, malformed/bounded responses, permission changes, non-self contexts, unresolved/ambiguous source provenance and transport restriction to collection GET.

The nine-tool catalog is verified by the TypeScript/Python clients and hosting fixtures. Codex/Hermes product adapters have updated expected catalog counts but were not rerun for this change. No live vessel, notification service, proposed alerts API, release or deployment is involved.

## Process restart and serialization hardening follow-up (issue #7)

PR #22 merged as `35ded66`, adding the released read-only notification collection. This follow-up tests three full native server process replacements with the original MCP clients and tokens, persisted native security, interrupted provider requests and allowed/denied reads after every replacement. Both supported server versions recover correctly. Native `server.stop()` calls the gateway stop hook zero times in both releases, so in-process shutdown remains an explicit upstream gap; process replacement is not evidence that those hooks run.

The adversarial model test found that a 64-path read sharing 1 MiB strings allocated the full roughly 64 MiB JSON result before rejection. The gateway now counts JSON bytes during serialization, preserving normal JSON output and the final limit. The same bounded check applies to already-parsed request bodies. This is transport validation only; no domain data calculation or transformation was added. On the isolated local comparison, repeated-value process peak RSS fell from **670.98 MiB to 347.81 MiB**, with allowed/denied recovery checks passing. Custom serialization, host-owned data and property enumeration prevent claiming a global memory ceiling.

The ten-minute local ARM64 run completed **12,000/12,000 reads** with no errors or skips: p95 reads **9.14 ms**, telemetry scheduling p99 **3.67 ms**, post-GC heap change **−9.47 MiB**. CPU/RSS remain observations. See [methodology and raw before/after/load artifacts](resource-validation.md).

Full local checks pass on Node **24.22.0 / Signal K 2.33.0** and Node **22.23.3 / Signal K 2.32.0**: **32 portable tests**, **47 passing native entries** and two explicitly skipped optional product-client entries per run, with Python MCP and real isolated InfluxDB/History enabled. The final special-serializer fallback guard was then checked by all nine focused security tests on both Node versions; type/lint/format and diff checks pass. Product binaries were not rerun. Remote CI results belong to the follow-up PR.

The dependency reassessment still finds zero plugin production advisories and 18 development-tree advisories; 2.33.0 remains the latest published server in this check. Issue #7 stays open for Raspberry Pi acceptance, the upstream in-process cleanup gap and installed-host dependency assessment before release. No release, deployment, live vessel operation or upstream message occurred.

## Simplified native configuration

The host and browser-origin fields have been removed at the owner’s request. The gateway follows Signal K’s CORS response for valid HTTP(S) origins and keeps mandatory bearer authentication and path/source permissions. It accepts alternate Host headers without using them for outbound routing. Old plugin-local network lists are ignored on upgrade; other saved settings are preserved. Host CORS may be permissive by default, so any restrictions previously enforced by the retired browser list must move to Signal K’s security settings. See [hosting policy and migration](hosting.md#browser-policy-and-upgrades).

The native settings card has been recaptured without those two fields. The optional HTTPS certificate hostname now explains its purpose, a hostname example, when to leave it empty and why URLs, ports and certificate file paths do not belong there.

Final full checks pass on Node 24.22.0 / Signal K 2.33.0 and Node 22.23.3 / Signal K 2.32.0: 34 portable tests and 47 native entries pass per pair, with two optional product-client checks skipped. Python MCP and the real isolated History provider are enabled. The final UI was inspected at desktop and mobile widths, and saving/reloading/restoring the staleness setting succeeded without either retired field.

## CI deduplication

Both workflows now run on PRs, pushes to `main` and manual dispatch, without a second feature-branch push run. Portable tests and formatting belong to the official platform workflow. One blocking type/lint job remains in our workflow because the pinned upstream lint step uses `continue-on-error`. The four native runtime combinations retain checkout integration tests and installed-tarball integration tests, which validate different installation layouts. No test cases or supported runtime combinations were removed; `npm run check` still runs every local check.

The full local check passes on Node 24.22.0 / Signal K 2.33.0: 34 portable tests and 47 native entries, with only the two opt-in product clients skipped. Python MCP and isolated real InfluxDB/History are enabled. Type checking, lint, formatting and `git diff --check` pass. Remote workflow validation is recorded on the CI deduplication PR.

## Native plugin read approvals

Eligible blocked reads now return `APPROVAL_PENDING` and appear in native Plugin Config without a configuration write or provider call. Duplicate requests share one bounded entry; mutations, unsupported/ambiguous operations and invalid arguments cannot queue a review. Only the host's existing admin configuration route saves approve/reject decisions. Reviews bind exact operation/schema metadata, rejection overrides a matching manual approval, and overlapping approvals retain the stricter admin requirement. Unsaved requests remain in memory; saved decisions survive restart. Provider upgrades with unchanged metadata still require handler review.

Full local checks on Node 24.22.0 / Signal K 2.33.0 and Node 22.23.3 / Signal K 2.32.0 pass 37 portable tests and 48 native entries, with two opt-in product clients skipped. Python MCP and real isolated History are enabled. Native tests cover admin-only configuration saves, pending/approve/reject/retry, saved decisions, schema changes and original-caller enforcement; the unchanged published Alert Center fixture also queues an eligible read while its writes remain disabled.

The native form was inspected at 1280×900 and 390×844. Approving a synthetic read, saving and reloading succeeded; a second pending request appeared alongside the saved approval and could be rejected/saved on mobile. The mobile settings card has no horizontal overflow (380px content width and scroll width). The settings-only screenshot is refreshed. No live vessel data, deployment or npm publication was involved.

The approval UI now uses a custom table embedded in native Plugin Config. Five synthetic rows were inspected at 1600×1000 and the table was exercised at 390×844. A saved rejection survives reload and can be accepted again. Deleting a missing-plugin row requires confirmation and Save Configuration; the deletion survives reload. The mobile card remains 380px wide with 380px scroll width; the table scrolls horizontally within it. Connection and manual settings are expandable. The settings-only screenshot shows five demo entries, including a missing plugin.

Full checks pass on Node 24 / Signal K 2.33.0 and Node 22 / Signal K 2.32.0: 42 portable tests and 48 native passes, with two optional product-client skips. Added coverage checks concurrent edits, preservation of new requests and host flags, rejected-row edits, disabled/reinstalled-plugin deletion refusal, failed saves, native admin enforcement and HTTP serving of the built configurator. Browser visual verification uses the 2.33.0 Admin UI; both server versions exercise the native configuration APIs and asset hosting.

## Reviewed plugin POST extension — 2026-10-19

Rebased onto the alpha.2 release, preserving its first-time configuration fix. The implementation adds exact POST endpoint-contract reviews, bounded JSON bodies and original-bearer mutation forwarding. Per the owner's decision, package/version changes alone do not invalidate approval; endpoint schema, route, documented meaning or effective security-contract changes do. Key/required-field ordering and unrelated endpoints preserve approval. GET approvals cannot authorize POSTs, read-only identities cannot queue or dispatch them, and native provider permissions remain mandatory.

`npm run check` passed locally on Node 24.22.0 / Signal K 2.33.0: **83 portable tests passed; 60 native tests passed, three optional integrations skipped** (the production History backend and two opt-in product clients). The isolated Python MCP client was enabled. `git diff --check` passed. Focused native POST/published Alert Center tests passed on all four Node 22.23.3 / 24.22.0 × Signal K 2.32.0 / 2.33.0 combinations; this is targeted local matrix evidence, not a claim of full CI success.

Tests cover pending/rejected/no-dispatch, native administrator saves, exact contract renewal, body-name collisions, malformed/unsupported inputs, original caller identity, native admin-route denial, provider disablement, pre/post-dispatch revocation, unchanged provider replies, 202/204, redirects, invalid/oversized responses, HTTP failures and disconnects without retries. The production-provider fixture exercises unchanged `signalk-alert-center@0.4.1` snooze state with external transports disabled. No live vessel, notification service or physical device was used.

The embedded configurator was visually inspected at 390, 1280 and 1920 pixels in a disposable native server. A synthetic POST review was accepted and saved through the UI; its input schema, Write label and revocation action were inspected. The screenshot is [plugin-post-approvals.png](images/plugin-post-approvals.png). The native configuration fixture, not a live vessel, produced it.

Installed-artifact acceptance runs `npm run verify:package`, now including native POST and published-provider tests alongside existing native integration/PUT tests. Its external receipt records the exact tarball checksum, source commit, dirty state and audit result. Publication, merge and deployment remain separate authorized steps.
