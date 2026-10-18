# Reviewed plugin read: Hat Labs Alert Manager

Review date: 2026-10-18. This is a reproducible compatibility example, not a default approval. `pluginOperations` remains empty unless the user explicitly configures it.

## Exact package and operation

| Component                 | Reviewed target                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Independent provider      | [`signalk-alert-manager@0.1.0`](https://www.npmjs.com/package/signalk-alert-manager/v/0.1.0), maintained by Hat Labs                                         |
| Published source          | [`b8c4e8bdd86e38cc9f9a73d64c10872fe88fad9d`](https://github.com/hatlabs/signalk-alert-manager/tree/b8c4e8bdd86e38cc9f9a73d64c10872fe88fad9d) (npm `gitHead`) |
| Native route              | `GET /plugins/signalk-alert-manager/alerts`                                                                                                                  |
| OpenAPI operation         | `listAlerts`                                                                                                                                                 |
| Caller requirement        | Existing Signal K admin identity                                                                                                                             |
| Signal K / Node CI matrix | Signal K 2.32.0 and 2.33.0 × Node 22 and 24                                                                                                                  |

The dev dependency and lockfile pin the exact published tarball (SHA-512 integrity `ULdVkaouIApRz36IobNrPTfnzoPvq1jlb3U2Hio2nQpDIk7f306eYaahZljn5NyWazGsMa9ziuhEDPQtiulD/A==`). It is test-only: installing this gateway's production package does not install or enable Alert Manager. The test does not patch the installed provider or replace its handlers.

Review evidence:

- [`src/api/routes.ts`](https://github.com/hatlabs/signalk-alert-manager/blob/b8c4e8bdd86e38cc9f9a73d64c10872fe88fad9d/src/api/routes.ts): the `/alerts` GET validates string filters and calls `manager.getAlerts(filter)`. It does not raise, acknowledge, silence, clear, persist or emit alerts. It registers on the default admin router, without a `router.access` downgrade.
- [`src/core/AlertManager.ts`](https://github.com/hatlabs/signalk-alert-manager/blob/b8c4e8bdd86e38cc9f9a73d64c10872fe88fad9d/src/core/AlertManager.ts): `getAlerts` reads the in-memory collection and applies provider-owned filters. The gateway forwards that provider result and performs no calculation or transformation of alert values.
- [`src/api/openApi.json`](https://github.com/hatlabs/signalk-alert-manager/blob/b8c4e8bdd86e38cc9f9a73d64c10872fe88fad9d/src/api/openApi.json): `listAlerts` exposes optional string filters `state`, `priority`, `category` and `stale`; the latter is the string enum `"true"`/`"false"`. No schema expansion is needed.
- [`src/index.ts`](https://github.com/hatlabs/signalk-alert-manager/blob/b8c4e8bdd86e38cc9f9a73d64c10872fe88fad9d/src/index.ts): the provider itself owns alert persistence, notification consumption and lifecycle behavior. The read approval does not expose those mutation APIs through MCP.

**The endpoint does not filter its JSON using Signal K telemetry path/source ACLs.** Its native security boundary is admin access. This example must remain admin-only; a readonly approval would misdescribe who can access it. The gateway forwards the caller's original bearer and still goes through native authorization. No privileged replacement identity is created. Even a deliberately relaxed approval in the regression test cannot make the target accept a readonly caller.

## Configure and call

After installing and enabling that exact provider in a test Signal K instance, add this explicitly reviewed entry to this gateway's configuration:

```json
{
  "pluginOperations": [
    {
      "pluginId": "signalk-alert-manager",
      "operationId": "listAlerts",
      "method": "GET",
      "path": "/alerts",
      "readOnly": true,
      "permission": "admin"
    }
  ]
}
```

Keep the gateway's existing `allowedHosts` and other settings. `readOnly: true` records the handler review above; HTTP GET alone does not establish absence of side effects. An upgrade requires another review even if its method/path/operation ID is unchanged. Configuration does not pin the installed provider version automatically.

Call `describe_capability` with `{"id":"plugin.signalk-alert-manager"}`, then invoke `execute_capability` with an existing admin bearer:

```json
{
  "id": "plugin.signalk-alert-manager",
  "operation": "listAlerts",
  "arguments": { "priority": "warning", "stale": "false" }
}
```

The result's `data` is the provider's JSON. The gateway does not infer alarm health, recompute priorities, or acknowledge anything. This API is unpaginated; responses over the gateway's 256 KiB bound fail rather than returning a partial invented result.

## Reproduce

```sh
npm ci --ignore-scripts --omit=optional
npm run build
node --test --test-force-exit test/production-plugin.test.cjs
```

Use Node 24 for the primary check. The existing CI matrix runs this suite under both supported server versions and Node majors. `MCP_TEST_SERVER_DIR` selects a separately installed Signal K runtime as described in [authentication compatibility](authentication.md). The package's use of built-in `node:sqlite` also requires a Node release with that module; CI uses current Node 22/24 releases, not every historical patch release.

Tests use a fresh temporary configuration and SQLite database, synthetic device identities and a synthetic notification delta. Provider audio is disabled, escalation is disabled and no browser audio client or external notifier is connected. Seed setup is outside MCP. The test compares MCP output with native HTTP output, then verifies mutation attempts leave alert state unchanged. It uses native configuration to disable the provider and starts a separate server without the installed package to test stale approval behavior. Schema-drift cases replace only the temporary server's published OpenAPI record, restoring it afterward; the published package stays unchanged.

## Diagnostics and compatibility limits

| Result                                       | Meaning / action                                                                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PERMISSION_DENIED` in description           | This approval requires admin; readonly callers cannot use it.                                                                                                                             |
| `UPSTREAM_PERMISSION_DENIED`                 | Native target authorization refused the original caller (the reviewed default admin middleware returns HTTP 401 for a readonly token). A gateway approval cannot grant extra permissions. |
| `NOT_ALLOWLISTED`                            | No exact reviewed plugin/operation/method/path match; re-review configuration and provider version.                                                                                       |
| `UNSUPPORTED_SCHEMA`                         | An input schema is outside the bounded subset. This package's individual-alert UUID and history date-time inputs remain disabled; no format is silently ignored.                          |
| `AMBIGUOUS_OPERATION_ID`                     | The provider document duplicates an operation ID; execution is disabled.                                                                                                                  |
| `METHOD_NOT_READONLY`                        | A mutation method is documented but never executable.                                                                                                                                     |
| `PLUGIN_DISABLED` / `CAPABILITY_UNAVAILABLE` | Enablement or the target API is unavailable; the gateway does not enable it.                                                                                                              |
| `CAPABILITY_NOT_FOUND`                       | The provider is absent from native discovery, including an approval left behind after removal and restart.                                                                                |
| `INVALID_ARGUMENTS`                          | Wrong types, extra fields, invalid enum values or bounds; consult the described input schema.                                                                                             |
| `UPSTREAM_HTTP_ERROR`                        | The provider rejected a schema-valid request or failed. Native error bodies are deliberately not echoed; consult that provider's local diagnostics.                                       |
| `UNSUPPORTED_OPENAPI`                        | The document is not supported OpenAPI 3.0/3.1.                                                                                                                                            |

Operations without valid `operationId` values are omitted rather than assigned invented IDs. Missing docs, schema support, or approval are not proof that a provider has no read API. Unsupported operations remain unavailable. Invalid gateway configuration reports the configuration field names, including `pluginOperations`, without echoing supplied values or credentials.

These tests establish the reviewed API contract with synthetic alerts. They do not validate live vessel data, external notification delivery, physical safety, arbitrary plugin versions, or the provider's complete lifecycle implementation.
