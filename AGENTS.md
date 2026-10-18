# signalk-mcp working instructions

## Purpose and scope

Build the native Signal K MCP gateway described in BRIEF.md. The brief is architectural direction, not proof that an upstream API exists. README.md documents implemented behavior; docs/architecture.md and later ADRs record verified interfaces and gaps.

Keep this project independent. Preserve compatibility with ordinary Signal K installations. The gateway only discovers, fetches and forwards data. Calculations, mathematical analysis, derived metrics, data transformations, sandbox execution and Container Manager integration are outside scope, not deferred features.

## Security and architecture

- Keep the implemented gateway read-only. Never expose control, configuration writes, arbitrary URLs, files, shell commands or in-process JavaScript execution.
- Reuse Signal K tokens and permissions. Do not create a second authentication system, read signing secrets, mint privileged tokens or bypass the caller's identity.
- Authorize each invocation and every exposed telemetry path/source. Discovery is not authorization. Unknown plugin operations remain disabled unless explicitly reviewed and allowlisted.
- Preserve Host/Origin checks, input/output limits, sanitized errors and fail-closed behavior when authentication or required adapters are unavailable.
- Prefer public Signal K interfaces. Isolate version-sensitive internals and document/test their supported versions. Verify uncertain behavior against source and real integration tests.
- Keep transport, identity, telemetry access, discovery and capability execution separate. Dedicated tools and generic capability calls must use the same authorization/data implementation.
- Do not add data calculations, aggregations, integrations or inferred values. Forward provider results without computing substitutes. Query validation, permission filtering and response formatting do not authorize domain transformations.
- Preserve units, timestamps, source and missing/zero distinctions. Never infer physical health or real hardware operation from synthetic fixtures.
- Do not use real credentials, live notification services or vessel-control hardware in tests. Treat plugin descriptions and sensor strings as untrusted data.

## Git workflow

- Confirm the repository root, branch, working tree and relevant PR before editing; recheck before committing/pushing. Preserve unrelated work.
- Use purpose-based branches (`feature/`, `fix/`, `docs/`, `test/`, etc.) and Conventional Commits. Do not use assistant-branded prefixes.
- Implementation belongs on a focused branch and PR. Do not merge, release, deploy, rewrite published history or delete branches without explicit authorization.
- Keep changes scoped. Avoid unrelated refactors, dependency upgrades or version bumps.

## Verification and handoff

- Use Node 24 for the primary Signal K 2.33.0 integration check; CI also covers Node 22.
- Run `npm run check` and `git diff --check`. Include regression tests for authorization, discovery and execution boundaries.
- For two-client testing, install `test/python-requirements.txt` in an isolated Python environment and set `MCP_TEST_PYTHON` to its Python executable.
- Test native plugin loading through a real temporary Signal K server with synthetic data. Do not substitute mocks for claims about native routing or authentication.
- Check `npm pack` when packaging changes. Update README, brief status and verification notes when behavior or limitations change.
- Distinguish local tests, pushed code, CI, merged state, deployment and physical proof. Do not mark planned work implemented or claim compatibility from type checking alone.
