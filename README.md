# Signal K MCP

Connect an AI agent to your boat’s Signal K data. Ask for current readings, available sensors, notifications or recorded history, and let the agent use MCP tools to fetch the information.

Signal K MCP runs as a plugin inside your existing Signal K server. It uses Signal K’s accounts and permissions, with no separate server or account to manage.

**Alpha software:** use a test installation for evaluation. Supported versions are Signal K **2.32.0 and 2.33.0**, with Node.js **22 or 24**. Live vessel acceptance and end-to-end ChatGPT connection testing remain outstanding.

## What you can do

- Read current vessel measurements, including their units, timestamps and sources.
- Discover available data and installed plugin capabilities.
- Read notifications and historical data from an installed History API provider.
- Use selected plugin operations and native control actions after an administrator approves each one.

The plugin fetches and forwards data. It does not calculate derived values or run agent-written code. Data availability depends on your sensors, installed providers and Signal K permissions.

## Install and enable

1. Use Node.js 24 for the recommended setup and enable [Signal K security](https://demo.signalk.org/documentation/Security.html#enabling-security). MCP connections always need a token, even if Signal K allows guest reads.
2. In your **test Signal K configuration directory**, run this command as the account that runs Signal K:

   ```sh
   npm install --omit=dev --ignore-scripts signalk-mcp@0.1.0-alpha.3
   ```

3. Restart Signal K and open **Apps & Plugins → Configuration → Signal K MCP**.
4. Click **Save Configuration** to save the defaults. After the page refreshes, use the **Enabled** switch to enable the plugin and save the change.

Your MCP endpoint is your Signal K server address followed by `/plugins/signalk-mcp/mcp`, for example:

```text
https://boat.example/plugins/signalk-mcp/mcp
```

Replace `https://boat.example` throughout this guide with your server’s address. The computer running your agent must be able to reach it. Use HTTPS for remote access; see the [HTTPS and reverse-proxy guide](docs/hosting.md) for setup and browser access settings.

## Create a Signal K token

Create a separate device token for your agent using Signal K’s [access-request flow](https://signalk.org/specification/1.7.0/doc/access_requests.html). Start with **read-only** access for viewing data.

1. In Signal K, check that device registration is allowed under **Security → Settings**.
2. In a terminal, generate a client ID with `uuidgen`. Copy that UUID into the command below in place of `YOUR-UUID`, then send the request to your server:

   ```sh
   curl --fail-with-body --silent --show-error \
     --header 'Content-Type: application/json' \
     --data '{"clientId":"YOUR-UUID","description":"Signal K MCP agent"}' \
     https://boat.example/signalk/v1/access/requests
   ```

3. Keep the returned `href`; it identifies this request. In Signal K, open **Security → Access Requests**, select **Signal K MCP agent**, choose **Read Only**, set **Authentication Timeout** (for example, `1d` for one day), and click **Approve**.
4. Fetch the result using your server address followed by the exact returned `href`. For example, replace `REQUEST-ID` below with the ID from your response:

   ```sh
   curl --fail-with-body --silent --show-error \
     https://boat.example/signalk/v1/requests/REQUEST-ID
   ```

5. Once approved, the response contains `accessRequest.token`. Store that value in your agent’s secret settings or password manager. Treat it like a password: do not paste it into a chat, commit it to a repository or include it in screenshots.

The token uses the device’s Signal K permissions. For approved actions, the device needs **Read/Write** access as well as the individual operation approvals described below. Native PUT actions also require Signal K’s `put` permission for the exact target and source. An administrator token is not needed for ordinary data reads.

Manage or revoke the device under **Security → Devices**. If its token expires, request a replacement. Signal K also documents an alternative [token-generation method for existing user accounts](https://demo.signalk.org/documentation/Security/Generating_Tokens.html).

## Connect your agent

Use an agent that supports **MCP Streamable HTTP** and a bearer token. In its MCP connection settings, enter:

| Setting              | Value                                          |
| -------------------- | ---------------------------------------------- |
| Server name          | `signalk`                                      |
| Transport            | Streamable HTTP                                |
| URL                  | `https://boat.example/plugins/signalk-mcp/mcp` |
| Authorization header | `Bearer YOUR-SIGNAL-K-TOKEN`                   |

Use the client’s secret storage or environment-variable support for the token. Signal K MCP does not provide an OAuth login flow. Clients that only offer OAuth cannot connect directly through that flow.

### Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.signalk]
url = "https://boat.example/plugins/signalk-mcp/mcp"
bearer_token_env_var = "SIGNALK_MCP_TOKEN"
```

Make the token available to the Codex process as `SIGNALK_MCP_TOKEN`. For a terminal session in Bash or Zsh, run the following, paste the token at the hidden prompt and press Enter:

```sh
read -r -s SIGNALK_MCP_TOKEN
export SIGNALK_MCP_TOKEN
codex
```

In Codex CLI, use `/mcp` to check the connection. An already-running app will need its own launch environment configured and a restart to receive the variable. This setup uses a bearer token; `codex mcp login` is for OAuth servers. See the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).

For **Hermes** and **Claude Code** configuration examples, see the [agent connection guide](docs/clients.md). That guide distinguishes tested CLI connections from untested desktop/web clients, including ChatGPT.

### Try it in a chat

Once connected, ask your agent:

> Use Signal K to show my current position, speed over ground and wind readings. Include units and timestamps, and flag missing or stale data.

> List the measurements I can access, then show the available battery readings.

> Show the notifications I’m allowed to read, including their reported status.

> Check whether a history provider is available. If it is, fetch the last hour of speed-over-ground history.

The agent discovers and calls the tools; you do not need to write JSON requests. A useful instruction for your agent is:

> Discover available paths and capabilities before using them. Preserve units, timestamps and missing values. Ask me before any action that changes state. If an action has an unknown outcome, do not retry it automatically.

## Approve plugin operations and actions

Built-in telemetry, history and notification reads use your Signal K permissions immediately. **Every plugin read, plugin POST and native PUT action needs its own saved administrator approval.** There is no allow-all setting, and an agent cannot approve itself.

When an agent attempts an eligible operation that has not been approved, it receives `APPROVAL_PENDING`. The operation has not run.

1. Open **Apps & Plugins → Configuration → Signal K MCP** and click **Refresh**.
2. In **Operation requests**, review the requested operation and its **Read** or **Write** label. Expand the details to check what it does, its inputs and, for native controls, the exact path and source. Review the provider’s behavior and permissions before accepting.
3. Click **Accept** or **Reject**, then **Save Configuration**. Decisions take effect only after saving.
4. After approval, ask the agent to try the operation again.

![Signal K MCP operation approval table with example requests](docs/images/plugin-post-approvals.png)

_The screenshot uses synthetic example requests, not live vessel data._

Saved approvals survive restarts and allow later calls while Signal K permissions still apply. The plugin does not ask for confirmation on every call; configure your agent to ask before changing state. Changed operation contracts require a new review. Unsaved requests disappear on restart, so refresh the table before reviewing and saving.

If a submitted action times out or loses its connection, its outcome may be unknown. Do not retry automatically. A successful response alone does not prove that physical equipment acted.

## Troubleshooting

| What you see                         | What to check                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection or authentication failure | Confirm the plugin is enabled, the URL is reachable and the agent is sending a valid token. A browser login alone does not authenticate the agent. |
| Missing measurements                 | Ask the agent to list available paths. Check that Signal K receives the data and that the device has permission to read it.                        |
| `APPROVAL_PENDING`                   | Review and save the individual operation in Plugin Config, then try again.                                                                         |
| `HISTORY_UNAVAILABLE`                | Install and configure a provider for Signal K’s standard v2 History API.                                                                           |
| Permission denied after approval     | Check the device’s Signal K permissions and the provider’s own access requirements. Approval does not override either.                             |
| Certificate or browser-origin errors | Follow the [hosting guide](docs/hosting.md). Browser access follows Signal K’s server-wide CORS settings.                                          |

Upgrading from plugin-local `allowedHosts` or `allowedOrigins` settings? Those fields are now ignored; move any browser-origin restrictions to Signal K’s CORS settings. See [upgrade guidance](docs/hosting.md#browser-policy-and-upgrades).

## Further documentation

- [Agent connection examples and compatibility](docs/clients.md)
- [Tool reference, approval rules and limits](docs/reference.md)
- [Native control actions](docs/native-puts.md) and [plugin POST operations](docs/plugin-posts.md)
- [Installation upgrades, rollback and removal](docs/release-readiness.md#upgrade-rollback-and-removal)
- [Changelog](CHANGELOG.md)
- [Developer guide](docs/development.md) and [verification details](docs/verification.md)
