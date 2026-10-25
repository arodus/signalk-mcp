# Development

For installation and use, start with the [README](../README.md). For project direction and contribution requirements, see the [brief](../BRIEF.md), [working instructions](../AGENTS.md) and [architecture](architecture.md).

## Build from source

Use Node 24 for the primary Signal K 2.33.0 check.

```sh
npm ci --ignore-scripts --omit=optional
npm run check
npm pack
```

Install the resulting tarball in a test Signal K configuration directory, using its service account:

```sh
npm install --omit=dev --ignore-scripts /absolute/path/signalk-mcp-0.3.1.tgz
```

Restart Signal K, save the default plugin configuration and enable the plugin as described in the README.

## Validation and JSON Schema

The gateway uses Zod 4.6.7 or later and native `z.toJSONSchema()` conversion. `src/schema.ts` targets Draft 7 input contracts and preserves their established representation so a validator upgrade alone does not revoke saved approvals. The shared bounded OpenAPI compiler registers explicit metadata for `oneOf`, `allOf`, property counts, unique arrays and bounded custom JSON. Other unrepresentable types and cycles fail conversion; no generic fallback to an unconstrained schema is enabled.

`test/fixtures/zod3-review-keys.json` records 165 review keys generated from commit `a0303d6eb81a0a7570c46d5ff5329b743ce5b463` with Zod 3.25.76. `test/schema.test.cjs` checks every admitted pinned plugin/native operation and each Resources mutation against that baseline, then verifies saved plugin/native approvals still enable the same operation. These hashes are synthetic fixture contracts, not user approvals. Change them only after reviewing an intentional contract change. Regression tests also preserve timestamp spellings, GUID-shaped IDs, strict configuration and the pre-parse rejection of oversized arrays.

The gateway has no direct dependency on `zod-to-json-schema` and imports no Zod 3 compatibility API. The pinned MCP SDK still declares the converter as a transitive dependency for its own Zod 3 compatibility branch; it uses native conversion for the Zod 4 schemas supplied by this gateway.

## Checks and integration tests

```sh
npm run check
```

Tests use a real temporary Signal K instance, a synthetic installed provider, disposable identities and synthetic deltas. Signal K binds its test listener using its default address; run in an isolated development environment. No vessel connection is configured.

`npm test` runs the portable permission, schema, history-validation and local HTTP transport tests without forced exit. `npm run test:integration` runs the native Signal K, hosting, provider and lifecycle tests. `npm run check` includes both suites plus type, lint and format checks.

The official [Signal K plugin CI](https://github.com/SignalK/signalk-server/blob/master/.github/workflows/plugin-ci.yml) runs the portable suite and upstream package/schema/lifecycle checks on Linux x64, Linux ARM64, macOS and Windows with Node 22/24. Our separate native integration CI retains the Signal K 2.32.0/2.33.0 matrix, Python MCP and real disposable InfluxDB. Generic upstream checks do not establish native permission compatibility, hardware acceptance or a registry score.

Both workflows run on pull requests, pushes to `main` and manual dispatch, avoiding duplicate feature-branch push runs. The official workflow owns portable tests and formatting; one local-workflow job enforces type checking and lint because upstream lint is advisory. The native matrix runs integration tests against the checkout and again against the installed tarball to verify packaging. `npm run check` remains the complete local check.

To include the second client (Python 3.10+):

```sh
python3 -m venv /tmp/signalk-mcp-python
/tmp/signalk-mcp-python/bin/pip install -r test/python-requirements.txt
MCP_TEST_PYTHON=/tmp/signalk-mcp-python/bin/python npm run test:integration
```

Without `MCP_TEST_PYTHON`, that test is explicitly skipped. Credentials reach Python over stdin. The native integration runner uses `--test-force-exit` after tests/cleanup because the upstream test server leaves background handles after stopping; the plugin does not force process exit.

The separate lifecycle test checks gateway-owned timer/TCP cleanup before terminating residual server processes and also runs without forced test exit. The opt-in local ARM64 benchmark passed the agreed development gates. Full server process replacement preserves client access and permissions in native tests; in-process server shutdown still has upstream cleanup gaps. Raspberry Pi testing is outside the release acceptance scope; the local ARM64 results do not establish Pi compatibility. Oversized ordinary JSON results now stop serialization at the byte budget, but that is not a total host-memory limit. See [resource results, reproduction commands and limits](resource-validation.md).

To verify an installed tarball, set `MCP_TEST_PLUGIN_DIR` to the installed package directory while running the integration test. CI covers Signal K 2.32.0 and 2.33.0 on Node 22 and 24 with both clients. See the verification report for actual results and outstanding acceptance work.

## Release evidence

The release pipeline stamps the release commit into the package and verifies npm’s published `gitHead`. Stable versions use `latest`; prereleases use `next`. See [registry score evidence](registry-readiness.md), [package verification and release acceptance](release-readiness.md), and the [verification report](verification.md). Publication requires explicit authorization.

## Reproduce installed-client tests

Build the plugin and explicitly select installed client paths:

```sh
npm run build
MCP_TEST_CODEX_BIN=/absolute/path/to/codex \
MCP_TEST_HERMES_DIR=/absolute/path/to/hermes-agent \
MCP_TEST_HERMES_PYTHON=/absolute/path/to/hermes-managed/python3 \
node --test --test-force-exit test/integration.test.cjs
```

The existing native server fixture creates an isolated configuration, short-lived synthetic tokens and synthetic telemetry. Codex's child process disables existing MCP servers, apps, plugins and hooks through command-line overrides and verifies only the fixture is enabled before connecting. Its test threads are ephemeral. User configuration is never changed. Hermes uses a temporary `HERMES_HOME`; its existing profile and real credentials are not used. The token is passed in child process memory/environment, never written into the config or command line.

The Hermes script uses the selected installation's bootstrap/dependencies, CLI discovery and actual registered handlers. It does not implement an alternative MCP client. Pin the installed version/commit when repeating it: these product interfaces can change. No model request or real external notification is made. A fresh Codex thread and Hermes shutdown/re-discovery check explicit reconnect; abrupt network loss and interactive UI recovery remain untested.

These checks are opt-in because the products are not CI dependencies. Missing `MCP_TEST_CODEX_BIN` or `MCP_TEST_HERMES_DIR` is reported as a skipped product test. Normal CI continues to run both pinned SDK clients and real provider tests. Follow [ADR 002](decisions/002-client-authentication.md) for the OAuth decision and unresolved native contract.
