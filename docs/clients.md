# Product-client compatibility

Checked 2026-10-18. The gateway requires an existing Signal K bearer token on every HTTP request. It implements Streamable HTTP and has no OAuth login/discovery flow. SDK tests and product-runtime tests are separate evidence; a desktop application being installed does not establish its connection UI works.

The issue #30 development catalog contains fourteen tools, including native PUT discovery/status and separate mutation tools. The older product-runtime observations below cover the read-only catalog; they do not establish mutation approval/confirmation behavior in a desktop client. Mutation annotations declare non-read-only, potentially destructive, non-idempotent external actions, while actual approval and native permission checks stay enforced on the server. Plugin POSTs remain disabled.

## Matrix

| Product / tested version       | Authentication route                                                   | Evidence and limits                                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI `0.163.0-alpha.10.2` | HTTP URL with `bearer_token_env_var`                                   | Installed CLI/app-server runtime tested against synthetic native Signal K. Seven tools, authorized zero/unit read, denied-path filtering, tool error and a new connection through a second ephemeral thread. No model invocation or desktop UI acceptance. |
| Hermes Agent `0.22.2`          | HTTP headers with an environment reference                             | Installed CLI discovery and registry reads, permission filtering, tool errors and shutdown/re-discovery passed; commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`. No model or desktop UI acceptance.                                                      |
| Claude Code                    | Official docs support HTTP bearer headers and environment substitution | Documentation only; no installed CLI tested here. Do not extrapolate this to Claude Desktop/web connectors.                                                                                                                                                |
| Claude Desktop/web             | Separate connector authorization surface                               | Untested. No claim that a native bearer can be entered or that OAuth works.                                                                                                                                                                                |
| ChatGPT web/plugin connection  | Separate hosted connection surface                                     | Untested. Current public submission documentation says its portal has no bearer-token input. The gateway cannot be configured as unauthenticated to bypass this.                                                                                           |

Official references: [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Hermes MCP configuration](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference), [Claude Code MCP](https://code.claude.com/docs/en/mcp), [OpenAI public submission authentication limitations](https://developers.openai.com/plugins/deploy/submission#authentication-limitations). Product versions, account surfaces and requirements can change; re-test the actual intended client before deployment.

## Codex

In your Codex configuration, use an environment variable name instead of committing a token:

```toml
[mcp_servers.signalk]
url = "https://boat.example/plugins/signalk-mcp/mcp"
bearer_token_env_var = "SIGNALK_MCP_TOKEN"
```

Supply `SIGNALK_MCP_TOKEN` to the client process through your secret manager or protected launch environment. `codex mcp list` inspects configuration; connection/tool evidence comes from the runtime, not that listing alone. This native bearer connection does not use `codex mcp login`, which starts an OAuth flow.

## Hermes

The corresponding server entry in Hermes `config.yaml` is:

```yaml
mcp_servers:
  signalk:
    url: https://boat.example/plugins/signalk-mcp/mcp
    transport: streamable-http
    headers:
      Authorization: "Bearer ${SIGNALK_MCP_TOKEN}"
```

Supply the environment variable to Hermes and run `hermes mcp test signalk` for initialization and discovery. This command alone does not prove a tool call succeeds; the test below additionally invokes Hermes's registered tool handlers. Configure the endpoint explicitly; do not use a live vessel while reproducing the fixture tests.

## Claude Code (documented, untested here)

An environment reference avoids a literal credential in `.mcp.json`:

```json
{
  "mcpServers": {
    "signalk": {
      "type": "http",
      "url": "https://boat.example/plugins/signalk-mcp/mcp",
      "headers": { "Authorization": "Bearer ${SIGNALK_MCP_TOKEN}" }
    }
  }
}
```

The product must receive that environment variable. This example is based on the official configuration reference, not a successful local Claude test.

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
