> Original project brief. Statements about implementation status and prior art below describe the handoff, not the current release. See README.md and docs for current behavior, verification and decisions. Current direction: continue this independent plugin with read-only capability discovery and existing Signal K permissions.

## Current implementation checkpoint (2026-10-18)

The independent plugin implements authenticated Streamable HTTP, batched telemetry, vessel snapshots, legacy notification reads, source-specific standardized history, a compact capability registry, public feature discovery, and on-demand plugin OpenAPI inspection. Only explicitly reviewed GET operations can execute, using the original Signal K bearer identity and native route permissions. Unknown operations remain disabled. History and OpenAPI coverage are deliberately limited and documented in README.md.

README.md, docs/capabilities.md and docs/verification.md are the authority for implemented behavior and verification. AppStore publication, live vessel acceptance, broad production-provider compatibility, OAuth, control operations and sandbox execution remain incomplete. The following original handoff is retained as the longer-term brief.

# Project Handoff: Native Signal K MCP Plugin

**Project name:** `signalk-mcp` (provisional)  
**Status:** Architecture and feasibility assessment completed; implementation not started.  
**Goal:** Develop an open-source, native Signal K plugin that exposes vessel data, Signal K functionality, and installed plugin APIs to AI agents through the Model Context Protocol (MCP).

The solution should support both conventional MCP tools and optional sandboxed JavaScript execution, reuse Signal K's existing authentication, and integrate with Signal K Container Manager for isolated execution.

**Target users:** Signal K community, vessel owners, AI developers, and automation systems including ChatGPT, Claude, Codex, and Hermes.

---

## 1. Project objectives

Build an MCP integration that:

1. Installs directly through the **Signal K AppStore**.
2. Implements MCP over **Streamable HTTP**.
3. Reuses **Signal K authentication and authorization**.
4. Exposes Signal K's standard APIs and vessel telemetry.
5. Automatically discovers capabilities exposed by installed Signal K plugins.
6. Allows authorized invocation of third-party plugin APIs.
7. Supports both conventional MCP tools and sandboxed `execute_code`.
8. Uses **Signal K Container Manager** for sandbox lifecycle management.
9. Minimizes tokens and unnecessary MCP calls.
10. Remains lightweight and functional without Docker or Podman.

The plugin must be suitable for community adoption rather than being specific to one vessel.

**Design philosophy:** Reuse existing Signal K infrastructure and standards wherever possible. Avoid reinventing authentication, container management, data providers, or plugin interfaces.

---

## 2. Existing projects and prior art

Research these repositories before implementation.

| Project                      | Repository                                                                           | Relevance                                          |
| ---------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Signal K Server              | [SignalK/signalk-server](https://github.com/SignalK/signalk-server)                  | Plugin architecture, authentication, ServerAPI     |
| VesselSense MCP              | [VesselSense/signalk-mcp-server](https://github.com/VesselSense/signalk-mcp-server)  | Sandboxed JavaScript execution, MCP implementation |
| Sailing Naturali MCP         | [sailingnaturali/signalk-mcp](https://github.com/sailingnaturali/signalk-mcp)        | Conventional MCP tools                             |
| Signal K Container Manager   | [dirkwa/signalk-container](https://github.com/dirkwa/signalk-container)              | Docker/Podman container lifecycle                  |
| Signal K MCP feature request | [SignalK/signalk-server#1867](https://github.com/SignalK/signalk-server/issues/1867) | Previous community discussion                      |

### Important context

Signal K issue #1867 was opened in January 2025, when MCP primarily relied on stdio and HTTP+SSE.

Modern Streamable HTTP was introduced later, making native HTTP integration substantially more practical.

Do not assume that the original issue describes current architectural requirements.

Neither of the two identified MCP implementations is a native Signal K AppStore plugin.

The proposed architecture combines capabilities currently spread across multiple projects.

**Before coding:** Check for newly published implementations, related pull requests, and active development efforts. Avoid duplicating existing work unnecessarily.

---

## 3. Target architecture

```text
                 AI AGENTS
       ChatGPT / Claude / Hermes / Codex
                     |
                     |
             MCP Streamable HTTP
                     |
                     v
       ┌──────────────────────────┐
       │    Signal K MCP Plugin   │
       │                          │
       │  MCP Protocol Server     │
       │  Signal K Authentication │
       │  Authorization           │
       │  Capability Discovery    │
       │  MCP Tools & Resources   │
       │  Capability Broker       │
       └────────────┬─────────────┘
                    |
          ┌─────────┴───────────┐
          |                     |
          v                     v
    Standard MCP          execute_code
        Tools                   |
          |                     |
          |             Container Manager
          |                     |
          |                     v
          |             ┌───────────────┐
          |             │ Sandbox Worker│
          |             │               │
          |             │ V8 JavaScript │
          |             │ Restricted SDK│
          |             │ Resource Limits│
          |             └───────┬───────┘
          |                     |
          |              Broker RPC
          |                     |
          └──────────┬──────────┘
                     |
                     v
            CAPABILITY LAYER
                     |
          ┌──────────┼──────────┐
          |          |          |
          v          v          v
      Signal K    History    Plugin APIs
        Core        API
```

### Architectural principles

- The MCP HTTP endpoint runs inside Signal K.
- Authentication and authorization are handled by the native plugin using existing Signal K infrastructure.
- Conventional tools access the capability layer directly.
- Sandboxed code accesses the same capability layer through a restricted broker.
- The sandbox never receives unrestricted access to Signal K internals.
- Docker/Podman functionality is optional.
- Core navigation and telemetry functionality must continue working if the sandbox crashes.

---

## 4. Signal K authentication and authorization

### Requirement

**Reuse Signal K's existing authentication system. Do not introduce separate MCP user accounts or credentials.**

Use existing Signal K JWT/device-token authentication.

Proposed endpoint:

```http
POST /plugins/signalk-mcp/mcp
Authorization: Bearer <signalk-token>
Content-Type: application/json
```

The endpoint path is provisional.

Signal K supports permission-aware plugin routing.

Illustrative implementation:

```typescript
plugin.registerWithRouter = (router) => {
  router.access("readonly").post("/mcp", mcpHandler);
};
```

The actual registration and HTTP transport integration must be verified against the target Signal K version.

### Permissions

| Operation                                    | Required permission   |
| -------------------------------------------- | --------------------- |
| Read vessel telemetry                        | readonly              |
| Read navigation state                        | readonly              |
| Read historical measurements                 | readonly              |
| Discover approved plugin capabilities        | readonly              |
| Execute approved read-only plugin operations | readonly              |
| Modify Signal K values                       | readwrite             |
| Execute operational commands                 | Explicitly authorized |
| Modify server configuration                  | admin                 |

### Critical requirement

**HTTP route authorization is insufficient by itself.**

MCP uses POST requests for tool invocations, including read operations.

Consequently, authorization must also be enforced for every individual MCP tool and capability invocation.

The authenticated user's permissions must propagate through the entire execution chain.

Never allow an MCP operation to acquire administrator privileges merely because the native plugin can access privileged internal APIs.

### Security considerations

- Reject invalid or expired credentials.
- Do not expose sensitive capabilities to unauthenticated guests.
- Default to read-only operations.
- Deny unknown permissions.
- Restrict access to high-risk operations.
- Prevent privilege escalation through third-party plugin APIs.
- Handle deployments where Signal K security is disabled.
- Validate HTTP origins where required.
- Avoid exposing credentials to sandboxed execution.

### OAuth

Existing Signal K bearer tokens should be supported initially.

Some remote MCP clients may require OAuth discovery or interactive authorization.

Full OAuth interoperability is a separate implementation concern and should not block the initial proof of concept.

Do not assume that accepting bearer tokens guarantees compatibility with every MCP client.

---

## 5. MCP transport

Implement **MCP Streamable HTTP** using the official TypeScript MCP SDK where practical.

Requirements:

- Protocol initialization and capability negotiation.
- JSON-RPC request handling.
- MCP tools.
- MCP resources where useful.
- Proper HTTP status codes and error handling.
- Multiple concurrent clients.
- Authentication integration.
- Origin validation.
- Compatible content negotiation.
- Graceful restart and connection recovery.

Prefer stateless MCP operation where compatible with the selected SDK and supported protocol versions.

Avoid introducing unnecessary session management.

### Important

Review the current MCP transport specification before implementation.

Reference:

https://modelcontextprotocol.io/specification

Test compatibility with actual clients rather than relying exclusively on protocol compliance.

---

## 6. Core Signal K functionality

Expose core Signal K data through a compact, stable set of MCP tools.

### Initial tools

| Tool                  | Description                                          |
| --------------------- | ---------------------------------------------------- |
| `get_vessel_state`    | Retrieve the current vessel state                    |
| `list_paths`          | Discover available Signal K paths                    |
| `get_values`          | Retrieve multiple values in one operation            |
| `get_history`         | Query historical measurements                        |
| `list_capabilities`   | Discover supported Signal K and plugin functionality |
| `describe_capability` | Inspect capability schemas and permissions           |
| `execute_capability`  | Execute an authorized operation                      |

Avoid exposing one MCP tool per Signal K measurement.

That would create unnecessary tool proliferation and increase context/token consumption.

### Data requirements

Every returned measurement should include appropriate metadata:

- Value.
- Signal K path.
- Unit.
- Timestamp.
- Data source, where available.
- Freshness/staleness.
- Relevant metadata.

Do not invent unavailable measurements.

Distinguish missing data from zero values.

### History

Prefer Signal K's standardized History API when a compatible provider is installed.

Do not require a direct InfluxDB integration merely to retrieve historical data.

The History API may be supplied by another Signal K plugin.

History support must therefore be capability-dependent.

---

## 7. Dynamic plugin API discovery

This is one of the project's primary differentiators.

### Goal

Allow AI agents to discover and use functionality provided by installed Signal K plugins without requiring manually developed MCP tools for every plugin.

Examples:

- Historical-data providers.
- Weather plugins.
- Navigation plugins.
- Alarm systems.
- Autopilot integrations.
- Equipment-monitoring plugins.
- Custom vessel functionality.

### Discovery strategy

Use existing Signal K mechanisms:

1. Standardized Signal K APIs.
2. Feature discovery.
3. Plugin-provided OpenAPI definitions.
4. Explicit adapters where required.

Signal K plugins can expose HTTP APIs and provide OpenAPI descriptions.

However, **not every installed plugin exposes a complete OpenAPI definition**.

Automatic discovery must therefore support partial capability coverage.

### Proposed capability model

```json
{
  "id": "energy.history",
  "provider": "example-history-plugin",
  "description": "Query historical electrical measurements",
  "operations": ["query", "aggregate"],
  "permission": "readonly",
  "available": true
}
```

This is a proposed model, not an existing Signal K standard.

### MCP tools

Instead of dynamically registering hundreds of tools, expose:

```text
list_capabilities()
describe_capability(id)
execute_capability(id, operation, arguments)
```

Frequently used functions can also have dedicated tools.

### Security

Never assume that an API operation is safe merely because it appears in an OpenAPI specification.

Implement:

- Operation allowlisting.
- Permission classification.
- Input validation.
- Authorization checks.
- Restricted invocation.
- Clear error reporting.
- Explicit handling of side effects.

Unknown operations should be disabled by default.

Plugin APIs must not be called using elevated privileges that bypass the original authorization model.

---

## 8. Sandboxed `execute_code`

### Motivation

Conventional MCP tools work well for straightforward operations.

However, complex queries can involve many measurements and substantial historical data.

Returning all raw data to the LLM wastes tokens and increases processing overhead.

A sandboxed JavaScript execution tool allows filtering, aggregation, and transformation to happen near the data source.

### Proposed tool

```text
execute_code(code)
```

The agent supplies JavaScript executed in a restricted environment.

Example:

```javascript
const values = await signalk.getValues([
  "navigation.speedOverGround",
  "navigation.courseOverGroundTrue",
]);

return {
  speed: values["navigation.speedOverGround"],
  course: values["navigation.courseOverGroundTrue"],
};
```

This is illustrative SDK syntax.

### Restricted JavaScript SDK

Potential functions:

```typescript
signalk.getValue(path);

signalk.getValues(paths);

signalk.listPaths(prefix);

signalk.getVesselState();

signalk.getHistory(options);

signalk.listCapabilities();

signalk.describeCapability(id);

signalk.executeCapability(id, operation, args);
```

The SDK must not expose unrestricted Signal K internals.

### Sandbox restrictions

- No unrestricted filesystem access.
- No host filesystem mounts.
- No unrestricted network access.
- No Signal K authentication tokens.
- No access to Docker/Podman sockets.
- No arbitrary process execution.
- Execution timeouts.
- Memory limits.
- CPU limits.
- Output-size limits.
- Restricted capability invocation.

Evaluate reusing the execution engine from:

https://github.com/VesselSense/signalk-mcp-server

Review its licensing, implementation, maintenance status, and security properties before deciding whether to reuse it.

### Important distinction

Executing JavaScript inside a V8 isolate is not equivalent to full operating-system isolation.

For stronger isolation, run the execution engine in a separate container.

---

## 9. Signal K Container Manager integration

Use the existing project:

https://github.com/dirkwa/signalk-container

### Goal

Let `signalk-container` handle the sandbox's lifecycle instead of implementing independent Docker/Podman management.

Responsibilities:

- Container creation.
- Image pulling.
- Start/stop.
- Restart.
- Resource limits.
- Network configuration.
- Container discovery.
- Health reporting.

### Deployment modes

| Mode                               | Functionality                              |
| ---------------------------------- | ------------------------------------------ |
| Signal K without Container Manager | Conventional MCP tools                     |
| Signal K with Container Manager    | Conventional tools + `execute_code`        |
| Container Manager unavailable      | Graceful fallback                          |
| Sandbox crashes                    | Core MCP functionality remains operational |

### Existing relevant APIs

The prior architecture investigation identified:

```typescript
ensureRunning();
ensureNetwork();
connectToNetwork();
disconnectFromNetwork();
resolveContainerAddress();
```

Verify current signatures against the installed Container Manager version.

Avoid depending on undocumented globals or unstable interfaces without checking their lifecycle and compatibility.

---

## 10. Container networking and isolation

**This is the most significant unresolved infrastructure issue.**

The sandbox must communicate with the capability broker without gaining unrestricted access to Signal K or the vessel's network.

### Preferred architecture

Use a dedicated internal container network and broker-controlled communication.

```text
Signal K MCP Plugin
        |
        | Initiates connection
        v
Capability Broker / Relay
        |
        | Restricted bidirectional RPC
        v
Sandbox Container
        |
        | Restricted JavaScript
        v
AI-generated query
```

### Reverse RPC concept

The Signal K plugin initiates a connection to the sandbox worker.

The worker can request capabilities through that established connection.

Example execution request:

```json
{
  "executionId": "abc123",
  "code": "return await signalk.getValues(['navigation.position'])"
}
```

The worker requests data:

```json
{
  "executionId": "abc123",
  "operation": "getValues",
  "arguments": {
    "paths": ["navigation.position"]
  }
}
```

Signal K validates the request against the original MCP client's permissions.

The worker receives only authorized results.

### Security requirements

The container must not be able to:

- Connect directly to Signal K's HTTP API.
- Access the internet.
- Connect to arbitrary LAN services.
- Query InfluxDB directly.
- Reach unrelated containers.
- Access the host filesystem.
- Obtain Signal K credentials.

The broker must not act as an unrestricted network proxy.

Every broker request must be associated with an authenticated execution context.

### Container Manager limitations

Earlier investigation suggested that Container Manager's current public API does not expose all required isolation settings.

Potential extensions:

```typescript
await manager.ensureNetwork("mcp-sandbox", {
  internal: true,
});
```

And:

```typescript
security: {
  readOnlyRootFilesystem: true,
  noNewPrivileges: true,
  dropCapabilities: ["ALL"]
}
```

These are **proposed API additions**, not confirmed existing configuration options.

Investigate whether these changes can be contributed upstream.

### Important deployment consideration

Signal K may run:

- Directly on Linux.
- Inside Docker.
- Inside Podman.
- On Raspberry Pi.
- On other resource-constrained devices.

Container Manager can use different networking strategies depending on deployment.

Do not assume an internal Docker network provides identical isolation under every configuration.

In particular, Docker's `internal` networking option does not automatically guarantee that host gateway services are inaccessible.

### Alternative worth evaluating

Investigate whether a Unix-domain socket, process-local relay, or other IPC mechanism could simplify broker communications.

Compare isolation properties, installation requirements, and Container Manager compatibility before finalizing the design.

**The reverse WebSocket broker is currently a design proposal, not a validated implementation.**

---

## 11. Energy and historical calculations

One important application is accurate vessel energy reporting.

For example, FOR TUNA needs:

- Yesterday's total solar production.
- Yesterday's wind generation.
- Yesterday's electrical consumption.
- Overnight battery SOC changes.
- Wind generation during the night.
- Current battery state.

Existing AI-generated reporting has previously produced incorrect energy figures.

The MCP plugin should enable accurate calculations through standardized, tested aggregation functions.

### Requirements

- Distinguish power from energy.
- Preserve units.
- Handle counter resets.
- Handle missing measurements.
- Handle irregular sampling.
- Define time boundaries precisely.
- Avoid double-counting sources.
- Differentiate measured consumption from estimates.
- Provide provenance for calculated values.

Do not rely on an LLM generating correct integration or aggregation logic for every report.

Sandbox execution can be useful for exploratory analysis, but recurring reports should use validated computation functions.

---

## 12. Performance and efficiency

The implementation should prioritize efficient MCP interaction.

### Conventional tools

Support batched operations.

Prefer:

```text
get_values(paths[])
```

over:

```text
get_value(path1)
get_value(path2)
get_value(path3)
```

### Sandboxed execution

Use `execute_code` for complex filtering, aggregation, and multi-source analysis.

Avoid returning thousands of raw measurements when a small aggregate result is sufficient.

### Resource constraints

The plugin must remain suitable for typical onboard systems.

Investigate:

- Raspberry Pi ARM compatibility.
- Docker/Podman overhead.
- V8 native dependencies.
- Memory usage.
- Worker startup time.
- Concurrent execution limits.
- CPU pressure.
- Impact on Signal K responsiveness.

**Signal K's primary navigation and telemetry duties must take priority over AI workloads.**

---

## 13. Suggested repository structure

```text
signalk-mcp/
│
├── src/
│   ├── index.ts
│   │
│   ├── transport/
│   │   └── http.ts
│   │
│   ├── auth/
│   │   ├── principal.ts
│   │   └── permissions.ts
│   │
│   ├── signalk/
│   │   ├── vessel.ts
│   │   ├── paths.ts
│   │   ├── history.ts
│   │   ├── resources.ts
│   │   └── notifications.ts
│   │
│   ├── capabilities/
│   │   ├── registry.ts
│   │   ├── discovery.ts
│   │   ├── openapi.ts
│   │   └── execution.ts
│   │
│   ├── mcp/
│   │   ├── server.ts
│   │   ├── tools.ts
│   │   └── resources.ts
│   │
│   ├── sandbox/
│   │   ├── manager.ts
│   │   ├── broker.ts
│   │   └── protocol.ts
│   │
│   └── config/
│       └── schema.ts
│
├── sandbox-worker/
│   ├── src/
│   │   ├── server.ts
│   │   ├── runtime.ts
│   │   └── sdk.ts
│   │
│   └── Dockerfile
│
├── test/
│
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE
```

This is an initial structure, not a mandatory implementation layout.

---

## 14. Development roadmap

### Phase 1 — Research and minimal proof of concept

**Goal:** Establish a working native Signal K MCP integration.

Tasks:

- Inspect the current Signal K plugin API.
- Verify authentication middleware behavior.
- Select an MCP SDK and compatible transport implementation.
- Implement MCP initialization.
- Expose `list_paths`.
- Expose `get_values`.
- Test with an existing Signal K token.
- Test using at least two MCP clients.

**Acceptance criteria:** An authenticated external MCP client can discover and retrieve live vessel measurements through a native Signal K plugin.

### Phase 2 — Capability layer

**Goal:** Create a consistent interface for core Signal K functionality.

Tasks:

- Implement the capability registry.
- Add vessel-state retrieval.
- Add metadata.
- Add notifications.
- Add historical queries through standardized APIs.
- Implement consistent units, timestamps, and source information.
- Add comprehensive error handling.

**Acceptance criteria:** Core Signal K data is discoverable and accessible through stable MCP tools.

### Phase 3 — Plugin API discovery

**Goal:** Discover and invoke authorized third-party plugin APIs.

Tasks:

- Investigate Signal K feature discovery.
- Investigate OpenAPI registration.
- Implement OpenAPI parsing.
- Build the capability registry.
- Implement permission classification.
- Support allowlisted read-only operations.
- Test with real plugins.

**Acceptance criteria:** An agent can discover a supported third-party plugin capability, inspect its schema, and invoke an authorized read-only operation.

### Phase 4 — Container Manager integration

**Goal:** Support isolated execution infrastructure.

Tasks:

- Inspect Container Manager's current APIs.
- Implement worker lifecycle management.
- Verify runtime detection.
- Implement secure networking.
- Implement resource restrictions.
- Test Docker and Podman.
- Validate graceful degradation.

**Acceptance criteria:** The native plugin can start, stop, communicate with, and recover a sandbox worker without interrupting core Signal K functionality.

### Phase 5 — Sandboxed JavaScript execution

**Goal:** Implement `execute_code`.

Tasks:

- Evaluate VesselSense's sandbox engine.
- Implement restricted SDK bindings.
- Implement capability broker.
- Propagate authorization context.
- Enforce timeouts and memory limits.
- Restrict network access.
- Validate outputs.
- Test malicious and malfunctioning code.

**Acceptance criteria:** An AI agent can execute a complex read-only query without obtaining direct access to Signal K credentials, the host, or unrestricted network resources.

### Phase 6 — Hardening and release

Tasks:

- Security review.
- Performance benchmarking.
- ARM/Raspberry Pi testing.
- Multi-client concurrency testing.
- Documentation.
- Configuration UI.
- CI/CD.
- AppStore packaging.
- Community feedback.
- Upstream collaboration.

---

## 15. Decisions already made

| Decision                                  | Status                 |
| ----------------------------------------- | ---------------------- |
| Native Signal K plugin                    | Preferred              |
| Open-source/community-oriented            | Required               |
| Streamable HTTP                           | Preferred transport    |
| Existing Signal K authentication          | Required               |
| Read-only by default                      | Required               |
| Tool-level authorization                  | Required               |
| Standard MCP tools                        | Required               |
| Dynamic plugin API discovery              | Required               |
| Optional sandboxed `execute_code`         | Preferred              |
| Separate sandbox container                | Preferred              |
| Use Signal K Container Manager            | Preferred              |
| No Docker requirement for basic operation | Required               |
| Reuse VesselSense components              | Evaluate               |
| Generic capability broker                 | Preferred              |
| Restrict sandbox networking               | Required               |
| Modify Signal K core                      | Avoid unless necessary |
| Publish through Signal K AppStore         | Target                 |

---

## 16. Outstanding technical questions

The next agent should investigate these before committing to the final architecture.

**1. Signal K authentication**

Can the current plugin router expose the authenticated principal and effective permissions reliably for every MCP request?

How are permissions propagated through internal ServerAPI calls?

**2. Plugin API discovery**

Can a plugin retrieve other plugins' OpenAPI definitions through a stable public interface?

If not, should a small upstream enhancement be proposed?

**3. Capability authorization**

Can third-party plugin operations be invoked under the original client's identity without bypassing Signal K's permission model?

**4. Container Manager isolation**

Can Container Manager create an internal-only network and enforce required security settings?

Does this work consistently with Docker and rootless Podman?

**5. Broker communication**

Is reverse WebSocket RPC the best design?

Could a Unix-domain socket or another IPC mechanism provide simpler and stronger isolation?

**6. Container security**

How can the sandbox be prevented from accessing host gateway services, Signal K, and other containers?

**7. Execution engine reuse**

Can VesselSense's sandbox implementation be reused without carrying unnecessary standalone-server dependencies?

**8. MCP client compatibility**

Which clients support custom Signal K bearer tokens directly?

Which require OAuth?

**9. Performance**

Can the worker operate reliably on common Raspberry Pi installations without degrading Signal K performance?

---

## 17. Important constraints for the implementing agent

- Do not assume earlier feasibility assessments constitute successful integration tests.
- Verify APIs against current upstream code.
- Prefer documented public interfaces over private internals.
- Do not introduce a second authentication system.
- Do not automatically expose all third-party plugin APIs.
- Do not enable vessel-control commands by default.
- Do not expose unrestricted JavaScript execution in the Signal K process.
- Do not assume Docker networking alone provides a complete security boundary.
- Do not require Container Manager for basic functionality.
- Preserve compatibility with existing Signal K deployments.
- Keep the MCP tool catalog compact.
- Separate transport, authorization, data access, and execution.
- Write integration tests covering authentication and privilege escalation.
- Document unsupported features rather than silently emulating them.
- Prioritize reliable vessel operation over AI query performance.

---

## 18. Immediate next actions

The next AI agent should begin with **technical validation rather than implementing the entire system immediately**.

1. Inspect the current Signal K server source, particularly plugin routing, authentication, feature discovery, and OpenAPI registration.
2. Inspect Container Manager's current networking and security capabilities.
3. Inspect VesselSense's execution engine and licensing.
4. Check for active MCP development in Signal K's GitHub issues and pull requests.
5. Produce a concise architecture decision record identifying confirmed APIs, integration gaps, and any required upstream changes.
6. Implement a minimal native MCP endpoint with Signal K bearer-token authentication and two read-only tools.
7. Run actual integration tests before proceeding to dynamic plugin APIs or sandboxed execution.

### Definition of success

The initial milestone is complete when:

> A user can install `signalk-mcp` through Signal K, connect an MCP-compatible AI agent using an existing Signal K token, discover available vessel measurements, and query live data through a secure Streamable HTTP endpoint—without installing a separate MCP server.

The extended milestone is complete when:

> The same agent can discover authorized APIs from other installed Signal K plugins and execute complex, read-only JavaScript queries inside a Container Manager-managed sandbox, without compromising Signal K's security boundaries or operational stability.

---

### Final instruction to the next agent

**Treat this document as a project brief and architectural direction, not as proof that every proposed integration is supported.**

Validate the assumptions against current source code, identify the minimum viable implementation, and prioritize working, tested integrations over speculative features.

The principal opportunity is to create a **native, secure, extensible MCP gateway for the Signal K ecosystem**—combining existing authentication, standardized APIs, third-party plugin discovery, and optional isolated code execution.

**Start by validating the Signal K and Container Manager interfaces, then build the smallest working native MCP plugin.**
