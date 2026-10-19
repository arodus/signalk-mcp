# Lifecycle and local resource validation

Issue [#7](https://github.com/arodus/signalk-mcp/issues/7) tracks the upstream in-process shutdown limitation and host dependency review. On 2026-10-19, the owner removed Raspberry Pi testing from release acceptance; existing local ARM64 measurements remain development evidence only. Full process replacement and client reconnection are now tested. These tests use isolated synthetic data and native Signal K permissions. No vessel hardware is involved.

## Shutdown regression

Stopping the plugin during a provider read previously aborted the upstream request but left the MCP client's HTTP connection waiting until the 15-second gateway deadline. Closing the SDK transport alone also left its JSON-response promise pending. The handler now races transport completion against response closure so it can reach cleanup, and plugin stop explicitly destroys pending responses. Normal request authorization and forwarding are unchanged.

`test/runtime.test.cjs` runs two disposable native servers in child processes: one without the gateway, and one with it. The gateway case exercises 12 alternating client-disconnect/plugin-stop cycles, allowed and denied identities concurrently after recovery, eight occupied request slots plus a rejected ninth request, and two real five-second provider timeouts. It requires client disconnect within one second and verifies upstream socket cancellation. Oversized model/depth and feature-discovery tests check rejection and recovery separately.

An `async_hooks` trace records timer and TCP allocation origins. After shutdown it allows 1.1 seconds for Node's verified HTTP Date-header cache timer (which expires at the next second boundary), without clearing timers. Before terminating either child, assertions require no surviving traced gateway-owned timer/TCP resource, including unreferenced ones, and no extra referenced resource origin/count relative to the server without the gateway. A 1.5-second exit observation then reports whether the server exited naturally. The parent terminates residual children only after those assertions; the lifecycle test also runs without the main suite's `--test-force-exit`.

Signal K 2.33.0 leaves upstream timers after `server.stop()`: WebSocket metadata cache and Primus heartbeat/destruction timers, DeltaCache sweeps, notification-manager cleanup and the MFD webapp timer. Both cohorts fail to exit naturally within the observation window. Allocation stacks in the test diagnostic distinguish these from gateway resources. This is evidence for the traced resources and scenarios, not proof that every possible JavaScript reference is released. In-process whole-server cleanup is not established; the upstream survivors must be addressed before claiming it. Full process replacement has separate coverage below.

## Reproduce

Use Node 24 for the primary run, with dependencies installed:

```sh
npm run build
node --test test/runtime.test.cjs
node --test test/restart.test.cjs
node test/runtime-benchmark.cjs /tmp/signalk-mcp-arm64.json
node test/runtime-benchmark.cjs /tmp/signalk-mcp-10min.json 600
node test/runtime-pressure.cjs /tmp/signalk-mcp-pressure.json
```

Select the alternate server with `MCP_TEST_SERVER_DIR` and assert its version with `MCP_TEST_SERVER_VERSION`, as described in [authentication compatibility](authentication.md). Run each benchmark by itself, without simultaneous test suites or builds. The optional final duration argument selects 30–1,800 seconds of load; the idle phase remains 30 seconds. Fixture tokens last one hour so longer local measurements do not measure credential expiry. The benchmark is opt-in, not a variable-speed CI performance gate. Its driver enables GC in the child, records whether shutdown exits naturally and terminates upstream survivors afterward.

## Agreed local development gate

Before measurement, the owner approved a local ARM64 development baseline, leaving Raspberry Pi acceptance open:

| Measurement                | Gate                                                          |
| -------------------------- | ------------------------------------------------------------- |
| MCP load                   | 20 reads/second for 30 seconds; all 600 succeed, none skipped |
| Read latency               | p95 ≤250 ms                                                   |
| Telemetry scheduling delay | p99 ≤100 ms                                                   |
| Post-GC heap growth        | ≤16 MiB                                                       |
| CPU and RSS                | Report only                                                   |

The synthetic model contains 1,001 measurement leaves. Each read fetches 64 paths through the real authenticated MCP HTTP endpoint, with at most four requests outstanding. Fifty warm-up reads precede a 30-second idle phase and a 30-second load phase. During both phases a 10 Hz timer injects deltas through Signal K and verifies that the native model contains the new value. The telemetry delay is lateness of that timer relative to its prior tick plus 100 ms; processing time measures synchronous delta injection/model observation. Neither establishes instrument-to-client delivery latency.

CPU includes the server and same-process HTTP benchmark client and is expressed as a percentage of one core. RSS is sampled on telemetry ticks. Heap growth compares explicit post-GC measurements before the idle phase and after the load phase. This is a short development check, not a long-duration leak test or a Raspberry Pi equivalence claim. Benchmark arithmetic exists only in the test harness; the gateway still only discovers, fetches and forwards data.

## Recorded local result

The [raw measurement](benchmarks/2026-10-18-arm64.json) records macOS/Darwin 25.6.0, ARM64 Apple M4 Max (16 logical CPUs, 64 GiB RAM), Node 24.22.0 and Signal K 2.33.0 on 2026-10-18. All gates passed: 600/600 reads, no skipped requests or telemetry observation failures, read p95 **7.83 ms**, read p99 **9.83 ms**, telemetry scheduling p99 **2.18 ms**, and post-GC heap change **−9.68 MiB**. Negative heap change reflects this short sampled interval and is not proof against long-term leaks.

Idle/load CPU was **0.91% / 12.69%** of one core; peak RSS was **324.8 / 355.5 MiB**. Event-loop p99 was **11.53 / 13.61 ms**, and telemetry processing p99 **0.46 / 0.43 ms**. CPU/RSS are observations, not gates. Natural exit was false, consistent with the separately traced upstream timers. An initial harness run used a plugin-facade accessor on the server object; it was discarded, corrected to the actual native model accessor, and the recorded run explicitly checks zero telemetry observation errors.

## Boundary review and remaining limits

The review covered native identity reauthorization, per-path/source permissions, fixed socket-derived local HTTP destinations, certificate validation, GET approvals, OpenAPI schema restrictions and sanitized errors. Existing regression tests exercise permission revocation, routing spoofing/redirects, schema changes, oversized responses and internal error redaction. The confirmed shutdown defect above is fixed with native integration coverage.

Core results now count UTF-8 JSON bytes during serialization and stop normal oversized strings/repeated values before allocating the complete result. The final 256 KiB check remains for special non-JSON-native objects whose serializer can bypass normal child traversal. The already-parsed request body uses the same early byte-budget check with its existing 64 KiB limit. Allowed JSON spelling and values remain unchanged; this is transport validation, not domain calculation.

These limits still do not impose a strict process-memory ceiling. Signal K parses requests before plugin routing, and native model/discovery data already exists in the host. Property enumeration and custom serialization can allocate memory before the gateway can reject it. HTTP provider bodies remain bounded while received. The MCP wire envelope includes both text and structured content, so its complete wire size exceeds the data-JSON budget. Do not interpret the measured RSS reduction as a global memory guarantee.

## Dependency exposure snapshot

On 2026-10-18, `npm audit --omit=dev --json` reported **zero production advisories**. The full locked development tree reported **18**: 12 moderate, five high and one critical. All reported nodes are development dependencies used by the isolated Signal K test runtime; the published plugin's dependency list does not install that server.

The critical finding is `lodash@3.10.1` under `@signalk/signalk-schema`. High-severity nodes include `nanoid@3.1.32`, `node-forge@1.4.0`, `validator@7.2.0/10.11.0`, and their affected parent packages. Moderate findings additionally involve `sprintf-js@1.0.3`, `uuid@8.3.2` and their parent chains. For example, the audit links [lodash](https://github.com/advisories/GHSA-fvqr-27wr-82fm), [nanoid](https://github.com/advisories/GHSA-mwcw-c2x4-8c55), [node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv) and [validator](https://github.com/advisories/GHSA-qgmg-gppg-76g5) advisories; these links identify audit findings, not demonstrated exploitability in this gateway.

The audit's proposed top-level fix is `signalk-server@0.1.32`, a downgrade outside the supported 2.32.0/2.33.0 matrix. It is not a usable compatibility-preserving upgrade. The latest published server was rechecked as 2.33.0 for this follow-up; the advisory counts were unchanged. No forced fix or transitive override was applied. Keep synthetic test servers isolated, reassess upstream supported releases before release, and audit the separately installed production Signal K host independently. A clean plugin production audit does not certify the host server or eliminate test-environment exposure.

## Full process restart and reconnection

`test/restart.test.cjs` starts four native Signal K processes sequentially on the same port and configuration directory, terminating each preceding process with SIGTERM. The first fixture writes its synthetic security configuration to `security.json`; replacement servers read that file using the native security loader. The original TypeScript SDK Client, transport and bearer token are reused across all three replacements. Each generation publishes a distinct synthetic value, verifies nine-tool discovery and an allowed read, and verifies that the second identity still cannot read that path. Plugin configuration remains unchanged.

Each replacement interrupts an actual pending provider read. The client observes failure while the process is down, then reads the new generation after the next server starts without manual credential refresh or reconnection. This runs without `--test-force-exit` in isolation and passes on Node 24/Signal K 2.33 and Node 22/Signal K 2.32. OS process termination closes the resources; it is not evidence that JavaScript shutdown hooks ran.

The final generation also invokes native `server.stop()` with a spy around the gateway's stop hook. Both tested releases report **zero plugin stop calls**. Inspection confirms that their plugin interface implements `start()` without a corresponding interface `stop()`, while the server only stops interfaces exposing that hook. Together with the separate residual-timer trace, this leaves native in-process reload/cleanup unsupported as a verified shutdown path. Use full server process replacement for the tested restart behavior; do not patch Signal K internals or clear upstream timers inside the gateway to conceal the gap.

## Large-value pressure methodology

`test/runtime-pressure.cjs` uses a separate child with a 384 MiB V8 old-space limit (not an RSS cap). It measures the native HTTP endpoint with synthetic model values: 64 small strings, one 8 MiB string, 64 paths sharing a 1 MiB value, a 128 KiB string of control characters requiring JSON escaping, and an object with 30,000 keys. Each case warms once, makes 20 measured calls and checks an ordinary allowed read and denied identity after every call. Oversized cases must return `OUTPUT_LIMIT`; no rejected value is forwarded. Source data is seeded through native delta handling. Before/after heap samples use explicit GC; RSS peaks are process-wide high-water marks, so later cases inherit earlier peaks.

The baseline uses production code from merged commit `35ded66` with the new measurement harness. The comparison uses the bounded serializer from this change. These are isolated local observations, not Raspberry Pi measurements or production memory limits. CPU and memory arithmetic remains solely in the test harness.

### Recorded serialization comparison

The [baseline](benchmarks/2026-10-18-serialization-before.json) and [bounded-serialization result](benchmarks/2026-10-18-serialization-after.json) were measured independently on the same Apple M4 Max, Node 24.22.0 and Signal K 2.33.0. The table reports each case's process high-water RSS and p95 read latency; these are observations, not acceptance thresholds.

| Case                       | Previous peak RSS | Bounded peak RSS | Previous p95 | Bounded p95 |
| -------------------------- | ----------------: | ---------------: | -----------: | ----------: |
| 64 small strings           |        349.05 MiB |       347.81 MiB |      3.28 ms |     4.23 ms |
| One 8 MiB string           |        415.42 MiB |       347.81 MiB |      7.74 ms |     1.58 ms |
| 64 shared 1 MiB values     |        670.98 MiB |       347.81 MiB |     37.72 ms |     1.56 ms |
| Escaped control characters |        670.98 MiB |       358.56 MiB |      1.89 ms |     1.69 ms |
| 30,000-key object          |        670.98 MiB |       358.56 MiB |      4.50 ms |     6.69 ms |

All expected successes/rejections and subsequent allowed/denied reads passed in both runs. In the bounded run, post-GC heap change was +2.39 MiB for the small case and at most +0.14 MiB for each oversized case. The shared-value case previously allocated a roughly 64 MiB JSON result before applying the 256 KiB check; it now rejects during traversal. Both children still required termination after the upstream shutdown observation window. The improvement does not establish natural in-process shutdown or a universal memory ceiling.

## Ten-minute local load observation

The [extended raw measurement](benchmarks/2026-10-18-arm64-600s.json) uses the same local hardware, Node 24.22.0, Signal K 2.33.0 and synthetic workload as the short baseline, with 30 seconds idle followed by 600 seconds of load. All **12,000/12,000 reads** succeeded at 20/second, with zero skipped requests and zero telemetry observation errors. Read p95 was **9.14 ms**, p99 **12.43 ms**, telemetry scheduling p99 **3.67 ms**, and post-GC heap change **−9.47 MiB**. The previously approved short-run thresholds are retained as reference checks and all pass; this extension does not establish new Raspberry Pi or production acceptance thresholds.

Idle/load CPU was **1.17% / 15.99%** of one core, peak sampled RSS **330.83 / 361.02 MiB**, and event-loop p99 **11.58 / 14.66 ms**. Load telemetry processing p99 was **0.46 ms**. The raw artifact includes ten-second memory samples without forcing GC during the workload. No other test suite or build ran alongside this measurement. Natural exit remained false because of the upstream shutdown gap. Ten minutes of synthetic load and a negative retained-heap delta do not prove absence of long-term leaks or performance on vessel hardware.

## Alpha acceptance scope (2026-10-19)

Raspberry Pi testing is no longer required. Historical benchmark descriptions retain their original scope; no Pi compatibility is claimed. Vessel acceptance follows the first alpha release and requires separate access/deployment authorization.

The shutdown limitation concerns whole-server shutdown inside a still-running Node process: supported Signal K versions do not invoke plugin stop hooks through `server.stop()`, and upstream timers survive. Gateway stop/start cleanup is tested separately. For the alpha, document this unsupported shutdown path and use full server process replacement, whose reconnection and permission behavior is tested. Fixing upstream shutdown is not required for the alpha; this does not mark the upstream defect resolved.
