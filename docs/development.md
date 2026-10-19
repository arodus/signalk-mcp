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
npm install --omit=dev --ignore-scripts /absolute/path/signalk-mcp-0.1.0-alpha.3.tgz
```

Restart Signal K, save the default plugin configuration and enable the plugin as described in the README.

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

The release pipeline stamps the release commit into the package and verifies npm’s published `gitHead`. Alpha versions use the `next` distribution tag. See [registry score evidence](registry-readiness.md), [package verification and release acceptance](release-readiness.md), and the [verification report](verification.md). Publication requires explicit authorization.
