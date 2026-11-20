# ADR 003: Optional isolated execution inside signalk-mcp

Date: 2026-11-20. Status: scope accepted; experimental implementation, not production-enabled or released.

## Decision

The owner accepted execution inside signalk-mcp rather than a companion plugin.
This supersedes the earlier exclusion of execution, but does not change ordinary
fetch-and-forward tools. [Issue #39](https://github.com/arodus/signalk-mcp/issues/39)
tracks the extension. Container Manager [draft PR #344](https://github.com/dirkwa/signalk-container/pull/344)
is the experimental dependency, not an upstream release.

The first slice supports JavaScript function bodies over current self-context
telemetry only. History input, caller-supplied datasets, installed calculation
libraries and non-administrator execution are not implemented. A missing or denied
path rejects the whole snapshot. Missing values stay null, zero stays zero, and
units, timestamps and selected sources are preserved. The snapshot is not an
atomic multi-sensor observation; each measurement retains its timestamp.

## Configuration and eligibility

In native Plugin Config, under Connection and data settings, enable experimental
execution and enter a reviewed, locally installed image with its sha256 digest.
Saving uses the existing native configuration flow. The default is disabled;
without enablement the MCP tool is not registered. Container-free installations
continue using ordinary tools.

Only a currently authenticated native administrator can invoke this first version.
Administrator identity does not bypass path/source read ACLs. Every requested
measurement must be readable. The gateway checks identity and the snapshot's exact
path/source permissions again immediately before dispatch and before result
release. Revocation during execution suppresses output at completion; it does not
promise instant termination on an ACL edit. Disconnect, request cancellation,
plugin stop and the HTTP deadline propagate an abort signal to Container Manager.

No result store or cross-request job lookup exists. Results return only on the
initiating request. A container job ID is diagnostic information, never an access
token. Execution does not approve or invoke native PUTs or other mutations.

## Protocol and boundaries

`execute_code` accepts only `code` (a JavaScript function body, at most 32 KiB in
UTF-16 code units) and `paths` (1–64 exact self-context paths). Existing HTTP request
limits still apply. Example:

```json
{
  "code": "return data.measurements[0].value * 2;",
  "paths": ["navigation.speedOverGround"]
}
```

The worker receives bounded JSON `{ "version": 1, "code": "...", "data": { ... } }`
over stdin. `data` has the same measurement structure as `get_values`. The entire
serialized input is limited to 1 MiB; oversized snapshots are rejected without
truncation. No bearer, Signal K configuration, host path or live service reference
enters that envelope. Submitted code is evaluated only inside the container.

The trusted gateway fixes owner `signalk-mcp` and runner
`/usr/local/bin/signalk-mcp-worker`. Only native administrator configuration chooses
the image. The isolated adapter uses the experimental upstream shared bus
`globalThis.__signalk_containerManager` and requires `runSandboxJob`; there is no
fallback to `runJob`, a host process, shell or in-process evaluation. This interface
is version-sensitive and must be revalidated against the eventual release.

The worker prints `{ "version": 1, "value": ... }` for a returned value. Code can
also print arbitrary bytes, so the gateway never trusts worker output as a success
claim or protocol message. The response has `kind: "execution-result"`, upstream
status, exit code, OOM evidence and cleanup state. `outputEncoding: "base64"`
preserves the bounded combined stdout/stderr stream (maximum 256 KiB); decode it
before inspecting the worker JSON. MCP serialization allows 384 KiB for this tool
only to accommodate base64. No output is published as telemetry or written to
server logs. Unknown/malformed manager results are sanitized and never retried.

Container Manager enforces one active job, no queue, six attempts/minute, 256 MiB
memory without swap, 0.5 CPU, 32 processes, 16 MiB tmpfs and an independent 15-second
container deadline. These are initial design targets, not production benchmarks.
The HTTP budget is 25 seconds for this tool, allowing setup and cleanup; ordinary
requests retain 15 seconds. Exit 137 alone is not proof of timeout or OOM.

## Local development

The worker Dockerfile pins Node 24 Bookworm slim with GNU timeout 9.1. Review it
and `worker/runner.cjs` before building. The image is not published by this change.

```sh
docker build --pull=false -t signalk-mcp-execution-test:local worker
docker image inspect signalk-mcp-execution-test:local --format '{{json .RepoDigests}}'
```

Use the resulting fully qualified `docker.io/library/signalk-mcp-execution-test@sha256:...`
as the configured image, not the mutable tag. Run the opt-in live test against a
built checkout of Container Manager PR #344:

```sh
MCP_EXECUTION_TEST_IMAGE=docker.io/library/signalk-mcp-execution-test@sha256:... \
MCP_CONTAINER_TEST_DIR=/absolute/path/to/signalk-container \
node --test --test-force-exit test/execution-native.test.cjs
```

That test uses a real temporary Signal K server, synthetic identities/data and the
real Container Manager executor through a small test bridge. It does not establish
native Container Manager plugin loading, release compatibility, or production
readiness. Portable tests never require Docker. The ordinary native integration
suite tests identity/configuration behavior with an injected manager fixture.

## Release gate

Keep this experimental until a released upstream contract and supported runtime
combinations are verified. Docker and rootless Podman, bare-metal/containerized
Signal K, cancellation/restart behavior and deployment-specific enforcement need
explicit evidence. Ordinary containers share the host kernel; they are not a VM
security boundary. No release, deployment or vessel-hardware validation is implied.
