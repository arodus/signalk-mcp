# Connect your agent

Official documentation checked **2026-10-19**. These are client-specific setup recipes, not a claim that every product has been tested with this plugin. See [verification status](#verification-status) for the runtime evidence.

## Before you connect

1. [Install the plugin and create a Signal K token](../README.md). Start with a dedicated read-only identity.
2. Replace `https://boat.example` in the examples with your Signal K address. Keep `/plugins/signalk-mcp/mcp` at the end.
3. Choose **Streamable HTTP**. Signal K MCP requires `Authorization: Bearer <token>` on every request and does not implement OAuth. Do not select SSE or configure the server as unauthenticated.
4. Merge the example into your existing configuration; preserve other servers and settings.

The credential syntax varies by client. `SIGNALK_MCP_TOKEN` is an environment variable name, not a special token issued by the plugin. Its value is the token alone, without `Bearer `. For clients using an environment reference, supply it through your secret manager or launch environment. In Bash or Zsh, you can enter it without adding it to shell history:

```sh
read -r -s SIGNALK_MCP_TOKEN
export SIGNALK_MCP_TOKEN
```

Paste the token at the hidden input and press Enter, then launch the CLI from that terminal. An already-running desktop app does not inherit a later terminal export. Its process or remote execution host needs the variable separately. VS Code's input prompt and Claude's connector form below avoid this requirement.

## Choose your client

| Client                                                          | Configuration                                | Token handling                                                  |
| --------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| [Codex](#codex)                                                 | `~/.codex/config.toml`                       | `bearer_token_env_var` or private static header                 |
| [Claude Code](#claude-code)                                     | Project `.mcp.json`                          | `Bearer ${SIGNALK_MCP_TOKEN}`                                   |
| [Claude Desktop / web / Cowork](#claude-desktop-web-and-cowork) | Custom connector form                        | Request header entered in the UI; cloud network access required |
| [Cursor](#cursor)                                               | `~/.cursor/mcp.json`                         | `Bearer ${env:SIGNALK_MCP_TOKEN}`                               |
| [VS Code / GitHub Copilot](#vs-code--github-copilot)            | `.vscode/mcp.json` or user MCP config        | Hidden input prompt                                             |
| [GitHub Copilot CLI](#github-copilot-cli)                       | `/mcp add`                                   | HTTP headers entered in the setup UI                            |
| [Gemini CLI](#gemini-cli)                                       | `~/.gemini/settings.json`                    | `Bearer ${SIGNALK_MCP_TOKEN}` with `httpUrl`                    |
| [Hermes](#hermes)                                               | Active profile's `config.yaml`               | `Bearer ${SIGNALK_MCP_TOKEN}`                                   |
| [OpenCode](#opencode)                                           | `opencode.json`                              | `Bearer {env:SIGNALK_MCP_TOKEN}`                                |
| [Windsurf / Cascade](#windsurf--cascade)                        | Cascade's MCP config editor                  | `Bearer ${env:SIGNALK_MCP_TOKEN}`                               |
| [ChatGPT](#chatgpt)                                             | Depends on desktop host versus hosted plugin | Separate setup and verification limits                          |

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.signalk]
url = "https://boat.example/plugins/signalk-mcp/mcp"
bearer_token_env_var = "SIGNALK_MCP_TOKEN"
```

Launch `codex` with the environment variable available. Use `/mcp` to inspect the connection; `codex mcp list` only checks saved configuration. Do not run `codex mcp login` for this bearer-only server.

For a desktop process where environment setup is inconvenient, Codex also supports a static header in the same server entry. **Replace** `bearer_token_env_var` with:

```toml
http_headers = { Authorization = "Bearer YOUR-SIGNAL-K-TOKEN" }
```

This stores the token in plaintext: use only your private user configuration, protect the file, and never commit or share it. Restart/reconnect after changing credentials. Shared configuration does not establish desktop UI acceptance.

Source: [official Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

## Claude Code

Create `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "signalk": {
      "type": "http",
      "url": "https://boat.example/plugins/signalk-mcp/mcp",
      "headers": {
        "Authorization": "Bearer ${SIGNALK_MCP_TOKEN}"
      }
    }
  }
}
```

Start `claude` with the variable available, approve the project MCP configuration when prompted, and use `/mcp` to check it. The `type` field is required here. `${SIGNALK_MCP_TOKEN}` is expanded by Claude Code; keep the reference in the file instead of substituting a literal secret. This configuration is for Claude Code, not Claude Desktop's local-server JSON file.

Source: [Claude Code HTTP setup and environment expansion](https://code.claude.com/docs/en/mcp).

## Claude Desktop, web and Cowork

Current Claude documentation supports fixed bearer credentials in remote custom connectors:

1. Open **Customize → Connectors → Add → Add custom connector**. Team/Enterprise administrators configure connectors through organization settings.
2. Enter a name and your full Signal K MCP URL.
3. Choose **No sign in** for the OAuth choice, then add a **Request header** named `Authorization` with value `Bearer YOUR-SIGNAL-K-TOKEN`.
4. Finish adding the connector and enable it for the conversation.

“No sign in” skips OAuth; the required bearer header still authenticates every request. These connections originate from Anthropic's cloud, including in Desktop and Cowork. A boat-only LAN/VPN endpoint will not be reachable through this flow. On Team/Enterprise, the fixed credential is shared by connector users, so its permissions apply to all of them. This UI route is documentation-verified only; it has not been exercised against Signal K here.

Source: [Claude custom connectors, request headers and network requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

## Cursor

Use `~/.cursor/mcp.json`, or `.cursor/mcp.json` for one project:

```json
{
  "mcpServers": {
    "signalk": {
      "url": "https://boat.example/plugins/signalk-mcp/mcp",
      "headers": {
        "Authorization": "Bearer ${env:SIGNALK_MCP_TOKEN}"
      }
    }
  }
}
```

Make the variable available to Cursor and enable the server in its MCP settings. Cursor uses `${env:NAME}`, unlike Claude Code's `${NAME}`. Cursor's `envFile` option applies to stdio servers, not this remote HTTP connection.

Source: [Cursor MCP configuration and interpolation](https://cursor.com/docs/mcp).

## VS Code / GitHub Copilot

Use `.vscode/mcp.json`, or open the user MCP configuration with **MCP: Open User Configuration**:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "signalk-token",
      "description": "Signal K access token",
      "password": true
    }
  ],
  "servers": {
    "signalk": {
      "type": "http",
      "url": "https://boat.example/plugins/signalk-mcp/mcp",
      "headers": {
        "Authorization": "Bearer ${input:signalk-token}"
      }
    }
  }
}
```

Start the server from the MCP configuration or **MCP: List Servers**. Enter the token when prompted, accept the server trust prompt, and enable its tools in your agent chat. This uses `servers`, not `mcpServers`; do not copy another client's outer JSON structure.

Source: [VS Code MCP configuration and secret inputs](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

## GitHub Copilot CLI

In an interactive `copilot` session, run `/mcp add`. Choose an HTTP server, name it `signalk`, and enter the full endpoint URL. In **HTTP Headers**, enter:

```json
{ "Authorization": "Bearer YOUR-SIGNAL-K-TOKEN" }
```

Replace the placeholder in the setup form, then save. Keep the credential in your private user configuration rather than a shared project file. Use `/mcp show signalk` to inspect the server. Copilot CLI's configuration is separate from VS Code's `servers` format.

Source: [GitHub Copilot CLI MCP setup](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).

## Gemini CLI

Merge into `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "signalk": {
      "httpUrl": "https://boat.example/plugins/signalk-mcp/mcp",
      "headers": {
        "Authorization": "Bearer ${SIGNALK_MCP_TOKEN}"
      },
      "trust": false
    }
  }
}
```

Start `gemini` with the variable available and use `/mcp` to inspect the connection. Use **`httpUrl`**: Gemini's `url` setting selects SSE. Environment references are expanded in settings string values. Keep `trust` false so this entry does not bypass tool-call confirmations.

Sources: [Gemini MCP transport and headers](https://geminicli.com/docs/tools/mcp-server/) and [settings/environment expansion](https://geminicli.com/docs/reference/configuration/).

## Hermes

In the active Hermes profile's `config.yaml` (normally `~/.hermes/config.yaml`):

```yaml
mcp_servers:
  signalk:
    url: https://boat.example/plugins/signalk-mcp/mcp
    headers:
      Authorization: "Bearer ${SIGNALK_MCP_TOKEN}"
```

Supply the token through that profile's secret source or process environment. HTTP entries use Streamable HTTP by default; no OAuth setting is needed. Run `hermes mcp test signalk` for initialization and discovery, then request a read in a chat. Discovery alone does not prove a tool call succeeds.

Source: [Hermes MCP settings and secret references](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference).

## OpenCode

Merge into `opencode.json`:

```json
{
  "mcp": {
    "signalk": {
      "type": "remote",
      "url": "https://boat.example/plugins/signalk-mcp/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:SIGNALK_MCP_TOKEN}"
      }
    }
  }
}
```

Launch OpenCode with the variable available and check `opencode mcp list`. The variable reference is **`{env:NAME}` without a dollar sign**. Disabling OAuth here selects fixed-token authentication; the bearer header remains mandatory.

Source: [OpenCode remote MCP and fixed credentials](https://opencode.ai/docs/mcp-servers/).

## Windsurf / Cascade

The former Windsurf documentation now redirects to Devin Desktop's **legacy Cascade** guide. Open the MCP config file through Cascade's **Actions → MCPs → Open MCP config file** control rather than assuming an old filesystem location. Add:

```json
{
  "mcpServers": {
    "signalk": {
      "serverUrl": "https://boat.example/plugins/signalk-mcp/mcp",
      "headers": {
        "Authorization": "Bearer ${env:SIGNALK_MCP_TOKEN}"
      }
    }
  }
}
```

Make the variable available to the app and enable this server in Cascade. This recipe follows the current Cascade documentation; Devin Local uses a different configuration and is not covered by this example.

Source: [Cascade MCP configuration](https://docs.devin.ai/desktop/cascade/mcp).

## ChatGPT

**Desktop using a Codex host:** OpenAI documents shared MCP configuration and bearer support for the desktop app, CLI and IDE on the same Codex host. Follow the [Codex recipe](#codex) on that host. This is documentation support, not a completed desktop acceptance test. [Official connection documentation](https://learn.chatgpt.com/docs/extend/mcp).

**Hosted web/plugin connection:** this is a separate surface. The public plugin submission portal currently has no bearer-token input, even though its manifest schema accepts API-key declarations. That portal limitation does not describe every private connection surface. There is no verified end-to-end ChatGPT web/tunnel recipe for this gateway yet. Do not disable Signal K authentication or embed credentials in a public plugin to work around it. [Portal authentication limits](https://developers.openai.com/plugins/deploy/submission#authentication-limitations).

## Confirm your connection

After connecting, ask: “Use Signal K to list the measurement paths I can read, then fetch one available reading with its units and timestamp.” A connected indicator or tool list alone is not proof of a successful read.

For an authentication failure, check the actual client's token syntax and launch environment, the token expiry, and the server address. For an empty result, check Signal K data and identity permissions. For `APPROVAL_PENDING`, follow the [saved operation approval steps](../README.md#approve-plugin-operations-and-actions).

Client tool confirmations and Signal K administrator approvals are separate. Every plugin GET/POST and native PUT still requires its own saved review. Never automatically retry a state-changing call whose outcome is unknown.

## Verification status

The setup references above were reviewed on 2026-10-19. The historical product-runtime checks below were performed on 2026-10-18 against an earlier seven-tool read catalog; they do not certify all fourteen current tools, mutation handling, newer client versions or desktop UIs.

| Product runtime                                                    | Recorded evidence                                                                                                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI/app-server `0.163.0-alpha.10.2`                          | Synthetic native-server initialization, seven tools, allowed zero/unit read, denied-path filtering, tool errors and reconnect through a fresh ephemeral thread. |
| Hermes `0.22.2`, commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8` | CLI discovery and registered handlers, permission filtering, tool errors and shutdown/re-discovery against synthetic Signal K.                                  |
| Other clients and desktop/web surfaces above                       | Official-documentation review only; no product connection or physical-vessel verification.                                                                      |

No product-client tests were rerun for this documentation update. For SDK/server integration evidence, see [verification](verification.md); for opt-in product test commands, see [development](development.md#reproduce-installed-client-tests). The [authentication decision](decisions/002-client-authentication.md) records why this gateway uses native tokens.
