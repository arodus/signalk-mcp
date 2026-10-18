# Lifecycle and local resource validation

Issue [#7](https://github.com/arodus/signalk-mcp/issues/7) remains open for Raspberry Pi acceptance and whole-server restart validation. These tests use isolated synthetic data and native Signal K permissions. No vessel hardware is involved.

## Shutdown regression

Stopping the plugin during a provider read previously aborted the upstream request but left the MCP client's HTTP connection waiting until the 15-second gateway deadline. Closing the SDK transport alone also left its JSON-response promise pending. The handler now races transport completion against response closure so it can reach cleanup, and plugin stop explicitly destroys pending responses. Normal request authorization and forwarding are unchanged.

`test/runtime.test.cjs` runs two disposable native servers in child processes: one without the gateway, and one with it. The gateway case exercises 12 alternating client-disconnect/plugin-stop cycles, allowed and denied identities concurrently after recovery, eight occupied request slots plus a rejected ninth request, and two real five-second provider timeouts. It requires client disconnect within one second and verifies upstream socket cancellation. Oversized model/depth and feature-discovery tests check rejection and recovery separately.

An `async_hooks` trace records timer and TCP allocation origins. After shutdown it allows 1.1 seconds for Node's verified HTTP Date-header cache timer (which expires at the next second boundary), without clearing timers. Before terminating either child, assertions require no surviving traced gateway-owned timer/TCP resource, including unreferenced ones, and no extra referenced resource origin/count relative to the server without the gateway. A 1.5-second exit observation then reports whether the server exited naturally. The parent terminates residual children only after those assertions; the lifecycle test also runs without the main suite's `--test-force-exit`.

Signal K 2.33.0 leaves upstream timers after `server.stop()`: WebSocket metadata cache and Primus heartbeat/destruction timers, DeltaCache sweeps, notification-manager cleanup and the MFD webapp timer. Both cohorts fail to exit naturally within the observation window. Allocation stacks in the test diagnostic distinguish these from gateway resources. This is evidence for the traced resources and scenarios, not proof that every possible JavaScript reference is released. In-process whole-server restart remains unverified; the upstream survivors must be addressed before claiming it.

## Reproduce

Use Node 24 for the primary run, with dependencies installed:

```sh
npm run build
node --test test/runtime.test.cjs
node test/runtime-benchmark.cjs /tmp/signalk-mcp-arm64.json
```

Select the alternate server with `MCP_TEST_SERVER_DIR` and assert its version with `MCP_TEST_SERVER_VERSION`, as described in [authentication compatibility](authentication.md). Run the benchmark by itself, without simultaneous test suites or builds. The benchmark is opt-in, not a variable-speed CI performance gate. Its driver enables GC in the child, records whether shutdown exits naturally and terminates upstream survivors afterward.

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

Response limits are not a strict process-memory ceiling: core results are serialized before their 256 KiB check, Signal K has already parsed the request body before the plugin's 64 KiB check, and model/discovery data already exists in the host. HTTP provider bodies are bounded while being received. Path scanning has node/depth limits, but native enumeration and serialization can still allocate transient memory. Retain issue #7 for adversarial large-value/long-duration evaluation and whole-server restart work; a passing short benchmark does not close those questions.

## Dependency exposure snapshot

On 2026-10-18, `npm audit --omit=dev --json` reported **zero production advisories**. The full locked development tree reported **18**: 12 moderate, five high and one critical. All reported nodes are development dependencies used by the isolated Signal K test runtime; the published plugin's dependency list does not install that server.

The critical finding is `lodash@3.10.1` under `@signalk/signalk-schema`. High-severity nodes include `nanoid@3.1.32`, `node-forge@1.4.0`, `validator@7.2.0/10.11.0`, and their affected parent packages. Moderate findings additionally involve `sprintf-js@1.0.3`, `uuid@8.3.2` and their parent chains. For example, the audit links [lodash](https://github.com/advisories/GHSA-fvqr-27wr-82fm), [nanoid](https://github.com/advisories/GHSA-mwcw-c2x4-8c55), [node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv) and [validator](https://github.com/advisories/GHSA-qgmg-gppg-76g5) advisories; these links identify audit findings, not demonstrated exploitability in this gateway.

The audit's proposed top-level fix is `signalk-server@0.1.32`, a downgrade outside the supported 2.32.0/2.33.0 matrix. It is not a usable compatibility-preserving upgrade. No forced fix or transitive override was applied. Keep synthetic test servers isolated, reassess upstream supported releases before release, and audit the separately installed production Signal K host independently. A clean plugin production audit does not certify the host server or eliminate test-environment exposure.
